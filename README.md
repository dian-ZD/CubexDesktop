# CubexDesktop

[![version](https://img.shields.io/badge/version-0.2.2--dev-blue)](https://github.com/dian-ZD/CubexDesktop/releases) [![license](https://img.shields.io/badge/license-FSL--1.1--MIT-lightgrey)](vendor/aoci/LICENSE)

CubexDesktop 是一个面向本地项目的 AI 智能体协作工作站。它集对话式编码、工作流画布、可视化浏览器、文件预览与编辑、多子智能体、本地语音输入和外部 MCP 工具于一体，帮助你在熟悉的桌面环境中完成复杂开发任务。

> 当前版本：`0.2.2-dev`  
> 产物：`release\Cubex Setup 0.2.2-dev.exe`（由本机打出；未数字签名）  
> 上下文文档：`goal.md` / `plan.md` / `memory.md` / `AGENTS.md`

## 功能概览

- **Code 模式**：对话式编码；可读写文件、执行命令、搜索代码、自动修复与分步验证。
- **Work 模式**：可视化工作流画布；把任务拆成节点和依赖，支持暂停、恢复、重试和跳过。
- **Browser 模式**：Electron 内置浏览器工作台；AI 可导航、点击、输入、截图、抽取页面内容并生成参考引用。
- **多子智能体**：可并行拆解任务；支持独立模型、角色、权限和进度展示，研究/审查角色默认只读。
- **文件预览与变更**：右栏可预览文件树、查看变更差异，并直接编辑 `UTF-8` 文本文件保存。
- **错误继续发送**：模型返回或服务超时后保留已收到内容，可一键继续。
- **推荐选项**：询问用户时标注推荐项；可配置自动选择有效推荐项。
- **AOCI 认知索引**：开源本地索引 MCP，可选启用；首次使用需初始化索引。
- **语音输入**：本地 Whisper 转写，支持预览、重新识别和编辑后发送。
- **插件与 MCP**：可通过本地插件目录或 stdio MCP 服务器扩展工具能力。

## 安装与运行

### 从安装包使用（Windows）

1. 打开 `release\Cubex Setup 0.2.2-dev.exe`。
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

模型端点支持 `HTTP` 或 `HTTPS` 地址，包括局域网和远程 HTTP；不应把真实 API Key 提交到仓库。

### AOCI（可选）

开启设置中的「token节省与大型项目优化」后，会自动注册内置 `aoci` MCP 服务。首次使用前需要在项目根目录完成索引：

```bash
aoci --repo "<项目根目录>" init
aoci --repo "<项目根目录>" scan
aoci --repo "<项目根目录>" index build
```

## 项目结构

```text
src/
  main/       # Electron 主进程：Agent、LLM、工具、MCP、Browser、工作流
  preload/    # contextBridge 暴露的受控 API
  renderer/   # React UI：聊天、文件、设置、工作流画布、浏览器工作台
  shared/     # IPC 通道、Zod schema、类型定义
tests/        # Vitest 单元/集成测试
vendor/aoci/  # 内置 AOCI 二进制与许可文件
plugins.md    # 本地插件开发指南
```

## 开发约定

- 文案改动走 i18n：中文写 `tr('中文')`，并在 `src/renderer/src/phrases.ts` 补对应英文。
- 改完代码必须运行 `npm run typecheck` 和 `npm run lint`，并通过相关测试。
- 破坏性修改前确认没有相关进程占用。
- `release/`、`out/`、`node_modules/` 等产物不提交。

## 已知限制

- 当前 Windows 安装包未数字签名。
- AOCI 首次建索引可能较慢。
- `context deadline exceeded / Client.Timeout` 通常表示模型服务端或中转网关超时，本地调大超时不能完全替代服务端优化。
- Browser 模式基于 Electron 内置 `WebContentsView`，需要与 UI 同窗口协同，后台加载时不会持续盖住其他页面。

## 许可

CubexDesktop 及内置 AOCI 相关二进制遵循随仓库提供的许可文件；`vendor/aoci/` 与 `LICENSE`/`NOTICE`/`THIRD-PARTY-NOTICES` 请保留随附文件。

---

如果你想参与开发，请先读 `AGENTS.md` 中的协作流程与禁止事项，再从 `plan.md` 文首的当前任务开始。
