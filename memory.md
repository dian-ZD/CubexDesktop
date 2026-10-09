# 记忆

> 最后更新时间：2026-10-09 ｜ 更新者：AI Agent（0.3.1-dev：透明度/圆角/拖动/对齐/报错修复）
>
> 记录项目中长期有效的事实与本轮任务的过程细节。任务目标见 goal.md，步骤进度见 plan.md，此处不重复大段步骤说明。

## 技术栈与约定

### 2026-10-09 电脑操控、悬浮窗、思考等级与复制/语音修复

- **独立桌面（电脑操控）**：`src/main/computer.ts` 用 PowerShell P/Invoke 做四件事——`CreateDesktop` 建 `CubexAgent` 桌面、`CreateProcess`（`lpDesktop` 指向该桌面）启动应用、`gdi32` 的 `CreateDC/CreateCompatibleBitmap/BitBlt` 截屏、`EnumDesktopWindows` 按标题找窗口后 `PostMessage` 点击/输入。坑（全部实测定位）：① GDI 函数写成 user32.dll 会报找不到入口点，必须 gdi32.dll；② `Add-Type` 里可选字符串指针传 `$null` 会被当空串，`CreateProcess`/`CreateDC` 返回 123/87，必须 `[NullString]::Value`；③ `CreateProcess` 的 `lpCurrentDirectory` 传 `$null` 同样触发 123；④ `FindWindow` 看不到其它桌面的窗口，只能在目标桌面内枚举；⑤ PowerShell 输出默认 OEM 代码页，中文标题必须 base64 传输。
- **镜像帧下发**：`liveWindows()` 必须包含悬浮窗，否则镜像 IPC 到不了悬浮窗（曾因此看不到画面）。
- **当前桌面避让**：`GetLastInputInfo` 取用户空闲秒数，`waitForUserIdle` 在设置的上限内等待；超限则放弃本次输入并如实返回，不强行抢鼠标。
- **悬浮窗**：主进程新建 frameless/transparent/alwaysOnTop/skipTaskbar 窗口，hash `#floating`，渲染 `components/FloatingPanel.tsx`；透明度来自 `settings.floating.opacity`，自动弹出由 `settings.floating.autoShow` 控制，触发点是扩展层 `onControl`（任务开始操控浏览器/电脑）。`window.cubex` 桥接复用同一 preload，`trusted()` 与 `liveWindows()` 已覆盖该窗口。
- **思考强度**：`modelParams.thinkingLevel`（off/low/medium/high，默认 null）经 `mergeModelParams` 支持单模型覆盖；OpenAI 兼容走 `reasoning_effort`，Anthropic 走 `thinking.budget_tokens`。是否支持用 `supportsThinkingLevel(modelId)` 按已知推理/普通模型名单判断，未知型号按支持处理并在 UI 标注。
- **语音输入**：打包后渲染页在 app.asar 内 file://，里面 `new Worker(url, {type:'module'})` 能构造但起不来（worker 里 sandboxed_renderer bundle 报 `binding.startupData` 为 null），表现为状态卡在「正在识别」。改为渲染进程主线程动态 `import('@xenova/transformers')`（whisper-tiny + onnxruntime-web，wasmPaths 显式指向 jsdelivr）。`src/renderer/index.html` 的 CSP meta 必须放行 `script-src 'wasm-unsafe-eval'` 与 `connect-src https://huggingface.co https://*.hf.co https://cdn.jsdelivr.net`，否则 wasm 编译和模型下载都会被拦。
- **复制**：`navigator.clipboard.writeText` 在窗口未聚焦时直接抛 `NotAllowedError: Document is not focused`（实测），点「复制」恰恰常发生在焦点切换后。所有复制改走主进程 `clipboard.writeText`（新增 `copyText` IPC），浏览器预览模式回退到 `navigator.clipboard`。
### 2026-10-09 0.3.1-dev 修复轮（透明度/圆角/拖动/对齐/报错）

