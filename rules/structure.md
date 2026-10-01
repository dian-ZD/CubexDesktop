# 项目结构说明（文件级）

> 最后更新时间：2026-10-01 ｜ 维护者：AI Agent
>
> 目的：保证"每个文件有明确职责、新增文件有明确归属、依赖方向不被破坏"。新增/移动/删除文件前必须先读本文件；结构变化后必须同步更新本文件与 `agents.md` 登记。

## 1. 顶层布局

```text
cubex/
├── agents.md / goal.md / plan.md / memory.md   # AGENTS.md 体系（现行入口，勿改名）
├── plugins.md                                   # Cubex 插件协议对外文档（面向插件作者）
├── rules/                                       # 现行规则：quality-gates / platform-support / structure
├── specs/                                       # 任务方案与决策：SPEC-XXX / ADR-XXX
├── src/                                         # 全部源码（main / preload / renderer / shared 四层）
├── tests/                                       # vitest 单元测试（node 环境，不依赖 Electron 运行时）
├── scripts/                                     # 开发/构建/验证辅助脚本（*.mjs，node 直接执行）
├── build/                                       # electron-builder 资源（图标、logo 源图）
├── out/ dist/ release/ coverage/                # 构建产物（.gitignore，不入库）
├── package.json                                 # 依赖、脚本、electron-builder 配置（build 段）
├── electron.vite.config.ts                      # 三端（main/preload/renderer）构建配置
├── vite.web.config.ts                           # 纯浏览器预览模式（dev:web，配合 bridge.previewApi）
├── vitest.config.ts / tsconfig.json / eslint.config.js
```

## 2. 依赖方向（必须遵守）

```text
                 ┌─────────┐
   渲染进程 ────▶│ shared/ │◀──── 主进程
                 └─────────┘
                      ▲
                 preload（只依赖 shared/channels + schema 类型）
```

- `shared/` 不依赖任何其它层（纯类型/校验/常量，可在三端通用）。
- `main/` 可以依赖 `shared/`；**禁止** import `renderer/` 或 `preload/` 的任何文件。
- `renderer/` 可以依赖 `shared/`（仅类型与常量）；**禁止** import `main/`；与主进程通信只走 `bridge.ts` → `window.cubex`（preload 暴露的 API）。
- `preload/` 只做 contextBridge 转发，**禁止**写业务逻辑。
- `tests/` 只 import `src/main` 与 `src/shared`（vitest 为 node 环境，Electron API 通过 mock 或注入绕过）。
- `scripts/` 只 import 依赖包与 `src` 的构建产物/纯函数，不被源码反向依赖。

## 3. `src/shared/` —— 契约层（3 文件）

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `schema.ts` | 全项目唯一数据契约：zod schema + 类型 + 默认值 + 状态迁移 + IPC 输入类型 + `CubexAPI` 接口定义 | `stateSchema`、`settingsSchema`、`defaultSettings()`、`migrateState()`、`toolNames`、`CubexAPI` |
| `channels.ts` | IPC 通道名字符串常量（main ↔ preload ↔ renderer 三方共用） | `channels` |
| `schedule.ts` | 定时/自动化到期计算（纯函数，无依赖） | `isDue()`、`nextRunAt()`、`dueAutomations()` |

**注意**：`schema.ts` 已 567 行、职责偏多（架构线待办），但**新增字段仍必须加在这里**，不要在别处另建类型契约。

## 4. `src/main/` —— 主进程（17 文件）

组合根是 `index.ts`；其余模块被它装配，模块间依赖遵循下表"依赖"列。

