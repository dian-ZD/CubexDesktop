# CubexDesktop Goal

> 最后更新时间：2026-10-07 ｜ 更新者：AI Agent（HTTP 端点与 0.2.2-dev 安装包）

## 当前任务目标（一句话）

最新交付：开放本机、局域网及远程 HTTP 模型端点，版本更新为 0.2.2-dev，版权为 Copyright © 2026 HIGHLIGHT STUDIO，并生成 Windows 安装包。158 passed / 4 skipped，typecheck、lint、打包与打包版隔离冒烟通过；产物和核对结果见 plan.md 文首。以下为历史任务记录，其“安装包未包含”描述仅适用于当时的旧版本。

最新目标：Browser 网页只在自己的可见工作台内显示，加载和后台操作不得重新覆盖其他页面或会话。修复及真实 Electron 原生视图回归已完成，最新全量测试为 157 passed / 4 skipped，收尾见 plan.md 文首。

当前任务：文件预览与文件变更支持手动编辑保存；改善模型响应体超时处理及模型设置排版；错误提示条提供发送“继续”的按钮；询问选项显示推荐高亮点，并允许配置自动选择有效推荐项。代码与隔离验证已完成，153 passed / 4 skipped；最终收尾见 plan.md 文首。上游服务实际超时未用真实端点复测，本地重试与诊断改善不等于服务商故障已消除。

本轮目标：修复聊天消息自动贴底，消息区按 8 条渐进加载并保持阅读位置；增强多子智能体的并发、独立模型/角色/权限配置及进度结果展示。用户已确认滚动条指聊天消息区，子智能体范围为提高并发、独立模型与角色、进度面板。上述功能已实现并通过单元测试与隔离 Electron UI 回归，收尾状态见 plan.md 文首；以下为前序任务记录。

用户四项指令：① **删除设置里的「自动化」，点侧栏「自动化」后收起右栏、把中间栏与右栏整片变成自动化页面，而不是跳转设置页**；② **Code/Work/Browser 模式选择器从标题栏移到标题下方、新建任务上方，并整理排版**；③ **把 https://github.com/aoci-spec/aoci-code 与 https://github.com/kernel4632/agent-core 两个仓库「搞进去」，并在设置里新增「Beta 功能」栏目，含两个开关「token节省与大型项目优化」「agent循环优化」**；④ **删掉旧安装包 `0.1.1` 并编译 `0.2.1`**。当前状态：①②③④ **均已实现、通过全量校验（typecheck 0 / lint 0 error / test 130 passed + 4 skipped）、完成实测**，①②③ 已提交推送（`a07116f` feat + `9ea6de1` docs，`ls-remote` 核对一致），**④ 与文档回填尚未 commit**——③ 连 dev 版与**打包版**都跑了端到端（aoci 子进程真实握手「已连接 · 9 个工具」、开关关闭自动移除、安装包 106.22 → **112.74 MB**，+6.52 MB / +6.13%），④ 产出 `release\Cubex Setup 0.2.1.exe` = 112,735,082 B（112.74 MB），测试状态均已还原为默认。用户已拍板 `vendor/aoci/` 进 git（已随 `a07116f` 入库）、许可证 FSL-1.1 可以捆绑。接法经选择题确认：agent-core **只移植循环停机语义、不装依赖**（它绑定 Bun 运行时，Electron 跑不起来）；aoci **二进制打进安装包**。另一项指令「不要让 cubex 永远置顶」——主窗口的临时置顶已清除（`GWL_EXSTYLE=0x0`），分离任务面板浮窗经选择题确认**保留**置顶。前序的体积优化（安装包 144.53 → 106.22 MB，`da9b013` + `26be755` 已推送）与「资料报告 + 引用溯源」「Browser 模式全网爬取」「zip 分支合并」均已完成但**尚未真实会话实测**。执行进度详见 plan.md，过程细节详见 memory.md。

### 背景与动机

