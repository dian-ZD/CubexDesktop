# CubexDesktop

[![version](https://img.shields.io/badge/version-0.3.10--dev-blue)](https://github.com/dian-ZD/CubexDesktop/releases) [![license](https://img.shields.io/badge/license-FSL--1.1--MIT-lightgrey)](vendor/aoci/LICENSE)

CubexDesktop 是一个面向本地项目的 **AI 智能体协作工作站**。它集对话式编码、工作流画布、可视化浏览器、文件预览与编辑、多子智能体、技能与插件系统、本地语音输入和外部 MCP 工具于一体，帮助你在熟悉的桌面环境中完成复杂开发任务。

> 当前版本：`0.3.10-dev`
> 产物：`release\Cubex Setup 0.3.10-dev.exe`（由本机打出；未数字签名）
> 上下文文档：`goal.md` / `plan.md` / `memory.md` / `agents.md`

## 功能总览

### 三种工作模式

- **Code 模式**：对话式编码。AI 可读写文件、执行命令、搜索代码、自动修复并分步验证；支持计划先行、变更校验、自动待办与上下文文件（`goal.md` / `plan.md` / `memory.md` / `agents.md`）实时注入。
- **Work 模式**：可视化工作流画布。AI 能把任务拆成节点与连线（支持分支与汇合），按**思维导图式树状布局**自动排版；节点可配置专属参数（命令、网址、文件路径等）；回复节点运行后把 AI 回复直接显示在节点卡的**回复框**里（重跑自动清空，可展开/复制/跳转对话）；支持暂停、恢复、重试和跳过。
- **Browser 模式**：Electron 内置浏览器工作台。AI 可导航、点击、输入、截图、抽取页面内容并生成参考引用；支持全网爬取（多引擎种子搜索 + 逐层扩展）。

### 技能与插件系统

- **内置技能**：写作、审查（review）、重构（refactor）、文档（docs）、测试、讲解、工作流搭建方法论（work-builder）等 7 个内置技能，随时 `/` 调用。
- **内置插件**：hello、texttools、sysinfo、croncalc——4 个零依赖 Node 脚本插件，可作为插件开发范例。
- **`/` 统一调用**：输入 `/` 唤起统一菜单，技能（✨）与插件（🧩）并列展示；选中只挂占位标签，内容随下次请求注入、不污染历史。
- **插件协议**：支持 `slash` 开关、工具级 `slashCommand` 别名与 `slashTemplate` 模板；详见 [`docs/plugins.md`](docs/plugins.md)。
- **MCP**：可接入任意 stdio MCP 服务器扩展工具能力；开启「token节省与大型项目优化」自动注册内置 AOCI 认知索引。

### 智能体能力

- **多子智能体**：主智能体并行拆解任务（每批最多 32 个子任务），子智能体支持独立角色与只读权限（researcher / reviewer 默认只读）。
- **防循环治理**：相同「工具+参数」重复 3 次拦截；同名工具 12 次总量上限；每 3 步自动自查复盘，连续无实质进展强制换思路。
- **上下文管理**：接近窗口上限自动摘要压缩、历史裁剪、错误续发（保留已收到内容一键继续）。
- **推荐选项**：询问用户时标注推荐项，可自动选择。

### 桌面集成

- **独立桌面**：可在独立的 Windows 虚拟桌面打开浏览器窗口，与当前桌面互不干扰（浏览器全路径探测 + 独立 user-data-dir 隔离）。
- **圆角窗口**：Windows 11 走 DWM 原生圆角；Windows 10 走透明窗口 + CSS 圆角，按系统自动分流。
- **语音输入**：本地 Whisper 转写，支持预览、重新识别和编辑后发送。
- **文件预览与变更**：右栏预览文件树、查看变更差异，直接编辑 `UTF-8` 文本文件。

### 联网搜索

- `web_search` 尊重设置中的搜索引擎：**Bing / Google / 百度 / DuckDuckGo** 均有专属抓取解析器（离屏窗口 + DOM 解析）。
- 失败自动降级，全部失败时把具体错误抛给模型而不是静默空结果。

## 安装与运行

### 从安装包使用（Windows）

1. 从 [Releases](https://github.com/dian-ZD/CubexDesktop/releases) 下载 `Cubex Setup <版本>.exe`。
2. 按向导安装到目标目录。
3. 启动 **Cubex**，选择项目目录并配置模型服务。

### 从源码开发

环境要求：

- Node.js `>=22.12.0`
- Windows / macOS / Linux（打包目标主要支持 Windows；Linux 打包脚本可用于 AppImage/deb）

```bash
npm install
npm run dev
```

```bash
# 类型检查
npm run typecheck

# Lint，必须 0 error
npm run lint

# 全量测试
npm test

# 启动构建产物的隔离冒烟
npm run test:desktop

# 构建并生成 Windows 安装包
npm run dist
```

## 配置

### 模型服务

在「设置 → 提供商与模型」中添加兼容接口：

- OpenAI Compatible
- Anthropic
- Ollama（本机）

模型端点支持 `HTTP` 或 `HTTPS` 地址，包括局域网和远程 HTTP；不要把真实 API Key 提交到仓库。

### 插件开发

内置插件目录：`%APPDATA%\cubex-desktop\plugins\`。每个插件是一个文件夹 + `plugin.json` 清单 + Node 脚本，支持零依赖开发。协议字段（含 slash 配置）、脚本模板与安全须知见 **[`docs/plugins.md`](docs/plugins.md)**。

### 技能

内置技能目录：`%APPDATA%\cubex-desktop\skills\`。技能是一个 Markdown 提示词文件，通过 `/` 菜单或让 AI 自动 `load_skill` 调用，全文随当次请求注入、不写入历史。

### AOCI 认知索引（可选）

开启设置中的「token节省与大型项目优化」后，会自动注册内置 `aoci` MCP 服务。首次使用前需要在项目根目录完成索引：

```bash
aoci --repo "<项目根目录>" init
aoci --repo "<项目根目录>" scan
aoci --repo "<项目根目录>" index build
```

## 项目结构

```text
src/
  main/       # Electron 主进程：Agent、LLM、工具、技能/插件、MCP、Browser、工作流
  preload/    # contextBridge 暴露的受控 API
  renderer/   # React UI：聊天、文件、设置、工作流画布、浏览器工作台
  shared/     # IPC 通道、Zod schema、类型定义、共享布局算法
tests/        # Vitest 单元/集成测试
docs/         # 开发者文档（插件协议等）
vendor/aoci/  # 内置 AOCI 二进制与许可文件
```

## 开发约定

- 文案改动走 i18n：中文写 `tr('中文')`，并在 `src/renderer/src/phrases.ts` 补对应英文。
- 改完代码必须运行 `npm run typecheck` 和 `npm run lint`（0 error），并通过相关测试。
- 破坏性修改前确认没有相关进程占用。
- `release/`、`out/`、`node_modules/` 等产物不提交。
- 发版流程：升版本号 → `npm run dist` → `npm run test:desktop` 冒烟 → commit/push → 打 tag 触发 Actions 构建。

## 版本亮点

### 0.3.10-dev
- Win10 窗口圆角（透明窗口 + CSS 圆角，按系统版本自动分流）
- 防循环加强：重复调用 3 次拦截、同名工具 12 次上限、复盘提前加密

### 0.3.9
- 搜索引擎修复：`web_search` 走设置引擎（Bing 实测可用）+ 多引擎解析器 + 降级链
- Work 思维导图布局、节点专属 config、回复节点回复框与类型图标
- DWM 原生圆角（Win11）、独立桌面根因修复
- 内置技能 7 个、内置插件 4 个、`docs/plugins.md` 开发者文档
- `/` 菜单统一技能与插件调用

### 0.3.8-dev 及更早
- 见 [Releases](https://github.com/dian-ZD/CubexDesktop/releases)。

## 已知限制

- 当前 Windows 安装包未数字签名。
- Win10 透明窗口方案下，任务栏自动隐藏时的全屏应用判定可能受影响（Win10 有圆角的必然 trade-off）。
- AOCI 首次建索引可能较慢。
- Google/百度搜索抓取有验证码风险，失败会自动降级到 DuckDuckGo；国内网络下 DuckDuckGo 通常不可达，建议使用 Bing。
- `context deadline exceeded / Client.Timeout` 通常表示模型服务端或中转网关超时，本地调大超时不能完全替代服务端优化。
- Browser 模式基于 Electron 内置 `WebContentsView`，需要与 UI 同窗口协同，后台加载时不会持续盖住其他页面。

## 许可

CubexDesktop 及内置 AOCI 相关二进制遵循随仓库提供的许可文件；`vendor/aoci/` 与 `LICENSE`/`NOTICE`/`THIRD-PARTY-NOTICES` 请保留随附文件。

---

如果你想参与开发，请先读 `AGENTS.md` 中的协作流程与禁止事项，再从 `plan.md` 文首的当前任务开始。
