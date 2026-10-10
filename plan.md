# 计划

> 最后更新时间：2026-10-10 ｜ 更新者：AI Agent（0.3.3-dev 第二批：Skill 标准化 + Work 画布 AI 生成工作流）
>
> 记录当前任务的拆解与进度。总目标见 goal.md，过程细节/决策见 memory.md。标记：`[ ]` 未开始 ｜ `[x]` 已完成 ｜ `[~]` 进行中。

## 当前阶段

### 当前任务：0.3.3-dev 第四批（Work 节点类型专属配置项）

用户反馈：所有 Work 节点的可配置项都只有一个「指令」，类型形同虚设。

- [x] schema：`workflowNodeSchema` 新增可选 `config: Record<string, string>`；新增 `nodeConfigFields`（shared 定义一份，UI 表单与指令拼装共用）。各类型专属字段：response（输出格式/面向对象）、image（尺寸/数量）、video（画幅/时长）、check（检查命令/失败策略）、review（审查重点/范围）、computer（目标窗口/操作）、browser（网址/提取内容）、launch（打开目标）、command（命令/工作目录）、search（关键词/范围）、file（路径/操作）、git（提交信息/是否推送）、plugin（插件/工具）、mcp（服务器/工具）、wait（等待条件）、ask（问题/候选选项）；task/note 无专属项（纯指令）。
- [x] 画布检查器：按当前类型渲染专属配置表单（text/textarea/select 三种控件），类型切换即换字段；画布节点卡片正文优先显示已填配置摘要（`标签：值；…`），无配置回落指令。
- [x] 执行链路：`composeNodeInstruction` 把已填配置注入为「## 本步参数（画布配置，必须遵守）」块（位于 hint 之后、指令之前，优先级高于模糊描述）；`workflowRunner` 透传 node.config。
- [x] AI 生成工作流：GENERATE_SYSTEM 要求把确定参数放 config（并给出各类型可用字段），`layout()` 白名单过滤（只保留该类型已定义字段的非空值）。
- [x] 持久化：preload saveWorkflow 透传 config（全空则省略）；旧工作流无 config 完全兼容。
- [x] 英文词条 60+ 条；校验 typecheck / lint 0 error / 180 passed + 4 skipped / 打包冒烟通过；重打 `release\Cubex Setup 0.3.3-dev.exe`（112,780,416 B）。

### 当前任务：0.3.3-dev 第三批（让 Cubex 主动用 subagent）

用户反馈：Cubex 不会主动用 delegate 委派子智能体。根因：subagent 机制完整（delegate 工具、并发执行、角色、profiles、审批隔离都在），但系统提示只是「顺带提了一句」，模型缺乏何时该用的明确判据。本批只改提示层，不动执行引擎。

- [x] `prompt.ts` CORE「工作方式」新增「善用 delegate 并行推进」条目：4 个明确触发条件（≥3 个互不相干文件的同类操作 / 调研+编码并行（researcher 只读）/ 改动后独立复查（reviewer）/ 大范围搜索分区并行）+ instruction 必须自包含 + 同文件禁止并行。
- [x] 会话规则 delegate 条目从平铺描述改为「委派优先」：命中 4 条件必须优先用 delegate；profiles 存在时补充 role 枚举说明（general/researcher/coder/reviewer 及只读约束）。
- [x] `tools.ts` delegate 工具 description 同步「应优先使用」+ 4 场景；instruction 参数描述强调「子智能体看不到当前对话，必须写全背景」。
- [x] `agent.ts` runSubAgent 系统提示按角色注入职责说明：coder（改文件+验证）/ researcher（只读调研）/ reviewer（复查+明确通过/不通过结论）。
- [x] Work 链路：`composeNodeInstruction` 每个节点通用追加「多而独立的子工作优先 delegate 并行，结果核对后汇总」；`workflowGenerate.ts` GENERATE_SYSTEM 增加对应规则，生成的工作流会在 prompt 中说明委派。
- [x] 校验：typecheck / lint 0 error（9 既有 warning）/ 178 passed + 4 skipped / 打包版冒烟通过；重打 `release\Cubex Setup 0.3.3-dev.exe`（112,777,969 B，SHA256 6D7D6175FB9411E3B7A55A960AC9B1D92B554F772E896F0A8C28EA7FD9C4B6AA）。
- 注意：效果依赖模型对提示的遵循度，建议实测「给 5 个文件补注释」「调研 X 并实现 Y」类任务观察是否触发 delegate；不触发再考虑加自动拆分逻辑。

### 当前任务：0.3.3-dev 第二批（Skill 标准化 + Work 画布 AI 生成工作流）

用户反馈：① skill 只是粘贴进输入框，不符合 Codex 等惯例；② 要标准 skill 格式；③ Work 工作流生成要真正生成到画布。

- [x] **Skill 调用改为 Codex 惯例的斜杠命令**：`App.tsx` 的 `pickSkill` 不再把全文塞回输入框，改为「技能内容 + 用户补充输入」立即作为一条用户消息发送（运行中自动入队，复用 send/queue 既有逻辑：建线程、压缩、busy 锁）。
- [x] **Skill 存储改为 Agent Skills 标准**：`SkillStore` 重写为目录式 `skills/<name>/SKILL.md`（YAML frontmatter name/description）+ 附加上下文文件（md/txt/json/csv/yaml，读取时追加为参考附录，渐进式披露）。单文件与 zip 导入自动转换成标准结构；id 从 `file:xxx.md` 改为 `skill:<dir>`；旧平铺单文件不再列出（需重新导入一次）。新增 tests/skills.test.ts（6 用例）。
- [x] **删除硬编码 work-builder 内置技能**；Work 画布「新建」菜单新增「AI 生成工作流…」：`ui.prompt` 收描述 → 主进程 `generateWorkflowWithModel`（`src/main/workflowGenerate.ts`）调 LLM 输出严格 JSON → `layout()` 排布坐标、越界/环/空 prompt 校验、无边自动串链 → 节点直接出现在画布（未保存，检查编辑后手动保存）。新增 IPC `cubex:generate-workflow` + schema + preload/bridge 接线。
- [x] 校验：typecheck 通过、lint 0 error（9 既有 warning）、178 passed / 4 skipped。
- [x] 重新打包 `release\Cubex Setup 0.3.3-dev.exe`（112,777,160 B，SHA256 61244311C6F739F929C94FB5431C430B32C4A005EA582E6F3548A93E76261D5A），打包版桌面冒烟通过。

### 当前任务：0.3.3-dev 第一批（独立桌面清理 + 悬浮窗任务级常驻 + Work 专用节点 + 视频设置）

- [x] 独立桌面生命周期：从「电脑操控模式」切回当前桌面（保存设置时）→ 关闭 `CubexAgent` 隔离桌面并停止镜像；操控任务结束（线程 idle 且无 pending/question/queue）→ 同样关闭隔离桌面与镜像，不再残留黑屏桌面。运行态 `controlThreadId` 与持久化设置分离。
- [x] 悬浮窗任务级常驻：第一次真实浏览器/电脑操控弹出后不再随单次工具结束收起，直到用户手动关闭（关闭后该任务内不再自动弹出，手动重开解除抑制）或任务结束自动关闭；仅搜索/生图等后台操作不触发弹窗（排除 `正在生成图片：` 前缀的 computer 回调）。
- [x] Work 模式新增节点类型 `response`（模型回复）、`image`（图片生成）、`video`（视频生成）：schema 枚举、画布 kindMeta 图标标签、`composeNodeInstruction`/`kindHints` 专用指令提示均已接入。
- [x] 设置新增「视频生成 · 提供商」分组（`settings.video`：providerId / modelId / size / seconds），位于生图配置之后；schema 迁移 `mergeGroup(videoSettingsSchema, …)` 兼容旧 state.json，非法单项丢弃不重置整组。
- [x] 队列消息溢出：`.queue-item` 补 `min-width: 0`，内容不再撑破容器。
- [x] ~~内置技能 `builtin:work-builder`~~（第二批已删除，改为 Work 画布「AI 生成工作流」入口，见上方第二批记录）。
- [x] 英文词条：视频设置、Work 新节点、技能说明共 20+ 条已登记进 phrases。
- [x] 校验：typecheck 通过、lint 0 error（既有 9 条 hooks warning）、测试 172 passed / 4 skipped（新增视频设置迁移 + Work 节点类型回归）。
- [x] 打包 `release\Cubex Setup 0.3.3-dev.exe`（112,775,718 B，SHA256 F1208F06BE964798D108774B52526E9172D5D419F59E38209E2D0E94FD9A00B5）；首次 dist 因残留 Cubex.exe 占用 win-unpacked 失败（Access is denied），清进程后重跑成功；打包版桌面冒烟通过（smoke-ready）。
- [~] 已提交本地 `609ab1d`（14 文件）；push 到 origin/main 暂时失败（github.com:443 连不上，连续两次超时），网络恢复后重试 `git push origin main` 并用 `git ls-remote` 核对。