- 已有 Code（对话式编码）与 Work（画布工作流）两个模式，均复用同一 agent/工具集；现需要一个可视化、可交互的浏览器自动化模式，参考 tabbit 的「任务隔离工作区 + 动作-验证-取证闭环」。
- 已有只读的 `browser_open`（离屏 BrowserWindow，仅打开+抽取文本），不足以支撑交互式浏览；需升级为可见 + 可交互后端。
- 前置已完成：修复多处输出/工具截断问题、新增自动检测可用模型与上下文长度、放大白底 logo 图标、输入框自适应高度，并编译 0.1.2-dev 推送至 GitHub。

### 验收标准 / Definition of Done（Browser 模式）—— 全部达成 ✅

- [x] `view` 联合类型与标题栏 radiogroup 新增 `browser`，与 Code/Work 并列。
- [x] `thread.mode` 下沉到 schema（`code|work|browser`），agent 按模式注入专属 system prompt 段。
- [x] 新建 `src/main/browser.ts` BrowserEngine：任务隔离会话（partition per threadId + lease Map）、可见可交互 WebContentsView（`addChildView`/`setBounds`）、动作原语（navigate/click/type/extract/screenshot/wait）+ 租约 + 取证 + `setOptions`（UA/下载/新窗口/起始页）。
- [x] 新增结构化浏览器工具（`browser_navigate` 等六个），接入 extensions/dispatch + 审批（navigate/click/type 为敏感）；保留旧 `browser_open` 不动。
- [x] IPC/preload/bridge 三件套 + 实时状态推送（`browserState`）+ 内嵌真实视图（放弃截图帧，改用 WebContentsView 内嵌）。
- [x] 前端 `BrowserWorkspace.tsx`（分屏：复用对话 main + 实时视图 + 地址栏 + 前进/后退/刷新经 `cubex://` 控制 URL）。
- [x] 设置新增 browser 分区（起始页/逐步审批/租约时长/下载/新窗口/UA）+ i18n 全量 + 样式。
- [x] `npm run typecheck`=0 / `npm run lint`=0 error / `npm test`=86 passed + `npm run build` + smoke（`tests/browser.test.ts` 9 例）。

### 前置里程碑（已完成）

- [x] 修复写入/工具参数过长被截断（Anthropic 8192 上限 + safeArgs 静默失败 + JSON 修复）。
- [x] 修复输出被莫名截断（`resolveMaxTokens` 统一两协议默认输出上限 + `finish_reason/stop_reason` 截断续写 + 上下文预留上调）。
- [x] 自动检测可用模型 + 自动检测上下文长度（`llm.listModels` + `guessContextWindow` + IPC + 设置面板 UI）。
- [x] 白底 logo 图标内容放大（0.72→0.88）；询问框加高一倍；输入框随字数自适应（最高 2.5×）。
- [x] 编译 0.1.2-dev（`release\Cubex Setup 0.1.2-dev.exe`）并推送 GitHub（`dian-ZD/CubexDesktop` main，commit f57ade2）。

### 边界（不做什么 / 不改什么）

- 不改动 `src/main/index.ts`、`src/renderer/src/speech.worker.ts` 中由用户/linter 外部修改的内容（保留 createWindow 先于 buildAppIcon、MCP/scheduler 延迟、whisper ASR 流水线、resolveMaxTokens 相关外部微调）。
- **不删除**旧只读工具 `browser_open`（Work/Code 仍可能引用）；Browser 模式新增独立 `browser_*` 交互工具。
- 不删除 `schema.ts` 中 `appearance.theme/accent/background` 字段（数据层保留有效）。
- 未获用户同意不引入 Playwright/Puppeteer 等新浏览器二进制依赖（已选定用 Electron 内置 BrowserWindow）。
- 不在文档中写入任何真实密钥/令牌明文。

### 关键约束

- 技术栈：Electron 44 + React 19 + TypeScript + electron-vite + Vite 7 + electron-builder(NSIS)；详见 memory.md「技术栈与约定」。
- 编辑工具：当前环境 `Edit`/`Write` 均可用；改动代码前先读文件当前内容。
- 全程中文交流与中文注释。

