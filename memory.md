# 记忆

> 最后更新时间：2026-10-06 ｜ 更新者：AI Agent（Beta 功能栏目 + aoci-code / agent-core 接入）
>
> 记录项目中长期有效的事实与本轮任务的过程细节。任务目标见 goal.md，步骤进度见 plan.md，此处不重复大段步骤说明。

## 技术栈与约定

- Electron 44.4.3 + React 19.3 + TypeScript 5.9 + electron-vite 5 + Vite 7.3 + electron-builder 26（NSIS，x64）。
- 依赖：`zod` 4、`lucide-react`、`@xenova/transformers`（本地 whisper ASR）。
- 目录：主进程 `src/main/`，预加载 `src/preload/`，渲染层 `src/renderer/src/`，共享层 `src/shared/`，图标脚本 `scripts/make-icon.mjs`。
- i18n 机制：`tr(zhText, vars)`（zh→en 词典，`registerPhrases()` 注册，中文缺失时原样回退）；词典集中在 `src/renderer/src/phrases.ts`，分多个 `Record` 对象分别注册以避免重复键冲突。
- 数据存储（Electron `userData`）：开发运行用 `name`=cubex-desktop → `Roaming\cubex-desktop`；安装版用 `productName`=Cubex → `Roaming\Cubex`。核心文件 `state.json`、`secrets.json`、`plugins/`（见 `src/main/index.ts` 第 19/20/44 行）。
- 打包标识：`appId=com.cubex.desktop`，`productName=Cubex`，NSIS `perMachine:false`、`oneClick:false`、可改安装目录。

## 关键决策

- 圆角图标合成方式：用纯 `nativeImage` BGRA 像素处理（`scripts/make-icon.mjs` 的 `roundedIcon`/`roundedAlpha`/`buildIco`），不引入 `sharp`。原因：避免新增原生依赖。时间：图标任务期间。
- 应用内圆角范围：仅「助手消息头像 + 标题栏小图标」，由用户经选择题确认；侧栏/欢迎页/引导页不加。
- 删除主题分区但保留 schema 字段：`appearance.theme/accent/background` 仍是合法设置，只是入口从「主题」页迁到「外观」页。原因：不破坏已有用户数据结构。
- 版本策略：现为 `0.1.2-dev`（用户明确要求编译 0.1.2-dev）。
- 截断根因判定：输出被截断有三个独立根因——① Anthropic `max_tokens` 兜底 8192 过小；② `safeArgs` 静默吞掉截断/畸形 JSON → 空参静默写入；③ OpenAI 兼容路径不发 `max_tokens` 导致网关套用自身小默认值。统一由 `resolveMaxTokens` 收口，并用 `truncated` 标志 + 自动续写兜底。
- 模式架构哲学（延续）：Code/Work/Browser **共用同一 agent 与全量工具集**，差异只靠「注入不同 system prompt 段 + prompt 引导」实现，不为某模式裁剪工具集。Browser 模式因此需要把 `mode` 下沉到 `thread`（schema），让 agent 能感知并注入浏览器提示段。
- Browser 模式后端选型：用 **Electron 内置 BrowserWindow**（复用现有离屏窗口安全加固，升级为可见+可交互），**不引入 Playwright/Puppeteer**；交互形态为「可对话 + 可编排」混合；本轮交付完整版。用户经选择题确认。
- 旧 `browser_open`（只读抽取）保留不动，Browser 模式新增独立 `browser_*` 交互工具，避免破坏 Work/Code 引用。
- 上下文压缩采用 **LLM 摘要式**（用户选择题确认）：`compactMessages` 保留最近 10 条原文，较早消息交模型总结为结构化摘要后替换为一条 system 消息。原因：原实现只是删除早期消息，会丢失任务上下文。模型不可用时退化为移除标记，保证「始终能压缩」。
- 上下文检测改为 **二分法实测**（用户原文「本身也有检测上下文长度的按钮，优化一下就可以用了」）：不依赖服务端 `/models` 的 `context_length`。探测从已知/猜测值起倍增上界再二分，靠关键词（context length / maximum context / too many tokens / 413 …）判定超限。
- 「压缩不了」的**真正根因**：多数 OpenAI 兼容中转站即使请求 `stream_options.include_usage` 也不返回 usage → `usedTokens=0` → 压缩按钮的 `ratio>=0.7` 永false。修复=渲染层用 `historyTokens` 估算兜底（`estimateTokens` 抽到 `src/shared/tokens.ts` 供主进程与渲染层共用）。
- 循环治理三项（用户全选）：①占用 >90% 窗口自动摘要压缩（每轮至多 3 次）；②捕获上下文超限错误后自动压缩并重试（至多 3 次）；③相同「工具+参数」签名第 4 次起拦截，连续整步空转两次则中止。
- Browser 模式全网爬取（用户选择题「两者都做」+「两种方案可供选择」）：既新增 `browser_crawl` 聚合爬取工具，也增强 `browser_search` 返回结构化结果；呈现方式做成设置项 `crawlMode`（background=离屏并行+进度条 label / visible=前台标签逐页），`crawlPages` 3–20 控制规模。爬取总时长硬限 180 秒（`CRAWL_DEADLINE_MS`）防失控。
- 爬取种子优先走 `webSearch`（DuckDuckGo html），失败才退化为「配置的搜索引擎结果页离屏抓取 + 通用链接提取」，两者都经 `resolveResultUrl`（Bing /ck/a base64、DuckDuckGo uddg、百度 /link）还原真实地址。
- `[CUBEX_SEARCH]` 标记从「仅 web_search 尾部」改为「web_search 尾部 / browser_search 尾部 / browser_crawl **头部**」；渲染层用 `takeJsonObject` 括号配平解析（带字符串转义处理），因此标记前后有正文或被 40k 截断都能解析。