- **CSS 变量缺失是多个「透明/无边框」现象的共同根因**：`styles.css` 用了 `--bg-panel`、`--accent`、`--surface`、`--border`、`--text-secondary`、`--matcha-dim` 六个变量，但全文件从未 `:define`，深浅主题都没有。未定义变量在 `color-mix()` 与 `background` 里会让整条声明失效 → 背景变全透明、边框消失。已补齐并保留原配色语义（`--accent` 取原 accent 蓝，`--bg-panel` 深 #23252a / 浅 #ffffff）。**教训：新增 CSS 变量必须同时加进 `:root` 与 `[data-theme='light']` 两处。**
- **Electron `shell.openPath()` 的失败返回值就是字符串 `"Failed to open path"`**（已用 electron 直调复现，空字符串与 http 地址返回 `""` 表示成功）。所以用户看到的「一直报错 Failed to open path」来自 `computer_use open` 工具，不是抛异常。修复：相对路径 `resolve(root, raw)`、未注册关联的应用名回落 `cmd /c start`、路径不存在时给中文提示。
- **`transparent: true` 的无边框窗口在 Windows 上圆角外会露出 DWM 灰色残留**（用户描述的「灰色的尖」）。悬浮窗改为不透明窗口 + `backgroundColor` 随主题（`nativeTheme.shouldUseDarkColors` 判断 system），圆角交给 CSS。
- **`-webkit-app-region: drag` 会被任何后代的 `no-drag` 覆盖**：之前拖动条规则写在 `.floating-window`，而内层 `.floating-panel` 整个 `no-drag`，等于完全不可拖。改为只给 `.floating-head` 设 drag、其内 button 设 no-drag。
- **滑条几何统一用「半径内缩」公式**：`left: calc(r + ratio * (100% - 2r))` + `transform: translate(-50%,-50%)`，让滑块中心、刻度点中心、填充条末端三者重合（旧实现滑块用 `translate` 而填充条用 `left`，两端各差半个滑块宽）。模型选择器 `THUMB=10`，设置滑条 `SLIDER_THUMB=8`。
- **原生 `input[type=range]` 不适合这里的视觉**：端点处留白、填充与滑块无法对齐，且 accent-color 在深色主题下不跟随强调色。改为自绘 `Slider` 组件（`.slider` / `.slider-fill` / `.slider-thumb` + 磁吸 transition），提示音音量与悬浮窗透明度共用。
- **悬浮窗透明度「调整不好使」**：`applyFloatingOpacity()` 只在建窗时调用，设置改了不生效。改为在 `publish()`（所有 store 变更的统一出口）里每次都调用，并顺带同步 `backgroundColor`。
- **语音下载源**：`speech.downloadSource: 'auto' | 'official' | 'mirror'`，`speech.ts` 里 `REMOTE_HOSTS = { official: 'https://huggingface.co/', mirror: 'https://hf-mirror.com/' }`，`loadAsr()` 按 hostsFor 依次尝试、每个 host 独立缓存（key `${host}|${modelId}`），全部失败才抛出带「可更换下载源」提示的中文错误。「没有识别到语音内容」从 `error` 降级为 `info`（`useSpeech` 的 `onError` 增加可选 kind 参数）。
- **VocoType 是独立桌面应用（内核阿里 FunASR），不是可替换的模型文件**；用户在选择题里选了「保持在线下载 + 国内镜像」，故未接入 FunASR 引擎。
- **i18n 无覆盖测试**：`tests/` 里没有 phrases 覆盖用例，`tr()` 缺词条不会报错，只会让英文界面残留中文。本轮扫描 `src/renderer` 全部 835 条 `tr('…')` 字面量，补齐 56 条缺失英文（新增 `miscPhrases` Record 并在 `registerPhrases` 注册），现为 0 缺失；后续改文案可用同样方式正则扫描 `phrases.ts` 是否包含该 key。
- 版本 0.2.2-dev → **0.3.1-dev**（仅改 `package.json` 的 `version`，源码无硬编码版本号）。

