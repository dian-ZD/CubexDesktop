# 计划

> 最后更新时间：2026-10-01 ｜ 更新者：AI Agent（工作区初始化完成；新增 specs/SPEC-001 Linux 兼容性草案）
>
> 记录当前任务的拆解与进度。总目标见 goal.md，过程细节/决策见 memory.md。标记：`[ ]` 未开始 ｜ `[x]` 已完成 ｜ `[~]` 进行中。

## 当前阶段

**SPEC-003（工作流 DAG 执行引擎）阶段 1/2/3 全部完成（引擎 + 进度条 UI + 文档），已本地提交**。提交策略（用户 2026-10-01 指令）：**每阶段本地 commit 留痕，不 push、不开 PR**。SPEC-002 三阶段全部完成。Browser 模式（步骤 1–6）与多人协作 ADR 挂起。

## 步骤清单（近期已完成）

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

### 步骤 E：工作区初始化（project-development skill） —— [x]

- 目标：按 project-development skill 阶段 A/B 完成接手调查与工作区治理初始化；最小增量，只建 `rules/` 与 `specs/`。
- 涉及文件：新增 `rules/quality-gates.md`、`rules/platform-support.md`、`specs/SPEC-001-linux-compatibility.md`；更新 `agents.md`（登记结构）、`plan.md`、`memory.md`；全局技能装到 `~/.trae-cn/skills/project-development/`。
- 产物：Linux 实测基线（typecheck 0 / lint 0 error / build 通过 / test 76 passed·1 failed·2 skipped / 冒烟二次通过）；SPEC-001 含 8 项任务、验收标准与回滚条件。
- 结论：完成；SPEC-001 为**草案，等用户 Review** 后再决定实施范围。

### 步骤 F：SPEC-002 阶段 1 —— platform/sandbox 解耦（含 T4） —— [x]

- 目标：平台差异与沙箱策略从 `tools.ts` 抽出为 `src/main/platform/`（shell/proc/capture）与 `src/main/sandbox/`（env/guard），公开签名零变化；统一进程树终止（killTree，POSIX 进程组 / win32 taskkill）。
- 涉及文件：新增 `src/main/platform/*`（4）、`src/main/sandbox/*`（3）、`tests/platform.test.ts`、`tests/sandbox.test.ts`；修改 `tools.ts`/`github.ts`/`extensions.ts`（仅接入调用）；同步 `rules/structure.md`、`rules/platform-support.md`。
- 验证：typecheck 0 / lint 0 error·7 warning（既有）/ vitest **84 passed·1 failed（仅 p9:153，T3 待修）·2 skipped** / build 通过 / 冒烟通过；killTree 孙进程实测终止。
- 本地提交：治理文档 `d9ccefb`；阶段 1 代码随本步提交（不 push）。
- 结论：完成。下一步进入阶段 2（T1/T2/T3/T5/T6/T8 + T7=隐藏入口）。

### 步骤 G：SPEC-002 阶段 2 —— Linux 适配落地 —— [x]

- 目标：T1 打包（linux 段 + author + dist:linux）、T2 computer_use 平台门控（D1=隐藏）、T3 repoNameFor 平台无关化、T5 脚本 tmpdir、T6 basic_text 弱加密提示、T8 冒烟阈值 45s。
- 涉及文件：`package.json`、`src/main/github.ts`、`src/main/extensions.ts`、`src/main/index.ts`、`scripts/{repro,ui-check,ui-check-shell,desktop-smoke}.mjs`。
- 验证：vitest **85 passed / 0 failed / 2 skipped**（Linux 全绿）；AppImage 195MB + deb 119MB 产出；**打包态 `release/linux-unpacked/cubex-desktop` 冒烟 smoke-ready**；electron-builder 需 `ELECTRON_MIRROR` 镜像（直连 GitHub EOF）。
- 结论：完成。

### 步骤 H：SPEC-002 阶段 3 —— 渲染层试点迁移 + 预留登记 —— [x]

- 目标：Logo/SkillMenu/Markdown 迁入 `src/renderer/src/components/`（git mv 保历史），修正 7 处 import；structure.md 登记预留拆分目标位（sidebar/composer/messages、main 侧 ipc/agent）。
- 验证：typecheck 0 / lint 0 error / vitest 85 passed / build 通过 / 桌面冒烟通过。
- 结论：SPEC-002 三阶段全部完成；产物如需交付应重新 `dist:linux`（当前 AppImage/deb 基于迁移前 out/）。