| 文件 | 职责 | 依赖 |
| --- | --- | --- |
| `index.ts` | 组合根：窗口/会话安全加固、全部 IPC handler 注册、自动化调度、状态广播 | 本目录几乎全部 |
| `platform/shell.ts` | ★平台层：shell 解析与命令包装（`shellCommand`，Windows/POSIX 分支唯一归口） | `shared/schema` |
| `platform/proc.ts` | ★平台层：`killTree` 进程树终止（POSIX 进程组 / win32 taskkill）+ `spawnDetached` | 无 |
| `platform/capture.ts` | ★平台层：`desktopCaptureSupported` 截屏能力探测（Wayland 保守判不可用） | 无 |
| `platform/index.ts` | 平台层 barrel re-export | platform 内部 |
| `sandbox/env.ts` | ★沙箱层：`buildSandboxEnv` 环境变量白名单/禁网（纯函数） | 无 |
| `sandbox/guard.ts` | ★沙箱层：`findEscape` 越权命令拦截（纯函数） | 无 |
| `sandbox/index.ts` | 沙箱层 barrel | sandbox 内部 |
| `agent.ts` | AgentRunner：会话循环、审批/提问/待办/委派子智能体 | `llm` `tools` `prompt` `context` `projectFiles` `errors` `store` `secrets` |
| `llm.ts` | 模型协议层：OpenAI/Anthropic 流式对话、SSE 解析、截断修复、模型列表探测 | `errors`、`shared/schema` |
| `tools.ts` | 内置工具执行：读写/搜索/命令执行、路径越界校验（`resolveInside`）、diff；命令的 shell 解析/进程终止/沙箱策略已抽至 `platform/`+`sandbox/`（公开签名不变） | `platform` `sandbox`、`shared/schema` |
| `prompt.ts` | 系统提示词组装（语言/审批/沙箱/环境注入） | `projectFiles`、`shared/schema` |
| `projectFiles.ts` | 项目四上下文文件（goal/plan/memory/agents.md）的模板、确保创建、读取与注入 | `shared/schema` |
| `context.ts` | token 估算与上下文窗口裁剪（`fitContext`） | `shared/schema` |
| `store.ts` | `state.json` 持久化（防抖 + 原子写 + 损坏恢复） | `shared/schema` |
| `secrets.ts` | 凭据存储（safeStorage 加密，0600） | electron `safeStorage` |
| `extensions.ts` | 扩展层：插件发现/调用、内置浏览器取数、联网搜索、电脑操控 | `tools`（复用工具名集合）、`mcp`、`github` |
| `mcp.ts` | MCP 服务器进程管理与 JSON-RPC 协议 | `shared/schema` |
| `skills.ts` | 技能包（md/zip）导入、解析 front-matter、内置技能 | `unzip`、`shared/schema` |
| `unzip.ts` | 最小 zip 解包（store + deflate，无第三方依赖） | 无 |
| `github.ts` | GitHub API + git 命令行推送（token 脱敏） | `shared/schema` |
| `workflowRunner.ts` | ★DAG 执行引擎（SPEC-003）：按依赖就绪推进节点、失败自动重试后暂停、暂停/继续/重试/跳过；状态落在 `thread.workflowRun`。依赖注入的 `NodeRunner` 接口（实现为 `agent.ts` 的 `runNode/abortRun/drainQueue`） | `store`、`workflow`、`errors`、`shared/schema` |
| `workflow.ts` | 工作流纯逻辑：拓扑排序（`orderWorkflowNodes`）、旧版整段提示词合成（`composeWorkflowPrompt`，保留供测试与回退）、DAG 执行计划（`workflowStepPlan`）与节点指令组装（`composeNodeInstruction`） | `shared/schedule`、`shared/schema` |
| `share.ts` | 会话分享图 HTML 渲染 + offscreen 截图 | `shared/schema` |
| `errors.ts` | 网络/TLS/HTTP 错误 → 用户可读提示 | 无 |

**新增主进程模块规则**：一个模块只做一件事、只从 `index.ts` 或上表既有依赖方向被调用；禁止模块间循环依赖（当前无，保持）。平台相关代码必须集中在上表已有的平台敏感文件内并登记到 `rules/platform-support.md` 索引表，禁止散落新判断点。

**platform/ 与 sandbox/ 依赖规则（2026-10-01 SPEC-002 阶段 1 生效）**：二者只允许依赖 `shared/schema` 类型与 Node 标准库；任何 main 模块可依赖它们，它们不得依赖 main 其它模块（防环）。新增 `process.platform` 判断一律收敛进 `platform/`；`tools.ts` 的公开导出（`runTool`/`runShellCommand`/`browseDirectory`/`readProjectFile`/`matchesCommandRule`/`makeDiff`/`resolveInside`/`toolSpecs`/各工具名集合）保持为稳定接口，消费方不得改为直接 import platform/sandbox 中的同名实现。

## 5. `src/preload/` 与 `src/renderer/`

