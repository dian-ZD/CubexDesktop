# 计划

> 最后更新时间：2026-10-01 ｜ 更新者：AI Agent（工作区初始化完成；新增 specs/SPEC-001 Linux 兼容性草案）
>
> 记录当前任务的拆解与进度。总目标见 goal.md，过程细节/决策见 memory.md。标记：`[ ]` 未开始 ｜ `[x]` 已完成 ｜ `[~]` 进行中。

## 当前阶段

**SPEC-002 已获用户确认（D1=A 隐藏入口 / D2=试点迁 3 组件 / D3=按序全做），实施中**。提交策略（用户 2026-10-01 指令）：**每阶段本地 commit 留痕，不 push、不开 PR**。Browser 模式（步骤 1–6）在 SPEC-002 完成前挂起。0.1.2-dev 稳定性修复 + 自动检测模型/上下文 + GitHub 推送 **已完成**。

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

- **当前状态**：SPEC-002 阶段 1 已完成并本地提交（platform/sandbox 解耦 + T4 进程树终止）。
- **下一步第一件事**：SPEC-002 阶段 2 —— T3 `repoNameFor` 平台无关化 + p9 测试修复 → T5 脚本 tmpdir → T8 冒烟阈值 → T2 computer_use 门控（用 `platform/capture`，D1=隐藏入口）→ T6 secrets basic_text 提示 → T1 Linux 打包配置与 AppImage 试构建。
- Browser 模式恢复时其"下一步第一件事"仍是：`src/shared/schema.ts` threadSchema 加 `mode` 字段 + 新建 `src/main/browser.ts`；动手前先向用户确认实时画面方案（截图流 vs WebContentsView）。

## 已知风险 / 阻塞项及应对

- **风险：可见 BrowserWindow 与主窗口的层级/DPI/焦点冲突**。应对：MVP 用截图流推帧到前端 canvas/img，避免真窗口叠加；完整版再评估 WebContentsView。
- **风险：electron-builder 打包时 `app.asar` 被杀软/索引器锁定**。应对：打包前先结束 Cubex 进程并删 `release`/`out`；仍锁定用 `npx electron-builder --win nsis "-c.directories.output=dist-out"`（PowerShell 中 `-c...` 加引号）。
- **风险：浏览器自动化的安全面**。应对：沿用 `setWindowOpenHandler deny`、`setPermissionRequestHandler(false)`、`will-download preventDefault`；交互动作接入审批。

## 已被否决 / 放弃的方案

- Browser 模式引入 Playwright/Puppeteer → 放弃，改用 Electron 内置 BrowserWindow（用户确认），避免新增浏览器二进制依赖与打包膨胀。
- 直接对接本机 tabbit-cli → 放弃，强依赖用户已装 Tabbit 且跨机不可控。
- 历史：用 `sharp` 合成圆角图标 → 放弃改用 `nativeImage` BGRA。
