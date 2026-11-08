[English](../../en/architecture/token-usage-scope.md) | 简体中文

# Token 用量 scope：契约、回归史与 reader 责任

> 本文展开 `design.md` §9.21，回答三个问题：
> 1. 卡片上的 Input / Output / Total / Context / 累计分别是什么 scope；
> 2. 为什么“多步 run 低报”在 opencode 上修过一次又复发；
> 3. 当前七个 session reader 各自负责哪条边界，还有哪些同类缺口。

---

## 1. 三个 scope

同一张卡片上并存三种不同 scope 的 token 数字，任何一处混用都会让用户看到自相矛盾的统计。

| 展示 | 字段 | scope | 含义 |
|---|---|---|---|
| Input / Output / Cache / Total | `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheCreationTokens` / `totalTokens` | **本 run（末个 turn）** | 末个 turn 内所有模型请求的采样之和 |
| Context | `contextLength` / `contextLimit` | **末次采样** | 当前上下文窗口占用，只取最后一条采样，**不求和** |
| 累计 | `cumulativeInputTokens` 等 `cumulative*` | **整个 session** | 会话内所有 turn 的采样之和 |

**硬不变量：**

1. **flow = 末个 turn 的采样之和**。一条 `assistant` 消息 / 一条 `step-finish` / 一条 `usage.record` 通常只是**一次模型请求**；带工具往返的 turn 会有多条。只取最后一条会把多步 run 系统性低报。
2. **context = 末次采样的窗口水位**。contextLength 表达“这一轮结束后窗口里有多少 token”，对采样求和无意义（会按 turn 数放大）。
3. **cumulative = 会话全量之和**。子 agent 的消耗只能进累计，不能进“本 run”（除非该子 agent 的 turn 边界可归属）。
4. **本 run ≤ 累计**。违反说明两侧 scope 混用；`formatUsageStats` 只标记「⚠️ 累计异常」，不修正数字。
5. **live 有 input/output 时 flow 用 live，否则 reader 兜底**；context/compactCount 始终 reader 优先。同一张卡禁止混 scope。

---

## 2. 数据流：两个生产者 + 一个兜底

```
live result event ─┐
                   ├─→ RunUsageCollector.finalize ─→ FinishMeta ─→ RunState ─→ 卡片
session reader ────┘        （flow: live 优先；context/compact: jsonl 优先）
```

- **live 生产者**
  - claude：`result` 事件原样透传（含 `cache_read_input_tokens` 等原生命名）。
  - pi：RPC translator 在一次 run 内逐条累加 `message_end.usage`。
  - codex：app-server `thread/tokenUsage/updated` 按 `turnId` 归属、按 turn 累加。
  - dsh：translator 在一次 run 内累加 durable `assistant/message.usage`。
  - opencode / kimi：ACP `usage_update` **只有** `used`（上下文占用）、`size` 与 cost，**没有 input/output 拆分**，因此 flow 永远只能走 jsonl。
  - codebuddy：ACP `usage_update._meta.usage` 带每次模型请求的 input/output，translator 按 turn 累加；但 CodeBuddy 的会话 jsonl 只在每个 turn 的最后一条 assistant 消息上落 usage（`requests: 1`），reader 另从 CodeBuddy 的逐请求日志重建 flow/cumulative。
- **reader 兜底**：七个 `AgentSessionReader.readSessionContent` 产出 `AgentSessionUsage`。codebuddy 的 reader 优先读 CodeBuddy 的逐请求日志（jsonl 只有每个 turn 的末次请求），日志不可用时才回退 jsonl。
- **reader 还有第二消费面**：`/resume`、自动恢复卡、完成通知卡直接展示 `readSessionContent` 的 usage。因此 reader 的 scope 正确性不能只靠“done 卡有 live 兜着”。

---

## 3. 回归史（2026-07 → 2026-11）

