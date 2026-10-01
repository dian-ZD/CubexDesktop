# 记忆

> 最后更新时间：2026-10-01 ｜ 更新者：AI Agent（Linux 环境实测记录 + 工作区治理建立）
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

## 已知问题与坑

- **asar 锁定**：`npm run dist` 打包时 `release\win-unpacked\resources\app.asar` 可能被杀软/索引器锁定（非 Cubex/node 进程），导致 `Remove-Item release` 失败。绕过：结束进程 + 删 `release`/`out` 后重试；仍失败用 `npx electron-builder --win nsis "-c.directories.output=dist-out"`（`-c` 参数在 PowerShell 必须加引号）。本轮清理进程与产物后 `npm run dist` 一次成功。
- **Program Files 权限**：删除 `C:\Program Files\Cubex` 需管理员，`-Verb RunAs` 提权可能被用户取消；当前该空文件夹壳残留，不影响重装。
- **本目录现为 git 仓库**（此前记录的「非 git 仓库」已过时）：remote `origin` = https://github.com/dian-ZD/CubexDesktop.git，默认分支 `main`，最新 commit f57ade2。`.gitignore` 已忽略 `node_modules/`、`out/`、`release/`。仍遵循「未获用户明确指令不擅自提交/推送」。
- **lint 既有告警**：`npm run lint` 有 7 个 `react-hooks/exhaustive-deps` 关于 `tr` 的 warning（App.tsx），为既有告警、非本轮引入，0 error。

## Linux 环境与平台事实（2026-10-01 实测）

- 本机为 Linux / **原生 GNOME（Wayland 会话）**（用户 2026-10-01 确认），Electron 44 在该机上走原生 Wayland 后端（日志 `ui/ozone/platform/wayland/*`），不是 XWayland。日志中 `Server doesn't support zcr_alpha_compositing_v1` 为 KWin 专属扩展，GNOME 下缺失属预期，不代表透明能力不可用；`Failed to register with org.freedesktop.host.portal.Registry` 对截图/透明窗口的实际影响以运行时实测为准。
- Node v26.8.2 / npm 11.19.1。**npm 11.19 的 install-scripts 白名单会跳过 electron 的下载脚本**：`npm ci` 后 `node_modules/electron/dist` 缺失，需 `node node_modules/electron/install.js` 手动补齐（国内网络可加 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）。
- Linux 测试基线（2026-10-01 SPEC-002 完成后）：`vitest run` = **85 passed / 0 failed / 2 skipped**（Linux 全绿，T3 已修复 p9:153）。
- Linux 打包（SPEC-002 T1）：`build.linux` 已配置（AppImage+deb，icon=build/icon.png）；**electron-builder 必须带 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`**（直连 GitHub 下载 electron zip 会 EOF）；Linux 可执行名取 package.json `name`（cubex-desktop）；打包态冒烟已验证（`release/linux-unpacked/cubex-desktop` → smoke-ready）。
- 冒烟：`npm run test:desktop` 首次冷启动超过脚本内置 20 秒阈值误报超时，二次运行通过；直接单跑 `electron .` 0.5 秒即输出 `smoke-ready`。
- 启动日志另有 `ERROR:crypto/nss_util.cc NSS error code: -8018`（根证书加载失败），影响范围未核实。
- **GNOME Wayland 运行时实测（2026-10-01，/tmp 独立脚本，非仓库文件）**：① `transparent:true + frame:false` 窗口渲染正常（capturePage 输出 RGBA，角点 alpha=0，缩放 1.25 生效）；② `desktopCapturer.getSources(screen)` **本机确定性不可用**——Wayland 原生报 `ScreenCastPortal failed: 3`（授权弹窗从未出现，portal 无活动 Request），强制 `--ozone-platform=x11` 则 >15s 挂起；③ `capturePage` 路径可用（分享图功能不受影响）。结论已写入 SPEC-001 T7（P2→P1）。
- 发布链路现状：`npm run dist` Windows NSIS；`npm run dist:linux` AppImage+deb（SPEC-002 已落地并验证）。
- 工作区治理：`rules/`、`specs/` 已建立；`docs/`、`achieve/` 暂不建；AGENTS.md 体系沿用现有四文件。
- 全局技能：`project-development` 已装到 `~/.trae-cn/skills/project-development/`（是 icelab-site 那份 SKILL.md 的副本，后续更新需手动同步）。

## 用户明确偏好与禁忌（尽量原样）

- 「白底logo的图标里面的内容能不能大点」——logo 内部图标要更大（已 0.72→0.88）。
- 「有时候会莫名其妙截断消息输出」——彻底根治输出截断。
- 「编译0.1.2-dev」——版本号用 0.1.2-dev。
- 「传到github上」——推送 GitHub（已完成）。
- 「添加与code work并列的第三个模式，Browser模式，参考tabbit，先给我一个plan」——**要求先出 plan 再动手**；后端用 Electron 内置 BrowserWindow、混合形态、完整版（经选择题确认）。
- 历史偏好：圆角只加指定位置、i18n 彻底覆盖、需求不明先用选择题确认、全程中文回复。

## 已运行的关键命令及结果摘要

- `npm run typecheck` → exit 0。
- `npm run lint` → exit 0（7 warning，0 error）。
- `npm test` / `npx vitest run` → 77 passed，2 skipped。
- `npm run dist`（0.1.2-dev）→ 成功，产物 `release\Cubex Setup 0.1.2-dev.exe`（已签名 + blockmap，x64）。
- git：`git add -A` → `git commit`（commit f57ade2，24 文件 +1793/−231）→ `git push origin main`（`46cbaa7`→`f57ade2`）成功。
- （2026-10-01 / Linux / Node v26.8.2）`tsc --noEmit` → exit 0；`eslint .` → 0 error / 7 warning；`electron-vite build` → 成功（2001 modules，产出 `out/`）；`vitest run` → 76 passed / 1 failed / 2 skipped（唯一失败 `tests/p9.test.ts:153`）；`npm run test:desktop` → 首次超时、二次通过；`npm ci` → 6 分钟 / 566 包（electron 二进制需手动补）。

## 未解决问题 / 待确认

- Browser 模式实时画面：MVP 用 `capturePage` 截图流还是完整版直接 `WebContentsView` 内嵌？（已在 plan 中向用户提出，倾向先截图流）
- `specs/SPEC-001-linux-compatibility.md`（Linux 兼容性）为**草案**，待用户 Review 后决定实施范围；P0 为 Linux 打包配置（T1）与 Linux 必挂测试（T3）。
- 全局技能 `~/.trae-cn/skills/project-development/` 与 icelab-site 源目录是两份独立副本，是否需要约定同步方式（否则后续更新会漂移）。
- 是否需要清掉 `C:\Program Files\Cubex` 空壳？（历史遗留，待确认）
- `author` 字段缺失导致 electron-builder 警告（不影响安装包），是否补上后重打？

## 临时性上下文

- SPEC-002 提交策略（用户 2026-10-01 明确指令）：**分阶段本地 commit 留痕，禁止 push / 开 PR**；仓库无本地 git 身份，提交用 `git -c user.name="dian-ZD" -c user.email="liangdianhs@163.com"` 单次覆盖（不改 git config）。
- 冒烟测试会把 userData 指向临时目录：`CUBEX_SMOKE=1` 时 `app.setPath('userData', temp/cubex-smoke-<pid>)`（`src/main/index.ts` 第 18 行）。
- 管理端（历史阶段）运行于 `http://127.0.0.1:4800`，管理密钥经环境变量 `CUBEX_ADMIN_KEY` 注入——**真实值不写入此处**，仅记引用位置。