下一步第一件事：网络恢复后推送 `609ab1d`；等用户安装 `release\Cubex Setup 0.3.3-dev.exe` 实测（独立桌面切换/任务结束后的清理、悬浮窗常驻与手动关闭、Work 新节点、视频设置、/生成 工作流技能）。

### 当前任务：0.3.2-dev 修补（滑条不可拖动 + 色彩条不完整）

- [x] 根因：`.volume-row input[type='range'] { flex: 1 }` 换成自绘滑条时**替换没生效**（脚本里该 replace 静默失败，只有另一处插入成功），`.slider` 没拿到弹性宽度 → `flex-basis: auto` + 无内容 → **实测宽度 0**，看不见也拖不动（用户报「透明度调整拖动不了」）。已显式补 `.volume-row .slider { flex: 1 1 0%; min-width: 0 }`。
- [x] 色彩条左端缺口：填充条原来从「半个滑块半径」起步（`left: 8px` / `left: 10px`），左端留白。改为 `left: 0` + JS 宽度 `calc(滑块半径 + 比例 * (100% - 2*半径))`，比例 0 时宽度取 `0px` 避免出现小凸起；设置滑条与思考强度滑条统一。实测填充条左端贴轨道（gap 0）、末端与滑块中心重合。
- [x] 用 CDP 真实鼠标事件（`Input.dispatchMouseEvent`）复验：悬浮窗透明度滑条宽度 636px、按下即到 31%、连续拖动 31→36→43→49→56→63；提示音音量滑条 50→100（过 20/55/90）。**教训：合成 PointerEvent 量不出点不到的问题，必须用真实输入事件 + 先 `scrollIntoView`（探针第二次量到 y=1816 在视口外，误判为不生效）。**
- [x] 版本 0.3.1-dev → **0.3.2-dev**（0.3.1-dev 已推送过但自绘滑条不可拖属明显回归，升一个小修订号便于区分）；typecheck、lint（0 error / 9 既有 warning）、171 passed / 4 skipped、打包版桌面冒烟均通过；dist 产出 `release\Cubex Setup 0.3.2-dev.exe`（112,773,932 B，SHA256 A3B6FB6C2C653137A588E862F77B92BDE90F0D7A51C54423ABE19AC3CBA2BE77），并用真实鼠标事件在打包版复验两条滑条连续拖动生效。

下一步第一件事：等用户实测最新安装包；确认滑条可拖动、色彩条完整后，如需再迭代问题仍从 `styles.css` 变量与自绘滑条入手。

### 当前任务：0.3.1-dev 打磨（透明度、圆角、拖动、滑条对齐、报错来源）

- [x] 根因修复：`styles.css` 里 `--bg-panel`/`--accent`/`--surface`/`--border`/`--text-secondary`/`--matcha-dim` 六个变量从未定义，导致悬浮窗与模型弹层背景透明、多处边框失效。已在深浅两套主题中补齐（实测弹层背景 rgb(35,37,42) 不透明、悬浮窗窗口背景同色）。
- [x] 悬浮窗灰色尖角：`transparent: true` 的无边框窗口在 Windows 上圆角外会露出 DWM 灰色残留。改为不透明窗口（`backgroundColor` 随主题切换）+ CSS 12px 圆角，`publish()` 里同步 `applyFloatingOpacity()`，透明度与主题改动即时生效（实测拖到 100% 后 state.json 落盘 opacity=1）。
- [x] 悬浮窗无法拖动：`.floating-window` 的 `-webkit-app-region: drag` 被子元素 `.floating-panel` 的 `no-drag` 整体覆盖。改为标题栏 `drag`、按钮 `no-drag`（实测 computed style 分别为 drag / no-drag）。
- [x] 思考强度刻度错位：滑块、刻度点、填充条各用一套坐标。统一为「半径内缩」公式 `calc(10px + ratio * (100% - 20px))`（`THUMB` 常量）。实测低档 thumb=445.9 = dots[0] = fillRight，高档 702.7 = dots[3] = fillRight。
- [x] 模型选择按钮去掉描边（实测 borderTopColor rgba(0,0,0,0)）。
- [x] 设置里的滑条改为自绘 `Slider`（轨道 + 填充 + 滑块 + 磁吸回弹），原生 `input[type=range]` 在端点处右侧留白、填充与滑块不对齐的问题一并解决；提示音音量与悬浮窗透明度两处都已替换。
- [x] 「Failed to open path」定位：Electron `shell.openPath()` 对不存在/不可打开的路径返回的正是这个英文串（已用 electron 单测复现）。`computer_use open` 工具改为：相对路径按项目根目录解析、未注册关联的应用名回落系统 `start`、路径不存在时给出中文可操作提示。
- [x] 语音：新增「模型下载源」设置（自动 / 官方 / 国内镜像 hf-mirror），auto 先试官方、失败自动切镜像重试，每个源各自缓存；下载失败时提示可更换下载源。「没有识别到语音内容」从 error 降级为 info 提示，不再当报错弹。
- [x] i18n 收口：扫描全部 `tr('…')` 字面量共 835 条，补上缺失/未登记的 56 条英文词条（新增 `miscPhrases` Record 并注册），现已 0 缺失。
- [x] 版本号 0.2.2-dev → 0.3.1-dev；typecheck 通过、lint 0 error / 9 既有 warning、171 passed / 4 skipped；dist 产出 release\Cubex Setup 0.3.1-dev.exe（112,773,865 B，SHA256 A8BACB45EB2E44D2D3072E2AFB40F43EF32C288A3E1973FEB961E7E9B79B4266）。
- [x] 按用户明确指示 commit 并 push 到 origin/main：功能提交 `36bd6c9`、i18n/文档提交 `3baeee7` 均已在远端（push 后 `git ls-remote origin main` 核对），本行为其后的文档补记提交。

下一步第一件事：请用户安装 release\Cubex Setup 0.3.1-dev.exe 实测（中文语音、悬浮窗拖动与透明度、模型选择器、打开文件路径报错）；若有新问题继续在 0.3.x 迭代。VocoType（FunASR 引擎）暂未接入，用户选择保持在线下载 + 国内镜像。


### 当前任务：电脑操控增强、任务悬浮窗、思考等级，以及复制/回退修复

- [x] 电脑操控新增拖拽、双击、右键、只移动鼠标、滚动；当前桌面模式用 GetLastInputInfo 检测键鼠占用并等待空闲，独立桌面模式完全不碰用户鼠标。
- [x] 新增独立 Windows 桌面（`CubexAgent`，PowerShell P/Invoke 创建桌面、启动进程、GDI 截屏、按标题枚举窗口并以 PostMessage 点击/输入）。已实测：在独立桌面启动记事本、按标题找到窗口、点击与按键成功、截图有实际内容。
- [x] 右下角置顶悬浮窗：可查看任务、待办、最近消息与追问选项，可随时插话、停止回复；透明度可调（最低 30%）、可自动弹出，标题栏可手动打开。
- [x] 独立桌面实时镜像：操控独立桌面时按设置把画面推送到悬浮窗小窗，可在设置中关闭。
- [x] 模型选择改为 Codex 风格（模型名 + 点击弹出列表），下方四档思考强度滑条；随强度切换边框/徽标样式，不支持的模型标注「不支持思考强度」。思考强度经 `reasoning_effort`（OpenAI 兼容）与 Anthropic `thinking.budget_tokens` 下发。
- [x] 语音输入修复：打包后页面来自 asar 内 file://，其中 Web Worker 起不来（sandbox bundle 报 preloadScripts 为 null），改为渲染进程主线程动态加载 @xenova/transformers；index.html CSP 放行 wasm-unsafe-eval 与模型/wasm 域名。打包版实测录音→识别→回填输入框全通过。
- [x] 复制修复：渲染进程 `navigator.clipboard` 在窗口未聚焦时直接失败（实测 NotAllowedError: Document is not focused），全部复制改走主进程 clipboard IPC。实测窗口失焦也能复制成功。
- [x] 回退到此消息之前：把该消息文字与附件放回输入框（已有内容则追加换行），确认弹窗文案同步更新。实测 4 条消息回退到 2 条，文字与 1 个附件都回到输入框。
- [x] 收尾校验：typecheck 通过、lint 0 error / 9 既有 warning、166 passed / 4 skipped；npm run dist 生成 release\Cubex Setup 0.2.2-dev.exe（112,770,346 B），打包版隔离冒烟通过；复制、回退、模型选择器、悬浮窗与镜像、语音均在打包版实测通过。