### 2026-10-09 语音、悬浮窗与模型选择器细节

- **语音（音乐）幻觉**：`（音乐）` 是 whisper 对静音/低电平音频的典型幻觉，分块解码还会把首尾静音块的幻觉文本拼进结果。`prepareAudio()` 按 20ms 帧 RMS 裁掉首尾静音、把峰值归一化到约 -3 dBFS（增益上限 4×，避免放大噪声），峰值过低直接返回空样本；超过 30 秒才启用 `chunk_length_s`；`stripHallucination()` 命中整段幻觉短语时返回空，交由 UI 提示「没有识别到语音内容」。模型可在 设置 → 通用 → 语音输入 里换（轻量/均衡/较准）。
- **悬浮窗生命期**：`controlActive` + `floatingAuto` 两个标记决定收放——`onControl` 激活时按 `floating.autoShow` 弹出并（独立桌面模式）启动镜像，失活时 `releaseControlFloating()` 收起自动弹出的窗口并停镜像；`force`（标题栏手动打开）不受影响。2 秒兜底计时器也改为只在操控期间检查镜像。
- **模型选择器**：单组件双模式（`slider` / `models`）。默认显示等级名 + 模型名（点击进列表、隐藏滑条）；滑条用绝对定位 + `transition: left 220ms cubic-bezier(0.34,1.5,0.64,1)` 做磁吸回弹，dragging 时关掉过渡跟手。`stopFromClientX()` 按轨道宽度算档位，键盘方向键也可调。**坑：合成 PointerEvent 没有真实指针，`setPointerCapture` 会抛 NotFoundError，必须先 `pick()` 再用 try/catch 包住 capture。**
- **设置分组**：Row 增加 `group`，渲染时同一分组只显示一次标题（`sortByGroup` 保证分组顺序稳定）；「通用」分区图标换成 `SlidersHorizontal`。
- 当前本机无法访问 huggingface.co，模型下载类验证只能靠预处理单测；真实中文识别需用户在能联网的环境实测。

### 2026-10-07 HTTP 端点与 0.2.2-dev 安装包

- providerSchema 已允许任意 HTTP/HTTPS 模型端点，仍拒绝 URL 凭据、查询参数、片段和其它协议；设置占位与中英文校验提示同步更新。
- package.json 与 package-lock.json 的项目版本均为 0.2.2-dev；build.copyright 为 Copyright © 2026 HIGHLIGHT STUDIO。
- typecheck 通过，lint 0 error / 9 既有 warning，全量 158 passed / 4 skipped；npm run dist 成功。安装包 release\Cubex Setup 0.2.2-dev.exe 为 112,742,496 B，SHA256 为 DCCF8066ACCB87B029F92ABB297E3F9F407711F74D94A7A05E2A9900908708AA。
- 安装包和 win-unpacked\Cubex.exe 的版权字段均包含 HIGHLIGHT STUDIO 与 ©；Authenticode 状态均为 NotSigned，不能把 builder 的 signing 日志当作已有数字签名。安装包 ProductVersion 为 0.2.2-dev，应用 EXE ProductVersion 为 Windows 数值版本 0.2.2.0，FileVersion 为 0.2.2-dev。
- asar 内 package.json 版本正确，19 个 out 构建文件逐字节核对通过；打包版 CUBEX_SMOKE=1 使用隔离 userData，输出 smoke-ready 并以 0 退出。此验证未执行安装向导或覆盖用户安装。
- Windows 上 asar.listPackage 返回反斜杠路径，extractFile 使用已发现的归档路径去掉首个反斜杠；使用 API 返回字节，不使用会覆盖当前 package.json 的 extract-file CLI。
- 0.2.2-dev 包含此前所有未发布增强与 Browser 修复。旧安装包保留，未 commit/push；真实模型服务端超时仍未进行真实端点复测。

### 2026-10-07 Browser 页面显示范围修复

