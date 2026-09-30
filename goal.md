# CubexDesktop Goal

> 最后更新时间：2026-09-30 ｜ 更新者：AI Agent（会话交接）

## 当前任务目标（一句话）

打磨 CubexDesktop 桌面端的「外观 / 图标 / 国际化」体验并产出可安装的 0.1.1 版本；当前正处于「删除主题设置页并入外观」完成、且刚清理本地进度重编译 0.1.1 之后的状态。执行进度详见 plan.md，过程细节详见 memory.md。

### 背景与动机

- 应用图标此前为透明底，在任务栏/安装器中辨识度不足 → 需白色圆角底；应用内仅在部分位置（助手消息头像、标题栏小图标）复用圆角样式。
- 设置界面存在大量中文硬编码，切换英文时覆盖不全；字体可选项偏少 → 需全量接入 i18n 并扩充字体。
- 「主题」与「外观」两个设置分区职责重叠 → 合并，主题项并入外观。
- 用户需要一份干净的本地环境用于重新安装验证。

### 验收标准 / Definition of Done

- [x] 应用图标带白色圆角底（OS 层：任务栏/安装器/窗口）。
- [x] 应用内仅「助手消息头像 + 标题栏小图标」复用圆角 Logo，其他位置不加。
- [x] i18n 全量补全（SettingsPanel / shared 层 Zod & schedule / App / ui / Markdown）。
- [x] 字体从 9 项扩充到 16 项（schema + CSS 字体栈 + 标签翻译一致）。
- [x] 删除「主题」设置分区，主题/配色/背景三项并入「外观」分区。
- [x] `npm run typecheck`、`npm run lint`（0 error）、构建通过。
- [x] 清理本地全部 Cubex 进度数据，并重新编译出 `release\Cubex Setup 0.1.1.exe`。
- [ ] 待确认：是否需要升版本号到 0.1.2（用户此前未确认，目前保持 0.1.1）。

### 边界（不做什么 / 不改什么）

- 不改动 `src/main/index.ts`、`src/renderer/src/speech.worker.ts` 中由用户/linter 外部修改的内容（保留 createWindow 先于 buildAppIcon、MCP/scheduler 延迟、whisper ASR 流水线）。
- 删除主题分区**不删除** `schema.ts` 中 `appearance.theme/accent/background` 字段（数据层保留有效）。
- 不主动 git 提交/推送（本目录当前非 git 仓库，`git status` 返回 128）。
- 不在文档中写入任何真实密钥/令牌明文。

### 关键约束

- 技术栈：Electron 44 + React 19 + TypeScript + electron-vite + Vite 7 + electron-builder(NSIS)；详见 memory.md「技术栈与约定」。
- 编辑工具限制：`Edit` 工具不可用，改动代码用 `SearchReplace`。
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
- 上下文仅按估算 token 裁剪旧消息（`src/main/context.ts`），尚无摘要式压缩。
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

## 下一步

1. 补测 Anthropic 原生接口与 Ollama；在 Electron 界面内用真实提供商走一遍。
2. 会话摘要式压缩；交互式终端（PTY）。
3. 桌面端 OAuth 授权流程；MCP 的 HTTP / SSE 传输。
4. 补充桌面端 UI 自动化测试。