### 相关方与沟通偏好

- 需求不明确或多方案时先用选择题确认；简单默认项可自行假设并说明。
- 用户倾向「先确认关键决策，再执行」，但破坏性操作（删数据/卸载）已获明确指令即可执行。

---

## 产品目标

基于 Electron 的本地编程智能体桌面应用，编程优先、兼容通用任务。功能与交互对标 Сodex / TRAE：**项目 → 会话 → 模型**，在对话中读代码、改文件、跑命令，并由用户审批。界面为简洁深色工作区，抹茶绿与红色作为强调色。

## 方向调整（2026-09-25）

按用户要求“先完全复刻 Сodex 和 TRAE 的功能，不要给协作角色选择 Harness 这种臃肿功能”：

- 移除 Model / Harness / Agent 三层配置、协作角色、只读扫描任务及其 Worker 与相关代码。
- 多智能体、Harness 适配等原 P2/P3 目标暂停，待单会话体验达标后再评估。

## 方向调整（2026-09-26）

- 系统提示词内置且不可编辑，由 `src/main/prompt.ts` 按项目路径、审批模式、只读模式、最大步数等设置动态拼接。
- 设置页独立全屏（隐藏项目/会话侧栏），8 个分类：通用、外观、模型与提供商、模型参数、Agent、权限、对话、关于；支持搜索、就地校验、测试连接，Esc 返回。
- 设置 schema 升级到 v3（分组结构），旧状态自动迁移，非法单项回退默认值。

## 原则与边界

- 不伪造模型输出、工具执行或验证结果；未实测的能力不能标为完成。
- 不自动提交、推送或安装依赖；写文件与执行命令受审批模式约束。
- API Key 仅存于主进程，使用系统 safeStorage 加密；渲染进程只能得知“是否已设置”。
- 文件工具限制在项目目录内（拒绝 `..` 越界、绝对路径、链接越界与凭据文件）。
- **命令执行没有沙箱**：在项目目录下以当前用户权限运行，“完全自动”模式需谨慎使用。

## 已实现（核心原型）

- 安全基础：contextIsolation + sandbox、无依赖 preload、主进程 Zod 校验全部 IPC、CSP、导航与权限限制。
- 模型接入：OpenAI 兼容、Anthropic、Ollama 三类提供商；SSE 流式文本与工具调用；未知工具名被过滤；流式空闲超时（可配置），失败自动重试。
- 工具：`read_file`、`list_directory`、`search_files`、`write_file`、`edit_file`（唯一片段替换）、`run_command`；写入产生统一 diff。
- Agent 循环：单轮最多 40 步；流式增量推送；审批（逐项确认 / 自动编辑 / 完全自动）；停止本轮并回收进程树（Windows 下取消约 1 秒完成）。
- 会话：按项目分组的会话历史、标题自动生成；状态文件带 schema 校验、原子写入、损坏备份与重启后中断恢复。
- 界面：窄侧栏 + 居中会话列 + 悬浮输入框；工具卡片、diff、审批卡片；设置页中文校验提示固定在保存栏上方。

## 未完成

- 已用真实 API Key 在 OpenAI 兼容中转站端到端实测；Anthropic 原生接口与 Ollama 尚未实测。
- 命令执行无沙箱；右侧终端面板为逐条命令执行（非交互式 PTY）；无文件编辑器。
- 上下文压缩已升级为 **LLM 摘要式压缩**（`src/main/agent.ts` `compactMessages`/`summarize`），并支持接近上限自动压缩、超限自动恢复与空转治理；模型不可用时退化为普通移除标记。
- 第三方登录（OAuth）仅可在管理端配置，桌面端未接入授权流程；MCP 仅支持 stdio 传输。
- 邮箱 / 短信验证码依赖管理端配置的 Webhook 实际投递，未对接具体服务商实测。
- 桌面端 UI 自动化仅有启动冒烟与 `scripts/ui-check.mjs`；持久化仍为 JSON 文件。