### 步骤 I：SPEC-003 阶段 1 —— DAG 执行引擎（主进程） —— [x]

- 目标：工作流从"编译成一整段提示词"改为"引擎按依赖逐节点驱动"，权威节点状态落在 `thread.workflowRun`。
- 涉及文件：新增 `src/main/workflowRunner.ts`、`tests/workflowRunner.test.ts`；改 `src/shared/schema.ts`（`workflowStepSchema`/`workflowRunSchema`/`workflowControlInputSchema`/`CubexAPI`）、`src/shared/channels.ts`、`src/main/workflow.ts`（执行计划 + 节点指令）、`src/main/agent.ts`（runNode/abortRun/drainQueue/完成信号/drain 守卫）、`src/main/index.ts`（接线 + 控制 IPC + 删除守卫 + cancelThread 转暂停）、`src/main/store.ts`（重启归一化）、`src/preload/index.ts`、`src/renderer/src/bridge.ts`；同步 `rules/structure.md`。
- 验证：typecheck 0 / lint 0 error·7 warning / vitest **97 passed·2 skipped**（新增 12 条：拓扑推进、上游产出注入、备注注入、失败重试上限、重试成功、暂停回退、重试/跳过、删除守卫、重启归一化、schema）、build 通过、桌面冒烟通过。
- 结论：完成。下一步阶段 2（UI 进度条 + 控制按钮 + i18n）。

### 步骤 J：SPEC-003 阶段 2 —— 工作流进度条与控制 UI —— [x]

- 目标：线程视图顶部展示权威进度（步骤 i/n、节点状态、失败原因），提供暂停/继续/重试/跳过。
- 涉及文件：新增 `src/renderer/src/components/WorkflowStrip.tsx`；改 `src/renderer/src/App.tsx`（`workflowControl` 调用 + 顶部渲染）、`src/renderer/src/phrases.ts`（`workflowPhrases` 12 条）、`src/renderer/src/styles.css`（`.workflow-strip` 段）；同步 `rules/structure.md` 与 SPEC-003。
- 验证：typecheck 0 / lint 0 error·7 warning / vitest 97 passed / build 通过 / 冒烟通过；**Playwright E2E**（注入含 workflowRun 的 state）：进度条正确渲染（`发布流水线 · 已暂停 · 步骤 3/4 · 失败原因…` + 4 枚状态胶囊），按钮按状态切换，点击「重试该步骤」实测走通 IPC→引擎，产生 `▶ 步骤 3/4：运行测试`、`（重试 1）`、`（重试 2）` 三条边界消息，步骤落真实错误 `请先在设置中添加模型并选择`，工作流重新暂停。
- 修复：E2E 暴露「存在失败节点时『继续』按钮无效」，已改为仅无失败节点时显示。
- 结论：完成。SPEC-003 三阶段全部落地。

### 步骤 K：修复沙箱禁网被 no_proxy 抵消 —— [x]

- 目标：`allowNetwork=false` 时禁网真实生效（用户决策 A：彻底禁网）。
- 涉及文件：`src/main/sandbox/env.ts`（删除 `no_proxy`/`NO_PROXY='*'` 两行 + 保留防回退注释）、`tests/sandbox.test.ts`（+3 条：禁网不得写 no_proxy、父进程不泄漏、真实进程环回实测正负对照）；同步 `rules/platform-support.md`（已知坑）、`rules/quality-gates.md`（门 3 例外说明与基线）、`memory.md`。
- 证据：curl 8.14.1 A/B —— 现状 `no_proxy='*'` 时环回目标 http=200 直连成功；去掉后 `exit=7` 被黑洞拒绝；`npm_config_offline=true` 时 `npm view express` cache-only 失败（npm/pip 索引本就被专用变量挡住）。
- 验证：vitest **100 passed / 0 failed / 2 skipped**（含真实进程禁网实测通过）、typecheck 0、lint 0 error。
- 结论：完成。来源为既有缺陷（SPEC-002 阶段 1 原样迁出 `tools.ts` 的实现），测试缺口一并补齐。

## 步骤清单（Browser 模式 — 待实现，落地顺序）

### 步骤 1：schema mode 下沉 + BrowserEngine —— [ ]