| 日期 | 变更 | 对 flow 的影响 |
|---|---|---|
| 2026-07-19 | done 卡定下「flow 字段 live 优先、jsonl 兜底」 | 明确本 run scope |
| 2026-07-19 | opencode **exec 模式**的流式翻译器新增 `accumulatedUsage`，把所有 `step_finish` 相加 | 第一次修复多步 run 低报 |
| 2026-08-17 | 删除 kimi CLI / opencode exec 模式，两者切纯 ACP | **“求和”的唯一实现随翻译器一起删除**；ACP live 又不带 input/output |
| 2026-08-18 | opencode reader 跳过全零 `step-finish` | 只修退化步，仍取“最后一条非空采样”；测试把该语义钉死 |
| 2026-10-17 | opencode 支持 2.0 export，新增 v2 reader | v2 把 tokens 挂在 message 上；沿用“最后一条 assistant 消息”语义 |
| 2026-10-30 | opencode v1/v2 + kimi reader 改为「末个 turn 内所有采样之和」 | 第二次修复，补上 anchor 测试 |
| 2026-11-01 | claude/pi/dsh reader 同样按末个真人 turn 汇总；kimi 与 opencode v2 的空 turn 归零；`usageAuthority` 拆出 `usesLiveResultEvents()` | 六个 reader 汇齐同一契约，scope 断言集中到 `tests/lib/usage-scope-contract.ts` |
| 2026-11-08 | codebuddy runner 的 flow 权威切到 live；reader 用 CodeBuddy 逐请求日志重建 flow/cumulative（jsonl 每 turn 只落末次请求） | 新增日志读取；日志不可用时仍回退 jsonl（下界） |

### 为什么会复发

1. **不变量没有代码载体。** §9.21 写了「flow = 本 run」，但 `AgentSessionUsage.inputTokens` 这个类型不表达 scope；`UsageAccumulator` 只有 `last` / `totals`，没有“按 turn 边界重置”的语义；opencode / dsh / codex 各自手写聚合。
2. **修复绑在会被删除的实现上。** 第一次修复在 exec 翻译器里，迁移到 ACP 时翻译器和它的测试一起被删；新载体（ACP live）根本不带 input/output，reader 从未继承该语义。**修复没有被搬到持久数据源。**
3. **外部数据模型同形不同义。** v1 的 `step-finish` 是“一次请求一条”，v2 把 tokens 挂到 message 上。“message = request”很容易被读成“message = run”，而真实粒度是 `turn = N requests`。opencode 的 `idle`、kimi 的 `turn.prompt`、codex 的 `task_started`、dsh 的 `turn/start` 才是 turn 标记。
4. **测试固化实现，而不是校验契约。** 旧测试直接写 `per-turn = last step-finish (overwrites)`，v2 测试断言最后一条消息的数值。后续修改只要让测试变绿，bug 就被合法化。
5. **兜底路径没有按 live 的标准验收。** reader 被当作“读不到 live 时才用的降级”，但它在 `/resume` / 自动恢复 / 完成通知里是唯一数据源。`usageAuthority` 又把“用量来源”和“runner 事件语义”压在一个字段里：ACP 返回 `'live'`，但 live 只有 context、没有 input/output，容易让人误以为 live 覆盖了 flow。

**结论：** 复发的是同一个不变量在不同实现载体上反复丢失，并非同一个代码 bug。

---

## 4. 当前 reader 责任矩阵

