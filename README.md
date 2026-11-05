# hermes-project-board · 项目看板

一个 [Hermes Agent](https://hermes-agent.nousresearch.com) 桌面插件：把本机常用项目加进看板，
一键 **启动 / 停止 / 重启**，实时查看日志，崩溃可自动拉起。Windows 优先实现（macOS / Linux 也可用）。

**A Hermes Desktop plugin that turns your local projects into a board: start / stop / restart with one
click, live logs, auto-restart on crash.**

## 功能

- 🚀 **一键启停**：启动 / 停止 / 重启，重复启动有锁，不会起两份
- ✏️ **在线编辑**：改命令、参数、端口、环境变量，保存后下次启动生效
- 📜 **实时日志**：内存环形缓冲（800 行）+ 落盘文件（5 MB 轮转），面板内直接看
- 🩺 **状态四档**：`运行中` / `端口不通`（端口或健康检查 URL 探测失败）/ `已停止` / `已崩溃`
- 🔁 **崩溃自动重启**：指数退避（2^n 秒），最多 5 次
- ⚡ **状态栏速览**：有项目在跑时，右下角出现 `▶ N`，点一下直达看板
- 🎯 **进程树级停止**：Windows 下先 `CTRL_BREAK`，8 秒不退再 `taskkill /T /F`

## 安装

### 方式一：插件 CLI（推荐）

```bash
hermes plugins install <你的GitHub用户名>/hermes-project-board --enable
```

装完在 **设置 → 插件** 里把「项目看板」打开（桌面半区默认 opt-in，和官方插件一致）。

### 方式二：手动安装

```bash
# 1) 克隆到 Hermes 插件目录
git clone https://github.com/<你的GitHub用户名>/hermes-project-board.git \
    "$HERMES_HOME/plugins/project-board"

# 2) 授权后端 import（user 插件必须进 plugins.enabled）
hermes plugins enable project-board

# 3) 把桌面 UI 复制到 desktop-plugins 根目录
mkdir -p "$HERMES_HOME/desktop-plugins/project-board"
cp "$HERMES_HOME/plugins/project-board/desktop/plugin.js" \
   "$HERMES_HOME/desktop-plugins/project-board/plugin.js"

# 4) 重启 Hermes Desktop，侧边栏出现「项目看板」
```

> `$HERMES_HOME` 默认是 `~/.hermes`（Windows：`%USERPROFILE%\.hermes`）。
> 手动方式装的是"独立桌面插件"，默认开启，不用再去设置里翻开关。

## 使用

| 操作 | 说明 |
|---|---|
| 添加项目 | `+ 添加项目` → 「选择…」调系统目录选择器 → 填命令和参数 |
| 编辑 | 卡片上的 **编辑** 按钮；保存不影响运行中的进程，下次启动 / 重启生效 |
| 启动 / 停止 / 重启 | 卡片按钮；停止先礼后兵，`?force=1` 直接强杀 |
| 日志 | 卡片上的 **日志** 按钮，1.5 秒刷新，支持清空 |
| 删除 | **移除** 只删记录，不动磁盘文件 |

### 添加字段

| 字段 | 说明 |
|---|---|
| 启动命令 | 可执行文件；`.bat/.cmd` 自动走 `cmd /c`；**参数数组执行，不经 shell** |
| 参数 | 空格分隔，含空格的参数用引号包起来：`--flag "a b"` |
| 端口 | 可选；用于「端口不通」健康探测 |
| 健康检查 URL | 可选；配置后以 TCP 连通性判断健康 |
| 环境变量 | 每行 `KEY=VALUE`，叠加在系统环境之上 |
| 自动重启 | 崩溃后按 2^n 秒退避重拉，最多 5 次 |

## API

挂载在 `/api/plugins/project-board/`（鉴权与官方插件一致）：

```
GET    /projects                      # 全部项目 + 运行态快照
GET    /projects/{id}                 # 单个项目完整配置（含 env）
POST   /projects                      # 新增
PATCH  /projects/{id}                 # 编辑
DELETE /projects/{id}                 # 先停再删记录
POST   /projects/{id}/start           # 启动
POST   /projects/{id}/stop?force=1    # 停止（force 强杀）
POST   /projects/{id}/restart         # 重启
GET    /projects/{id}/logs?tail=400   # 日志尾部
POST   /projects/{id}/clear-log       # 清空日志
GET    /system                        # 平台信息
WS     /events                        # 每秒推状态快照
```

## 安全与已知限制

- 命令以**参数数组**执行（`shell=False`），不做字符串拼接；本插件等价于本机任意代码执行入口，不要把 dashboard 暴露到公网
- 只支持本机进程；远程主机需要 Runner 抽象 + SSH 执行器（欢迎 PR）
- 插件重载后，仍在跑的进程会显示为「已停止」（内存运行态丢失）；PID 落盘校验在 roadmap 里
- 日志是纯文本，不解析 ANSI 颜色

## 开发

```bash
# 生命周期自检（真实拉起子进程：启动→日志→重复启动拦截→停止→重启→删除）
python tests/test_api.py
```

目录结构：

```
├── plugin.yaml               # 插件元数据
├── dashboard/
│   ├── manifest.json         # 声明 api=plugin_api.py
│   ├── plugin_api.py         # FastAPI 路由 + 进程管理器
│   └── dist/index.js         # Web 控制台占位入口
├── desktop/
│   └── plugin.js             # Desktop 运行时插件（纯 ESM + jsx()，免构建）
└── tests/
    └── test_api.py
```

## License

[MIT](LICENSE)