下一步第一件事：等待用户安装或使用反馈；若用户要求发布或提交，再执行 commit/push。源码和 out 已更新；release 安装包已包含本轮全部改动。

### 当前任务：补充 README 并推送 GitHub

- [x] 已创建仓库入口文档 README.md，覆盖项目简介、功能、安装/开发命令、配置、AOCI 初始化、目录结构、开发约定、已知限制与许可。
- [x] 网络恢复后已推送到 dian-ZD/CubexDesktop 的 main，远端为 0ac1d4f8729f278b35a3947b49f7ceac9548a4d9，工作区干净。

下一步第一件事：根据用户的新需求继续工作；不要重复创建 README 提交。不要提交安装包、缓存或 release/

说明：目录中还有未处理的“消息发送延迟与 AOCI 不可用”排查结论，需等用户进一步指示是否纳入本轮修复。

### 当前任务：定位发送消息延迟与 AOCI 不可用

- [~] 排查发送消息为何可能长时间无可见反馈，以及 AOCI 连接或工具同步失败的条件。
- [ ] 根据根因提出并实现最小安全修复，确保发送后立即有状态反馈，AOCI 失败时给出可执行提示。
- [ ] 完成针对性验证、全量校验并回填文档；真实模型端点与 AOCI 成功连接状态仍需实测确认。

下一步第一件事：检查 sendMessage IPC、AgentRunner 初始状态更新、MCP/AOCI 同步阻塞路径，以及打包版和源码版的 AOCI 子进程配置。

- [x] 已核对本地 main、origin 地址和待提交文件，diff 检查通过；网络恢复后 fetch 成功，推送前本地领先远端 1 个提交、无落后提交。
- [x] 已完成本地提交 d763f3d65c73452230435c0663d38ffb2bbdab46，包含 31 个文件的 0.2.2-dev 及此前增强；提交后工作区干净。
- [x] 网络恢复后已推送到 dian-ZD/CubexDesktop 的 main 分支，远端由 9ea6de1 更新至 d763f3d。
- [x] ls-remote 已确认远端功能提交为 d763f3d65c73452230435c0663d38ffb2bbdab46，与本地一致；功能代码推送完成，后续文档提交仅记录本次结果。

功能提交已成功上传。下一步第一件事：收到新的使用反馈后继续定位具体问题；不要重复创建功能提交。release/ 按现有规则忽略，安装包仍保存在本机，未上传为 GitHub Release 附件。文档提交后的最终远端 HEAD 与工作区状态以本次交付时的 Git 核对结果为准。

### 当前任务：开放 HTTP 端点并生成 0.2.2-dev 安装包

- [x] 已开放普通 HTTP 模型端点，同步中英文提示与端点测试；package.json 和锁文件版本为 0.2.2-dev，版权为 Copyright © 2026 HIGHLIGHT STUDIO。typecheck、lint（0 error / 9 既有 warning）、158 passed / 4 skipped 验证通过。
- [x] npm run dist 成功生成 release\Cubex Setup 0.2.2-dev.exe，大小 112,742,496 B；打包版隔离冒烟通过。
- [x] 已核对安装包版本 0.2.2-dev、版权 Copyright © 2026 HIGHLIGHT STUDIO（含 © 字符）；签名状态为 NotSigned。asar 内版本正确，19 个构建文件与当前 out 逐字节一致。四份上下文文档已同步，最终 diff 检查返回 0，Cubex/electron 进程数为 0。

本轮已完成，安装包位于 release\Cubex Setup 0.2.2-dev.exe。该包包含此前文件编辑、推荐选项、请求处理、消息滚动、多子智能体及 Browser 显示范围修复；未执行 commit/push。下一步第一件事：收到安装或实际使用反馈后定位具体问题；当前没有待执行的代码或打包步骤。

### 当前任务：Browser 网页仅在自己的页面显示

- [x] 已定位：BrowserEngine 的工具动作与手动导航无条件 attach，会重新挂载已隐藏的网页；异步标签操作回调还可能重新上报过期尺寸。
- [x] 已限制导航和工具动作只更新当前可见工作台，隐藏时清除尺寸；渲染端拦截弹窗及卸载后的过期尺寸回调。13 项 browser 测试及真实 Electron 原生视图回归通过：隐藏后加载完成、后续动作和后台会话均不重新覆盖当前页面，切回工作台可恢复显示。
- [x] 验证完成：typecheck 通过、lint 0 error / 9 既有 warning、全量 157 passed / 4 skipped；build、test:desktop 和原生视图回归通过，git diff --check（识别 CRLF）返回 0，本轮回归/冒烟匹配进程为 0。上下文文档已同步。

下一步第一件事：在更新后的构建中使用 Browser，确认加载期间切换其他页面不再被网页遮挡；若用户要求发布，再重新打包。源码和 out 已更新，现有 release 安装包不包含本轮修复；未 commit/push。

### 当前任务：文件编辑、模型请求与设置、推荐选项

- [x] 已核对文件读写 IPC、预览/变更面板、请求计时与响应体解析、询问生命周期及设置布局；确认原有重试只覆盖建立响应阶段，响应体内服务端超时未被重试。
- [x] 文件预览与变更面板可编辑、保存；相关测试和隔离 Electron UI 验证通过，覆盖跨面板草稿保留、CRLF 换行、外部修改冲突、截断文件禁止保存。
- [x] 响应体内上游超时纳入有界重试；已有文本后不重放请求，持久保存部分输出供“继续”使用。测试覆盖两类协议、重试耗尽、取消及响应体释放。服务商实际超时尚未进行真实端点复测，客户端修改不能消除上游服务故障。
- [x] 模型设置输入框、按钮和参数区支持收缩与换行；隔离 Electron 验证 1400px、900px 窗口下相关区域无横向溢出。
- [x] 错误消息提示条右侧增加“继续”，仅当前会话末尾错误在空闲时可用；UI 验证连续点击只发送一次“继续”，且保留输入框草稿。
- [x] 推荐项标题右侧显示高亮点；设置 → 规则与记忆增加“自动选择推荐项”，默认关闭。单元测试覆盖有效/无效推荐、手动替代选择、取消和配置迁移；UI 验证开关自动保存生效。
- [x] 收尾完成：typecheck 通过、lint 0 error / 9 既有 warning、153 passed / 4 skipped，build、test:desktop、针对性隔离 Electron UI 回归均通过；四份上下文文档已更新，识别 CRLF 行尾的 git diff --check 返回 0。隔离回归/冒烟匹配进程为 0；另有 6 个 Cubex 进程仍运行，未终止，不能宣称所有应用进程均已退出。

下一步第一件事：收到真实端点的使用反馈后，结合提供商、模型及错误发生阶段继续定位上游超时；如用户要求发布，再重新打包并核对产物。源码和 out 已更新；release 安装包仍为前序产物，本轮未 commit、push 或重新打安装包。真实模型端点超时是否缓解需实际使用反馈，不能把模拟测试通过等同于服务商恢复。

### 本轮任务：消息滚动与多子智能体增强

- [x] 修复消息自动跟随：贴底意图独立记录，ResizeObserver 处理内容增高；Electron 回归验证大段更新、流式输出贴底，以及上翻后新消息不挤走阅读位置。
- [x] 消息区初始显示 8 条、每批加载 8 条；所有消息类型补齐定位 ID。Electron 回归验证历史加载锚点、导航只展开目标附近消息、返回最新消息。
- [x] 增强 delegate：每批 1–32 项，并发可设 1–16（默认 8）；配置独立模型、角色和工具权限。设置入口位于「规则与记忆」，进度与结果位于右栏「摘要」；配置 UI、进度卡片及展开详情通过 Electron 回归。
- [x] 审批串行排队并隔离子任务调用 ID；测试覆盖同 ID 不串审批、取消释放等待、单项模型缺失不阻塞其它任务及只读越权拦截。
- [x] 收尾核对完成：typecheck 通过、lint 0 error / 9 既有 warning、137 passed / 4 skipped；build、桌面冒烟和隔离 Electron UI 回归通过。四份上下文文档已回填，git diff --check 通过，未发现本轮回归或冒烟测试遗留进程。