## 验证状态（2026-09-25）

- `npm run lint`、`npm run typecheck`、`npm run build` 通过。
- `npm test`：5 个文件 28 项通过，覆盖 schema、状态存储、路径边界、文件工具、命令执行与取消、diff、OpenAI / Anthropic 流解析、Agent 审批 / 拒绝 / 取消 / 并发发送。
- `npm run test:desktop`：真实 Electron 窗口启动并输出 `[cubex] smoke-ready`。
- 真实模型实测（`tests/live.test.ts`，设置 `CUBEX_LIVE_BASE_URL` / `CUBEX_LIVE_API_KEY` / `CUBEX_LIVE_MODEL` 后运行，否则跳过）：OpenAI 兼容中转站上 `gpt-5.6-luna` 流式回复与“读文件 → 写文件 → 执行命令 → 汇报”完整链路 2 项通过；`gpt-6-luna` 流式回复正常但从不返回 tool_calls（含 `tool_choice=required`），不可作为 Agent 模型；`glm-5.3`、`claude-sonnet-5` 能返回 tool_calls。
- 实测中 read_file / write_file 各出现两次：原始 SSE 显示每次响应只有一个 index=0 的调用，解析不会产生重复，推断是模型在后续轮次重复发起；同一模型还偶发把推理文本（如 “Confirming tool response”）混入正文。
- 浏览器预览人工检查：设置页按钮不换行、审批模式名称不换行、空模型 ID 保存时在保存栏显示“模型 1 · 模型 ID：不能为空或过小”。

本轮修复的真实问题：Windows 上取消命令卡住约 20 秒；`..notes.md` 等合法文件名被误判越界；模型返回未知工具名会导致状态文件在下次启动时被判损坏；diff 截断后超过 schema 上限导致无法保存。

## 验证状态（2026-09-26）

- `npm run typecheck`、`npm run lint`、`npm run build` 通过；`npm test` 37 项通过（新增 `tests/settings.test.ts` 9 项：迁移、命令规则、历史清理、提示词拼接）。
- 真实 Electron 窗口 + 用户配置的中转站（`scripts/repro.mjs`，使用副本 userData）：测试连接成功；设置页侧栏隐藏、导航正确；对话中模型调用 `read_file` 并正确回答文件内容。
- 修复“配置好 API 和模型却用不了”：总超时改为流式空闲超时、网络错误中文化并重试、发送前置条件提示、清理空的助手占位与孤立工具调用历史。
- 遗留：部分中转站模型（如 `gpt-6-luna`、`gpt-5-mini`）不返回 tool_calls，只能聊天、无法执行工具。

## 阶段 9（2026-09-27）：分享、GitHub、插件、Work 模式、自动化

- 分享：任务菜单“分享为图片”（离屏窗口渲染 HTML → PNG，复制到剪贴板 / 另存为，内容全部转义且 CSP 禁止脚本）与“导出 Markdown”。
- GitHub：设置 → GitHub 填写访问令牌（校验后加密保存）、目标仓库（留空按目录名）、分支、私有、完成后自动推送；可手动“推送”；Agent 新增 `github_push` 工具（非完全自动模式需审批，只读模式拒绝）。
- 插件：内置“浏览器”（`browser_open`，自动执行）与“电脑控制”（`computer_use`，始终需审批，默认关闭）；自定义插件放在插件目录，`plugin.json` 声明工具与命令，参数经 stdin 与 `CUBEX_ARGS` 传入，stdout 作为结果，120 秒超时；Agent 通过 `plugin_call` 调用。
- Code / Work 模式：标题栏切换；Work 为画布工作流（节点拖动、端口连线、检查器编辑提示词），按拓扑顺序合成一条指令新建任务执行，检测循环连线。
- 自动化：设置 → 自动化，按固定间隔（10 分钟～7 天）在指定项目与模型下自动新建任务执行；主进程每 60 秒检查到期任务，可“立即运行”。
- 验证：typecheck / lint / build 通过；`npm test` 63 项通过（新增 `tests/p9.test.ts` 10 项：工作流排序与循环、提示词合成、自动化到期、GitHub 校验与仓库名推断、设置迁移、分享 HTML 转义；agent 新增电脑控制审批与只读拒绝推送）；`scripts/ui-check.mjs` 通过。
- 未实测：真实 GitHub 推送（需用户令牌）、电脑控制在真实桌面上的操作、自动化长时间运行。