- 覆盖其他页面的原因：BrowserEngine.run/manualNavigate 原先无条件 attach，能把已隐藏的原生 WebContentsView 重新挂到主窗口。现在只有可见工作台上报有效 bounds 才取得显示资格，工具和导航仅同步当前可见会话；hide 清除 bounds，零尺寸也隐藏。
- BrowserWorkspace 的尺寸回调检查当前可见性、会话和卸载状态，避免异步标签操作完成后重新挂载已离开的页面。网页后台加载和抽取仍可继续。
- 新增 4 项引擎回归；全量 157 passed / 4 skipped，typecheck、lint（0 error / 9 既有 warning）、build、test:desktop 通过。C:\Windows\Temp\opencode\cubex-browser-visibility-main.cjs 使用隔离 userData、本地 HTTP 页面和真实 WebContentsView，验证加载中隐藏、后台动作不抢占、切回恢复、零尺寸隐藏；测试窗口不置顶且无额外浮窗。
- 本轮回归/冒烟匹配进程为 0，识别 CRLF 的 diff 检查通过。源码和 out 已更新；release 安装包未重打，未 commit/push。

### 2026-10-07 文件编辑、请求处理与推荐选项

- 文件保存通过 saveProjectFile IPC，校验项目内路径、UTF-8 文本、长度及 expectedContent，拒绝用旧内容覆盖已变化的文件；同路径手动保存串行。此校验不是跨进程文件锁，不能保证与外部程序同时写入时的原子性。
- 文件预览与变更使用同一个 FileEditor，支持编辑、保存、Ctrl/Cmd+S、重新加载；截断预览禁止保存。草稿保存在当前渲染进程内存，跨面板切换保留，不跨应用退出或独立窗口共享。重新加载会确认放弃脏草稿；保存失败保留草稿。
- context deadline exceeded / Client.Timeout 出现在响应体时属于服务端或中转上游报错，不能通过调大本地时限解决。streamChat 统一限制总重试次数：仅尚未发出文本的暂时性故障自动重试；已有文本时不自动重放，AgentRunner 保留部分文本。未使用真实端点复测，仍需实际使用反馈。
- 错误提示条的“继续”向对应会话发送原文“继续”，不清空输入草稿；忙碌或非末尾错误不可用，点击锁防重复。
- ask_user 保留字符串 options，新增 recommended（必须匹配一个选项）；标题右侧显示高亮点。agent.autoSelectRecommended 默认 false，设置入口在「规则与记忆」，沿用设置页自动保存机制；有效推荐直接返回工具选择结果，并记录自动选择来源，不伪装成人工回答；无效推荐仍等待用户，不绕过工具审批。
- useI18n 的 t/tr 通过 useCallback 保持同语言下引用稳定，避免文件面板依赖 tr 的加载 effect 反复运行。文件读取加请求序号，忽略过期返回。
- 校验：typecheck 通过，lint 0 error / 9 既有 warning，153 passed / 4 skipped；build、test:desktop 通过。隔离 UI 脚本 C:\Windows\Temp\opencode\cubex-editor-regression-main.cjs 验证编辑保存与冲突、推荐标记及自动保存、“继续”防重、1400/900px 模型布局。模拟桥接不调用真实模型服务。
- 源码与 out 已更新，release 安装包未重打，未 commit/push。

### 2026-10-07 本轮结果