## 本轮改动文件清单（0.1.2-dev，每项一句话）

- `src/main/llm.ts` —— 新增 `DEFAULT_MAX_TOKENS=64000`/`MIN_MAX_TOKENS=4096`/`resolveMaxTokens`；OpenAI 与 Anthropic body 均用 `resolveMaxTokens`；`safeArgs` 重写（`asObject`/`repairJson`，标记 `__truncated`/`__raw`）；`ChatTurn.truncated` + 两协议捕获 `finish_reason:length`/`stop_reason:max_tokens`；新增 `listModels`/`guessContextWindow`/`KNOWN_CONTEXT_WINDOWS`/`fetchJson`/`dedupe*` 与 `DiscoveredModel`。
- `src/main/tools.ts` —— `dispatch` 加 `__raw` 守卫抛错；write_file/edit_file 加缺参守卫。
- `src/main/agent.ts` —— 主循环/子循环加 `__raw` 守卫；`turn.truncated` 无工具调用时自动续写（`MAX_CONTINUATIONS=5`）；`reserve` 输出预留 8000→16000（部分为外部/linter 微调，勿回退）。
- `src/shared/channels.ts` —— 新增 `listProviderModels: 'cubex:list-provider-models'`。
- `src/shared/schema.ts` —— 新增 `DiscoveredModelInfo` 类型、`listProviderModelsInputSchema`、API 方法 `listProviderModels`。
- `src/main/index.ts` —— import `listModels`；新增 `listProviderModels` IPC handler（非 ollama 未填 Key 报错）。
- `src/preload/index.ts` —— 新增 `listProviderModels` 桥接。
- `src/renderer/src/SettingsPanel.tsx` —— 导入 `DiscoveredModelInfo`；`discovery` state；`detectModels`/`addDiscoveredModel`/`detectContext` 三个 handler；`renderProviders` 内「自动检测模型」列表+添加、「自动检测上下文」按钮 UI。
- `src/renderer/src/bridge.ts` —— 补 `listProviderModels` stub。
- `src/renderer/src/Logo.tsx` —— 白底圆角内部图标比例 0.72→0.88。
- `src/renderer/src/App.tsx` —— composer 输入框随 `input` 自适应高度（48→120px）effect。
- `src/renderer/src/styles.css` —— `.question-form textarea` min-height 88px；`.composer textarea` max-height 120px + overflow；自动检测相关样式。
- `package.json` —— 版本 0.1.1 → 0.1.2-dev（部分为外部修改）。

## 历史改动文件清单（0.1.1 图标/i18n，供参考）

- `scripts/make-icon.mjs` 白色圆角底图标；`Logo.tsx` `rounded` 属性；`schema.ts` 字体 9→16；`SettingsPanel.tsx` 全量 i18n + 删主题分区并入外观；`phrases.ts` 词条补全。
- 外部修改（勿回退）：`src/main/index.ts`（createWindow 先于 buildAppIcon、MCP/scheduler 延迟 1200ms）、`src/renderer/src/speech.worker.ts`（whisper-tiny ASR 流水线）。

## 新增源码模块（近期，非本会话截断/检测任务）

- `src/main/skills.ts`、`src/main/unzip.ts`、`src/renderer/src/SkillMenu.tsx`、`plugins.md` —— 技能菜单/技能加载/解压相关（随 commit f57ade2 一并入库）。

## 本轮改动文件清单（上下文压缩与 Agent 循环优化，每项一句话）

