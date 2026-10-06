# SPEC-003 工作流 DAG 执行引擎

> 状态：**阶段 1（引擎）与阶段 2（UI）已实施完成（2026-10-01，本地提交，未 push）；阶段 3（收尾文档已随阶段 2 同步完成）** ｜ 创建：2026-10-01 ｜ 依据：本会话对「无 DAG 症状」的代码分析
>
> 验证：typecheck 0 / lint 0 error / vitest **97 passed · 2 skipped**（新增 `tests/workflowRunner.test.ts` 12 条）/ build 通过 / 桌面冒烟通过 / **E2E**（Playwright 注入 state：进度条渲染 + 重试链路 3 次尝试 + 失败暂停，见阶段 2 说明）。实施说明：`cursor` 字段未采用（算法为就绪集扫描，该字段会成死状态）；失败重试上限 `MAX_RETRIES = 2`（总尝试 3 次）。
>
> 前置事实：现状是 `runWorkflow` → `composeWorkflowPrompt`（编译成一段文本）→ `agent.send`（普通会话）。图只在编译期用于**校验无环 + 排版顺序**，运行期无任何节点概念。已确认的三个症状：① 模型声明结束时整个运行直接 `return`，剩余节点无声搁置；② `fitContext` 会把作为首条用户消息的工作流指令裁掉；③ `thread.todos` 由模型自报，无外部权威来源。

## 1. 目标

1. **引擎持有权威执行状态**：节点级 status 持久化在 `thread.workflowRun` 上，不依赖模型自觉、不受上下文压缩影响、跨重启可恢复。
2. **上游产出显式传递**：节点完成后其总结写入运行状态，下游节点的指令中直接注入直接前驱的产出（替代"模型自己从历史里找"）。
3. **失败可感知、可处置**：节点失败 → 工作流暂停并留痕，用户可重试 / 跳过 / 继续。
4. **中断可恢复**：应用退出或用户暂停后，可从当前节点继续。

## 2. 非目标（本轮明确不做）

- **并行分支执行**：与"每线程单一 run"的 single-flight 不变式冲突，需多 run 线程模型（大改）。节点内部已有的 `delegate` 工具可自行实现并行。**本轮不做，但状态模型与调度已按图就绪——演进路径与不变式见 §13。**
- **真·节点隔离上下文**：见 §8 决策 2，v1 采用"追加式 + 上游注入"，改动面小；真隔离列为后续优化。
- **工作流运行期间的用户即时插话**：v1 沿用现有队列语义（工作流运行期间入队、结束/暂停后统一 drain）。插话要即时生效需先暂停工作流。
- **多人协作 / 消息队列传输**（另立 ADR）。
- **不改**：agent 循环主体结构、审批/提问/沙箱/步数机制、`state.json` 存储机制、旧 `composeWorkflowPrompt`（保留，`tests/p9.test.ts` 仍依赖）。

## 3. 数据模型（`src/shared/schema.ts`）

```ts
export const workflowStepSchema = z.object({
  nodeId: identifier,
  title: shortText,                                   // 快照标题：workflow 被改/删后 UI 仍可显示
  deps: z.array(identifier).max(20),                  // 直接前驱，用于产出注入
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
  output: z.string().max(20_000).optional(),          // 该节点最终总结（下游输入 + UI 展示）
  error: z.string().max(4_000).optional(),
  startedAt: isoTime.optional(),
  finishedAt: isoTime.optional(),
})

export const workflowRunSchema = z.object({
  workflowId: identifier,
  name: shortText,
  status: z.enum(['running', 'paused', 'done']),
  steps: z.array(workflowStepSchema).max(20),          // 启动时的拓扑序快照（含 deps）
  cursor: z.number().int().min(0).max(20),
  startedAt: isoTime,
  finishedAt: isoTime.optional(),
})
```