- 消息滚动原先在内容增高后判断距底距离，大段更新可能失去跟随。现在单独记录跟随意图，监听内容尺寸变化；消息初始与增量批次均为 8 条，历史定位不再展开目标之后的全部消息。所有消息类型均有 data-message-id，用于保留加载锚点。
- delegate 每批最多 32 项，并发设置范围 1–16、默认 8；配置保存在 agent.subagentProfiles，运行记录保存在 thread.subagentRuns（最多 64 条）。研究/审查角色强制只读，工具执行时检查允许列表；其它角色仍沿用项目权限与审批。
- 多子任务审批通过每轮队列串行处理，审批调用 ID 加子任务 ID 前缀，避免覆盖同一个审批槽位；停止会释放等待。程序重启时未完成的子任务标记 cancelled。右栏摘要显示最近一批任务，默认 8 张卡片，可继续加载和展开结果。
- 本轮校验：typecheck 通过；lint 0 error / 9 既有 warning；137 passed / 4 skipped；npm run build 与 test:desktop 成功。新增 7 条单元测试覆盖子智能体权限、模型、并发排队、审批隔离、取消、部分失败及配置迁移。
- 隔离 Electron UI 回归使用 C:\Windows\Temp\opencode\cubex-scroll-regression-main.cjs 及配套 preload/schema，加载当前 out/renderer 和模拟桥接，不读取真实用户状态或调用模型。已验证初始分页、大段内容和流式贴底、上翻期间新消息、历史定位、返回最新、逐批加载锚点、进度详情与配置表单。隐藏窗口的 requestAnimationFrame 不稳定，showInactive 后验证正常；测试实例自行退出。
- 本轮只更新源码及 out 构建，尚未重打 release 安装包，亦未提交/推送。此前安装包不能用于验证本轮新增功能。

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
- 版本策略：现为 **`0.2.1`**（2026-10-06 用户指示「编译 0.2.1」，`package.json` 从 `0.1.2-dev` 改为 `0.2.1`；此前 `0.1.2-dev` 也是用户明确指定的）。版本号全项目只在 `package.json` 一处，`src/` 无硬编码引用——NSIS 产物名 `Cubex Setup <version>.exe` 直接反映它。
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
- **aoci 二进制的体积代价**：`extraResources` 加 `vendor/aoci → aoci` 后重打，安装包 106,219,152 → 112,735,101 B，即 **106.22 → 112.74 MB（+6.52 MB / +6.13%，十进制）**。`aoci.exe` 裸文件 24.7 MB，但 NSIS/7z 对 Go 静态二进制压缩率高，**实际只涨 6.5 MB**——比「24.7 MB 直接相加」的直觉低得多，别拿裸文件大小估算安装包涨幅。electron-builder 会先 `signing with signtool.exe path=release\win-unpacked\resources\aoci\aoci.exe`（哈希未变说明本机无证书时是空操作）。
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
- **push 先测通再选路径（2026-10-06 更新，旧结论已部分失效）**：**曾经**直连 `github.com:443` 返回 `Connection was reset`，需走本地 7890 代理：`git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push origin main`（未写入 git 全局配置，避免影响其它仓库）。**但 2026-10-06 实测该代理已不可用**——`127.0.0.1:7890` 无 LISTEN（FlClash 核心只开着 1053 DNS，`ProxyEnable=0`），带代理直接 `Failed to connect to github.com:443 over proxy`；而**直连反而通了**（`git ls-remote origin main` 成功，直推 `26be755..9ea6de1` 成功）。**正确做法：先 `git ls-remote origin main`（不带参数）试一下，失败再补代理参数**——两个方向的网络状况都会随翻墙工具开合而变，别按记忆硬套。
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
- **`npx @electron/asar extract-file <asar> package.json` 会覆盖当前目录的 `package.json`**：它的第 2 个参数是**输出文件名**（不是「要提取的文件名」），且**写本地文件、不吐 stdout**。本轮因此把打包版的 package.json 写进了项目根，`scripts`/`build`/`devDependencies` 全没，`npm run typecheck/lint/test` 一律报 `Missing script`。**读 asar 内容必须先 `cd` 到临时目录再执行**，或用 `> 重定向`（也一样写本地，不可靠）。发现后 `git checkout -- package.json` 恢复、再重打版本号即可；**顺带记下 electron-builder 的行为：打进 app.asar 的 package.json 会被剥成 19 行（只留 name/version/private/description/author/type/main/engines/dependencies，去掉 scripts/build/devDependencies），这是正常现象，不是文件损坏**——判断产物版本直接在 asar 里搜 `"version": "0.2.1"`。
- **electron-vite dev 日志里只有 renderer 的 HMR 行**，主进程重建成功那几行只在**启动**时打印（`electron main process built successfully`）；运行中改 main 不一定会打印，所以别拿日志判断主进程是否是新的。

