# 计划

> 最后更新时间：2026-10-06 ｜ 更新者：AI Agent（Beta 功能栏目 + aoci/agent-core 两个外部仓库接入）
>
> 记录当前任务的拆解与进度。总目标见 goal.md，过程细节/决策见 memory.md。标记：`[ ]` 未开始 ｜ `[x]` 已完成 ｜ `[~]` 进行中。

## 当前阶段

0.1.2-dev 稳定性修复 + 自动检测模型/上下文 + Browser 模式 + 上下文压缩与 Agent 循环优化 **均已完成**；队列栏与引导交互优化完成；Browser 模式全网爬取完成；资料报告 + 引用溯源完成；**zip 分支合并（沙箱修复 + Linux 移植 + 工作流 DAG）完成**；**安装包体积优化完成**；**自动化改为独立页面（不再藏在设置里）完成**；**Code/Work/Browser 模式选择器从标题栏移入侧栏完成**；**设置新增「Beta 功能」栏目并接入 aoci-code + agent-core 完成**：typecheck 0 / lint 0 error / test 130 passed + 4 skipped。

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
- **打包实测（已通过）**：`npm run dist` 成功，`release\Cubex Setup 0.1.2-dev.exe` = 112,735,101 B = **107.51 MB**（旧 106.22 MB，**+6.21 MB / +6.13%**，Go 二进制压缩率高，远低于最初 ~116 MB 的预估）；`release\win-unpacked\resources\aoci\` 六个文件齐全（`aoci.exe` 24,729,600 B，sha256 `ee7ee51f…` 与源文件一致；LICENSE/NOTICE/PATENTS/THIRD-PARTY-NOTICES/TRADEMARKS）；`Cubex Setup 0.1.1.exe`（137.83 MB 旧包）未被覆盖。
- **打包版端到端（已通过）**：直接跑 `release\win-unpacked\Cubex.exe --remote-debugging-port=9334`，开「token节省与大型项目优化」后 `mcp.servers` 长出的 `command` 正是 `…\release\win-unpacked\resources\aoci\aoci.exe`（即 `process.resourcesPath` 落点，非 dev 回落分支），MCP 分区显示 **「9 个工具 · 已连接」**；关掉后条目自动移除，测试状态已还原为默认 `false`。
- 结论：代码、测试、dev 窗口 UI 实测、安装包体积与**打包版端到端**全部完成；仅剩 commit 等用户指示。

## 当前进行到的精确位置 / 下一步第一件事

- 步骤 H（分支合并 `b62a3cd`）、步骤 I（体积/启动优化）、步骤 J（自动化独立页面）、步骤 K（模式选择器移入侧栏）、**步骤 L（Beta 功能栏目 + aoci/agent-core 接入）**均已完成并通过全量校验；**步骤 J + K + L 尚未 commit**（等用户明确指示）。
- **校验基线**：typecheck 0 / lint 0 error（9 既有 warning）/ `npm test` = **130 passed + 4 skipped**（原 115 + 4，新增 15 条）。
- **已提交并推送**：`da9b013`（体积优化）+ `26be755`（docs 回填，当前 `HEAD` = `origin/main`），连同合并 `b62a3cd` 共 11+ 个提交经 7890 代理 `push origin main` 成功，`git ls-remote origin main` 核对一致。**坑：`ls-remote` 也必须带 `-c http.proxy=... -c https.proxy=...`；PowerShell 下 push 的 stderr 仍可能显示 `NativeCommandError`，以 `git status -sb`（无 ahead）为准。**
- **待办**：① Browser 爬取 + 角标跳转 + 资料报告导出未实测；② 沙箱禁网、工作流进度条未实测；③ 设置页新排版未实测（侧栏自动化入口、模式选择器位置与 **Beta 功能分区均已实测通过**）；④ `release\Cubex Setup 0.1.1.exe`（137.83 MB 旧包）待用户确认后删。
- **下一步第一件事**：等用户明确指示后，把步骤 J + K + L 一起 commit/push（**用户已确认 `vendor/aoci/` 一并提交进 git**；带 7890 代理并核对 `ls-remote`），再收集 ①②③ 的实测反馈。用户已确认**分离任务面板的永久置顶保留**，该项无需改动。

## 已知风险 / 阻塞项及应对

- **风险：可见 BrowserWindow 与主窗口的层级/DPI/焦点冲突**。应对：MVP 用截图流推帧到前端 canvas/img，避免真窗口叠加；完整版再评估 WebContentsView。
- **风险：electron-builder 打包时 `app.asar` 被杀软/索引器锁定**。应对：打包前先结束 Cubex 进程并删 `release`/`out`；仍锁定用 `npx electron-builder --win nsis "-c.directories.output=dist-out"`（PowerShell 中 `-c...` 加引号）。
- **风险：浏览器自动化的安全面**。应对：沿用 `setWindowOpenHandler deny`、`setPermissionRequestHandler(false)`、`will-download preventDefault`；交互动作接入审批。

## 已被否决 / 放弃的方案

- Browser 模式引入 Playwright/Puppeteer → 放弃，改用 Electron 内置 BrowserWindow（用户确认），避免新增浏览器二进制依赖与打包膨胀。
- 直接对接本机 tabbit-cli → 放弃，强依赖用户已装 Tabbit 且跨机不可控。
- 历史：用 `sharp` 合成圆角图标 → 放弃改用 `nativeImage` BGRA。