## 阶段 10（2026-09-27）：启动速度、防卡顿、问题修复、定时自动化

- 启动速度：设置 / 右侧面板 / Work 画布等按需懒加载，各自独立 Suspense（不再整体白屏）；主进程 GitHub、分享模块改为动态导入；构建开启压缩与 manualChunks（index 约 167 kB，react 约 222 kB）。
- 防卡顿：流式增量按 rAF 合并批量更新；消息视图 memo 化；主进程状态广播合并；状态写入防抖并在退出时 `flushSync` 落盘。
- 定时自动化：在固定间隔之外新增“每天指定时间”“每周指定星期与时间”（`src/shared/schedule.ts`）；错过的时间点仅补跑一次，首次创建有 5 分钟宽限，避免立即误触发。
- 问题修复：注册时邮箱 / 短信验证码此前无法发送与校验，现补齐端到端链路（管理端 `/api/send-code` 经 Webhook 投递，6 位验证码 10 分钟有效、60 秒冷却、最多 5 次尝试、常量时间比较、成功注册后作废；邮箱 / 手机号去重）；桌面端账户卡片按管理端配置动态显示邮箱 / 手机与验证码输入；右侧“概览”插件列表改为读取真实启用插件；OAuth 在界面与管理端注明“仅配置，桌面端暂未接入”。
- 验证：typecheck / lint / build 通过；`npx vitest run` 10 个文件 70 项通过（2 项真实模型测试按环境变量跳过），新增 `tests/admin.test.ts`（真实启动管理端 + 本地 Webhook，覆盖缺码、格式错误、冷却、错码、成功注册、验证码复用被拒）与定时计算用例；`scripts/ui-check.mjs` 通过；`npm run test:desktop` 冒烟通过。
- 未实测：定时任务长时间运行、真实邮件 / 短信服务商投递。

## 阶段 11（2026-09-27）：MCP、主动提问、移除宠物

- MCP：设置 → MCP 管理 stdio 服务器（名称、启动命令、逐行参数、KEY=VALUE 环境变量、启用开关、“测试连接”列出工具）；主进程 `src/main/mcp.ts` 手写 JSON-RPC 2.0 客户端（initialize → notifications/initialized → 分页 tools/list，tools/call，取消通知，响应 ping / roots/list），保存设置后自动启停/重启，退出时全部关闭；Agent 通过单一 `mcp_call` 工具调用（工具目录写入描述），非完全自动模式需审批；右栏概览显示服务器状态，输入框“技能与 MCP”按钮直达该分区。
- 主动提问：系统提示词明确要求需求不明确或存在多种方案时调用 `ask_user` 给出候选项，而非自行猜测。
- 移除宠物功能（设置分区、导航与样式）。
- 验证：typecheck / lint / build 通过；`npx vitest run` 77 项通过，新增 `tests/mcp.test.ts`（真实子进程假服务器：握手、分页、调用、环境变量、错误结果、启动失败、停用后目录清空、设置迁移与名称校验、提示词规则）。
- 未实测：真实第三方 MCP 服务器（如 npx 包）的长时间运行；暂不支持 HTTP/SSE 传输。

## 阶段 12（2026-09-27）：管理端修复、Work 模式升级、排版优化