| Agent | turn 边界 | flow 来源 | context 公式 | cumulative 来源 | 状态 |
|---|---|---|---|---|---|
| claude | 末条真实 user 消息（`isRealUserPrompt` 排除 tool_result / compact summary / `isMeta` / task notification / sidechain） | 末 turn 内所有 assistant 消息之和；没有真人 user 时退回末条采样 | 末条消息 `input+output+cacheRead+cacheCreation`，与 compact `postTokens` 取 max | 所有 message id 去重后求和（同 id 多行按字段 max） | 按末 turn 汇总 |
| pi | 末条 user 消息 | 末 turn 内所有 assistant 消息之和；没有 user 时退回末条采样 | 末条消息窗口占用 | 所有 assistant 消息求和 | 按末 turn 汇总 |
| opencode v1 | 最后一条 user 消息 | 末 turn 内所有 `step-finish` 之和 | 末条 `step-finish` 窗口占用 | 整个文件所有 `step-finish` 求和 | 按末 turn 汇总（2026-10-30） |
| opencode v2 | 末条采样之后还有 user 时，该 user 就是边界（空 turn）；否则取最后一个“其后仍有采样”的 `idle`；无 `idle` 退回最后一个 `user/synthetic/system` | 末 turn 内所有 assistant 消息之和；空 turn = 0 | 末条 assistant 采样窗口占用 | 整个文件所有 assistant 采样求和 | 空 turn 归零 |
| kimi | `turn.prompt` | 末个 turn 内主 wire 的 `usage.record` 之和；空 turn = 0，不退回上一轮 | 末条主 wire usage 的窗口占用 | 主 wire + 所有子 agent wire 求和 | 空 turn 归零 |
| codex | `event_msg.task_started` | 末 turn 内所有 `token_count` 采样之和 | 末条 raw `input_tokens`（含 cache，**不含 output**，既有约定） | 最后一条 `total_token_usage` | 按末 turn 汇总（2026-10-12） |
| dsh | `turn/start` – `turn/end`；在途 turn（有 `turn/start` 无 `turn/end`）就是当前边界 | `turnUsage ?? lastTurnUsage ?? 末条兜底`，在途优先 | `input + 末次 output + cacheRead + cacheWrite`：只取末次采样的 output，整 turn 的 output 求和会重复计数 | 所有 usage 求和 | 在途优先 + context 去重复计数 |
| codebuddy | 日志行的 `conversation_request_id`（与 jsonl 的 `providerData.conversationRequestId` 同源） | 末个 turn 内所有 `agent.model_call.completed` 行之和；日志不可用回退 jsonl 末次请求 | 末条请求 `input+output+cache`（input 已扣缓存） | 所有 turn 的日志行求和；日志不可用回退 jsonl | 日志优先 + 回退（2026-11-08） |

补充说明：

- claude/pi 的 jsonl 没有原生 turn 标记，用真实 user 消息划边界；“最后一条 assistant 消息”只等于单请求 turn 的本 run。
- qoder 复用 claude reader 内核，scope 与 claude 相同，不单列。
- **末 turn 为空一律显示 0**（kimi / opencode v2）：当前契约是“末个 turn”，不是“末个非空 turn”。想改成后者属于契约变更，要同时动 §9.21、七个 reader、测试和卡片文案。
- 无从划分 turn 时的兜底分两类：claude / pi / dsh 退回末条采样；kimi 的整份 wire 没有 `turn.prompt`（旧数据/截断）时沿用「整份文件 = 一个 turn」。
- codex 的 context 不含末轮 output 是既有文档约定，与其他 reader 不一致；改口径时需要同步 §9.21 与所有 reader。
- 子 agent：kimi 的子 agent wire 进累计、不进 flow；codex 的 subagent rollout 文件在列表和读取时整体排除；claude 的 `isSidechain` 目前只挡 turn 边界，usage 聚合仍不过滤，见 §5。
- `AgentSessionReader.supportsCompactCount` 声明该 reader 能否产出 compactCount；不支持的（opencode / dsh）在 compact 收尾不再重复走完整 export/读取。
- dsh 的 live translator 一次 run 创建一个、只累加 durable usage，turnUsage 不跨 run，live 路径本身没有 scope 问题。

---

## 5. 已知缺口与待验证项

