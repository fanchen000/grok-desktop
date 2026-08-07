# Grok Desktop（Grok 桌面版）

一个面向 **Grok Build** 的开源桌面代码代理。它使用官方 Grok ACP
与 CLI 能力作为执行内核，并提供接近现代桌面编码代理的会话、文件、
Diff、终端、Worktree、Skills、MCP、插件、浏览器与自动化体验。

> 非官方社区项目。本项目不隶属于、也不代表 xAI、OpenAI 或
> OpenChamber。Grok、Grok Build 及相关商标归其权利人所有。

## 核心能力

- **Grok ACP 原生会话**：流式回答、思考、计划、工具调用、权限请求、
  原生 `session/load` 与可恢复取消。
- **统一会话列表**：桌面会话与 `~/.grok/sessions` 原生历史按 native
  session ID 去重，正文按需加载，继续时仍使用原始 Grok 上下文。
- **订阅额度卡**：左下角常驻显示官方 `/usage` 返回的已用比例、剩余比例
  与重置时间；保留最近可信值并复用隐藏的官方 Grok 会话快速刷新。
- **多账号隔离**：系统默认账号与独立账号档案；切换时重启 ACP 环境，
  不读取、不解析、不复制认证文件内容。
- **Grok 原生命令**：`/context`、`/session-info`、`/compact`、
  `/deep-research`、`/workflow`、`/goal` 等直接进入命令菜单。
- **Skills / MCP / 插件**：读取 Grok `inspect` 的真实能力；支持插件市场
  搜索、安装、更新、卸载和 MCP 状态检查。
- **代码工作区**：文件树、Git Diff、终端、Worktree、多运行与审查界面。
- **受限 Computer Use**：Grok 可通过本地 MCP 操作应用内注册的浏览器
  WebView，支持导航、读取、点击、输入、滚动、快照、录制与回放。
- **简体中文体验**：固定 UI、Grok 原生命令、常用 Skills、Agents 与
  会话标题均提供中文展示。

## 为什么不是网页套壳

Grok Desktop 不嵌入 `grok.com` 作为聊天主界面。每个代码会话由本机安装的
官方 Grok Build 进程通过 ACP 驱动：

```text
Grok Desktop UI
  → OpenCode-compatible local bridge
  → Grok Build ACP (`grok agent --no-leader stdio`)
  → official Grok tools, sessions, Skills, MCP and plugins
```

网页仅在用户主动打开订阅管理等官方页面时使用。

## 安装前提

1. 安装并登录官方 Grok Build。
2. 确认 `grok`（Windows 为 `grok.exe`）在 `PATH` 中，或设置：

```powershell
$env:GROK_BINARY = 'C:\path\to\grok.exe'
```

3. Windows 10/11、macOS 或 Linux 桌面环境。

当前主要实机验证目标为 Windows x64。

## 从源码运行

需要 Node.js 22+、Bun 1.3.14，以及 Electron 构建所需的本机工具链。

```bash
git clone https://github.com/fanchen000/grok-desktop.git
cd grok-desktop
bun install
bun run electron:dev
```

使用接近发行包的内置 Web 资源：

```bash
bun run electron:dev:bundled
```

Windows 目录包：

```bash
bun run --cwd packages/electron build:web-assets
bun run --cwd packages/electron bundle:main
node node_modules/.bun/electron-builder@*/node_modules/electron-builder/cli.js --win dir
```

正式打包脚本与平台要求见 `packages/electron/README.md`。

## 可选 Google 配额兼容环境变量

公开源码不包含上游遗留的 Google OAuth 客户端值。需要相关兼容配额功能时，
请自行配置：

`	ext
OPENCHAMBER_ANTIGRAVITY_GOOGLE_CLIENT_ID
OPENCHAMBER_ANTIGRAVITY_GOOGLE_CLIENT_SECRET
OPENCHAMBER_GEMINI_GOOGLE_CLIENT_ID
OPENCHAMBER_GEMINI_GOOGLE_CLIENT_SECRET
`

这些变量与 Grok 登录、Grok 订阅额度和 Grok ACP 无关。
## 隐私与安全边界

- 不读取或向渲染器暴露 `auth.json` 内容。
- 不把 token、Cookie 或浏览器凭据写入日志、URL 或 Git 仓库。
- 新账号通过独立 HOME / USERPROFILE / GROK_HOME 隔离。
- ACP、MCP 与兼容服务默认只绑定回环地址。
- 浏览器控制仅能操作应用内已注册的浏览器视图，并限制为 HTTP(S)。
- 额度数据来自官方 Grok `/usage` 输出；不猜测额度、不抓取浏览器 Cookie。

更多信息见 [SECURITY.md](SECURITY.md)。

## 项目状态

这是一个可工作的社区桌面客户端，而不是 xAI 官方产品。不同 Grok Build
版本可能调整 ACP 扩展、CLI 文案或订阅策略。项目优先使用公开的官方能力，
社区接口只作为有边界、可关闭的兼容参考。

当前重点：

- 提高跨平台打包与自动更新可靠性；
- 持续补齐中文技能说明与原生命令；
- 增强大量历史线程下的搜索和虚拟化；
- 增加可重复的端到端桌面测试。

## 上游与许可证

本项目基于 OpenChamber 的成熟桌面界面与应用壳层进行修改，并保留其
MIT 许可证与原作者版权声明。Grok 集成层使用官方 Grok Build ACP/CLI，
不会分发 Grok 二进制、模型服务或认证凭据。

详见 [LICENSE](LICENSE) 与 [OPEN_SOURCE_NOTICES.md](OPEN_SOURCE_NOTICES.md)。

## 致谢

- [xai-org/grok-build](https://github.com/xai-org/grok-build) — Grok Build 与 ACP 内核
- [openchamber/openchamber](https://github.com/openchamber/openchamber) — 桌面 UI 与应用基础
- [openclaw/acpx](https://github.com/openclaw/acpx) — ACP 取消与进程回收设计参考
- [kenryu42/pi-grok-cli](https://github.com/kenryu42/pi-grok-cli) — 多账号与额度展示参考