## 用户明确偏好与禁忌（尽量原样）

- 「白底logo的图标里面的内容能不能大点」——logo 内部图标要更大（已 0.72→0.88）。
- 「有时候会莫名其妙截断消息输出」——彻底根治输出截断。
- 「编译0.1.2-dev」→ 后被 **「编译0.2.1」** 取代（2026-10-06）——版本号以最新指示为准，当前 `0.2.1`。
- 「删掉吧，然后编译0.2.1」——旧安装包 `release\Cubex Setup 0.1.1.exe` 直接删（已删 137.83 MB + blockmap 0.14 MB，删除前确认无进程占用）。
- 「传到github上」——推送 GitHub（已完成）。
- 「添加与code work并列的第三个模式，Browser模式，参考tabbit，先给我一个plan」——**要求先出 plan 再动手**；后端用 Electron 内置 BrowserWindow、混合形态、完整版（经选择题确认）。
- 「code work browser模式选择器放移动标题下方，新建任务上方，然后整理一下排版」——模式选择器从标题栏移入侧栏（已完成，步骤 K）。
- 「不要让cubex永远置顶啊」——**主窗口与普通窗口一律不置顶**（我截图验证时临时置顶被当场发现，已清，今后不再用该手段）；**分离任务面板浮窗例外，经选择题确认「保留置顶」**，`setAlwaysOnTop(true, 'floating')` 不动。
- 历史偏好：圆角只加指定位置、i18n 彻底覆盖、需求不明先用选择题确认、全程中文回复。

## 已运行的关键命令及结果摘要

- `npm run typecheck` → exit 0。
- `npm run lint` → exit 0（9 warning，0 error）。
- `npm test` / `npx vitest run` → **130 passed，4 skipped**（新增 `tests/loopPolicy.test.ts` 6 + `tests/aoci.test.ts` 9；此前 115/4，再往前 94/2、86/2）。
- `npm run dist` → 三轮产物（**统一十进制 MB = bytes/10⁶**；PowerShell 的 `$_.Length/1MB` 得到的是 MiB，别混用）：① 体积优化版 `Cubex Setup 0.1.2-dev.exe` = 106,219,152 B（106.22 MB，此前记为「101.30 MB」实为 MiB）；② 打入 aoci 后同名重打 = 112,735,101 B（**112.74 MB**，+6.52 MB / +6.13%）；③ 升版后 `Cubex Setup 0.2.1.exe` = 112,735,082 B（**112.74 MB**）。优化前的 0.1.1 包为 144,527,112 B（144.53 MB）。
- **`release\latest.yml` 是死文件**：内容停在 `version: 0.1.1`、`releaseDate: 2026-09-30`，每次 `electron-builder` 构建**都不会重写**它——因为 `package.json` 的 `build` 下没有 `publish` 字段，NSIS 只在有发布渠道时才生成/更新更新清单。目前项目不用自动更新，所以无害；**若以后要上 electron-updater，必须先补 `publish` 配置，否则会去拉一个 0.1.1 的旧版本。**
- git：`git add` → `git commit -F` → push 成功（`4e534a3`→`da9b013` 走 7890 代理，11 个提交含分支合并）。**2026-10-06**：`a07116f`（feat，19 files/+2353−50）+ `9ea6de1`（docs）**直连**推成功，`26be755..9ea6de1  main -> main`，`ls-remote` 返回 `9ea6de1a668…` 与本地 HEAD 一致，`git status -sb` 无 ahead。

## 未解决问题 / 待确认