- `threadSchema` 增加 `workflowRun: workflowRunSchema.optional()`。
- **持久化裁剪**：只存 `nodeId/title/deps/status/产出/时间`，**不存 `prompt`**——节点 prompt 与 `kind` 在启动该节点时从 workflow 实时取；若 workflow 或该节点已被删除，则该节点标记 `failed`（错误："工作流已被修改或删除，无法继续"）并暂停工作流。理由：避免 `state.json` 膨胀，且已用 `deleteWorkflow` 守卫覆盖运行中删除的场景。
- 失败枚举只有 `failed`，取消（用户暂停）不算失败：当前节点回退为 `pending`，工作流置 `paused`。

## 4. 执行器（新增 `src/main/workflowRunner.ts`）

职责单一：驱动节点推进，不碰 LLM、不碰审批（全部复用既有 agent 能力）。

```ts
export interface NodeRunResult { ok: boolean; cancelled?: boolean; error?: string; output?: string }

export interface NodeRunner {
  runNode(threadId: string, instruction: string, meta: NodeMeta): Promise<NodeRunResult>
}

export class WorkflowRunner {
  constructor(store: StateStore, runner: NodeRunner)
  start(threadId: string, workflow: Workflow): Promise<void>   // 初始化 workflowRun（拓扑序快照）并推进
  resume(threadId: string): Promise<void>                      // paused → 从当前 pending 节点继续
  retryNode(threadId: string, nodeId: string): Promise<void>   // failed → pending → 继续
  skipNode(threadId: string, nodeId: string): Promise<void>    // failed/pending → skipped → 继续
  pause(threadId: string): Promise<void>                       // 取消当前 run，置 paused（可恢复）
}
```

推进算法（`advance`）：循环执行——取第一个 `pending` 且**所有 deps 均为 `done`/`skipped`** 的节点 → 置 `running` → 组装指令 → `runner.runNode()` → 依结果落状态 → 全部终态则 `done`。单线程串行，不并发调度。

## 5. `AgentRunner` 集成（`src/main/agent.ts`，小改）

- `Run` 增加 `done: Promise<void>` 与 `outcome: { ok, cancelled?, error?, lastText? }`；在既有 `.finally()` 中 resolve（现有 `send`/`resume` 不受影响，无人 await 而已）。
- 循环每次 `turn.content` 写入 `outcome.lastText`，作为节点产出。
- 新增公开方法 `runNode(threadId, instruction, meta)`：断言线程空闲 → 追加**系统分隔消息**（`▶ 步骤 i/n：title`，level info，UI 可见的节点边界）→ 追加携带完整指令的 user 消息 → 复用现有 `start` 路径启动 run → `await run.done` → 返回 `outcome`。
- **drain 守卫**：`.finally()` 中的 `drain()` 增加条件——`thread.workflowRun?.status === 'running'` 时不 drain，留在队列里，待工作流 `done`/`paused` 后统一处理。避免工作流与排队用户消息交叉串跑。

## 6. 节点指令组装（`src/main/workflow.ts` 新增导出）

`composeNodeInstruction({ workflowName, index, total, title, kind, prompt, upstream, previous })`：

```text
【工作流「<name>」第 i/n 步：<title>】
<kindHints[kind] 原样复用>

## 上游步骤产出（直接前驱）
### <上游 title>
<上游 output 全文>

## 已完成步骤（供参考，勿重复执行）
- [x] <title>（一句话摘要，截断）

## 本步任务
<prompt.trim()>

要求：完成本步后，用一两句话总结本步产出（这段总结会作为下游步骤的输入）。
```