本轮已完成并验证。源码与 out 构建已更新；release 下此前的 0.2.1 安装包尚未包含本轮改动。下一步：收到实际使用反馈后定位具体问题；若用户要求发布，重新打包并核对产物。保留询问框 72–180px 与版本 0.2.1 等未提交改动；未执行 commit、push 或重新生成安装包。

0.1.2-dev 稳定性修复 + 自动检测模型/上下文 + Browser 模式 + 上下文压缩与 Agent 循环优化 **均已完成**；队列栏与引导交互优化完成；Browser 模式全网爬取完成；资料报告 + 引用溯源完成；**zip 分支合并（沙箱修复 + Linux 移植 + 工作流 DAG）完成**；**安装包体积优化完成**；**自动化改为独立页面（不再藏在设置里）完成**；**Code/Work/Browser 模式选择器从标题栏移入侧栏完成**；**设置新增「Beta 功能」栏目并接入 aoci-code + agent-core 完成**；**版本升到 0.2.1 并产出安装包**：typecheck 0 / lint 0 error / test 130 passed + 4 skipped。

## 步骤清单（近期已完成）

### 步骤 G：资料报告 + 引用溯源 —— [x]

- 目标：把 `browser_crawl`/`browser_search`/`web_search` 抓回的资料变成可消费的成果——回答带 `[n]` 引用角标可点开来源，右栏生成可导出的「资料报告」。
- 涉及文件：`src/renderer/src/sources.ts`（新建）、`src/renderer/src/Markdown.tsx`、`src/renderer/src/RightPanel.tsx`、`src/main/prompt.ts`、`src/shared/channels.ts`、`src/shared/schema.ts`、`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/src/bridge.ts`、`src/renderer/src/phrases.ts`、`src/renderer/src/styles.css`、`tests/citations.test.ts`（新建）。
- 产出：
  - 共享解析模块 `sources.ts`：`takeJsonObject`（自 RightPanel 迁出，括号配平抗截断）、`collectSources(thread)`（三种搜索/爬取工具的 `[CUBEX_SEARCH]` 标记汇总，按 URL 去重保序）、`parseSourceLine`（`1. 标题 — url` / `[2] 标题 url` / `3、url` 等写法，剥离尾部中英文标点）、`extractSources`（只取「参考来源」小节，遇下一标题即止）、`sourcesToMarkdown`（导出报告，含被引用编号）。
  - 引用溯源：`Markdown.tsx` 新增 `sources` 块（来源卡片列表）与 `cite`/`CiteToken`（正文 `[n]` 渲染为上标角标，命中来源则悬停显示标题、点击打开 URL；未命中降级为灰色纯文本）；`extractSources` 在 `Markdown` 顶层一次提取、经参数下传。
  - 资料报告：右栏分组由「联网搜索」改为「资料报告」，头部显示来源计数 + 「导出」按钮（`api.exportText` 保存为 `.md` 并在文件夹中显示）。
  - 新增通用 `exportText` IPC（title/defaultName/content → 保存对话框，复用 exportThread 模式），贯通 channels/schema/preload/bridge。
  - 提示词：BROWSER_MODE「作答与收尾」要求调研类回答末尾附 `## 参考来源`（`1. 标题 — https://…`）且正文标 `[n]`；CORE「工具使用」对 `web_search` 提同样要求（模板字符串内反引号已转义）。
  - i18n：`资料报告`/`导出`/`导出资料报告`/`导出 Markdown 报告`/`请在桌面应用中使用`；样式 `.md-cite`/`.md-cite-plain`/`.md-sources`/`.panel-action`。
- 验证：typecheck 0 / lint 0 error（9 既有 warning）/ test 94 passed + 2 skipped（新增 `tests/citations.test.ts` 8 例）。
- 结论：完成，**尚未在真实会话里实测角标点击与报告导出**。

### 步骤 F：Browser 模式全网爬取 —— [x]

- 目标：Browser 模式不再只靠逐页点读，能「全网爬取相关信息」；经选择题确认：两者都做（新聚合爬取工具 + browser_search 结构化结果），呈现方式两种可选（后台并行带进度 / 前台逐页可见）。
- 涉及文件：`src/shared/schema.ts`、`src/main/tools.ts`、`src/main/browser.ts`、`src/main/extensions.ts`、`src/main/prompt.ts`、`src/renderer/src/SettingsPanel.tsx`、`src/renderer/src/RightPanel.tsx`、`src/renderer/src/App.tsx`、`src/renderer/src/phrases.ts`、`tests/browser.test.ts`。
- 产出：
  - schema：`toolNames` 加 `browser_crawl`/`browser_extract_links`；`browserSettingsSchema` 加 `crawlMode`（background/visible，默认 background）与 `crawlPages`（3–20，默认 8），`migrateState` 自动补齐。
  - 工具集合：两新工具入 `browserTools`/`extensionToolNames`，`browser_crawl` 入 `sensitiveExtensionTools`（整次爬取只需一次审批）；`summarizeCall` 摘要。
  - 引擎：`browser.ts` 新增 `links` 动作（结构化提取 a[href] → title/url/text/snippet，支持 selector 限定）。
  - 核心 `crawlWeb`（extensions.ts）：种子收集（query → webSearch，失败退化为配置搜索引擎结果页离屏抓取；或直接 urls）→ Bing /ck/a、DuckDuckGo /l/?uddg、百度 /link 解析 → 去重过滤（搜索引擎自身页/静态资源后缀）→ background=离屏窗口 3 并发并行抓正文+链接 / visible=前台标签逐页打开 → depth=1 按中英文分词相关性补抓 → 按相关度排序聚合（含来源列表、失败清单），180 秒期限与 maxPages 上限，`onControl` 实时进度（`浏览器：后台爬取 3/8 · url`）。
  - `browser_search` 增强：打开结果页后额外返回结构化结果列表 + `[CUBEX_SEARCH]` 标记；`browser_crawl` 输出同样带标记；`RightPanel` 任务摘要识别 `browser_search`/`browser_crawl` 的搜索结果（新增 `takeJsonObject` 括号配平解析，抗 40k 截断，标记置于输出前部）。
  - 提示词：BROWSER_MODE 加 `browser_crawl`/`browser_extract_links` 说明，查资料/对比/调研类优先爬取；修订「唯一搜索方式」表述为「唯一批量抓取途径是 browser_crawl」。
  - 设置 UI：Browser 分区新增「全网爬取方式」「单次爬取最多页数」；i18n 词条与审批说明「将批量打开并抓取多个网页内容」；`toolTitle` 加 default 回退避免新工具 chip 无标题。
- 验证：typecheck 0 / lint 0 error（9 既有 warning）/ test 86 passed + 2 skipped。
- 结论：完成。

### 步骤 E：队列发送与排队项引导交互优化 —— [x]

- 目标：运行中发送直接加入队列；输入框右侧移除引导按钮；在排队栏每项右侧添加引导按钮（点击可立即将该排队消息作为引导注入当前任务）。
- 涉及文件：`src/renderer/src/App.tsx`、`src/renderer/src/styles.css`、`src/renderer/src/phrases.ts`。
- 产出：
  - `send()` 在任务运行中时默认直接调用 `queue()` 加入排队并清空输入框与提示。
  - 移除输入框右侧单独的 `steer`（闪电）引导按钮与对应的多余逻辑，运行中仅保留「加入队列」与「停止」。
  - 排队栏列表中的每项（`.queue-item`）右侧新增操作按钮组（`.queue-item-actions`），包含引导按钮 `<Zap />`（绿色 matcha 强调色高亮）和移除按钮 `<X />`。
  - 新增 `steerQueued(id)`：从队列中移除并直接调用 `api.steerMessage` 立即注入当前任务。
  - 补全英文国际化（i18n）文案。