| 文件 | 职责 |
| --- | --- |
| `preload/index.ts` | 把 `channels` 逐个包装成 `window.cubex`（`CubexAPI` 实现），含事件订阅卸载函数 |
| `renderer/index.html` | 入口 HTML（预置 `data-theme`，加载 main.tsx） |
| `renderer/src/main.tsx` | React 挂载入口 |
| `renderer/src/App.tsx` | 主界面（巨型，架构线待拆；**新组件不要再加进来**，独立建文件） |
| `renderer/src/SettingsPanel.tsx` | 设置页（同上） |
| `renderer/src/RightPanel.tsx` | 右栏：文件树/预览 webview/任务摘要 |
| `renderer/src/WorkflowCanvas.tsx` | 工作流画布（节点拖拽/连线） |
| `renderer/src/components/Logo.tsx` | ★叶子组件：品牌图标 |
| `renderer/src/components/SkillMenu.tsx` | ★叶子组件：输入框 `/` 技能菜单 |
| `renderer/src/components/Markdown.tsx` | ★叶子组件：自研轻量 Markdown 渲染（导出 `OpenTarget`） |
| `renderer/src/ui.tsx` | 小型共享 UI 原子（Toggle/Choice/按钮等） |
| `renderer/src/bridge.ts` | renderer 侧唯一 API 入口：桌面用 `window.cubex`，Web 预览用 `previewApi` 桩 |
| `renderer/src/i18n.ts` + `phrases.ts` | `tr()` 中文键词典机制 + 词条库（新文案必须同步补 phrases） |
| `renderer/src/useSpeech.ts` + `speech.worker.ts` | 语音输入（MediaRecorder + 本地 whisper ASR worker） |
| `renderer/src/styles.css` | 全局样式单文件（6414 行，架构线待拆；新组件样式追加时按现有分节注释归位） |
| `renderer/src/assets/logo.png`、`renderer/public/logo.png` | 图标资源（由 `scripts/make-icon.mjs` 生成，勿手改） |

**新增渲染组件规则**：无状态/低耦合的叶子组件一律新建于 `renderer/src/components/`（已试点：Logo/SkillMenu/Markdown）；跨组件共享的纯 UI 放 `ui.tsx`；数据只经 `bridge.ts` 取；禁止在组件里直接 `ipcRenderer`/`window.require`。**预留拆分目标位**（2026-10-01 登记，迁移发生时才建目录）：`components/sidebar/`、`components/composer/`、`components/messages/`（App.tsx 拆分目标）；主进程侧预留 `src/main/ipc/`（index.ts handler 拆分目标）与 `src/main/agent/`（AgentRunner 拆分目标）。

## 6. `tests/` 与 `scripts/`

- 测试与被测模块同名镜像：`src/main/tools.ts` → `tests/tools.test.ts`。新增主进程模块**必须**建同名测试文件（node 环境可跑的纯逻辑部分）。
- `tests/live.test.ts` 是唯一需要真实模型的测试（无 `CUBEX_LIVE_*` 环境变量时自动跳过），保持该约定。
- `scripts/desktop-smoke.mjs` 冒烟、`ui-check*.mjs` Playwright UI 检查、`repro.mjs` 复现、`make-icon.mjs` 图标生成。新脚本放 `scripts/` 并在 `rules/quality-gates.md` 登记用法；**禁止**放仓库根目录。

## 7. 新增文件归属决策表

| 你要做的事 | 涉及文件（按顺序） |
| --- | --- |
| 新增一个 IPC 能力 | `shared/channels.ts`（通道）→ `shared/schema.ts`（入参/返回类型）→ `main/index.ts`（handler）→ `preload/index.ts`（转发）→ `renderer/src/bridge.ts`（previewApi 桩）→ 组件调用 |
| 新增一个内置工具 | `shared/schema.ts`（`toolNames`）→ `main/tools.ts`（spec + dispatch）→ 若需审批：`tools.ts` 的 `mutatingTools/commandTools` 集合 → `main/agent.ts`（如属会话层处理）→ `tests/tools.test.ts` |
| 新增工作流相关状态 | `shared/schema.ts`（`threadSchema.workflowRun` 及子 schema，**必须放在 `threadSchema` 之前**）→ `main/workflowRunner.ts`（状态流转）→ `tests/workflowRunner.test.ts` |
| 新增一个设置项 | `shared/schema.ts`（settingsSchema + defaultSettings）→ `renderer/src/SettingsPanel.tsx` → 文案进 `phrases.ts` → 迁移兼容检查 `migrateState()` |
| 新增一个平台能力 | 先查 `rules/platform-support.md` 索引 → 落在既有平台敏感文件 → 更新索引表 + 非 Windows 行为说明（报错/降级/隐藏三选一） |
| 新增文档 | 规则→`rules/`；方案/决策→`specs/`（SPEC/ADR 编号递增）；其余暂放 `specs/`，`docs/` 建立后再迁 |

## 8. 体量红线（已知债务）

- 新文件目标 ≤ 400 行；超过 800 行需在 `plan.md` 说明理由。
- 已知超标（架构线待拆，**不要再往这些文件里加大块新功能**）：`styles.css` 6414、`SettingsPanel.tsx` 1593、`App.tsx` 1392、`phrases.ts` 864（词典文件例外）、`main/index.ts` 727、`RightPanel.tsx` 659、`schema.ts` 567。

## 9. 维护义务

- 本文件与 `agents.md`「工作区结构」一节同步更新：新增/删除/移动任何文件后，同一次改动内更新两处。
- 与代码不一致的结构描述视为 bug：发现即修正，修正记录写入当轮 `plan.md` 步骤。