- 复用现有 [kindHints](file:///home/zoneip/工程/Zoneip/cubex/src/main/workflow.ts#L32-L46)（需 export）。
- `upstream` 只取**直接前驱**产出（token 可控）；`previous` 只列标题一行。
- 产出捕获：取该次 run 的 `outcome.lastText`（最后一条 assistant 文本）。

## 7. 接线与恢复

- `index.ts` `runWorkflow` / `runAutomation`（workflowId 分支）改为：建线程 → `workflowRunner.start()`（不再走 `composeWorkflowPrompt` + `send`）。旧函数保留不再被调用（`tests/p9.test.ts` 继续覆盖其纯逻辑）。
- 新增 IPC `workflowControl: 'cubex:workflow-control'`，payload `{ threadId, action: 'pause'|'resume'|'retry-node'|'skip-node', nodeId? }`，zod 校验；preload/bridge 各加一个方法。
- **重启恢复**：`store.load()` 归一化——已停线程若 `workflowRun.status === 'running'`，则工作流置 `paused`、`running` 节点回 `pending`，并补一条系统消息"工作流因应用退出已暂停，可继续"。
- `deleteWorkflow` 守卫：任一线程存在 `workflowRun`（running/paused）引用该 workflow 时拒绝删除并提示。
- 运行中编辑 workflow：仅影响尚未启动节点（启动时实时取 prompt）——已知语义，写入文档。

## 8. 决策记录

1. **执行模型**：⏳ 待定 —— 用户就问「顺序拓扑是否影响未来多线协作」，答复与演进路径见 §13。
2. **节点上下文**：✅ 已定 = **追加式 + 上游注入**（零循环改动，配合 `fitContext` 自然裁剪）。
3. **节点失败策略**：✅ 已定 = **自动重试后暂停**（仅对可重试错误；上限 2 次，仍失败则标记 `failed` 并暂停工作流，等用户在 UI 上重试/跳过/继续）。

## 9. 阶段拆解（每阶段独立可回滚，质量门全绿后本地提交）

**阶段 1 — 引擎（主进程）** —— ✅ 完成（2026-10-01）：schema + `workflow.ts`（`workflowStepPlan`/`composeNodeInstruction`/导出 `kindHints`）+ `workflowRunner.ts`（新建）+ `agent.ts`（`runNode`/`abortRun`/`drainQueue`/`Run.outcome|settled`/drain 守卫）+ `index.ts`（runWorkflow/runAutomation 接线、`workflowControl` IPC、cancelThread 转暂停、deleteWorkflow 守卫）+ `store.ts`（重启归一化）+ `preload`/`bridge` + `tests/workflowRunner.test.ts`。

**阶段 2 — UI** —— ✅ 完成（2026-10-01）：新增 `src/renderer/src/components/WorkflowStrip.tsx`（状态点 + 步骤计数 + 失败原因 + 状态胶囊列表 + 控制按钮），`App.tsx` 接线（`workflowControl` 调用 + 线程视图顶部渲染），`phrases.ts` 新增 `workflowPhrases` 12 条，`styles.css` 新增 `.workflow-strip` 段。
E2E 验证（Playwright 驱动 Electron + 注入含 workflowRun 的 state）：进度条渲染、按钮按状态切换、点击「重试该步骤」→ IPC → 引擎重试 3 次（`▶ 步骤 3/4：运行测试` / `（重试 1）` / `（重试 2）`）→ 步骤落真实错误 `请先在设置中添加模型并选择` → 工作流重新暂停。**验证中发现并修复**：存在失败节点时「继续」为无效按钮（引擎会因上游未完成立即重新暂停），已改为仅在无失败节点时显示。

**阶段 3 — 收尾**：同步 `rules/structure.md`（新文件与职责）、`rules/quality-gates.md`（若基线变化）、`agents.md`/`plan.md`/`memory.md`；SPEC 状态更新。

## 10. 验收标准

- **单测**：`tests/workflowRunner.test.ts` 全绿；既有 85 条不回归。
- **质量门**：typecheck 0 / lint 0 error / `vitest run` 全绿 / `build` 通过 / `test:desktop` 通过。
- **端到端（手工，Linux GNOME）**：建 3 节点工作流 → 运行 → 观察到 `步骤 i/3` 边界消息与状态推进 → 下游节点指令含上游产出 → 人为制造节点失败（如断网）→ 工作流暂停且节点标记 failed → 重试成功 → 跳过某节点后正常收尾 → 运行中强杀应用 → 重启后显示 paused 并可 resume。
- **不回归**：旧 `composeWorkflowPrompt` 的 5 条 p9 测试仍通过；非工作流的普通会话行为不变。

## 11. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 改动 `agent.ts` 循环出口与 drain，可能影响普通会话的排队/取消 | 只新增 `Run.outcome/done` 与一个 drain 条件；既有 85 条测试 + 手工验证普通会话排队/取消 |
| 节点重跑导致重复副作用（暂停后 resume 重跑当前节点） | 文档明示；`▶` 边界消息让用户可见重复；后续可加"跳过本节点"处置 |
| `state.json` 体积（每节点最多 20KB 产出 × 20） | 上限已由 schema 收紧（20k×20=400KB 最坏）；实测观察，必要时下调上限 |
| 重启归一化遗漏导致工作流永久 running | 归一化逻辑入单测（`store` 层） |
| 与 automation 定时触发叠加 | automation 走同一执行器，同一 threadId 单 run 不变式不变 |

回滚：阶段 1 回滚 = 删 `workflowRunner.ts` 与测试、还原 6 个被改文件（引入 `workflowRun` 后旧路径仍可跑，因为 `composeWorkflowPrompt` 未删）。

## 12. 停止条件

- 需要打破 single-flight 才能推进（如并入并行分支）→ 停下重新确认方案。
- 既有 85 条测试出现无法解释的回归且 30 分钟内无解 → 回滚该阶段并上报。

## 13. 前向兼容：顺序执行与未来并行 / 多线协作的关系

**结论：顺序拓扑不堵死未来的多线协作，反而比现在上并行更安全。**

**13.1 single-flight 是"每线程"而非"全局"**
`AgentRunner.runs` 是 `Map<threadId, Run>`，不同线程本就可并发运行；被限制的只是"同一线程内多个 run"。未来并行有两条现成路径，且都不要求现在改执行器：
- 每分支一个线程（或子线程），分支间用消息传递——与"一人/一智能体一线程 + mailbox 传消息"的多协作形态天然一致；
- 把同线程 single-flight 放宽到 N 并发（需补 run 记账与 UI 并发呈现）。

**13.2 状态模型已是图形态，只有调度器是线性的**
- `steps[]` 每项带 `deps`（直接前驱）：就绪判定与上游注入都按依赖算，而非按"上一个节点"算；
- `advance` 的取节点逻辑本就是"第一个 `pending` 且所有 deps 已终结"的**就绪集扫描，并发度恒为 1**——启用并行 = 把并发度 1 改为 N，调度器不需重写；
- 唯一线性残留是 `cursor`（纯优化字段；并行时改由就绪集驱动，可直接忽略）。

**13.3 现在上并行反而更糟**——会同时放大三件尚未解决的事：
1. 全量状态广播（多 run 并发写同一 store，O(N×状态) 序列化）；
2. 归属与冲突（无 author/投递语义，多写者的结果无法对账）；
3. 审批流并发（多个 `pending` 并存时，UI 展示与 `resolveApproval` 的 callId 匹配会打架）。
这三件正是「多人协作 ADR」要解决的问题。顺序执行让并行能力**随 mailbox/归属设计一起到来**，而不是先欠债再还。

**13.4 为守住演进路径，本 SPEC 承诺三条不变式（实施时不得违反）**
1. `workflowStep.deps` 必须持久化；指令组装只依赖 `deps`，**禁止**写死"上一步"的线性假设；
2. `NodeRunner.runNode(threadId, instruction, meta)` 保持 Promise 化、按线程寻址，**禁止**假设"全局同一时刻只有一个 run"；
3. 就绪判定集中在 `advance` 一处，**禁止**把"下一个节点"的推断散落到 UI 或其它模块。

**13.5 未来启用并行时唯一需要迁移的东西**：若分支各占一个线程，`workflowRun` 目前挂在单个 thread 上，需上移到工程级或独立的"工作流实例"实体。这是一次可被 `migrateState` 承载的数据迁移，不是架构死路——且该迁移无论今天顺序与否都要做。