- 验证：typecheck 0 / lint 0 error（9 既有 warning）/ test 86 passed。
- 结论：完成。

### 步骤 A：修复工具/输出截断 —— [x]

- 目标：根治「写入过长被截断」「工具参数被截断」「输出莫名截断」三类问题。
- 涉及文件：`src/main/llm.ts`、`src/main/tools.ts`、`src/main/agent.ts`。
- 产出：`resolveMaxTokens` 统一两协议默认输出上限（用户值优先，否则上下文/2 夹在 4096~64000）；`safeArgs`+`repairJson` 修复截断 JSON，`__raw`/`__truncated` 标记；dispatch/agent `__raw` 守卫；write/edit 缺参守卫；`ChatTurn.truncated` + `finish_reason:length`/`stop_reason:max_tokens` 捕获 + 自动续写（MAX_CONTINUATIONS=5）；上下文预留 8000→16000。
- 验证：typecheck 0 / lint 0 error / test 77 passed。
- 结论：完成。

### 步骤 B：自动检测可用模型 + 上下文长度 —— [x]

- 目标：设置页一键拉取提供商可用模型并自动填充上下文长度。
- 涉及文件：`src/main/llm.ts`、`src/shared/channels.ts`、`src/shared/schema.ts`、`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/src/SettingsPanel.tsx`、`src/renderer/src/bridge.ts`。
- 产出：`listModels`（Anthropic/Ollama/OpenAI 三类）+ `guessContextWindow` 兜底表；IPC 三件套；设置面板「自动检测模型」列表+逐个添加、「自动检测上下文」回填。
- 验证：typecheck 0 / lint 0 error / test 77 passed。
- 结论：完成。

### 步骤 C：UI 微调 + 编译 0.1.2-dev + 推 GitHub —— [x]

- 目标：白底 logo 放大、询问框加高、输入框自适应；编译 0.1.2-dev 并推送 GitHub。
- 涉及文件：`src/renderer/src/Logo.tsx`（0.72→0.88）、`src/renderer/src/App.tsx`（输入框自适应）、`src/renderer/src/styles.css`、`package.json`（0.1.2-dev）。
- 产出：`release\Cubex Setup 0.1.2-dev.exe`；push 到 `dian-ZD/CubexDesktop` main（commit f57ade2）。
- 结论：完成。

### 步骤 D：UI/交互/提示词批量优化（11 项） —— [x]

- 目标：一次性处理用户提出的 11 项体验与提示词问题。
- 涉及文件：`src/main/index.ts`、`src/main/prompt.ts`、`src/main/projectFiles.ts`、`src/main/skills.ts`、`src/renderer/src/App.tsx`、`src/renderer/src/RightPanel.tsx`、`src/renderer/src/styles.css`、`src/renderer/src/phrases.ts`、`src/renderer/index.html`、`src/shared/schema.ts`。
- 产出：
  - r1 右栏内置浏览器可访问任意外网：`will-attach-webview` 仅放行 `persist:cubex-preview` 分区并降权（去 preload、sandbox、webSecurity），webview 类型窗口 http/https 交系统浏览器；新增 `hardenPreviewSession`。
  - r2 切页/切线程保持滚动位置：按线程记忆 scrollTop，恢复优先用保存值否则到底；仅在贴近底部时才自动跟随流式输出。
  - r3 消息按需加载：默认渲染最近 20 条，顶部「加载更早」按钮 + 上滚自动加载并保持视口。
  - r4 侧栏文字溢出：`.nav-row` 加 `min-width:0/overflow:hidden`，图标/计数/状态点 `flex:0 0 auto`。
  - r5 去掉任务待办卡片渐变，改纯 `--bg-elevated`。
  - r6 任务摘要除「待办」外所有分组各自内部分页（每页 10）+「上一页/下一页」与「页码/总页」翻页器（`usePaged`/`SummaryPager`/`SearchGroup`）。
  - r7 消息区最左侧垂直导航点（每个用户消息一个，hover 显示预览、>10 字省略、点击定位）；待办卡片同逻辑状态点。
  - r8 默认主题改亮色（`schema.ts` 默认 `theme:'light'`，强调色本就 matcha），`index.html` 预置 `data-theme=light`；本体已圆角；NSIS 安装窗口不做不可靠圆角（用户选“只做可控项”）。
  - r9 新增内置「写插件」skill，按 plugins.md 协议脚手架本地插件。
  - r10 强化四个参考文件（goal/plan/memory/agents.md）读取/更新铁律（`PROJECT_FILE_RULES` 重写；机制本就在 agent.ts 每步注入，此处强调强制更新）。
  - r11 系统提示词新增「准确性与自我约束」段，遏制编造、越界、谎报完成等不符合预期行为。
- 验证：typecheck 0 / lint 0 error（7 条既有 `tr` 依赖 warning）/ test 77 passed。
- 结论：完成。

## 步骤清单（Browser 模式 — 已完成，落地顺序）

> 实时画面最终采用 **WebContentsView 内嵌**（用户确认）：主进程 `addChildView` 挂载真实可交互视图，前端上报 frame bounds 用 `setBounds` 定位；每线程独立租约（lease Map，同一时刻仅挂一个）。

### 步骤 1：schema mode 下沉 + BrowserEngine —— [x]

- `src/shared/schema.ts`：`threadSchema` 加 `mode: enum(['code','work','browser']).optional()`，导出 `AgentMode`。
- 新建 `src/main/browser.ts`：任务隔离会话（partition per threadId）、可见 BrowserWindow、动作原语（navigate/click/type/press/scroll/waitFor/extract/screenshot/evaluate）、租约冻结、每步取证（`{ok,verified,title,url,screenshot,snippet}`）。复用现有离屏窗口安全加固。

### 步骤 2：浏览器工具 + agent 模式感知 —— [x]

- `src/main/tools.ts` toolNames 新增 `browser_navigate/click/type/extract/screenshot/wait`（保留旧 `browser_open`）。
- `src/main/extensions.ts` dispatch 路由到 BrowserEngine + 审批（sensitiveExtensionTools）+ `onControl({kind:'browser'})`。
- `src/main/agent.ts` 按 `thread.mode` 注入 prompt 段；`src/main/prompt.ts` 增加 Browser 模式提示（每步 extract/screenshot 验证再继续）。

### 步骤 3：IPC/preload/bridge + 实时帧 —— [x]

- channels/schema/index/preload：`browserAction`、`browserFrame`（截图流事件）、`browserSessionClose`。
- bridge.ts 补 stub。

### 步骤 4：前端 BrowserWorkspace —— [x]

- App.tsx：`view` 加 `'browser'`、radiogroup 第三按钮 `<Globe/> Browser`、workspace 分支渲染、panelMode/标题/快捷键联动。
- 新建 `BrowserWorkspace.tsx`：混合形态（对话子视图复用 MessageView + 编排子视图参考 WorkflowCanvas）+ 实时画面（消费 browserFrame）+ 地址栏。

### 步骤 5：设置分区 + i18n + 样式 —— [x]

- SettingsPanel 新增 browser 分区（起始页/逐步审批/租约时长/下载与新窗口策略/UA）；phrases.ts 文案；styles.css `.browser-workspace`/`.browser-frame` 及三按钮 mode-switch 适配。

### 步骤 6：测试 + 冒烟 + 全量校验 —— [x]

- 新建 `tests/browser.test.ts`（9 例）：mode 注入/不注入 prompt 分支、六个浏览器工具集合与敏感集、`summarizeCall` 摘要、`threadSchema`/`createThreadInputSchema`/`browserBounds`/`browserNavigate`/`browserState` 校验、settings `browser` 分组默认值与 `migrateState` 补齐、`browserEngine.setOptions/setWindow/state/hasSession`（mock electron）。
- 冒烟沿用 `scripts/desktop-smoke.mjs`：启动即触发 `browserEngine.setWindow + setOptions`（index.ts:300-303），已通过 `[cubex] smoke-ready`。navigate/extract 需真实网络与租约窗口，交由单测的动作/schema 层覆盖。
- 验证：`npm run typecheck`=0 / `npm run lint`=0 error（7 既有 `tr` warning）/ `npm test`=86 passed（2 skipped live）/ `npm run build` ✅ / smoke ✅。

## 步骤清单（上下文压缩与 Agent 循环优化 — 已完成）

