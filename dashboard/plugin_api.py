"""项目看板 — 本机项目进程管理插件的后端。

挂载点：``/api/plugins/project-board/``（由 dashboard 插件系统在 discovery 时
按 ``dashboard/manifest.json`` 的 ``api`` 字段导入）。

设计约束（与 Hermes 插件契约一致）：
- handler 永不向外抛异常，一律返回 ``{"ok": False, "error": ...}``；
- 进程用参数数组启动，``shell=False``，绝不拼接命令字符串；
- 停止分级：CTRL_BREAK / SIGTERM → 超时后 taskkill /T /F（整棵进程树）；
- 日志：内存环形缓冲（给前端）+ 落盘文件（按大小轮转），管道始终有人读；
- WebSocket 走 dashboard 的 ``_ws_auth_ok`` 规范鉴权。
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Body, Query, WebSocket, WebSocketDisconnect

router = APIRouter()

IS_WIN = sys.platform == "win32"
PLUGIN_ID = "project-board"
RING_SIZE = 800
LOG_MAX_BYTES = 5 * 1024 * 1024
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if IS_WIN else 0
CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if IS_WIN else 0

_STORE_LOCK = threading.RLock()
_RUN_LOCK = threading.RLock()


# ---------------------------------------------------------------------------
# 数据目录 / 持久化
# ---------------------------------------------------------------------------

def _hermes_home() -> Path:
    home = os.environ.get("HERMES_HOME")
    if home:
        return Path(home)
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        return Path(get_hermes_home())
    except Exception:
        return Path.home() / ".hermes"


def _data_dir() -> Path:
    d = _hermes_home() / "plugin-data" / PLUGIN_ID
    (d / "logs").mkdir(parents=True, exist_ok=True)
    return d


def _store_path() -> Path:
    return _data_dir() / "projects.json"


def _load_projects() -> list[dict[str, Any]]:
    path = _store_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    items = data.get("projects") if isinstance(data, dict) else data
    return [p for p in items if isinstance(p, dict) and p.get("id")] if isinstance(items, list) else []


def _save_projects(projects: list[dict[str, Any]]) -> None:
    path = _store_path()
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"version": 1, "projects": projects}, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _find(project_id: str) -> Optional[dict[str, Any]]:
    for p in _load_projects():
        if p.get("id") == project_id:
            return p
    return None


# ---------------------------------------------------------------------------
# 运行态
# ---------------------------------------------------------------------------

@dataclass
class Running:
    project_id: str
    proc: subprocess.Popen
    pid: int
    started_at: float
    ring: deque = field(default_factory=lambda: deque(maxlen=RING_SIZE))
    stopping: bool = False
    restarts: int = 0


_RUNNING: dict[str, Running] = {}
_LAST: dict[str, dict[str, Any]] = {}
_HEALTH_CACHE: dict[str, tuple[float, bool]] = {}
_MONITOR_STARTED = False


def _log_path(project_id: str) -> Path:
    return _data_dir() / "logs" / f"{project_id}.log"


def _rotate_log(path: Path) -> None:
    try:
        if path.exists() and path.stat().st_size > LOG_MAX_BYTES:
            backup = path.with_suffix(".log.1")
            if backup.exists():
                backup.unlink()
            path.rename(backup)
    except OSError:
        pass


def _argv(project: dict[str, Any]) -> list[str]:
    command = str(project.get("command") or "").strip()
    args = [str(a) for a in (project.get("args") or [])]
    if not command:
        raise ValueError("command 为空")
    if IS_WIN and command.lower().endswith((".bat", ".cmd")):
        return ["cmd", "/c", command, *args]
    return [command, *args]


def _pump(run: Running, log_path: Path) -> None:
    """持续读子进程管道。必须有人读，否则缓冲区满会卡死子进程。"""
    stream = run.proc.stdout
    if stream is None:
        return
    _rotate_log(log_path)
    try:
        fh = open(log_path, "a", encoding="utf-8", errors="replace")
    except OSError:
        fh = None
    try:
        for raw in iter(stream.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            run.ring.append(line)
            if fh is not None:
                try:
                    fh.write(line + "\n")
                    fh.flush()
                except OSError:
                    pass
    finally:
        if fh is not None:
            try:
                fh.close()
            except OSError:
                pass
        try:
            stream.close()
        except Exception:
            pass


def _spawn(project: dict[str, Any]) -> Running:
    cwd = project.get("cwd") or project.get("path") or None
    if cwd and not Path(cwd).is_dir():
        raise ValueError(f"工作目录不存在：{cwd}")
    env = dict(os.environ)
    for k, v in (project.get("env") or {}).items():
        env[str(k)] = str(v)

    flags = 0
    if IS_WIN:
        flags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW

    proc = subprocess.Popen(
        _argv(project),
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,
        start_new_session=not IS_WIN,
        creationflags=flags,
    )
    run = Running(project_id=project["id"], proc=proc, pid=proc.pid, started_at=time.time())
    threading.Thread(target=_pump, args=(run, _log_path(project["id"])), daemon=True, name=f"pb-pump-{proc.pid}").start()
    return run


def _reap(project_id: str) -> Optional[dict[str, Any]]:
    with _RUN_LOCK:
        run = _RUNNING.get(project_id)
        if run is None:
            return None
        code = run.proc.poll()
        if code is None:
            return None
        _RUNNING.pop(project_id, None)
        info = {"exit_code": code, "at": time.time(), "intentional": run.stopping, "restarts": run.restarts}
        _LAST[project_id] = info
        return info


def _terminate(run: Running, timeout: float = 8.0) -> int:
    run.stopping = True
    proc = run.proc
    if proc.poll() is not None:
        return proc.returncode or 0

    if IS_WIN:
        try:
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        except Exception:
            pass
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:
            pass

    try:
        proc.wait(timeout)
    except subprocess.TimeoutExpired:
        if IS_WIN:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                creationflags=CREATE_NO_WINDOW,
            )
        else:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                pass
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            pass
    return proc.returncode if proc.returncode is not None else -1


def _health(project: dict[str, Any]) -> Optional[bool]:
    url = (project.get("health_url") or "").strip()
    port = project.get("port")
    if not url and not port:
        return None
    key = project["id"]
    now = time.time()
    cached = _HEALTH_CACHE.get(key)
    if cached and now - cached[0] < 3.0:
        return cached[1]

    ok = False
    if url:
        try:
            parsed = urlparse(url)
            host = parsed.hostname or "127.0.0.1"
            p = parsed.port or (443 if parsed.scheme == "https" else 80)
            with socket.create_connection((host, p), timeout=1.0):
                ok = True
        except OSError:
            ok = False
    elif port:
        try:
            with socket.create_connection(("127.0.0.1", int(port)), timeout=1.0):
                ok = True
        except (OSError, ValueError):
            ok = False
    _HEALTH_CACHE[key] = (now, ok)
    return ok


def _snapshot(project: dict[str, Any]) -> dict[str, Any]:
    pid = project["id"]
    _reap(pid)
    with _RUN_LOCK:
        run = _RUNNING.get(pid)
    last = _LAST.get(pid) or {}
    if run is not None:
        status = "running"
        health = _health(project)
        if health is False:
            status = "unhealthy"
        out = {
            "id": pid,
            "status": status,
            "pid": run.pid,
            "uptime_s": int(time.time() - run.started_at),
            "health": health,
        }
    else:
        intentional = last.get("intentional", True)
        code = last.get("exit_code")
        if not last:
            status = "stopped"
        elif code == 0 or intentional:
            status = "stopped"
        else:
            status = "crashed"
        out = {"id": pid, "status": status, "pid": None, "uptime_s": 0, "health": None,
               "exit_code": code, "exited_at": last.get("at")}
    merged = {**{k: v for k, v in project.items() if k != "env"}, **out}
    merged["env_keys"] = sorted((project.get("env") or {}).keys())
    return merged


def _monitor() -> None:
    """auto_restart：异常退出后按退避重拉，最多 5 次。"""
    while True:
        time.sleep(2.0)
        try:
            for project in _load_projects():
                if not project.get("auto_restart"):
                    continue
                pid = project["id"]
                if pid in _RUNNING:
                    continue
                last = _LAST.get(pid)
                if not last or last.get("intentional"):
                    continue
                if last.get("restarts", 0) >= 5:
                    continue
                time.sleep(min(30.0, 2.0 ** last.get("restarts", 0)))
                try:
                    run = _spawn(project)
                    run.restarts = int(last.get("restarts", 0)) + 1
                    with _RUN_LOCK:
                        _RUNNING[pid] = run
                except Exception:
                    _LAST[pid] = {**last, "restarts": int(last.get("restarts", 0)) + 1, "intentional": False}
        except Exception:
            continue


def _ensure_monitor() -> None:
    global _MONITOR_STARTED
    with _RUN_LOCK:
        if _MONITOR_STARTED:
            return
        _MONITOR_STARTED = True
    threading.Thread(target=_monitor, daemon=True, name="pb-monitor").start()


# ---------------------------------------------------------------------------
# 请求校验
# ---------------------------------------------------------------------------

_ALLOWED = {"name", "path", "command", "args", "cwd", "env", "port", "health_url", "autostart", "auto_restart"}


def _clean(payload: dict[str, Any], *, creating: bool) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("请求体必须是 JSON 对象")
    out: dict[str, Any] = {}
    for key in _ALLOWED:
        if key not in payload:
            continue
        value = payload[key]
        if key == "args":
            if not isinstance(value, list) or not all(isinstance(a, (str, int, float)) for a in value):
                raise ValueError("args 必须是字符串数组")
            out[key] = [str(a) for a in value]
        elif key == "env":
            if not isinstance(value, dict):
                raise ValueError("env 必须是对象")
            out[key] = {str(k): str(v) for k, v in value.items()}
        elif key == "port":
            out[key] = int(value) if value not in (None, "", 0) else None
        elif key in ("autostart", "auto_restart"):
            out[key] = bool(value)
        else:
            out[key] = str(value or "")

    if creating:
        if not out.get("command"):
            raise ValueError("command 必填")
        if not out.get("name"):
            out["name"] = Path(out.get("path") or out["command"]).name or "未命名项目"
    return out


# ---------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------

@router.get("/projects")
def list_projects():
    try:
        _ensure_monitor()
        projects = _load_projects()
        return {"ok": True, "platform": sys.platform, "home": str(_hermes_home()), "projects": [_snapshot(p) for p in projects]}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.post("/projects")
def create_project(payload: dict[str, Any] = Body(default_factory=dict)):
    try:
        data = _clean(payload, creating=True)
        project = {
            "id": uuid.uuid4().hex[:12],
            "created_at": time.time(),
            **data,
        }
        with _STORE_LOCK:
            projects = _load_projects()
            if any(p.get("name") == project["name"] for p in projects):
                project["name"] = f"{project['name']}-{project['id'][:4]}"
            projects.append(project)
            _save_projects(projects)
        return {"ok": True, "project": _snapshot(project)}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.patch("/projects/{project_id}")
def update_project(project_id: str, payload: dict[str, Any] = Body(default_factory=dict)):
    try:
        patch = _clean(payload, creating=False)
        with _STORE_LOCK:
            projects = _load_projects()
            for p in projects:
                if p["id"] == project_id:
                    p.update(patch)
                    _save_projects(projects)
                    return {"ok": True, "project": _snapshot(p)}
        return {"ok": False, "error": "项目不存在"}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.delete("/projects/{project_id}")
def delete_project(project_id: str):
    try:
        with _RUN_LOCK:
            run = _RUNNING.pop(project_id, None)
        if run is not None:
            _terminate(run, timeout=5.0)
        with _STORE_LOCK:
            projects = _load_projects()
            kept = [p for p in projects if p["id"] != project_id]
            if len(kept) == len(projects):
                return {"ok": False, "error": "项目不存在"}
            _save_projects(kept)
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.get("/projects/{project_id}")
def get_project(project_id: str):
    """单个项目的完整配置（含 env）。列表接口出于展示脱敏不返回 env，编辑表单用这个。"""
    try:
        project = _find(project_id)
        if project is None:
            return {"ok": False, "error": "项目不存在"}
        return {"ok": True, "project": project}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.post("/projects/{project_id}/start")
def start_project(project_id: str):
    try:
        _ensure_monitor()
        project = _find(project_id)
        if project is None:
            return {"ok": False, "error": "项目不存在"}
        with _RUN_LOCK:
            if project_id in _RUNNING and _RUNNING[project_id].proc.poll() is None:
                return {"ok": False, "error": "项目已在运行"}
            _reap(project_id)
            run = _spawn(project)
            _RUNNING[project_id] = run
            _LAST.pop(project_id, None)
        time.sleep(0.4)
        return {"ok": True, "project": _snapshot(project)}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.post("/projects/{project_id}/stop")
def stop_project(project_id: str, force: bool = Query(False)):
    try:
        project = _find(project_id)
        if project is None:
            return {"ok": False, "error": "项目不存在"}
        with _RUN_LOCK:
            run = _RUNNING.get(project_id)
        if run is None:
            return {"ok": True, "project": _snapshot(project)}
        _terminate(run, timeout=1.0 if force else 8.0)
        _reap(project_id)
        _LAST.setdefault(project_id, {})["intentional"] = True
        return {"ok": True, "project": _snapshot(project)}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.post("/projects/{project_id}/restart")
def restart_project(project_id: str):
    try:
        project = _find(project_id)
        if project is None:
            return {"ok": False, "error": "项目不存在"}
        with _RUN_LOCK:
            run = _RUNNING.get(project_id)
        if run is not None:
            _terminate(run, timeout=8.0)
            _reap(project_id)
            _LAST.setdefault(project_id, {})["intentional"] = True
        with _RUN_LOCK:
            run = _spawn(project)
            _RUNNING[project_id] = run
            _LAST.pop(project_id, None)
        time.sleep(0.4)
        return {"ok": True, "project": _snapshot(project)}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.get("/projects/{project_id}/logs")
def project_logs(project_id: str, tail: int = Query(200, ge=1, le=2000)):
    try:
        project = _find(project_id)
        if project is None:
            return {"ok": False, "error": "项目不存在"}
        with _RUN_LOCK:
            run = _RUNNING.get(project_id)
        lines: list[str] = list(run.ring)[-tail:] if run is not None else []
        if not lines:
            path = _log_path(project_id)
            if path.exists():
                try:
                    with open(path, "r", encoding="utf-8", errors="replace") as fh:
                        lines = deque(fh, maxlen=tail)  # type: ignore[assignment]
                        lines = list(lines)
                except OSError:
                    lines = []
        return {"ok": True, "lines": lines, "status": _snapshot(project)["status"]}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.post("/projects/{project_id}/clear-log")
def clear_log(project_id: str):
    try:
        path = _log_path(project_id)
        if path.exists():
            path.write_text("", encoding="utf-8")
        with _RUN_LOCK:
            run = _RUNNING.get(project_id)
        if run is not None:
            run.ring.clear()
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.get("/system")
def system_info():
    """给前端做路径提示 / 端口预检用的轻量信息。"""
    try:
        info = {"platform": sys.platform, "python": sys.version.split()[0], "home": str(_hermes_home())}
        if IS_WIN:
            info["taskkill"] = shutil.which("taskkill") is not None
        return {"ok": True, **info}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.websocket("/events")
async def events(ws: WebSocket):
    try:
        from hermes_cli.web_server_chat import _ws_auth_ok  # 与 kanban 同一把锁

        if not _ws_auth_ok(ws):
            await ws.close(code=1008)
            return
    except Exception:
        pass
    await ws.accept()
    try:
        while True:
            projects = _load_projects()
            await ws.send_json({"type": "status", "projects": [_snapshot(p) for p in projects]})
            await _async_sleep(1.0)
    except WebSocketDisconnect:
        return
    except Exception:
        try:
            await ws.close()
        except Exception:
            pass


async def _async_sleep(seconds: float) -> None:
    import asyncio

    await asyncio.sleep(seconds)