- `browser_crawl` 尚未在真实会话中跑通（需真实网络与已配模型）；后台离屏抓取在国内站点/搜索引擎反爬下的成功率待实测。
- 引用溯源未实测：回答里的 `[n]` 角标点击跳转、右栏「资料报告」导出 `.md`（`exportText` IPC 走保存对话框）需在真实会话验证。
- Browser 模式实时画面：MVP 用 `capturePage` 截图流还是完整版直接 `WebContentsView` 内嵌？（已在 plan 中向用户提出，倾向先截图流）
- ~~是否需要清掉 `C:\Program Files\Cubex` 空壳？~~ 历史遗留，仍待确认。
- `author` 字段缺失导致 electron-builder 警告（不影响安装包），是否补上后重打？
- **aoci 二进制的处理（2026-10-06 用户已拍板，三项）**：① **`vendor/aoci/aoci.exe`（24.7 MB）提交进 git**——仓库会永久变重，换来「clone 即可打包」的可复现性；② **aoci 许可证 FSL-1.1 确认可以捆绑分发**，LICENSE/NOTICE/THIRD-PARTY-NOTICES/PATENTS/TRADEMARKS 随二进制放进 `vendor/aoci/` 一并打包；③ **同意跑 `npm run dist` 覆盖 `release\Cubex Setup 0.1.2-dev.exe`**（已执行并验证，`0.1.1.exe` 旧包保留）。决定已记录，但**尚未执行 commit**（按规则等用户明确指示提交，届时 `vendor/` 一并纳入）。
- **Beta 功能 + aoci 已端到端实测通过**（dev 版与**打包版**各测一遍，CDP 手法见下）：分区渲染、开关切换、`state.json` 落盘、MCP 列表自动长出 `aoci` 条目并显示「已连接 · 9 个工具」、关掉开关自动移除，全部验证。**打包版**额外确认 `command` 指向 `release\win-unpacked\resources\aoci\aoci.exe`（`process.resourcesPath` 落点，不是 dev 的 `vendor/aoci` 回落分支）。安装包 106.22 → **112.74 MB（+6.52 MB）**。测试时打开的开关均已还原为默认 `false`。
- **`release\` 里现在有两个安装包**：`Cubex Setup 0.2.1.exe`（当前版本，112,735,082 B）与被它取代的 `Cubex Setup 0.1.2-dev.exe`（112,735,101 B，内容除版本号外一致）。**要不要删 0.1.2-dev 包待用户确认**；`release\latest.yml` 是停在 0.1.1 的死文件（无 `publish` 配置），也待确认是否删。
- **锁屏时怎么验 Electron UI**：屏幕锁了（前台是 `LockApp`）→ `CopyFromScreen` 只能拍到锁屏画面，`SetForegroundWindow` 也会失败（`SetForegroundWindow=False`）。**改用 CDP**：用 `Start-Process electron.exe -ArgumentList '--remote-debugging-port=9333','.' -RedirectStandardOutput/-RedirectStandardError` 启动（**别用 `& electron ... | Out-String`，会永久挂起**），Node 22 有全局 `WebSocket`，连 `GET http://127.0.0.1:9333/json/list` 里的 `webSocketDebuggerUrl`，用 `Runtime.evaluate`（`returnByValue:true` + 需要异步时 `awaitPromise:true`）点按钮读 DOM，用 `Page.captureScreenshot` 截图——**离屏渲染，与锁屏无关**。注意 `window.cubex.getState()` 返回的是 `{ok, data}` 包装，取 `s.data.settings`；直接把大对象塞进 `returnByValue` 会拿到 `undefined`，在页面里先 `JSON.stringify` 成字符串更稳。

## 临时性上下文

- 冒烟测试会把 userData 指向临时目录：`CUBEX_SMOKE=1` 时 `app.setPath('userData', temp/cubex-smoke-<pid>)`（`src/main/index.ts` 第 18 行）。
- 管理端（历史阶段）运行于 `http://127.0.0.1:4800`，管理密钥经环境变量 `CUBEX_ADMIN_KEY` 注入——**真实值不写入此处**，仅记引用位置。