> 需求原文：「怎么没办法压缩上下文 优化agent循环机制 上下文检测用这个工具（jishuzhan.net/article/2065976861796167682）」。经选择题确认：压缩方式=LLM 摘要式；上下文检测=改造设置里已有的「自动检测」按钮为二分法实测；循环优化=全选（超限自动恢复 / 接近上限自动压缩 / 用量计算修复 / 步数与空转治理）。

### 步骤 1：共享 token 模块 + 用量兜底 —— [x]

- 新建 `src/shared/tokens.ts`：`estimateTokens`/`messageTokens`/`historyTokens`；`src/main/context.ts` 改为复用并保留 re-export（`tests/context.test.ts` 依赖 `estimateTokens` 从 context 导出）。
- `RightPanel.tsx`/`App.tsx`：最后一次助手 usage 缺失时用 `historyTokens(messages)` 兜底，修复中转站不返回 usage 导致压缩按钮永久禁用的根因。

### 步骤 2：二分法实测上下文窗口 —— [x]

- `llm.ts`：新增 `probeContextWindow`（从已知/猜测值起，按需倍增上界后二分，关键词识别超限）与 `isContextOverflowError`。
- 三件套打通：`channels.probeContextWindow` + `probeContextWindowInputSchema`/`ContextProbeInfo`/`CubexAPI` + main IPC handler + preload + renderer bridge（含预览 stub）。
- `SettingsPanel.tsx`：`detectContext` 改调 `api.probeContextWindow` 实测并回填，新增 `info` 状态显示实测结果。

### 步骤 3：compactThread 改 LLM 摘要式 —— [x]

- `agent.ts` 新增 `compactMessages`/`summarize`/`renderTranscript`：保留最近 10 条，较早消息交模型总结为结构化中文摘要；模型不可用退化为移除标记。`compactThread`（公共入口，仍要求 idle）改为调用 `compactMessages`。

### 步骤 4：循环治理（自动压缩 / 超限恢复 / 空转） —— [x]

- 主循环顶部：估算占用 > 90% 窗口时自动摘要压缩（每轮至多 3 次），压缩后 `step--` 重来。
- `streamChat` 捕获：`isContextOverflowError` 命中且可压缩时自动压缩并重试（至多 3 次）。
- 空转治理：相同「工具+参数」签名第 4 次起拦截，连续两步整步被拦截则中止本轮并提示。

### 步骤 5：校验 + 文档 —— [x]

- `npm run typecheck`=0；`npm run lint`=0 error（9 条既有 warning）；`npm test`=94 passed + 2 skipped（新增 citations 测试）。
- 同步刷新 agents/goal/plan/memory 四份文档。

### 步骤 H：zip 分支合并（沙箱修复 + Linux 移植 + 工作流 DAG + components 迁移） —— [x]

- 来源：用户提供的 `CubexDesktop-2026-10-02-9766db7.zip`（自带 `.git`、同 remote，自 `ac8be26` 分叉，对方 9 提交 / 我方 5 提交），解压至 `C:\Windows\Temp\opencode\cubex-9766db7\CubexDesktop`。
- 取舍：经选择题确认「三块全并入、冲突一律以我方为主」且 `rules/` `specs/` 6 个 md 一并并入；实操为「以我方为底 + 补入对方独有符号」——单纯全取我方编译不过（25+ TS 错误）。
- 关键决策：`agent.ts` 以我方 `finish()` 为骨架补入 `run.outcome` 追踪，**`run.settle()` 必须排在 `finish()` 之后**，否则工作流会在上一线程未置 idle 时启动下一节点并抛「会话正在执行中」；`index.ts` 窗口最大化取我方实现，剔除对方已失效的 `screen`/`Rectangle`/`MessageCard`/`Workflow` 导入，保留 `BrowserState`/`safeStorage`/`workflowControlInputSchema`。
- 产出：12 处冲突手工解决，真 merge commit `b62a3cd`（双父 `4e534a3` + `9766db7`），工作区干净。
- 验证：typecheck 0 / lint 0 error（9 warning）/ test **115 passed + 4 skipped**（基线 94，新增沙箱 7 + 平台 4 + 工作流 12）；我方特性保真核对通过（browser_crawl 17 处、引用溯源/导出 6 处、通用分区 22 字段、侧栏自动化入口、无 `about`）；沙箱修复本体核对通过（`sandbox/env.ts` 已删 `env.no_proxy = '*'`，黑洞代理保留）。
- 结论：完成，**沙箱禁网与工作流 DAG 尚未在真实会话实测**（仅单测覆盖）。

### 步骤 I：安装包体积与启动/加载速度优化 —— [x]

- 目标：优化加载速度、文件大小、启动速度，完成后推送到远端仓库。方法为**先测量后动手**。
- 诊断：`app.asar` 185.4 MB 中 **6299/6328 条目是 `node_modules`（177.5 MB 纯死重量）**，真正运行的 `out/` 仅 1.89 MB；`locales/` 另占 50.6 MB（55 个语言包）。
- **关键坑（隔离测试才暴露）**：`electron-vite` 5 默认自动追加 `externalizeDepsPlugin()`，`out/main` 因此保留 ESM `import 'zod'`。打包版之所以「能跑」，是从 `app.asar` 向上遍历目录时**碰巧命中工程根的 `node_modules`**，装到任意路径必然 `ERR_MODULE_NOT_FOUND`。修复：`electron.vite.config.ts` 的 main/preload 加 `externalizeDeps: false`，zod 打进 main（295 KB → 482 KB），外部依赖只剩 `electron` + `node:*`。
- 配置：`package.json` `build.files` 增 `"!node_modules"`、新增 `"electronLanguages": ["zh-CN","en-US"]`（原 `en` 匹配不到，须写 `en-US`）。
- 交付：NSIS 安装包 **144.53 MB → 106.22 MB（−36.5 MB / −26.5%）**；解包 545.5 → 322.4 MB（−223.1）；`app.asar` 176.8 → 2.0 MB；`locales` 50.6 → 0.6 MB（zh-CN + en-US 两个 pak）。
- 启动实测（多采样，避免单次假象）：窗口标题出现 **首跑 1056 ms、后 4 次均 368 ms**；阶段拆解 `module evaluated 3ms → whenReady 57ms → createWindow 110ms → did-finish-load 158ms → ready-to-show 238ms`。
- 交付验证：`asar list` 确认 26 条目、0 个 node_modules；把打包产物复制到**上级链无任何 `node_modules`** 的隔离目录实跑，`[cubex] smoke-ready` 通过、无 `MODULE/ENOENT`。
- 结论：体积收益确定；**启动/加载速度无低风险可优化瓶颈**——热启动已 ~368 ms，冷启动多出的 ~752 ms 全在首帧光栅化（React 在 `dom-ready` 前已渲染完），而 HTML 骨架可乘窗口仅几毫秒、收益不确定，故不改。

### 步骤 J：自动化从设置里拆出为独立页面 —— [x]

- 需求：删除设置里的「自动化」；点侧栏「自动化」后**收起右栏、让中间栏 + 右栏整片变成自动化页面**，而不是跳转设置页。
- 做法（选的是**复用 `SettingsPanel` 加 `page` 模式**，而非新建组件）：新增 `page?: SectionId` prop，`page` 存在时隐藏 `.settings-nav`（设置分类栏）、只渲染该分区的行、顶部多一条 `.settings-toolbar`（「返回会话 Esc」）；自动保存/校验/「立即运行」/计数全部沿用现成逻辑，零重复实现、风险最低。
- `App.tsx`：`view` 联合类型加 `'automation'`；侧栏按钮 `onClick={() => setView('automation')}`（不再 `setSettingsSection('automation')`）；`returnView` ref 类型加 `'automation'`（从设置关闭能回到自动化页），自动化页自己的返回则兜底到 `'chat'`；标题栏标题 = 「自动化」、隐藏项目面包屑与 Code/Work/Browser 模式切换器；`showRightPanel` 本就要求 `view === 'chat'`，右栏与右侧分界线自动不渲染 → 页面独占中间 + 右侧区域。
- 从设置里**彻底**摘除：`hiddenSections`（`Set`）让 `pool` 在设置模式下直接排除隐藏分区的行，**设置搜索也搜不到**；侧栏 nav 的 `|| section === meta.id` 补丁一并去掉（该分支已无意义）。
- 校验：typecheck 0 / lint 0 error（9 既有 warning）/ test 115 passed + 4 skipped。
- 实测（dev 窗口 + 整屏抓图）：① 设置分类栏无「自动化」；② 点侧栏「自动化」→ 标题栏「自动化」、设置分类栏消失、右栏收起、页面铺满、底部「改动会自动保存并立即生效」、侧栏保留且「自动化」高亮。
- **坑**：对 Electron 窗口 `PrintWindow(hwnd, hdc, 2)` 抓到的是**陈旧帧**（点了按钮仍显示旧视图），验证 UI 必须用 `CopyFromScreen` 整屏抓图；另 DPI 环境下脚本须先 `SetProcessDPIAware()`，否则 `GetWindowRect` 返回虚拟化坐标（1440x840 而非 1800x1050），点击会整体偏移。