- `src/shared/schema.ts`：`threadSchema` 加 `mode: enum(['code','work','browser']).optional()`，导出 `AgentMode`。
- 新建 `src/main/browser.ts`：任务隔离会话（partition per threadId）、可见 BrowserWindow、动作原语（navigate/click/type/press/scroll/waitFor/extract/screenshot/evaluate）、租约冻结、每步取证（`{ok,verified,title,url,screenshot,snippet}`）。复用现有离屏窗口安全加固。

### 步骤 2：浏览器工具 + agent 模式感知 —— [ ]

- `src/main/tools.ts` toolNames 新增 `browser_navigate/click/type/extract/screenshot/wait`（保留旧 `browser_open`）。
- `src/main/extensions.ts` dispatch 路由到 BrowserEngine + 审批（sensitiveExtensionTools）+ `onControl({kind:'browser'})`。
- `src/main/agent.ts` 按 `thread.mode` 注入 prompt 段；`src/main/prompt.ts` 增加 Browser 模式提示（每步 extract/screenshot 验证再继续）。

### 步骤 3：IPC/preload/bridge + 实时帧 —— [ ]

- channels/schema/index/preload：`browserAction`、`browserFrame`（截图流事件）、`browserSessionClose`。
- bridge.ts 补 stub。

### 步骤 4：前端 BrowserWorkspace —— [ ]

- App.tsx：`view` 加 `'browser'`、radiogroup 第三按钮 `<Globe/> Browser`、workspace 分支渲染、panelMode/标题/快捷键联动。
- 新建 `BrowserWorkspace.tsx`：混合形态（对话子视图复用 MessageView + 编排子视图参考 WorkflowCanvas）+ 实时画面（消费 browserFrame）+ 地址栏。

### 步骤 5：设置分区 + i18n + 样式 —— [ ]

- SettingsPanel 新增 browser 分区（起始页/逐步审批/租约时长/下载与新窗口策略/UA）；phrases.ts 文案；styles.css `.browser-workspace`/`.browser-frame` 及三按钮 mode-switch 适配。

### 步骤 6：测试 + 冒烟 + 全量校验 —— [ ]

- 单测 browser.ts 动作层（mock BrowserWindow）、mode 注入 prompt 分支；`scripts/desktop-smoke.mjs` 加 Browser 启动 + navigate/extract；`npm run typecheck && npm run lint && npm test`。

## 当前进行到的精确位置 / 下一步第一件事

- **当前状态**：SPEC-003 阶段 1/2/3 全部完成并本地提交；Linux 质量门全绿（97 passed / 0 failed），DAG 引擎与进度条均已通过单测 + Playwright E2E 双验证。
- **下一步第一件事**：等用户实测工作流（真实模型下跑多节点 DAG、暂停/继续/重试/跳过、中途杀进程看重启恢复）；之后可选：Browser 模式步骤 1、多人协作 ADR、或把"运行期间用户插话即时生效""节点隔离上下文"等 SPEC-003 非目标项排期。
- Browser 模式恢复时其"下一步第一件事"仍是：`src/shared/schema.ts` threadSchema 加 `mode` 字段 + 新建 `src/main/browser.ts`；动手前先向用户确认实时画面方案（截图流 vs WebContentsView）。

## 已知风险 / 阻塞项及应对

- **风险：可见 BrowserWindow 与主窗口的层级/DPI/焦点冲突**。应对：MVP 用截图流推帧到前端 canvas/img，避免真窗口叠加；完整版再评估 WebContentsView。
- **风险：electron-builder 打包时 `app.asar` 被杀软/索引器锁定**。应对：打包前先结束 Cubex 进程并删 `release`/`out`；仍锁定用 `npx electron-builder --win nsis "-c.directories.output=dist-out"`（PowerShell 中 `-c...` 加引号）。
- **风险：浏览器自动化的安全面**。应对：沿用 `setWindowOpenHandler deny`、`setPermissionRequestHandler(false)`、`will-download preventDefault`；交互动作接入审批。

## 已被否决 / 放弃的方案

- Browser 模式引入 Playwright/Puppeteer → 放弃，改用 Electron 内置 BrowserWindow（用户确认），避免新增浏览器二进制依赖与打包膨胀。
- 直接对接本机 tabbit-cli → 放弃，强依赖用户已装 Tabbit 且跨机不可控。
- 历史：用 `sharp` 合成圆角图标 → 放弃改用 `nativeImage` BGRA。