- `src/shared/tokens.ts`（**新建**）—— `estimateTokens`/`messageTokens`/`historyTokens`，主进程与渲染层共用。
- `src/main/context.ts` —— 删除本地 token 估算实现，改从 `shared/tokens` 导入并 re-export（保住 `tests/context.test.ts` 与 agent 的既有导入）。
- `src/main/llm.ts` —— 新增 `isContextOverflowError`、`ContextProbe`、`probeContextWindow`（二分法实测）。
- `src/shared/channels.ts` —— 新增 `probeContextWindow: 'cubex:probe-context-window'`。
- `src/shared/schema.ts` —— 新增 `probeContextWindowInputSchema`、`ContextProbeInfo`、`CubexAPI.probeContextWindow`。
- `src/main/index.ts` —— import `probeContextWindow` + `probeContextWindowInputSchema`，新增 IPC handler。
- `src/preload/index.ts` —— 新增 `probeContextWindow` 桥接。
- `src/renderer/src/bridge.ts` —— 补 `probeContextWindow` 预览 stub。
- `src/renderer/src/SettingsPanel.tsx` —— `detectContext` 改调实测；`discovery` 状态联合新增 `info` 项与渲染。
- `src/renderer/src/RightPanel.tsx` —— 用量缺失时 `historyTokens` 兜底；导入共享模块。
- `src/renderer/src/App.tsx` —— 自动压缩前的用量同样兜底。
- `src/renderer/src/phrases.ts` —— 补实测结果与「实测上下文长度」英文词条。
- `src/main/agent.ts` —— 新增 `compactMessages`/`summarize`/`renderTranscript`；`compactThread` 改调用；主循环加自动压缩、超限恢复、空转治理。
- `src/renderer/src/App.tsx` —— 运行中发送直接加入队列，输入框右侧移除引导按钮，排队列表每项新增引导按钮；`steerQueued` 触发移出队列并立即注入引导。
- `src/renderer/src/styles.css` —— `.queue-item-actions` 与 `.queue-steer-btn` 样式。
- `src/renderer/src/phrases.ts` —— 排队栏引导按钮相关提示与国际化词条。

## 本轮改动文件清单（Browser 模式全网爬取，每项一句话）

- `src/shared/schema.ts` —— `toolNames` 加 `browser_crawl`/`browser_extract_links`；`crawlModes`/`CrawlMode`；`browserSettingsSchema` 加 `crawlMode`/`crawlPages`（zod default）；`defaultSettings.browser` 补 `crawlMode:'background', crawlPages:8`。
- `src/main/tools.ts` —— `browserTools`/`extensionToolNames` 加两新工具，`sensitiveExtensionTools` 加 `browser_crawl`；`summarizeCall` 加 crawl 分支。
- `src/main/browser.ts` —— `BrowserAction` 加 `{kind:'links', selector?}`；`BrowserActionResult.links`；`PageLink.snippet`；`LINKS_SCRIPT`/`extractLinks`（结构化 a[href] 提取）。
- `src/main/extensions.ts` —— 新增 `fetchPageOffscreen`/`CRAWL_PAGE_SCRIPT`/`resolveResultUrl`/`keepLink`/`safeHost`/`queryTerms`/`relevanceScore`/`runPool`/`crawlWeb`；specs 加 `browser_crawl`/`browser_extract_links` 并改写 `browser_search` 描述；dispatch 分支 `runBrowserCrawl`；`runBrowser` 支持 links 动作、搜索结果结构化 + `[CUBEX_SEARCH]`。
- `src/main/prompt.ts` —— BROWSER_MODE 工具清单与选型指引改写（crawl 优先）。
- `src/renderer/src/SettingsPanel.tsx` —— Browser 分区加「全网爬取方式」Select 与「单次爬取最多页数」NumberField。
- `src/renderer/src/RightPanel.tsx` —— 搜索结果识别 `browser_search`/`browser_crawl`；新增 `takeJsonObject`。
- `src/renderer/src/App.tsx` —— `toolIcon` 加两图标、`approvalDetail` 加爬取说明、`toolTitle` 加 `default: return tr(call.name)` 兜底。
- `src/renderer/src/phrases.ts` —— 爬取设置/审批文案英文词条。
- `tests/browser.test.ts` —— 工具集扩到 10 个、crawl 敏感性、summarizeCall crawl 摘要、prompt 含 crawl 工具名、设置默认与越界校验。

## 本轮改动文件清单（资料报告 + 引用溯源，每项一句话）

