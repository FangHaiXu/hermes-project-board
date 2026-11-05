/**
 * 项目看板 — Hermes Desktop 运行时插件（纯 ESM，jsx() 调用，不需要构建）。
 *
 * 安装位置：<HERMES_HOME>/desktop-plugins/project-board/plugin.js
 *   （统一包形态：<HERMES_HOME>/plugins/project-board/desktop/plugin.js，
 *     启动时会被自动复制到上面那个目录）
 *
 * 后端：同包的 dashboard/plugin_api.py，挂载在 /api/plugins/project-board/
 * 通过 ctx.rest 访问（命名空间由宿主保证，不用自己拼 URL 或 token）。
 *
 * 只允许 import：@hermes/plugin-sdk、react、react/jsx-runtime。
 */

import { cn, host, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS, Tip } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// ---------------------------------------------------------------------------
// 数据层
// ---------------------------------------------------------------------------

let rest = null
let pluginOs = null

function api(path, opts) {
  if (!rest) {
    return Promise.reject(new Error('项目看板：插件上下文尚未就绪'))
  }
  return rest(path, opts)
}

async function act(path, opts) {
  const res = await api(path, opts)
  if (!res || res.ok === false) {
    throw new Error((res && res.error) || '操作失败')
  }
  return res
}

const STATUS = {
  running: { label: '运行中', color: '#3fb950' },
  unhealthy: { label: '端口不通', color: '#d29922' },
  stopped: { label: '已停止', color: '#8b949e' },
  crashed: { label: '已崩溃', color: '#f85149' },
  starting: { label: '启动中', color: '#58a6ff' }
}