- 管理端修复：应用启动时自动以子进程拉起本地管理端（`ELECTRON_RUN_AS_NODE` 方式复用 Electron 二进制），健康轮询 `/api/health`，退出时回收；设置页显示在线状态点（15 秒轮询）与“打开管理端”入口；管理端脚本修复端口占用友好提示、favicon 404、用户表 XSS（改 DOM API）；管理端配置的内置模型与用户默认设置在登录后自动应用到桌面端。
- Work 模式升级：节点新增类型（执行 / 检查 / 审阅 / 备注，`kind` 可选字段向后兼容旧数据）；备注节点不执行、作为背景信息注入提示词，检查 / 审阅节点附加对应引导语；新建工作流支持三个模板（功能开发 / 问题排查 / 代码审查）；画布新增撤销重做（Ctrl+Z / Ctrl+Y，50 步快照）、自动排版（按拓扑深度分列）、缩放（40%–160%）与适配视图、复制节点、Delete 删除、Esc 取消连线；节点按类型着色并显示执行顺序编号；检查器未选中时显示工作流概览与可点击的执行顺序列表；空状态提供模板快捷入口。
- 排版优化：Work 工具组独立样式（`.work-tools`）；1180px / 900px 断点下检查器收窄、工具栏换行、名称输入收缩；帮助面板层级化排版。
- 验证：typecheck / lint / build 通过；`npm test` 80 项通过（`tests/p9.test.ts` 新增节点类型兼容、备注背景块、检查/审阅提示语、全备注报错 3 项用例）；`npm run test:desktop` 冒烟通过。
- 未实测：管理端打包分发后的子进程启动路径；Work 画布在超大工作流（≥20 节点）下的拖拽体验。

## 阶段 13（2026-09-27）：管理端 credits 化 + 全功能图形化后台

- 计费体系：改为 credits 计费，基准每百万 tokens = 100 credits；模型可配置消耗倍率 `creditRate`（如 1.00× / 0.40× / 0.16×）。桌面端 `agent.ts` → `account.ts` → `/api/usage` 透传 `modelId`，管理端按 `tokens / 1e6 × 100 × rate` 记账。
- 双滚动窗口配额：用户用量改为事件记账（`user.events = [{at, credits, tokens, modelId}]`），按 5 小时与每周两个滚动窗口分别汇总（`windowUsage`），`pruneEvents` 清理超周或超 2000 条事件。free 组默认 5 小时 50 credits、每周 666 credits。
- 订阅组：完全可配置（增删改），支持 `unlimited` 去掉某组限额；删除时至少保留一个订阅组，被删组的用户与默认组自动回落。
- 一键重置：仪表盘“一键重置所有人配额”清空全部用量事件（`POST /api/admin/reset-quota`）。
- 图形化后台：`admin-server.mjs` 内嵌单页 `page`（纯原生 JS、无依赖、深色控制台美学、抹茶绿点缀），淘汰主要 JSON textarea，改为图形化表单/表格内联编辑：登录、仪表盘（10 项统计 + 重置）、用户管理（订阅组下拉 / 角色 / 重置 / 删除）、订阅组 CRUD、内置模型 CRUD（含倍率）、广告卡片 CRUD、系统设置（公告 / 提示词 / 认证 API / 默认组 / 高级 modelOverrides·userDefaults JSON）；卡片空状态常驻可见；XSS 转义 + toast + token 持久化。
- 数据迁移：`migrateConfig` 将旧 `plan.monthlyTokens` 折算为 credits 周额度、为旧模型补 `creditRate:1`；schema、account、admin-server 三处 credits 结构同步。
- 验证：typecheck / lint / build 通过；`npm test` 83 项通过（`tests/admin.test.ts` 新增 credits 倍率记账、订阅组增删改与至少保留一个、一键重置清零共 3 项；`tests/schema.test.ts` account 用例更新为 credits 结构）；本地启动管理端根路径返回 200 图形化界面（31.8 KB，含登录页）。
- 未实测：图形化后台各面板在真实浏览器中的交互点击；大量用户/事件下的窗口汇总性能。

## 阶段 14（2026-09-27）：管理端密钥登录 + 全图形化配置