- `src/renderer/src/sources.ts`（新建）—— `takeJsonObject`（自 RightPanel 迁出）、`collectSources`（三工具 `[CUBEX_SEARCH]` 汇总去重）、`parseSourceLine`/`extractSources`（解析「参考来源」小节与 `[n]` 行，URL 尾部中英文标点都要剥）、`sourcesToMarkdown`（导出报告）。
- `src/renderer/src/Markdown.tsx` —— Block 加 `sources` 种类（来源卡片列表）；`inlinePattern` 末尾加 `\[(\d{1,3})\]`（必须放在链接分支之后，避免 `[1](url)` 被截断）；`cite`/`CiteToken` 渲染上标角标；citations 由 `Markdown` 顶层 `extractSources` 一次提取后作参数下传（不可用 hook：`inline` 是普通函数）。
- `src/renderer/src/RightPanel.tsx` —— 「联网搜索」分组改为「资料报告」+ 计数 + 导出按钮；`summarize` 复用 `collectSources`；`SearchHit` 改为从 `sources.ts` 再导出。
- `src/shared/channels.ts` / `src/shared/schema.ts` / `src/main/index.ts` / `src/preload/index.ts` / `src/renderer/src/bridge.ts` —— 新增通用 `exportText` IPC（title/defaultName/content → 保存 `.md` 对话框并定位文件），桥接层含 preview 兜底。
- `src/main/prompt.ts` —— CORE「工具使用」与 BROWSER_MODE「作答与收尾」都要求附 `## 参考来源` 与 `[n]` 角标；**坑：模板字符串内反引号必须写成 \`，否则整个 prompt 语法炸掉**。
- `src/renderer/src/phrases.ts` —— `资料报告`/`导出`/`导出资料报告`/`导出 Markdown 报告`/`请在桌面应用中使用` 词条。
- `src/renderer/src/styles.css` —— `.md-cite`（上标角标）/`.md-cite-plain`（灰色降级）/`.md-sources`（来源卡片）/`.panel-action`（分组头按钮）。
- `tests/citations.test.ts`（新建）—— 8 例：takeJsonObject 截断、collectSources 去重/失败忽略、parseSourceLine 三种写法、extractSources 节边界、sourcesToMarkdown 编号、两段提示词断言。

## 安装包体积与启动（0.1.2-dev 后续优化）

- **构成真相**：优化前 `app.asar` 185.4 MB 里 6299/6328 条目是 `node_modules`（177.5 MB），而真正运行的 `out/` 只有 1.89 MB。原因是 `files: ["out/**/*","package.json"]` 并不能阻止 electron-builder 打包生产依赖。
- **`electron-vite` 5 默认外部化依赖**：main/preload 会自动追加 `externalizeDepsPlugin()`（见 `node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js` 的 `config.build?.externalizeDeps ?? true`），于是 `out/main/index.js` 保留 `import 'zod'`。**必须写 `build.externalizeDeps: false`** 才会把依赖打进产物。
- **最危险的假象**：打包版在开发机上「正常启动」，是因为 ESM 解析从 `resources/app.asar/out/main/` 一路向上**命中了工程根的 `node_modules`**；装到 `Program Files` 必然 `ERR_MODULE_NOT_FOUND`。**验证打包产物必须复制到上级链无 `node_modules` 的隔离目录再跑**（本轮在 `C:\Windows\Temp\opencode\pkg-test` 实跑 `[cubex] smoke-ready` 通过）。
- **`electronLanguages` 要写 `en-US`**：写 `en` 匹配不到 `locales\en.pak`，会只留 zh-CN。
- **体积成果**：NSIS 安装包 144.53 → **106.22 MB**（−26.5%）；解包 545.5 → 322.4 MB；`app.asar` 176.8 → 2.0 MB；`locales` 50.6 → 0.6 MB。剩余体积大头是 Electron 自带 `Cubex.exe` 234.8 MB（≈ `node_modules\electron\dist\electron.exe`，非我们可控）。
- **aoci 二进制的体积代价**：`extraResources` 加 `vendor/aoci → aoci` 后重打，安装包 106.22 → **107.51 MB**（112,735,101 B，**+6.21 MB / +6.13%**）。`aoci.exe` 裸文件 24.7 MB，但 NSIS/7z 对 Go 静态二进制压缩率高，**实际只涨 6 MB**——比「24.7 MB 直接相加」的直觉低得多，别拿裸文件大小估算安装包涨幅。electron-builder 会先 `signing with signtool.exe path=release\win-unpacked\resources\aoci\aoci.exe`（哈希未变说明本机无证书时是空操作）。
- **启动测量方法论（踩过两次坑）**：
  - `WaitForInputIdle` **不是**窗口显示时间（会得到 3813 ms 的假象），要看 `ready-to-show` 或轮询 `MainWindowTitle`。
  - **单次测量不可信**：同一二进制首跑 1056 ms、后 4 次 351–409 ms，必须多采样区分冷热。
  - `asar` 大小（185 MB vs 1.9 MB）**对启动时间几乎无影响**（热启动 244 vs 276 ms），我曾据 `WaitForInputIdle` 错判为「3.5 秒全在 asar」，已推翻。
- **阶段拆解**（热）：`module evaluated 3ms → whenReady 57ms → createWindow 110ms → dom-ready 157ms → did-finish-load 158ms → ready-to-show 238ms`；冷启动多出的 ~752 ms 全在 `did-finish-load` 之后的**首帧光栅化**（React 在 `dom-ready` 前已渲染完），故 HTML 骨架方案收益不确定、未采用。
- **`& electron ... | Out-String` 会永久挂起**：Electron 的 GPU/renderer 子进程继承 stdout 句柄，管道不 EOF。测启动一律用 `Start-Process -RedirectStandardOutput` + 轮询日志。
- **首屏已充分代码分割**：`SettingsPanel`/`RightPanel`/`WorkflowCanvas`/`BrowserWorkspace` 均 lazy，`speech.worker`（812 KB，最大单文件）按需 `new Worker`；首屏同步资源为主包 292 KB + react 222 KB + css 100 KB，无低风险可再优化项。

## 自动化独立页面（0.1.2-dev 后续交互）

- **需求**：删除设置里的「自动化」；点侧栏「自动化」收起右栏、让中间栏 + 右栏整片变成自动化页面，而不是跳转设置页。
- **方案选型：复用 `SettingsPanel` 加 `page` 模式，不新建组件**。理由：`renderAutomations` 128 行依赖 `draft`/`settings`/`errors`/`errorFor`/`open`/`addAutomation`/`runAutomationNow`/`autoBusy`/`activeProjects`/`workflows` 及 `FieldError`/`NumberField`/`Select`/`Toggle` 等一堆内部件，且设置本身是**600 ms 防抖自动保存**（`autoSave` + `settingsSchema.safeParse` 全量校验）；搬出去意味着重抄整套草稿/校验/保存，风险高、代码重复。
- **`page?: SectionId` 的三处作用**：① 不渲染 `.settings-nav`（设置分类栏与搜索框）；② `pool` 改为 `rows.filter(row => row.section === page)`，只渲染该分区；③ `.settings` 顶部插一条 `.settings-toolbar`（「返回会话 Esc」按钮，样式 `.settings-toolbar` + 相邻 `.settings-inner` 收紧上边距）。
- **设置里彻底摘除**：模块级 `hiddenSections = new Set(sections.filter(s => s.hidden).map(s => s.id))`，设置模式下 `pool` 直接排除隐藏分区 → **nav、内容、搜索三处都搜不到**（原实现 nav 有 `|| section === meta.id` 补丁、搜索则完全不过滤 `hidden`，故此前搜「自动化」能搜出来）。`activeSection` 对隐藏分区兜底回 `'providers'`，防止 `initialSection` 传入隐藏 id。
- **`App.tsx` 接线**：`view` 联合类型加 `'automation'`；侧栏按钮只 `setView('automation')`（删掉 `setSettingsSection('automation')`）；`returnView` ref 类型加 `'automation'`（否则 `if (view !== 'settings') returnView.current = view` 会编译错），**设置页关闭时能回到自动化页**；自动化页自己的返回/Esc 用 `returnView.current === 'automation' ? 'chat' : returnView.current` 兜底，否则会自指死循环。
- **右栏「收起」无需写代码**：`showRightPanel = rightPanelOpen && view === 'chat' && !panelDetached`、右侧分界线由它网关、`panelMode`（任务操作/右栏切换按钮）也排除 automation → 页面自然独占中间 + 右侧区域，`rightPanelOpen` 状态保留，回到 chat/browser 时右栏原样恢复。
- **标题栏**：标题 `自动化`；项目面包屑与 Code/Work/Browser 模式切换器在 automation 视图下隐藏；`showSidebar = sidebarOpen && view !== 'settings'` 未动 → **侧栏保留**（用户只说收起右栏），侧栏「自动化」按钮加 `aria-current="page"`。
- **已知耦合（未改，属既有行为）**：自动化的草稿仍属 `settings.automations`，任一分区 schema 校验失败会让**两个页面的自动保存同时暂停**（`if (!parsed.success) return`），`totalErrors = errors.size` 也是全局计数——今天在「通用」分区看到「有 N 处设置需要修正」而四处找不到错误，是同一现象，非本次引入。
- **校验**：typecheck 0 / lint 0 error（9 warning）/ test 115 passed + 4 skipped。**未 commit**（等用户指示）。

## 模式选择器移入侧栏（0.1.2-dev 后续交互）

- 需求：`Code/Work/Browser` 从标题栏移到**标题下方、新建任务上方**，并整理排版。
- 抽成组件内常量 `modeSwitch`（普通 JSX 常量，两处 `{modeSwitch}` 复用），侧栏用 `.sidebar-mode` 包一层，标题栏原位改成 `{!sidebarOpen && view !== 'settings' && modeSwitch}`——**与既有「展开侧栏」按钮的条件一字不差**，所以侧栏收起时仍能切模式，避免「移动 = 丢失入口」。
- **为什么删掉图标只留文字**：`--side-col: clamp(208px, 18vw, 288px)` 最小 208 px，扣侧栏 `padding 10×2` + 胶囊 `padding/border 6` + `gap 2×2` 后每段只剩 ~60 px；而「Browser」带 14px 图标 + 5px gap + 约 46px 文本 = ~61 px，**窄侧栏下必然裁字**。纯文本只需 ~46 px，全宽度区间都装得下。副作用：`CodeXml` 只有这一处用，必须从 import 移除（`Workflow`/`Globe` 另有 onboarding、消息卡片、工具图标在用，保留）。
- 新增样式：`.sidebar-mode{margin-bottom:10px}`、`.sidebar-mode .mode-switch{width:100%}`、`button{flex:1;min-width:0;justify-content:center;height:26px;padding:0 6px;white-space:nowrap}`；`.sidebar-brand` 底部 padding 12 → 8。特异性 `.sidebar-mode .mode-switch button` (0,2,1) > `.mode-switch button` (0,1,1)，**不受 5450 行那批规则顺序影响**。
- **取舍**：automation 视图侧栏现在也会显示选择器（原标题栏在该视图是隐藏它的），此时无任何项 `aria-checked`，点一下即可回 Code/Work/Browser——算改进不是回归。

## Beta 功能栏目与 aoci-code / agent-core 接入（0.1.2-dev 后续）

- **两个仓库是什么**：`aoci-code`（Go）= 持久化代码库认知索引 + 本地 stdio MCP 服务器（9 个工具），agent 读一次索引就懂系统、不必每次重读仓库；`agent-core`（TS/Bun）= 极简 agent 循环框架，卖点是停机语义。两者分别对应开关「token节省与大型项目优化」与「agent循环优化」。
- **为什么 agent-core 只移植不引入**：它绑定 Bun 运行时——`features/llm.js` 的 `Bun.hash`、`tool.js` 的 `new Bun.Glob().scan()`、`tool-process.js` 的 `Bun.spawn`/`Bun.file`，`scripts/build.js` 明写 `target:'bun'`//「只在 Bun 上跑」。Electron/Node 里跑不起来，真引入要么打 shim 要么捆 ~90MB Bun 运行时（体积优化直接报废）。经选择题用户拍板「效果一样就选移植」。**移植边界**：循环停机语义逐条等价；Gemini/Responses 协议、text-tools 纯文本工具协议、结构化输出、目录扫描工具发现**不在本次范围**（那些必须真依赖 + Bun）。
- **移植落点** `src/main/loopPolicy.ts`：`nextNoToolStep(count, rounds)` 逐行对应 `features/loop.js` 的 `noToolCount += 1` / `=== noToolRounds - 1` 置 `temporaryPrompt` / `>= noToolRounds` 返回 `no-tool`。`DEFAULT_LOOP_POLICY` = 1 轮不补问 + 0.9 压缩比（**与改动前行为逐字一致**，保证开关关着时零回归），`OPTIMIZED_LOOP_POLICY` = 3 轮 + 0.8 + 补问提示。
- **补问提示不进历史**：在 `fitContext` 之后临时拼一条 `role:'user'` 消息进请求体，`streamChat` 成功后清空；历史里看不到，避免污染对话。**steering 到达时把计数清零**（agent-core 无 steering 概念，属本地补充）。
- **AOCI 的 `--repo` 是可选的**（`aoci --help` 写 `overrides automatic discovery`），但显式给更稳，因为 `McpClient.spawn` 不设 `cwd`。`planAociServers` 用固定 id `cubex-aoci` 就地替换条目，`McpManager.sync` 以 `configKey`（含 command/args）比对 → 换项目会自动重启该 server。
- **MCP 协议版本兼容（已实测）**：Cubex `mcp.ts` 发 `protocolVersion: '2024-11-05'`，aoci 自述 `2025-11-25`；实测 stdio 直连**服务端回显 2024-11-05**（按 MCP 规范回显即支持），`tools/list` 9 个工具齐全，未初始化仓库返回带下一步提示的 `[not_initialized]`。
- **aoci 二进制**：v0.1.0-rc18 windows_amd64 zip 9,487,255 B，SHA256 与官方 `SHA256SUMS` 一致；解出 `aoci.exe` 24,729,600 B（sha256 `ee7ee51f…`）放 `vendor/aoci/`，另附 LICENSE/NOTICE/PATENTS/THIRD-PARTY-NOTICES/TRADEMARKS；`package.json` `extraResources` 加 `{"from":"vendor/aoci","to":"aoci"}` → 打包后在 `resources/aoci`，dev 下回落到仓库 `vendor/aoci`。
- **挂钩位置**：`syncAoci()` 在 `saveSettings`、启动 1200ms 定时器、`sendMessage`/`regenerateMessage` 三处调用（后两处传 threadId 精确取项目），统一写回 settings 后再 `mcp.sync`。

## 已知问题与坑

- **asar 锁定**：`npm run dist` 打包时 `release\win-unpacked\resources\app.asar` 可能被杀软/索引器锁定（非 Cubex/node 进程），导致 `Remove-Item release` 失败。绕过：结束进程 + 删 `release`/`out` 后重试；仍失败用 `npx electron-builder --win nsis "-c.directories.output=dist-out"`（`-c` 参数在 PowerShell 必须加引号）。本轮清理进程与产物后 `npm run dist` 一次成功。
- **Program Files 权限**：删除 `C:\Program Files\Cubex` 需管理员，`-Verb RunAs` 提权可能被用户取消；当前该空文件夹壳残留，不影响重装。
- **本目录现为 git 仓库**（此前记录的「非 git 仓库」已过时）：remote `origin` = https://github.com/dian-ZD/CubexDesktop.git，默认分支 `main`，最新 commit `da9b013`（2026-10-06 推送成功，含分支合并与体积优化）。`.gitignore` 已忽略 `node_modules/`、`out/`、`release/`。仍遵循「未获用户明确指令不擅自提交/推送」。
- **push 需走本地代理**：本机直连 `github.com:443` 返回 `Connection was reset`（`Test-NetConnection github.com -Port 443` = False），但本地 7890 端口有代理（Clash 类）。成功命令：`git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push origin main`。未写入 git 全局配置（避免影响其它仓库）。
- **PowerShell 下 git push 的 stderr 会被当作错误**：push 实际成功时仍显示 `NativeCommandError`，必须以 `git status -sb`（无 ahead）或 `git ls-remote origin main` 核对，不要只看退出码。
- **lint 既有告警**：`npm run lint` 现有 9 个 `react-hooks/exhaustive-deps` warning（App.tsx，多为 `tr`/`thread` 依赖），为既有告警、非本轮引入，0 error。
- **探测函数的副作用/耗时**：`probeContextWindow` 一次点击会发多轮（约 5–18 次）真实请求，默认上界 100 万 tokens；对超大模型首轮可能较慢，属预期。`low`/`high` 可调。
- **摘要压缩依赖模型可用**：无 API Key / 模型被删时 `summarize` 直接返回移除标记（非摘要），不会报错也不阻塞。
- **`step--` 重来**：主循环自动压缩后 `step--; continue`，保证压缩本身不占用步数（注意 `step` 是 `let`）。
- **`PrintWindow(hwnd, hdc, 2)` 对 Electron 抓到的是陈旧帧**：本轮点完按钮 `PrintWindow` 仍返回点击前的视图（返回 false 也可能是合成器用 D3D 交换链），据此误判成「点击没生效」。**验证 Electron UI 必须用 `Graphics.CopyFromScreen` 整屏抓图**，或走 CDP（需 `--remote-debugging-port` 启动）。
- **DPI 下的坐标虚拟化**：PowerShell 默认 DPI 感知，`GetWindowRect`/`Screen.Bounds` 返回虚拟化坐标（1920x1080@125% 变成 1536x864），算出的点击位置整体偏移 20%。**脚本开头必须 `SetProcessDPIAware()`**，之后 `GetWindowRect` 才给物理坐标（本轮 1440x840 → 1800x1050，窗口 `(48,24)` → `(60,30)`）。
- **`SetForegroundWindow` 可能静默失败**（Windows 前台锁定），点击会落到被遮挡的窗口上。可靠做法：`AttachThreadInput(当前线程, 前台线程, true)` → `BringWindowToTop` → `SetForegroundWindow` → 解绑，并用 `GetForegroundWindow()` 校验后再点。
- **最小化窗口的 `MainWindowHandle`**：`IsIconic=true` 时 `PrintWindow` 只得到 159x29 的残帧，先 `ShowWindow(h, 9)`（SW_RESTORE）再取 rect。
- **截图不要用 `HWND_TOPMOST`**：为绕开其它窗口遮挡曾 `SetWindowPos(h, HWND_TOPMOST, ...)` 提顶，其中一个脚本设了没还原，导致主窗口持续置顶、被用户当场发现（「不要让cubex永远置顶啊」）。**已清**：`SetWindowPos(h, HWND_NOTOPMOST, ...)` 后 `GetWindowLong(hwnd, GWL_EXSTYLE)` 必须为 0x0、`topmost=False`。正确做法是改窗口位置/尺寸避开遮挡，或直接问用户，不要动 z 序。
- **`SetWindowPos` 的 flag 别写反**：`SWP_NOSIZE=0x0001`、`SWP_NOMOVE=0x0002`。想「只移动不改尺寸」要传 `0x0001`（保留尺寸），传 `0x0003` 是**位置和尺寸都不动**，写了等于没写；传 0 且 `cx/cy=0` 会把窗口缩成 0。
- **dev 下 `src/main` 改了不一定重建**：本轮改了 `index.ts`/`agent.ts`/`prompt.ts` 后 `out/main/index.js` 的 mtime 仍是 dev 启动时刻、内容里查不到新符号，而 Electron 进程还是启动时那个 pid——**主进程 watcher 没触发，renderer HMR 日志也不会报**。后果是「renderer 新代码 + main 旧代码」混跑：旧 main 的 `settingsSchema.parse` 会把 `beta` 当未知键剥掉，新 renderer 读 `draft.beta.tokenSaving` 直接崩。**验证主进程改动前必须先核对 `Get-Item out\main\index.js` 的 mtime 是否晚于源文件**，不是就重启 `npm run dev`（kill `electron-vite`/`electron` 后重开）。
- **electron-vite dev 日志里只有 renderer 的 HMR 行**，主进程重建成功那几行只在**启动**时打印（`electron main process built successfully`）；运行中改 main 不一定会打印，所以别拿日志判断主进程是否是新的。

## 用户明确偏好与禁忌（尽量原样）

- 「白底logo的图标里面的内容能不能大点」——logo 内部图标要更大（已 0.72→0.88）。
- 「有时候会莫名其妙截断消息输出」——彻底根治输出截断。
- 「编译0.1.2-dev」——版本号用 0.1.2-dev。
- 「传到github上」——推送 GitHub（已完成）。
- 「添加与code work并列的第三个模式，Browser模式，参考tabbit，先给我一个plan」——**要求先出 plan 再动手**；后端用 Electron 内置 BrowserWindow、混合形态、完整版（经选择题确认）。
- 「code work browser模式选择器放移动标题下方，新建任务上方，然后整理一下排版」——模式选择器从标题栏移入侧栏（已完成，步骤 K）。
- 「不要让cubex永远置顶啊」——**主窗口与普通窗口一律不置顶**（我截图验证时临时置顶被当场发现，已清，今后不再用该手段）；**分离任务面板浮窗例外，经选择题确认「保留置顶」**，`setAlwaysOnTop(true, 'floating')` 不动。
- 历史偏好：圆角只加指定位置、i18n 彻底覆盖、需求不明先用选择题确认、全程中文回复。

## 已运行的关键命令及结果摘要

- `npm run typecheck` → exit 0。
- `npm run lint` → exit 0（9 warning，0 error）。
- `npm test` / `npx vitest run` → **130 passed，4 skipped**（新增 `tests/loopPolicy.test.ts` 6 + `tests/aoci.test.ts` 9；此前 115/4，再往前 94/2、86/2）。
- `npm run dist`（0.1.2-dev）→ 成功，产物 `release\Cubex Setup 0.1.2-dev.exe` = **106,219,152 bytes（101.30 MB）**，已签名 + blockmap，x64；优化前同名产物为 144,532,022 bytes。
- git：`git add -A` → `git commit` → 走 7890 代理 `git push origin main` 成功（`4e534a3`→`da9b013`，11 个提交含分支合并，`ls-remote` 带代理核对一致）。

## 未解决问题 / 待确认

- `browser_crawl` 尚未在真实会话中跑通（需真实网络与已配模型）；后台离屏抓取在国内站点/搜索引擎反爬下的成功率待实测。
- 引用溯源未实测：回答里的 `[n]` 角标点击跳转、右栏「资料报告」导出 `.md`（`exportText` IPC 走保存对话框）需在真实会话验证。
- Browser 模式实时画面：MVP 用 `capturePage` 截图流还是完整版直接 `WebContentsView` 内嵌？（已在 plan 中向用户提出，倾向先截图流）
- ~~是否需要清掉 `C:\Program Files\Cubex` 空壳？~~ 历史遗留，仍待确认。
- `author` 字段缺失导致 electron-builder 警告（不影响安装包），是否补上后重打？
- **aoci 二进制的处理（2026-10-06 用户已拍板，三项）**：① **`vendor/aoci/aoci.exe`（24.7 MB）提交进 git**——仓库会永久变重，换来「clone 即可打包」的可复现性；② **aoci 许可证 FSL-1.1 确认可以捆绑分发**，LICENSE/NOTICE/THIRD-PARTY-NOTICES/PATENTS/TRADEMARKS 随二进制放进 `vendor/aoci/` 一并打包；③ **同意跑 `npm run dist` 覆盖 `release\Cubex Setup 0.1.2-dev.exe`**（已执行并验证，`0.1.1.exe` 旧包保留）。决定已记录，但**尚未执行 commit**（按规则等用户明确指示提交，届时 `vendor/` 一并纳入）。
- **Beta 功能 + aoci 已端到端实测通过**（dev 版与**打包版**各测一遍，CDP 手法见下）：分区渲染、开关切换、`state.json` 落盘、MCP 列表自动长出 `aoci` 条目并显示「已连接 · 9 个工具」、关掉开关自动移除，全部验证。**打包版**额外确认 `command` 指向 `release\win-unpacked\resources\aoci\aoci.exe`（`process.resourcesPath` 落点，不是 dev 的 `vendor/aoci` 回落分支）。安装包 106.22 → **107.51 MB（+6.21 MB）**。测试时打开的开关均已还原为默认 `false`。
- **锁屏时怎么验 Electron UI**：屏幕锁了（前台是 `LockApp`）→ `CopyFromScreen` 只能拍到锁屏画面，`SetForegroundWindow` 也会失败（`SetForegroundWindow=False`）。**改用 CDP**：用 `Start-Process electron.exe -ArgumentList '--remote-debugging-port=9333','.' -RedirectStandardOutput/-RedirectStandardError` 启动（**别用 `& electron ... | Out-String`，会永久挂起**），Node 22 有全局 `WebSocket`，连 `GET http://127.0.0.1:9333/json/list` 里的 `webSocketDebuggerUrl`，用 `Runtime.evaluate`（`returnByValue:true` + 需要异步时 `awaitPromise:true`）点按钮读 DOM，用 `Page.captureScreenshot` 截图——**离屏渲染，与锁屏无关**。注意 `window.cubex.getState()` 返回的是 `{ok, data}` 包装，取 `s.data.settings`；直接把大对象塞进 `returnByValue` 会拿到 `undefined`，在页面里先 `JSON.stringify` 成字符串更稳。

## 临时性上下文

- 冒烟测试会把 userData 指向临时目录：`CUBEX_SMOKE=1` 时 `app.setPath('userData', temp/cubex-smoke-<pid>)`（`src/main/index.ts` 第 18 行）。
- 管理端（历史阶段）运行于 `http://127.0.0.1:4800`，管理密钥经环境变量 `CUBEX_ADMIN_KEY` 注入——**真实值不写入此处**，仅记引用位置。