### 步骤 K：Code/Work/Browser 模式选择器移入侧栏 —— [x]

- 需求：把模式选择器从标题栏移到**标题下方、新建任务上方**，并整理排版。
- 做法：把三按钮 JSX 抽成组件内常量 `modeSwitch`（非组件，直接 `{modeSwitch}` 复用），侧栏插在 `.sidebar-brand` 与 `.new-task` 之间（包一层 `.sidebar-mode`）；标题栏原位改为 `{!sidebarOpen && view !== 'settings' && modeSwitch}`——**条件与既有的「展开侧栏」按钮完全一致**，故侧栏收起时仍能在标题栏切模式，不会因为「移动」而丢失入口。
- **去掉图标只留文字**（`CodeXml`/`Workflow`/`Globe` → 纯文本）：`--side-col` 最小 208 px，扣掉侧栏 padding 与胶囊 padding 后每段只剩 ~60 px，而「Browser」带 14px 图标 + 5px 间隙需 ~61 px，窄侧栏下必然裁字；纯文本约 46 px 全宽度区间都装得下，零边界情况。`CodeXml` 因此从 import 里移除（`Workflow`/`Globe` 仍被 onboarding、消息卡片、工具图标使用）。
- 排版整理：`.sidebar-brand` 底部 padding 12 → 8；新增 `.sidebar-mode { margin-bottom:10px }`、`.sidebar-mode .mode-switch { width:100% }`、`button { flex:1; min-width:0; justify-content:center; height:26px; padding:0 6px; white-space:nowrap }`。三段等分、居中、撑满侧栏，与上下 `nav-action` 行高视觉对齐（26+4+2 = 32 vs 34）。
- **已知取舍**：自动化页侧栏现在也会显示模式选择器（原先标题栏在 automation 视图下是隐藏它的），当前无任何模式被选中，点一下即可回 Code/Work/Browser——视为改进而非回归。
- 校验：typecheck 0 / lint 0 error（9 既有 warning）/ test 115 passed + 4 skipped；整屏截图确认「标题栏只剩标题 + 右侧图标组，侧栏品牌行下方是 Code|Work|Browser 胶囊、其下是新建任务」。
- **截图注意事项（本轮踩到）**：验证时为绕开遮挡曾 `SetWindowPos(HWND_TOPMOST)` 把窗口提到最顶层，其中一个脚本设了没还原，导致主窗口持续置顶被用户察觉。**已清除**（`GetWindowLong(GWL_EXSTYLE)` = 0x0、`topmost=False`），临时脚本全部删除；今后截图不再使用置顶。

### 步骤 L：接入 aoci-code + agent-core，设置新增「Beta 功能」栏目 —— [x]

- 需求：把 https://github.com/aoci-spec/aoci-code 与 https://github.com/kernel4632/agent-core 「搞进去」，并在设置里加「Beta 功能」栏目，含两个开关：**「token节省与大型项目优化」**与 **「agent循环优化」**。
- 两仓库定位：aoci-code = Go 实现的**持久化代码库认知索引** + 本地 stdio MCP 服务器（9 个工具），让 agent「读一次就懂整个系统」而非每次重读仓库 → 对应 token 节省/大型项目；agent-core = TS 写的**极简 agent 循环**（LLM + 工具 + 自动循环，核心是停机语义）→ 对应 agent 循环优化。
- 经选择题确认的两条接法：
  - **agent 循环 → 移植逻辑、不装依赖**。理由：agent-core 深度绑定 Bun 运行时（`features/llm.js` 的 `Bun.hash`、`tool.js` 的 `new Bun.Glob().scan()`、`tool-process.js` 的 `Bun.spawn`/`Bun.file`，`scripts/build.js` 还写着 `target:'bun'`//「只在 Bun 上跑」），**跑不进 Electron**；真引入要么打 shim 要么捆 ~90MB Bun 运行时，会把刚做完的 106 MB 体积优化报废。用户的条件是「效果一样就选移植」——**循环停机部分逐条等价**，因此选移植；agent-core 另外的能力（Gemini/Responses 协议、纯文本工具协议 text-tools、结构化输出、目录扫描式工具发现）**不在「循环优化」范围内**，那些必须真依赖且要 Bun，本轮不做。
  - **aoci → 二进制打进安装包**（用户明确选择，而非按需下载或用户自装）。
- 产出：
  - **schema**（`src/shared/schema.ts`）：新增 `betaSchema { tokenSaving, agentLoop }`，`settingsSchema` 加 `beta`，`defaultSettings` 默认 `false`，`migrateState` 走 `mergeGroup` 自动给老 state 补齐。
  - **设置 UI**（`SettingsPanel.tsx`）：`SectionId` 加 `'beta'`；`sections` 插在「规则与记忆」与「键盘快捷键」之间（`FlaskConical` 图标）；`sectionPrefixes` 加 `beta: ['beta']`；`patch` 泛型加 `'beta'`；rows 加两条 `Toggle` 行（label 即用户给的两个中文名）。i18n 走 `tr()` + `phrases.ts` 新增 `betaPhrases` 并注册。
  - **agent 循环**（新建 `src/main/loopPolicy.ts` + `agent.ts`）：`DEFAULT_LOOP_POLICY`（1 轮不补问 / 0.9 压缩比，**与改动前行为逐字一致**）与 `OPTIMIZED_LOOP_POLICY`（3 轮 / 0.8 / 补问提示）；`nextNoToolStep(count, rounds)` 逐行对应 `features/loop.js` 的 `noToolCount += 1` / `=== noToolRounds - 1` 则 `temporaryPrompt = noToolPrompt` / `>= noToolRounds` 则返回 `no-tool`。主循环：无工具调用时若开关关着仍直接 `return`；开着则计数 → 补问（临时 user 消息**只随本次请求发送、不写历史**，`streamChat` 成功后清空）→ 用尽才结束并写一条 system 说明。**引导（steering）到达时把计数清零**（agent-core 无此概念，属本地补充）。同一套语义也套进 `delegate` 子智能体循环。压缩触发比 `window * 0.9` 改为 `window * policy.compactRatio`。
  - **AOCI 接入**（新建 `src/main/aoci.ts` + `index.ts` + `prompt.ts`）：`resolveAociBinary` 按打包（`resources/aoci`）/dev（仓库 `vendor/aoci`）两个目录找 `aoci.exe`；`planAociServers` 在开关打开且二进制、项目路径齐备时维护唯一一条 id `cubex-aoci` 的 MCP 条目（`command` = 二进制，`args` = `['--repo', <项目根>, 'mcp']`），换项目**就地替换**、开关关/二进制缺失/无项目则移除，用户自建的其它服务器一律不动。挂钩三处：`saveSettings`、启动 1200 ms 定时器、`sendMessage`/`regenerateMessage`（用线程的 projectId 精确定位），统一经 `syncAoci()` 写回 settings 再 `mcp.sync`（`McpManager.sync` 以 `configKey` 比对，args 变了会自动重启）。`prompt.ts` 在 `settings.beta.tokenSaving` 时追加 `AOCI_RULE`：先用 `aoci_overview`/`aoci_search` 取条目理解、别通读仓库；未初始化时按 `aoci --repo <root> init → scan → index build` 建索引；改动后 `aoci_update_entry` 维护。
  - **安装包**：`package.json` `extraResources` 加 `{"from":"vendor/aoci","to":"aoci"}`；`vendor/aoci/` 放入 `aoci.exe`（24,729,600 B，SHA256 `ee7ee51f…`，来自 `v0.1.0-rc18` 官方 `SHA256SUMS` 校验通过）+ `LICENSE`/`NOTICE`/`PATENTS`/`THIRD-PARTY-NOTICES`/`TRADEMARKS`。
  - **测试**：新增 `tests/loopPolicy.test.ts`（6 例）与 `tests/aoci.test.ts`（9 例）。