- 密钥登录：管理后台去掉用户名/密码登录，改为固定管理密钥直接进入（`ADMIN_KEY`，可用环境变量 `CUBEX_ADMIN_KEY` 覆盖）。新增 `authenticateAdmin(req)` 用 `timingSafeEqual` 常量时间比较 `Bearer <key>`；新增 `POST /api/admin/login` 校验密钥；`/api/admin/*` 全部改走密钥认证并抽取为 `handleAdmin`，与用户账号完全解耦。前端密钥存 localStorage `cubex-admin-key`，`doLogin/boot/guard/logout` 全改密钥流。
- 全图形化：淘汰系统设置中剩余的 JSON textarea。`modelOverrides` 改为卡片式编辑器（模型下拉 + 专属提示词 textarea + 5 项参数表单：温度/最大 Token/超时/重试/历史上限），`userDefaults` 改为键值对表格行（key/value + `parseVal` 自动识别数字/布尔/JSON/字符串），配 `ov-add`/`ud-add` 新增行、`st-save-overrides`/`st-save-defaults` 分别保存。
- 验证：typecheck / lint / build 通过；`npm test` 84 项通过（`tests/admin.test.ts` 新增“管理密钥登录/错误密钥拒绝”测试，spawn env 注入 `CUBEX_ADMIN_KEY`，所有 admin 路由测试改用密钥认证）。本地启动管理端 `POST /api/admin/login` 密钥登录返回 `ok=true`。
- 服务：管理端运行于 http://127.0.0.1:4800，桌面端 dev（electron-vite）已启动供测试。

## 阶段 15（2026-09-30）：0.1.2-dev 稳定性 + 自动检测模型 + GitHub 化

- 截断修复：`src/main/llm.ts` 新增 `resolveMaxTokens`（用户值优先，否则按上下文窗口取半、夹在 4096~64000），OpenAI 与 Anthropic 两条路径统一输出上限；捕获 `finish_reason:length` / `stop_reason:max_tokens` 写入 `ChatTurn.truncated`，`agent.ts` 在无工具调用时自动续写（`MAX_CONTINUATIONS=5`），上下文预留由 8000 上调到 16000。
- 工具参数截断修复：`safeArgs` 重写（`asObject`/`repairJson` 修复截断 JSON，恢复标记 `__truncated`、不可恢复标记 `__raw`），`dispatch` 与 agent 主/子循环加 `__raw` 守卫抛明确错误，write_file/edit_file 加缺参守卫。
- 自动检测：`llm.listModels`（Anthropic /v1/models、Ollama /api/tags、OpenAI /models 读 context_length）+ `guessContextWindow` 兜底表；IPC `cubex:list-provider-models` 三件套；设置面板每提供商「自动检测模型」列表+逐个添加、每模型「自动检测上下文」回填。
- UI：白底 logo 内容比例 0.72→0.88；`.question-form textarea` 最小高度翻倍（88px）；composer 输入框随字数自适应（48→120px，2.5×）。
- 版本与仓库：版本升 `0.1.2-dev`，`npm run dist` 产出 `release\Cubex Setup 0.1.2-dev.exe`；**本目录已是 git 仓库**，remote `origin` = https://github.com/dian-ZD/CubexDesktop.git，已 push 到 main（commit f57ade2）。
- 验证：typecheck / lint（0 error，7 既有 warning）/ test（77 passed, 2 skipped）通过。

## 阶段 16（2026-10-04）：上下文压缩与 Agent 循环优化

