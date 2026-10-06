# 质量门

> 最后更新时间：2026-10-01 ｜ 维护者：AI Agent（project-development 初始化）
>
> 本文件定义本仓库"改动完成"的判定标准。命令均在仓库根目录执行。任务过程与结论写 `specs/`，本文件只记规则与基线。

## 基线（2026-10-01 实测）

环境：Linux（原生 GNOME / Wayland 会话）、Node v26.8.2、npm 11.19.1、Electron 44.4.3。

| 门 | 命令 | 本次结果 |
| --- | --- | --- |
| 1 类型检查 | `tsc --noEmit` | 通过，0 错误 |
| 2 静态检查 | `eslint .` | 通过，0 error / 7 warning（`tr` 依赖） |
| 3 单元测试 | `vitest run` | 通过，**100 passed / 0 failed / 2 skipped**（Linux 全绿） |
| 4 构建 | `electron-vite build` | 通过，`out/` 三端产出 |
| 5 桌面冒烟 | `node scripts/desktop-smoke.mjs` | 二次运行通过；首次冷启动超时误报 |
| 6 UI 脚本 | `node scripts/ui-check.mjs` | 已平台无关化（`tmpdir()`，SPEC-002 T5）；需 Playwright 浏览器就绪，本轮未执行 |

Windows 参考基线（项目原记录）：`npm test` 77 passed / 2 skipped，`npm run dist` 产出 `release\Cubex Setup <version>.exe`。

## 门 1：类型检查

- 命令：`npm run typecheck`
- 通过标准：退出码 0，无错误输出。
- 数据影响：只读，不修改任何文件。
- 失败处理：修类型错误后重跑。**不得**用 `any`、`@ts-ignore`、`@ts-expect-error` 压制（当前仓库 0 处，保持）。

## 门 2：静态检查

- 命令：`npm run lint`
- 通过标准：0 error。已知可接受基线为 7 条 `react-hooks/exhaustive-deps` warning（均由 `tr` 未列入依赖引起）。
- 数据影响：只读。
- 失败处理：修到 0 error；新增 warning 必须在交接报告中列为"新增告警"并说明原因，不得静默放过。

## 门 3：单元测试

- 命令：`npm test`（vitest，`environment: node`，无网络也能跑；`tests/live.test.ts` 在无 `CUBEX_LIVE_*` 环境变量时跳过）。
- 通过标准：全部通过。
- 例外说明：`tests/sandbox.test.ts` 含一条**真实进程**的环回禁网实测（起本地 HTTP 服务 + spawn curl，正负对照），依赖系统 `curl`，在 Windows 或无 curl 环境自动跳过——该条跳过时不计为失败，但沙箱相关改动不允许只依赖它通过，须同时人工确认代理变量形状。
- 数据影响：只写临时目录（`mkdtemp`），不动仓库与用户数据；沙箱实测只监听 `127.0.0.1` 随机端口，不访问外网。
- 平台一致性：平台相关断言已于 SPEC-002 T3 清理（`repoNameFor` 改为平台无关切分），Windows 与 Linux 基线一致，其它失败一律视为回归。
- 失败处理：先判断是环境差异还是回归；环境差异需在报告中标注平台，不得直接改断言迁就当前机器。

## 门 4：构建与目标平台检查

- 命令：`npm run build`（= `npm run typecheck` + `electron-vite build`）
- 通过标准：退出码 0，且 `out/main`、`out/preload`、`out/renderer` 均有产物。构建期为纯前端/Node 打包，跨平台一致。
- 发布产物：`npm run dist` 出 Windows NSIS 包；`npm run dist:linux` 出 AppImage+deb（SPEC-002 T1，**Linux 下需 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`**，直连 GitHub 会 EOF 失败）。改动打包配置后必须核对产物真实存在再报完成。
- 数据影响：写 `out/`（已在 `.gitignore`）。
- 失败处理：先清 `out/` 再重试；仍失败按阻塞上报，不得只报"编译过去了"。

## 门 5：桌面冒烟（Electron 运行时）

- 命令：`npm run test:desktop`
- 通过标准：输出含 `[cubex] smoke-ready` 与 `桌面冒烟通过：窗口已创建并正常退出`。
- 前置：`node_modules/electron/dist/electron` 必须存在。npm 11.19 的 install-scripts 白名单机制会跳过 electron 的下载脚本，缺失时执行 `node node_modules/electron/install.js` 补齐（国内网络可用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）。
- **冷启动说明**：脚本内置 20 秒超时。Linux 上首次运行（无缓存）曾超时误报，二次运行通过。判定规则：首次超时先重跑一次，仍失败才按失败上报，并在报告中记录两次结果。
- 数据影响：`CUBEX_SMOKE=1` 时 userData 指向 `temp/cubex-smoke-<pid>`，不碰真实用户数据。
- 失败处理：用 `CUBEX_SMOKE=1 ELECTRON_ENABLE_LOGGING=1 timeout 30 node_modules/.bin/electron .` 抓完整日志再定位。

## 门 6：UI / 端到端脚本（条件执行）

- 命令：`node scripts/ui-check.mjs`、`node scripts/ui-check-shell.mjs`（Playwright 驱动 Electron）。
- 现状：脚本已用 `os.tmpdir()` 平台无关化（SPEC-002 T5），Linux 可用；依赖 Playwright 浏览器就绪。
- 涉及渲染层布局、交互、快捷键、窗口行为的改动，若本轮无法执行本门，必须在报告中写「未执行 + 原因 + 需要什么环境才能执行」，不得默认通过。

## 报告格式

每轮结束按四段回答：**完成了什么 / 证据是什么 / 还缺什么 / 下一步需要谁确认**。

禁止只写"命令退出 0"；必须同时说明是否有告警、跳过的测试、被 mock 的链路和未覆盖的真实路径。危险操作（改动用户数据、推送、删除）需单独列出。