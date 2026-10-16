<div align="center">
  <img src="public/logo.svg" alt="Claude GUI" width="64" height="64">
  <h1>Claude GUI</h1>
  <p>为本地 AI 编程 CLI 打造的桌面工作区。<br>把项目、对话和模型选择放在一个界面里。</p>
  <p>
    <a href="https://github.com/woai66/Claude-code-GUI/releases">下载与发布</a> ·
    <a href="https://github.com/woai66/Claude-code-GUI/issues">问题反馈</a> ·
    <a href="#开发与验证">开发说明</a>
  </p>
</div>

Claude GUI 是基于 **[CloudCLI UI (https://github.com/siteboon/claudecodeui)](https://github.com/siteboon/claudecodeui)** 持续二次开发的个人维护版本，重点面向 Windows 本地桌面使用。项目围绕 Claude Code、Codex 和 Cursor CLI 的日常使用重新整理了界面、会话管理和模型设置。

安装后直接进入本地工作区，无需 Cloud 服务账户；在同一个项目目录里，可以选择不同 CLI 创建各自的对话。AI 服务使用你已有的 CLI 登录、订阅或 API 配置。

## 主要功能

| 功能 | 当前体验 |
| --- | --- |
| 项目与对话管理 | 自动发现已有 CLI 会话，按 Agent 筛选项目、对话、运行中会话和归档 |
| 简洁的侧边栏 | 顶部统一新建会话入口，展开项目查看历史对话 |
| 本地目录操作 | 桌面版使用系统目录选择窗口，也可将文件夹拖入新建项目窗口 |
| 动态模型库 | 从 CLI 获取模型列表，缓存结果供各模型选择器使用；刷新时保留自定义模型 |
| CLI 会话衔接 | 在 GUI 继续已有对话；Windows 桌面版可在 PowerShell 中恢复 Claude 会话 |
| 项目工具 | 文件浏览与编辑、Git 操作、内置终端，以及对话导出等功能 |

### 各 CLI 的模型与模式

| CLI | 模型与参数 |
| --- | --- |
| Claude Code | 动态读取模型，识别已有会话的模型和权限模式，兼容原生 `auto` 权限模式 |
| Codex | 通过本机 CLI 获取模型及其思考等级；独立提供 Fast 开关和「跟随 CLI 设置」，按会话保存速度选择 |
| Cursor CLI | 将同一模型的已识别变体合并展示，按实际返回的组合选择思考等级、上下文、Thinking 或 Fast |

Codex 和 Cursor 的模型列表来自 CLI 查询，不维护固定模型预设。Cursor 的参数选择最终对应 CLI 返回的真实模型 ID；界面仅展示当前模型实际支持的选项。

## 开始使用

### 1. 准备 CLI

先安装并登录你要使用的 CLI，确认它能在本机终端中正常运行。只需要配置实际使用的提供商。

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://developers.openai.com/codex)
- [Cursor CLI](https://docs.cursor.com/en/cli/overview)

Claude GUI 管理本地工作区和 CLI 会话，模型访问权限与用量由对应服务及账户决定。

### 2. 安装 Windows 桌面版

在本仓库的 [Releases](https://github.com/woai66/Claude-code-GUI/releases) 查看已发布的 Windows `.exe` 附件。尚未发布的版本可以从源码构建。

安装并启动 **Claude GUI**，即可打开内置的本地页面。桌面版包含应用运行时、前端和本地后端，无需全局安装本项目的 npm 包，也无需另外启动 Web 服务。

从源码构建需要 **Node.js 22+、npm 和 Git**，在 Windows PowerShell 中执行：

```powershell
git clone https://github.com/woai66/Claude-code-GUI.git
cd Claude-code-GUI
npm ci
npm run desktop:dist:win -- --publish never
```

安装包输出到 `release/desktop/`，文件名形如 `claude-gui-1.37.4-win-x64.exe`。首次构建会下载 Electron 并准备原生依赖，需要联网。

### 3. 添加项目并开始对话

1. 新建项目，选择本地目录；桌面版也可以从资源管理器拖入一个文件夹。
2. 通过侧边栏顶部的「新建会话」选择项目和 CLI，或打开已有对话继续。
3. 打开「模型库」，选择提供商并点击「获取模型列表」。已有缓存时可以手动刷新。
4. 在输入区的模型菜单中选择模型和可用参数，再发送消息。

CLI 更新或账户模型权限变化后，可再次获取模型列表，无需逐个手动添加。自定义模型仍可作为补充保留。

## 常用操作

### Codex Fast

打开输入区的模型菜单，使用 **Fast** 开关设置速度。关闭开关会明确使用标准速度；选择「跟随 CLI 设置」则由原生 CLI 配置和恢复行为决定。速度与模型、思考等级分别设置，并按会话保存。

Fast 的可用性取决于模型与账户，开启后会消耗更多额度。

### Cursor 模型参数

先选择模型，再按需调整思考等级、上下文或速度。同一模型的变体集中在一个模型条目下，避免长列表重复展示。

只有一种已知上下文容量时直接显示容量；存在多个容量时提供选择。参数切换会匹配真实存在的 CLI 模型变体，自定义模型保持独立条目。

### 在 PowerShell 中恢复 Claude 对话

在 Windows 桌面版的 Claude 对话菜单中选择恢复入口，即可在该项目目录打开 PowerShell，并执行对应会话的 `claude --resume`。

这是主动打开的交互终端；目录浏览和获取模型列表等后台操作会隐藏命令窗口。

## 使用浏览器访问

也可以直接从本仓库运行 Web 版本。获取源码并执行 `npm ci` 后，在仓库根目录运行：

```powershell
npm run build
npm run server
```

默认访问 [http://localhost:3001](http://localhost:3001)。浏览器模式使用页面提供的本地认证流程；系统目录选择和 PowerShell 恢复入口属于桌面版能力。

需要自定义端口或限制为本机访问时，可参考 [.env.example](.env.example)，在仓库根目录的 `.env` 中设置：

```dotenv
HOST=127.0.0.1
SERVER_PORT=3001
VITE_PORT=5173
```

桌面版自行管理本地服务，默认使用本机 `3001` 端口，端口被占用时会选择可用端口。

## 开发与验证

前端使用 **React、TypeScript、Vite 和 Tailwind CSS**，后端使用 **Node.js、Express、WebSocket 和 SQLite**。桌面壳使用 **Electron**，Windows 安装包由 **electron-builder / NSIS** 构建。

```powershell
npm run dev
```

开发时打开 [http://localhost:5173](http://localhost:5173)，前端会将 API 和 WebSocket 请求代理到后端。需要检查桌面集成时，在另一个终端运行 `npm run desktop:dev`。

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 检查前后端 TypeScript 类型 |
| `npm run lint` | 检查前后端代码 |
| `npm run test:client -- --maxWorkers=4` | 运行前端测试 |
| `npm test` | 运行后端测试 |
| `npm run test:desktop` | 运行 Electron 集成模块测试 |
| `npm run build` | 构建前端与后端 |
| `npm run desktop` | 在本地构建后启动桌面版 |
| `npm run desktop:dist:win -- --publish never` | 构建 Windows 安装包 |

主要目录：

```text
src/                 React 前端，按功能模块组织
server/              后端 API、CLI 适配和会话处理
electron/            桌面窗口、本地服务、目录选择和会话恢复
shared/              前后端共用代码
scripts/release/     桌面打包与运行时准备
docs/architecture/   聊天运行时架构说明
```

聊天流程的实现说明见 [架构文档](docs/architecture/README.md)。前后端模块约定见 [AGENTS.md](AGENTS.md)。

## 数据与兼容

CLI 原有的会话和配置仍使用各自的数据目录，例如 `~/.claude`、`~/.codex` 和 `~/.cursor`。Claude GUI 自身的数据库默认位于 `~/.cloudcli/auth.db`，可通过 `DATABASE_PATH` 调整；Windows 桌面设置继续使用 `%APPDATA%/CloudCLI/`，便于沿用已有安装的数据。

部分内部标识仍保留上游名称，包括 npm 包名 `@cloudcli-ai/cloudcli`、兼容命令 `cloudcli`、部分环境变量及数据目录。**本分支的使用入口是本仓库的安装包或源码**；从 npm 安装同名包会获取上游发布的版本。

如果模型列表缺少 CLI 中已有的模型，先更新并登录对应 CLI，再在模型库中重新获取。仍有差异时，请向[本仓库提交问题](https://github.com/woai66/Claude-code-GUI/issues)，附上 CLI 版本、模型名称和复现步骤。

## 来源与许可证

本项目是 **CloudCLI UI (https://github.com/siteboon/claudecodeui)** 的修改版本。感谢 Siteboon AI B.V. 及上游贡献者提供的开源基础。

沿用 **AGPL-3.0-or-later**，并保留原项目的署名及第 7 条附加条款。完整内容见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