- **Claude sidechain 只挡边界、不过滤聚合。** `scalarScan` 只在 turn 边界判定 `isRealUserPrompt` 里排除 `isSidechain`，usage 聚合本身不检查它。若真实 Claude JSONL 在同一文件混入 sidechain 消息，受影响的不只是末条采样，**cumulative 也会被抬高**。目前没有真实 fixture 证明这种混入一定发生，所以列为待验证项。动手前先拿脱敏真实 JSONL 确认三件事：sidechain 是否落同一文件、message id 是否唯一、turn 边界是否可识别；不要把它和数值口径改动混成同一批变更。
- **run-scope 聚合仍由各 reader 手写。** `UsageAccumulator` 只有 `last` / `totals`，没有“按 turn 边界重置”的语义；`cumulativeUsageFields` 的注释还明确写“opencode 保留自己的条件赋值”。每个 reader 都在重写“找边界 + 求和 + 取水位”，共享原语的方案见 §6.1，尚未落地。
- **codebuddy 的精确用量依赖 CodeBuddy 的诊断日志。** 会话 jsonl 每个 turn 只写末次请求的 usage；逐请求数据只在 `logs/<date>/<basename>__<md5(cwd)>.log` 的 `agent.model_call.completed` 行里。日志被清理、格式漂移或用户关闭文件日志时，reader 回退 jsonl，flow 与累计都退化为「每 turn 末次请求」的下界。该日志是 CodeBuddy 的内部格式，读取侧只做 fail-soft 解析，不把它当稳定协议。
- **参数化契约 harness 未落地。** 跨 reader 的 scope 断言已集中到 `tests/lib/usage-scope-contract.ts`，claude / pi / dsh / kimi / opencode / codebuddy 的回归用例共用（codex 仍由自己的 rollout 测试断言，没接进来）；§6.2 设想的“新 reader 只交 fixture”那套参数化 harness 还没做。
- **opencode 测试留有旧语义注释。** `per-turn = last step-finish (overwrites)` 与 §1 的不变量不符，属待清理的文档债。
- **字段名不表达 scope。** `AgentSessionUsage.inputTokens` / `outputTokens` 看不出是“本 run”，读的人只能靠注释和本文档约束；改名或补注释的方向见 §6.4。

---

## 6. 防复发设计

### 6.1 把不变量变成结构

新增一个共享原语（放在 `src/session/common/` 下，与 `usage-accumulator.ts` 并列）：

```ts
runScopeUsage({
  samples,          // 有序采样：input/output/cacheRead/cacheCreation/contextOccupancy
  turnStartIndex,   // 各 agent 只负责找边界
  declaredTotals,   // 可选的 agent 原生 total
}) => {
  flow: sum(samples after turnStartIndex),
  context: lastSample.occupancy,
  cumulative: sum(all samples),
}
```

各 reader 只提供两样东西：**采样序列**与**边界识别**（见 §4 的 turn 边界列）。加法、取水位、组装累计只有一份。

它与行为修复不要同批落地：先让数值口径在 reader 上站稳并补齐契约测试，再抽共享原语，否则出问题分不清是重构引的还是口径改的。

### 6.2 一套跨 reader 的契约测试

每个 reader 都要能回答这七条，答案由 scope 契约决定、与实现无关：

1. 末个 turn 有 N 条采样 → flow = N 条之和。
2. 前一个 turn 的采样 → 只进累计，不进 flow。
3. context = 末条采样，不等于求和。
4. 末条采样为零 token → 不得抹掉整个 turn 的 flow。
5. 在途 turn → 当前已发生的采样优先于上一轮。
6. 累计 ≥ 本 run。
7. 子 agent usage → 只进累计（kimi/opencode 等适用时）。

只断言“末条采样等于某个数”的测试固化的是实现快照：实现改错了它照样变绿，这也正是同一个低报反复复发的原因。当前落地面是共享断言库 `tests/lib/usage-scope-contract.ts`，七个 reader 的回归用例共用；「新 reader 只交 fixture」的参数化 harness 仍待补（见 §5）。

### 6.3 迁移规程

- 删除 / 替换 runner 模式时，**行为 + 对应测试一起迁移**，不允许“旧实现删了、测试也删了、新实现从零猜”。
- 至少保留一条 `reader → Bridge → 卡片` 的 anchor 数值断言（opencode 2026-10-30 已按此落地）。
- 修改 live 协议解析时，同时核对 jsonl reader 的同名字段 scope，而不是只修 live。

### 6.4 类型与命名

- `AgentSessionUsage.inputTokens` 仍不表达 scope（改名或加注释成 `runInputTokens` 的方向未落地，见 §5）；累计字段统一保持 `cumulative*` 前缀。
- `getUsageAuthority()` 只回答**用量来源**：live 带 input/output 的返回 `'live'`，ACP 这类 live 只有 context 的返回 `'jsonl'`。result 事件语义（pre-init result 丢弃、session 写回）另走 `usesLiveResultEvents()`。两个职责已经拆开，新增 runner 不要再把两层含义压回一个字段。