function useProjects(intervalMs = 2000) {
  const [state, setState] = useState({ loading: true, projects: [], error: null })

  useEffect(() => {
    let alive = true

    const tick = async () => {
      try {
        const res = await api('/projects')
        if (!alive) {
          return
        }
        if (!res || res.ok === false) {
          throw new Error((res && res.error) || '加载失败')
        }
        setState({ loading: false, projects: res.projects || [], error: null })
      } catch (err) {
        if (alive) {
          setState(s => ({ ...s, loading: false, error: String((err && err.message) || err) }))
        }
      }
    }

    tick()
    const timer = setInterval(tick, intervalMs)

    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [intervalMs])

  return state
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function fmtUptime(seconds) {
  const s = Math.max(0, Number(seconds) || 0)
  if (s < 60) {
    return `${s}s`
  }
  const m = Math.floor(s / 60)
  if (m < 60) {
    return `${m}m ${s % 60}s`
  }
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** 带引号的空格切分：`--flag "a b"` → ['--flag', 'a b'] */
function splitArgs(text) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m

  while ((m = re.exec(text || '')) !== null) {
    out.push(m[1] ?? m[2] ?? m[3])
  }

  return out
}

/** 参数数组 → 输入框文本（含空格的参数自动加引号） */
function argsToText(args) {
  return (args || []).map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
}

/** 环境变量对象 → KEY=VALUE 多行文本 */
function envToText(env) {
  return Object.entries(env || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

/** 拉取单个项目的完整配置（含 env）。旧后端没有这个路由时返回 null。 */
async function fetchProject(id) {
  try {
    const res = await api(`/projects/${id}`)
    return res && res.ok !== false && res.project ? res.project : null
  } catch {
    return null
  }
}

const BTN =
  'inline-flex h-7 items-center gap-1 rounded-md border border-(--ui-border) px-2 text-[0.75rem] ' +
  'transition-colors hover:bg-(--chrome-action-hover) disabled:opacity-40 disabled:hover:bg-transparent'

const BTN_PRIMARY =
  'inline-flex h-7 items-center gap-1 rounded-md bg-(--ui-accent) px-2.5 text-[0.75rem] font-medium ' +
  'text-white transition-opacity hover:opacity-90 disabled:opacity-40'

const INPUT =
  'h-8 w-full rounded-md border border-(--ui-border) bg-(--ui-bg-elevated) px-2 text-[0.8125rem] ' +
  'outline-none focus:border-(--ui-accent)'

function StatusPill({ status }) {
  const meta = STATUS[status] || STATUS.stopped

  return jsxs('span', {
    className: 'inline-flex items-center gap-1.5 rounded-full border border-(--ui-border) px-2 py-0.5 text-[0.6875rem]',
    children: [
      jsx('span', {
        'aria-hidden': true,
        style: { background: meta.color, borderRadius: '9999px', display: 'inline-block', height: '6px', width: '6px' }
      }),
      jsx('span', { children: meta.label })
    ]
  })
}

function Field({ children, label }) {
  return jsxs('label', {
    className: 'flex flex-col gap-1 text-[0.6875rem] text-(--ui-text-tertiary)',
    children: [jsx('span', { children: label }), children]
  })
}

// ---------------------------------------------------------------------------
// 添加项目
// ---------------------------------------------------------------------------

function ProjectForm({ initial, note, submitLabel, onCancel, onSubmit }) {
  const [form, setForm] = useState({
    name: (initial && initial.name) || '',
    path: (initial && initial.path) || '',
    command: (initial && initial.command) || '',
    args: argsToText(initial && initial.args),
    cwd: (initial && initial.cwd) || '',
    port: initial && initial.port ? String(initial.port) : '',
    health_url: (initial && initial.health_url) || '',
    env: envToText(initial && initial.env),
    auto_restart: Boolean(initial && initial.auto_restart)
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const set = (key, value) => setForm(f => ({ ...f, [key]: value }))

  const pick = async () => {
    const picked = await pluginOs?.pickOpenPath?.({ title: '选择项目目录' })
    if (picked) {
      set('path', picked)
    }
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const env = {}
      for (const line of (form.env || '').split('\n')) {
        const idx = line.indexOf('=')

        if (idx > 0) {
          env[line.slice(0, idx).trim()] = line.slice(idx + 1)
        }
      }
      await onSubmit({
        name: form.name.trim(),
        path: form.path.trim(),
        command: form.command.trim(),
        args: splitArgs(form.args),
        cwd: form.cwd.trim() || form.path.trim(),
        port: form.port ? Number(form.port) : null,
        health_url: form.health_url.trim(),
        env,
        auto_restart: Boolean(form.auto_restart)
      })
    } catch (err) {
      setError(String((err && err.message) || err))
    } finally {
      setBusy(false)
    }
  }

  return jsxs('div', {
    className: 'rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-3',
    children: [
      jsxs('div', {
        className: 'grid grid-cols-2 gap-2',
        children: [
          jsx(Field, { label: '名称', children: jsx('input', { className: INPUT, onChange: e => set('name', e.target.value), placeholder: '我的 API 服务', value: form.name }) }),
          jsx(Field, {
            label: '项目目录',
            children: jsxs('div', {
              className: 'flex gap-1',
              children: [
                jsx('input', { className: INPUT, onChange: e => set('path', e.target.value), placeholder: 'D:\\work\\my-api', value: form.path }),
                jsx('button', { className: BTN, onClick: pick, type: 'button', children: '选择…' })
              ]
            })
          }),
          jsx(Field, { label: '启动命令（可执行文件）', children: jsx('input', { className: INPUT, onChange: e => set('command', e.target.value), placeholder: 'npm  或  python 或  D:\\app\\run.bat', value: form.command }) }),
          jsx(Field, { label: '参数（空格分隔，支持引号）', children: jsx('input', { className: INPUT, onChange: e => set('args', e.target.value), placeholder: 'run dev', value: form.args }) }),
          jsx(Field, { label: '端口（可选，用于健康探测）', children: jsx('input', { className: INPUT, onChange: e => set('port', e.target.value), placeholder: '3000', value: form.port }) }),
          jsx(Field, { label: '健康检查 URL（可选）', children: jsx('input', { className: INPUT, onChange: e => set('health_url', e.target.value), placeholder: 'http://127.0.0.1:3000/health', value: form.health_url }) })
        ]
      }),
      jsx('div', {
        className: 'mt-2',
        children: jsx(Field, {
          label: '环境变量（每行 KEY=VALUE，可选）',
          children: jsx('textarea', {
            className: cn(INPUT, 'h-16 py-1 font-mono text-[0.75rem]'),
            onChange: e => set('env', e.target.value),
            placeholder: 'NODE_ENV=development',
            value: form.env
          })
        })
      }),
      jsxs('div', {
        className: 'mt-2 flex items-center justify-between',
        children: [
          jsxs('label', {
            className: 'flex items-center gap-1.5 text-[0.75rem] text-(--ui-text-secondary)',
            children: [
              jsx('input', { checked: form.auto_restart, onChange: e => set('auto_restart', e.target.checked), type: 'checkbox' }),
              jsx('span', { children: '崩溃后自动重启（最多 5 次，指数退避）' })
            ]
          }),
          jsxs('div', {
            className: 'flex gap-1.5',
            children: [
              jsx('button', { className: BTN, onClick: onCancel, type: 'button', children: '取消' }),
              jsx('button', { className: BTN_PRIMARY, disabled: busy || !form.command.trim(), onClick: submit, type: 'button', children: busy ? '保存中…' : (submitLabel || '保存') })
            ]
          })
        ]
      }),
      note
        ? jsx('div', { className: 'mt-2 text-[0.75rem] text-(--ui-warning, #d29922)', children: note })
        : null,
      error
        ? jsx('div', { className: 'mt-2 text-[0.75rem] text-(--ui-danger)', children: error })
        : null
    ]
  })
}

// ---------------------------------------------------------------------------
// 日志面板
// ---------------------------------------------------------------------------

function LogPanel({ project, onClose }) {
  const [lines, setLines] = useState([])
  const [error, setError] = useState(null)
  const boxRef = useRef(null)

  useEffect(() => {
    let alive = true

    const tick = async () => {
      try {
        const res = await api(`/projects/${project.id}/logs?tail=400`)
        if (!alive) {
          return
        }
        if (!res || res.ok === false) {
          throw new Error((res && res.error) || '读取日志失败')
        }
        setLines(res.lines || [])
        setError(null)
      } catch (err) {
        if (alive) {
          setError(String((err && err.message) || err))
        }
      }
    }

    tick()
    const timer = setInterval(tick, 1500)

    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [project.id])

  useEffect(() => {
    const el = boxRef.current

    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [lines])

  const clear = async () => {
    try {
      await act(`/projects/${project.id}/clear-log`, { method: 'POST' })
      setLines([])
    } catch (err) {
      setError(String((err && err.message) || err))
    }
  }

  return jsxs('div', {
    className: 'mt-2 rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated)',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between border-b border-(--ui-border) px-2 py-1',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-2 text-[0.75rem] text-(--ui-text-secondary)',
            children: [
              jsx('span', { children: `日志 · ${project.name}` }),
              jsx('span', { className: 'text-(--ui-text-tertiary)', children: `${lines.length} 行` })
            ]
          }),
          jsxs('div', {
            className: 'flex gap-1.5',
            children: [
              jsx('button', { className: BTN, onClick: clear, type: 'button', children: '清空' }),
              jsx('button', { className: BTN, onClick: onClose, type: 'button', children: '收起' })
            ]
          })
        ]
      }),
      error ? jsx('div', { className: 'px-2 py-1 text-[0.75rem] text-(--ui-danger)', children: error }) : null,
      jsx('pre', {
        ref: boxRef,
        className: 'max-h-72 overflow-auto whitespace-pre-wrap px-2 py-1.5 font-mono text-[0.6875rem] leading-5 text-(--ui-text-secondary)',
        children: lines.length ? lines.join('\n') : '（暂无输出）'
      })
    ]
  })
}

// ---------------------------------------------------------------------------
// 项目卡片
// ---------------------------------------------------------------------------

function ProjectCard({ project, onChanged, onEdit }) {
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [showLogs, setShowLogs] = useState(false)
  const running = project.status === 'running' || project.status === 'unhealthy'

  const run = async (label, path, opts) => {
    setBusy(label)
    setError(null)
    try {
      await act(path, opts)
      await onChanged()
    } catch (err) {
      setError(String((err && err.message) || err))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!window.confirm(`从看板移除「${project.name}」？\n（只删记录，不动磁盘文件）`)) {
      return
    }
    await run('delete', `/projects/${project.id}`, { method: 'DELETE' })
  }

  return jsxs('div', {
    className: 'rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) px-3 py-2',
    children: [
      jsxs('div', {
        className: 'flex items-start justify-between gap-3',
        children: [
          jsxs('div', {
            className: 'min-w-0',
            children: [
              jsxs('div', {
                className: 'flex items-center gap-2',
                children: [
                  jsx('span', { className: 'truncate text-[0.8125rem] font-medium', children: project.name }),
                  jsx(StatusPill, { status: project.status })
                ]
              }),
              jsx('div', {
                className: 'mt-0.5 truncate font-mono text-[0.6875rem] text-(--ui-text-tertiary)',
                children: project.cwd || project.path || '—'
              }),
              jsxs('div', {
                className: 'mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-(--ui-text-tertiary)',
                children: [
                  jsx('span', { children: project.command ? `${project.command} ${(project.args || []).join(' ')}`.trim() : '—' }),
                  project.pid ? jsx('span', { children: `PID ${project.pid}` }) : null,
                  running ? jsx('span', { children: `已运行 ${fmtUptime(project.uptime_s)}` }) : null,
                  project.port ? jsx('span', { children: `端口 ${project.port}` }) : null,
                  project.exit_code !== undefined && project.exit_code !== null && !running
                    ? jsx('span', { children: `退出码 ${project.exit_code}` })
                    : null,
                  project.auto_restart ? jsx('span', { children: '自动重启' }) : null
                ]
              })
            ]
          }),
          jsxs('div', {
            className: 'flex shrink-0 flex-wrap justify-end gap-1.5',
            children: [
              running
                ? jsx('button', { className: BTN, disabled: Boolean(busy), onClick: () => run('stop', `/projects/${project.id}/stop`, { method: 'POST' }), type: 'button', children: busy === 'stop' ? '停止中…' : '停止' })
                : jsx('button', { className: BTN_PRIMARY, disabled: Boolean(busy), onClick: () => run('start', `/projects/${project.id}/start`, { method: 'POST' }), type: 'button', children: busy === 'start' ? '启动中…' : '启动' }),
              jsx('button', { className: BTN, disabled: Boolean(busy), onClick: () => run('restart', `/projects/${project.id}/restart`, { method: 'POST' }), type: 'button', children: busy === 'restart' ? '重启中…' : '重启' }),
              jsx('button', { className: BTN, onClick: () => setShowLogs(v => !v), type: 'button', children: showLogs ? '隐藏日志' : '日志' }),
              jsx('button', { className: BTN, onClick: () => onEdit(project), type: 'button', children: '编辑' }),
              jsx('button', { className: cn(BTN, 'text-(--ui-danger)'), disabled: Boolean(busy), onClick: remove, type: 'button', children: '移除' })
            ]
          })
        ]
      }),
      error ? jsx('div', { className: 'mt-1.5 text-[0.75rem] text-(--ui-danger)', children: error }) : null,
      showLogs ? jsx(LogPanel, { onClose: () => setShowLogs(false), project }) : null
    ]
  })
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

function ProjectBoardPage() {
  const { loading, projects, error } = useProjects(2000)
  const [adding, setAdding] = useState(false)
  const [editor, setEditor] = useState(null)
  const [manual, setManual] = useState(0)

  const bump = () => setManual(v => v + 1)

  const startEdit = async project => {
    setAdding(false)
    setEditor({ project, initial: project, note: null })

    const full = await fetchProject(project.id)

    if (full) {
      setEditor(e => (e && e.project.id === project.id ? { ...e, initial: full } : e))
    } else {
      setEditor(e => (e && e.project.id === project.id
        ? { ...e, note: '环境变量暂时带不出来（后端还没有单项目查询接口，重启一次应用后就有了），其他字段已填好。' }
        : e))
    }
  }

  const saveEdit = async values => {
    await act(`/projects/${editor.project.id}`, { body: values, method: 'PATCH' })
    setEditor(null)
    bump()
  }

  const running = projects.filter(p => p.status === 'running' || p.status === 'unhealthy').length

  return jsxs('div', {
    className: 'mx-auto flex h-full w-full max-w-4xl flex-col gap-3 overflow-auto p-4',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between',
        children: [
          jsxs('div', {
            children: [
              jsx('div', { className: 'text-[0.9375rem] font-semibold', children: '项目看板' }),
              jsx('div', {
                className: 'mt-0.5 text-[0.75rem] text-(--ui-text-tertiary)',
                children: `共 ${projects.length} 个项目 · ${running} 个在运行`
              })
            ]
          }),
          jsxs('div', {
            className: 'flex gap-1.5',
            children: [
              jsx('button', { className: BTN, onClick: () => setManual(v => v + 1), type: 'button', children: '刷新' }),
              jsx('button', { className: BTN_PRIMARY, onClick: () => setAdding(v => !v), type: 'button', children: adding ? '关闭' : '+ 添加项目' })
            ]
          })
        ]
      }),
      editor
        ? jsxs('div', {
            className: 'rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-3',
            children: [
              jsx('div', { className: 'text-[0.8125rem] font-medium', children: `编辑项目：${editor.project.name}` }),
              jsx('div', {
                className: 'mb-2 mt-0.5 text-[0.6875rem] text-(--ui-text-tertiary)',
                children: '保存后正在运行的进程不受影响，下次启动 / 重启时生效。'
              }),
              jsx(ProjectForm, {
                initial: editor.initial,
                note: editor.note,
                submitLabel: '保存修改',
                onCancel: () => setEditor(null),
                onSubmit: saveEdit
              })
            ]
          })
        : null,
      adding
        ? jsx(ProjectForm, {
            submitLabel: '添加到看板',
            onCancel: () => setAdding(false),
            onSubmit: async values => {
              await act('/projects', { body: values, method: 'POST' })
              setAdding(false)
              bump()
            }
          })
        : null,
      error ? jsx('div', { className: 'rounded-md border border-(--ui-border) px-3 py-2 text-[0.75rem] text-(--ui-danger)', children: error }) : null,
      loading && projects.length === 0
        ? jsx('div', { className: 'py-8 text-center text-[0.8125rem] text-(--ui-text-tertiary)', children: '加载中…' })
        : projects.length === 0
          ? jsxs('div', {
              className: 'rounded-lg border border-dashed border-(--ui-border) px-4 py-10 text-center',
              children: [
                jsx('div', { className: 'text-[0.875rem] font-medium', children: '看板还是空的' }),
                jsx('div', {
                  className: 'mt-1 text-[0.75rem] text-(--ui-text-tertiary)',
                  children: '把常用项目的启动命令加进来，之后就能一键启动 / 停止 / 重启并查看日志。'
                }),
                jsx('button', { className: cn(BTN_PRIMARY, 'mt-3'), onClick: () => setAdding(true), type: 'button', children: '+ 添加第一个项目' })
              ]
            })
          : jsx('div', {
              className: 'flex flex-col gap-2',
              children: projects.map(p => jsx(ProjectCard, { key: p.id, onChanged: bump, onEdit: startEdit, project: p }))
            }),
      jsx('div', {
        className: 'pb-2 pt-1 text-[0.6875rem] text-(--ui-text-tertiary)',
        children: '提示：启动命令以参数数组执行，不经过 shell；停止会先发 CTRL_BREAK，超时后 taskkill /T /F 结束整棵进程树。'
      })
    ]
  })
}

// 状态栏：有项目在跑时才出现
function RunningChip() {
  const { projects } = useProjects(5000)
  const running = projects.filter(p => p.status === 'running' || p.status === 'unhealthy')

  if (running.length === 0) {
    return null
  }

  return jsx(Tip, {
    label: `${running.length} 个项目在运行：${running.map(p => p.name).join('、')}`,
    children: jsx('button', {
      className: 'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)',
      onClick: () => host.navigate('/project-board'),
      type: 'button',
      children: jsxs('span', {
        children: [jsx('span', { 'aria-hidden': true, children: '▶' }), jsx('span', { children: String(running.length) })]
      })
    })
  })
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export default {
  id: 'project-board',
  name: '项目看板',
  description: '把本机项目加入看板，一键启动 / 停止 / 重启，实时查看日志。',
  defaultEnabled: true,
  register(ctx) {
    rest = ctx.rest
    pluginOs = ctx.os

    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      title: '项目看板',
      data: { path: '/project-board' },
      render: () => jsx(ProjectBoardPage, {})
    })

    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { codicon: 'rocket', label: '项目看板', path: '/project-board' }
    })

    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 118,
      render: () => jsx(RunningChip, {})
    })
  }
}
