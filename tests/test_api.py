"""项目看板后端自检：真实拉起一个子进程，验证 启动/日志/重复启动/停止/重启/删除。

跑法（Windows，Hermes 自带 Python）：
    set HERMES_HOME=%TEMP%\\pb-test && python -m pytest tests\\test_api.py -q
或直接当脚本：
    python tests\\test_api.py
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
API = HERE.parent / "dashboard" / "plugin_api.py"

CHILD = "import time,sys\nfor i in range(3):\n    print('tick', i)\n    sys.stdout.flush()\n    time.sleep(0.3)\ntime.sleep(60)"


def load(tmp_home: pathlib.Path):
    import os

    os.environ["HERMES_HOME"] = str(tmp_home)
    spec = importlib.util.spec_from_file_location("pb_api_under_test", API)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["pb_api_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_lifecycle(tmp_path):
    m = load(tmp_path)

    created = m.create_project(
        {"name": "demo", "path": str(HERE), "command": sys.executable, "args": ["-u", "-c", CHILD]}
    )
    assert created["ok"], created
    pid = created["project"]["id"]

    assert m.start_project(pid)["ok"]
    time.sleep(1.2)
    snap = m._snapshot(m._find(pid))
    assert snap["status"] == "running"
    assert snap["pid"]

    logs = m.project_logs(pid, 50)
    assert logs["ok"] and any("tick" in line for line in logs["lines"])

    dup = m.start_project(pid)
    assert dup["ok"] is False and "已在运行" in dup["error"]

    assert m.stop_project(pid)["ok"]
    assert m._snapshot(m._find(pid))["status"] == "stopped"

    assert m.restart_project(pid)["ok"]
    time.sleep(0.6)
    assert m._snapshot(m._find(pid))["status"] == "running"

    assert m.stop_project(pid, force=True)["ok"]
    assert m.delete_project(pid)["ok"]
    assert m.list_projects()["projects"] == []


def test_rejects_empty_command(tmp_path):
    m = load(tmp_path)
    res = m.create_project({"name": "bad", "command": ""})
    assert res["ok"] is False and "command" in res["error"]


def test_missing_project(tmp_path):
    m = load(tmp_path)
    assert m.start_project("nope")["ok"] is False
    assert m.delete_project("nope")["ok"] is False


if __name__ == "__main__":
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        test_lifecycle(pathlib.Path(tmp))
        test_rejects_empty_command(pathlib.Path(tmp) / "a")
        test_missing_project(pathlib.Path(tmp) / "b")
    print("all checks passed")