- 摘要式压缩：`agent.ts` 新增 `compactMessages`/`summarize`/`renderTranscript`，用模型把较早消息总结为结构化中文摘要（目标/结论/文件位置/未完成/约束），保留最近 10 条原文；模型不可用时退化为移除标记，保证始终可释放空间。`compactThread` 改为调用它。
- 实测上下文窗口：`llm.ts` 新增 `probeContextWindow`（二分法发送递增填充提示词，按 `isContextOverflowError` 关键词判定超限）与 `isContextOverflowError`；IPC 三件套 `probeContextWindow` 打通至设置面板，「自动检测」按钮由「列模型猜长度」改为真正实测回填。
- 用量兜底：新增 `src/shared/tokens.ts`（`estimateTokens`/`messageTokens`/`historyTokens`），主进程 `context.ts` 改为复用；渲染层 `RightPanel`/`App` 在模型不返回 usage（多数中转站）时用估算值兜底，压缩按钮不再永久禁用。
- 循环优化：主循环内「接近上下文上限（>90%）自动摘要压缩（每轮至多 3 次）」「捕获上下文超限错误后自动压缩并重试（至多 3 次）」「重复相同工具+参数调用拦截与连续空转中止」。
- 验证：`npm run typecheck` 0；`npm run lint` 0 error（10 条既有 `react-hooks/exhaustive-deps` warning）；`npm test` 86 passed + 2 skipped。

## 阶段 17（2026-10-04）：Browser 模式全网爬取

- 新工具：`toolNames` 加 `browser_crawl`（query/urls 种子、maxPages 3–20、depth 0/1，敏感操作需一次审批）与 `browser_extract_links`（结构化链接提取，读取类免审批）。
- 爬取引擎（`src/main/extensions.ts` `crawlWeb`）：种子收集（webSearch 优先，失败退化为配置搜索引擎结果页离屏抓取）→ 搜索引擎跳转链接还原 → 去重/过滤 → background=离屏窗口 3 并发并行抓正文+链接、visible=前台标签逐页打开 → depth=1 按中英文分词相关性补抓 → 按相关度排序聚合；180 秒期限 + `onControl` 实时进度。
- 结构化搜索：`browser.ts` 新增 `links` 动作；`browser_search` 返回结果列表 + `[CUBEX_SEARCH]` 标记，`RightPanel` 摘要识别 `browser_search`/`browser_crawl`（`takeJsonObject` 抗截断解析）。
- 设置与提示词：`crawlMode`/`crawlPages` 设置项 + UI + i18n；BROWSER_MODE 提示词引导调研类任务优先 `browser_crawl`。
- 验证：typecheck 0 / lint 0 error（9 既有 warning）/ test 86 passed + 2 skipped；**未做真实会话实测**。

## 阶段 18（2026-10-04）：资料报告 + 引用溯源

- 新建 `src/renderer/src/sources.ts`：`collectSources`（汇总 `web_search`/`browser_search`/`browser_crawl` 的 `[CUBEX_SEARCH]` 标记，按 URL 去重）、`takeJsonObject`（括号配平抗截断，自 RightPanel 迁出）、`parseSourceLine`/`extractSources`（解析「参考来源」小节与 `[n]` 行）、`sourcesToMarkdown`。
- 引用溯源：`Markdown.tsx` 把「参考来源」小节渲染为来源卡片，正文 `[n]` 渲染为上标角标（悬停显标题、点击打开 URL，未命中降级灰色文本）。
- 资料报告：右栏分组改为「资料报告」（来源计数 + 导出按钮）；新增通用 `exportText` IPC 导出 Markdown 报告（channels/schema/index/preload/bridge 贯通）。
- 提示词：CORE 与 BROWSER_MODE 均要求调研类回答附 `## 参考来源` 与 `[n]` 角标。
- 验证：typecheck 0 / lint 0 error（9 既有 warning）/ test 94 passed + 2 skipped（新增 `tests/citations.test.ts` 8 例）；**未做真实会话实测**。

## 下一步

1. 在 Browser 模式发一条多来源调研类任务，一次实测：`browser_crawl` 抓取与进度、回答末尾「参考来源」小节、`[n]` 角标点击跳转、右栏「资料报告」导出 `.md`；顺带验证设置页爬取两项选项。
2. 在 Electron 界面内用真实提供商实测「自动检测」上下文窗口按钮与自动摘要压缩的端到端效果。
3. 补测 Anthropic 原生接口与 Ollama；在真实场景验证超限自动恢复。
4. 交互式终端（PTY）；桌面端 OAuth 授权流程；MCP 的 HTTP / SSE 传输。