- **实测（关键，先于 UI）**：用 stdio 直连 `aoci --repo <临时目录> mcp` —— **服务端回显了客户端请求的 `protocolVersion: 2024-11-05`**（Cubex 的 `mcp.ts` 用 2024-11-05，aoci 自述 2025-11-25，但按 MCP 规范回显即支持），`tools/list` 返回全部 9 个工具，`aoci_overview` 返回带下一步提示的 `[not_initialized]`（正好是 `AOCI_RULE` 里教 agent 去跑 init 的场景）。
- **UI 实测（已通过，走 CDP 而非整屏抓图）**：锁屏导致 `CopyFromScreen` 只能拍到锁屏画面，改用 `electron --remote-debugging-port=9333` + Node `WebSocket` 走 CDP（`Runtime.evaluate` + `Page.captureScreenshot`，离屏渲染不受锁屏影响）。结果：① 设置分类栏出现「Beta 功能」，位置在「规则与记忆」与「键盘快捷键」之间，`FlaskConical` 图标；② 分区渲染标题 + 说明 + 两个开关 + 底栏「改动会自动保存并立即生效」；③ 点开「token节省与大型项目优化」后 2.5 s 内 `settings.beta.tokenSaving=true` 落盘 `state.json`，且 `mcp.servers` 自动长出 `{"id":"cubex-aoci","name":"aoci","command":"…\\vendor\\aoci\\aoci.exe","args":["--repo","C:\\projectsfile\\cubex 协作","mcp"]}`；④ MCP 分区显示 `aoci … --repo … · 9 个工具` 且状态 **「已连接」**（真实子进程握手成功）；⑤ 再点回关，`servers` 自动清空、`beta.tokenSaving=false`，测试状态已还原为默认。
- 校验：typecheck 0 / lint 0 error（9 既有 warning）/ test **130 passed + 4 skipped**（基线 115，新增 15）。
- **用户三项拍板（2026-10-06）**：① `vendor/aoci/aoci.exe` 24.7 MB 二进制 **→ 提交进 git**（换可复现打包，仓库变重）；② aoci 许可证 FSL-1.1 **→ 确认可以捆绑分发**，相关许可文件随二进制进包；③ `npm run dist` **→ 跑**。已写入 memory.md，**commit 仍等用户明确指示**。
- **打包实测（已通过）**：`npm run dist` 成功，`release\Cubex Setup 0.1.2-dev.exe`（带 aoci 版）= 112,735,101 B = **112.74 MB**（优化后不含 aoci 时为 106,219,152 B = 106.22 MB，**+6,515,949 B / +6.52 MB / +6.13%**；Go 二进制压缩率高，远低于最初 ~116 MB 的预估；**注意文档统一用十进制 MB = bytes/10⁶，别和 PowerShell 的 `1MB`(MiB) 混用**）；`release\win-unpacked\resources\aoci\` 六个文件齐全（`aoci.exe` 24,729,600 B，sha256 `ee7ee51f…` 与源文件一致；LICENSE/NOTICE/PATENTS/THIRD-PARTY-NOTICES/TRADEMARKS）；`Cubex Setup 0.1.1.exe`（144,527,112 B = 144.53 MB 旧包）未被覆盖（后经用户指示已删除）。
- **打包版端到端（已通过）**：直接跑 `release\win-unpacked\Cubex.exe --remote-debugging-port=9334`，开「token节省与大型项目优化」后 `mcp.servers` 长出的 `command` 正是 `…\release\win-unpacked\resources\aoci\aoci.exe`（即 `process.resourcesPath` 落点，非 dev 回落分支），MCP 分区显示 **「9 个工具 · 已连接」**；关掉后条目自动移除，测试状态已还原为默认 `false`。
- **版本升到 0.2.1（2026-10-06 用户指示）**：`package.json` `"version"` `0.1.2-dev` → `0.2.1`（全项目唯一版本号来源），重跑 `npm run dist` → 产物 `release\Cubex Setup 0.2.1.exe` = **112,735,082 B = 112.74 MB** + blockmap 118,001 B；包内 `resources\aoci\` 六文件齐全、`aoci.exe` sha256 仍为 `ee7ee51f…`。安装包名即版本号，无需另查 asar。同轮删除 `Cubex Setup 0.1.1.exe`（137.83 MiB）与其 blockmap。**遗留：`release\latest.yml` 内容停在 `version: 0.1.1`（2026-09-30），因 `package.json` 无 `publish` 字段、electron-builder 每次都不会重写它——若以后要上自动更新需补 publish 配置。**
- 结论：代码、测试、dev 窗口 UI 实测、安装包体积与**打包版端到端**全部完成；仅剩 commit 等用户指示。

## 当前进行到的精确位置 / 下一步第一件事

- 步骤 H（分支合并 `b62a3cd`）、步骤 I（体积/启动优化）、步骤 J（自动化独立页面）、步骤 K（模式选择器移入侧栏）、**步骤 L（Beta 功能栏目 + aoci/agent-core 接入）**均已完成并通过全量校验，**J + K + L 已 commit 并 push**。
- **校验基线**：typecheck 0 / lint 0 error（9 既有 warning）/ `npm test` = **130 passed + 4 skipped**（原 115 + 4，新增 15 条）。
- **已提交并推送（2026-10-06）**：`a07116f`（feat：19 files / +2353 −50，含 `vendor/aoci/aoci.exe` 24,729,600 B）+ `9ea6de1`（docs：回填 J/K/L），`26be755..9ea6de1  main -> main`，`git status -sb` 无 ahead、`ls-remote` 返回 `9ea6de1a668…` 与本地 HEAD 一致。**本轮是直连推送成功的**：`127.0.0.1:7890` 已无 LISTEN（FlClash 核心只开 1053 DNS，`ProxyEnable=0`），带代理直接 `Could not connect to server`；实测**直连 github:443 现已通畅**（此前「直连被 reset」的情况已失效）。**坑：先 `git ls-remote origin main` 试一下再决定带不带代理；PowerShell 下 push 的 stderr 仍可能显示 `NativeCommandError`，以 `git status -sb`（无 ahead）为准。**
- **待办**：① Browser 爬取 + 角标跳转 + 资料报告导出未实测；② 沙箱禁网、工作流进度条未实测；③ 设置页新排版未实测（侧栏自动化入口、模式选择器位置与 **Beta 功能分区均已实测通过**）；④ `release\Cubex Setup 0.1.1.exe` 已按指示删除；⑤ **`release\` 里被取代的 `Cubex Setup 0.1.2-dev.exe`（112.74 MB）与停在 0.1.1 的死文件 `latest.yml` 待用户确认是否删**。
- **下一步第一件事**：本轮开发与验证已完成，按后续实际使用反馈继续处理；若用户要求发布，先重新打包。此前 `release\Cubex Setup 0.2.1.exe`（112,735,082 B）不含本轮滚动与子智能体增强；源码、版本行与文档均未提交。用户已确认**分离任务面板的永久置顶保留**。

## 已知风险 / 阻塞项及应对

- **风险：可见 BrowserWindow 与主窗口的层级/DPI/焦点冲突**。应对：MVP 用截图流推帧到前端 canvas/img，避免真窗口叠加；完整版再评估 WebContentsView。
- **风险：electron-builder 打包时 `app.asar` 被杀软/索引器锁定**。应对：打包前先结束 Cubex 进程并删 `release`/`out`；仍锁定用 `npx electron-builder --win nsis "-c.directories.output=dist-out"`（PowerShell 中 `-c...` 加引号）。
- **风险：浏览器自动化的安全面**。应对：沿用 `setWindowOpenHandler deny`、`setPermissionRequestHandler(false)`、`will-download preventDefault`；交互动作接入审批。

## 已被否决 / 放弃的方案

- Browser 模式引入 Playwright/Puppeteer → 放弃，改用 Electron 内置 BrowserWindow（用户确认），避免新增浏览器二进制依赖与打包膨胀。
- 直接对接本机 tabbit-cli → 放弃，强依赖用户已装 Tabbit 且跨机不可控。
- 历史：用 `sharp` 合成圆角图标 → 放弃改用 `nativeImage` BGRA。
