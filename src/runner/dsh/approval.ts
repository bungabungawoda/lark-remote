/**
 * Correlate DSH's durable approval audit with its live answer waterfall.
 *
 * `session/follow` carries `approval/asked` / `approval/decided`; `$events`
 * carries the answerable `approval/request` waterfall. The audit id is the
 * stable identity shown on the Feishu card; the waterfall contributes the
 * ephemeral `eventId` + `clientId` needed to answer it. Both are correlated by
 * `callId`, with an order-independent pairing so either transport may arrive
 * first.
 */

import { getLogger } from '../../logger/index.js';

export interface DshApprovalAudit {
  approvalId: string;
  callId?: string;
  toolName: string;
  reason?: string;
}

export interface DshApprovalWaterfall {
  eventId: string;
  clientId: string;
  callId?: string;
  toolName: string;
  reason?: string;
}

export interface DshApprovalBinding {
  audit: DshApprovalAudit;
  waterfall: DshApprovalWaterfall;
}

type BindingWaiter = (binding: DshApprovalBinding | undefined) => void;

// --- 模块级命名函数：把状态显式传入，避免在方法内定义带决策点的闭包 ---
// crapper 会把方法内部闭包的决策点计入外层方法；抽到模块顶层后
// onWaterfall / waitForBinding 只剩选路。

/** 重连重投：刷新已绑定 waterfall 的应答通道，不产新 binding。 */
function refreshRedeliveredWaterfall(
  bindings: Map<string, DshApprovalBinding>,
  waterfallByCallId: Map<string, DshApprovalWaterfall>,
  approvalId: string,
  waterfall: DshApprovalWaterfall,
): void {
  const binding = bindings.get(approvalId);
  if (!binding) return;
  binding.waterfall.clientId = waterfall.clientId;
  if (waterfall.reason) binding.waterfall.reason = waterfall.reason;
  if (waterfall.callId) waterfallByCallId.set(waterfall.callId, binding.waterfall);
}

/** 第一段：按 callId 精确匹配未绑定 audit。 */
function auditWithCallId(
  audits: Iterable<DshApprovalAudit>,
  bindings: Map<string, DshApprovalBinding>,
  callId: string,
): DshApprovalAudit | undefined {
  for (const audit of audits) {
    if (audit.callId === callId && !bindings.has(audit.approvalId)) return audit;
  }
  return undefined;
}

/** 第二段：无 callId 的 audit，按 toolName 兜底配对。 */
function unboundAuditWithoutCallId(
  audits: Iterable<DshApprovalAudit>,
  bindings: Map<string, DshApprovalBinding>,
  toolName: string,
): DshApprovalAudit | undefined {
  for (const audit of audits) {
    if (!audit.callId && !bindings.has(audit.approvalId) && audit.toolName === toolName) {
      return audit;
    }
  }
  return undefined;
}

/** 第三段：waterfall 无 callId 时，按 toolName 找最老未绑定 audit。 */
function unboundAuditByToolName(
  audits: Iterable<DshApprovalAudit>,
  bindings: Map<string, DshApprovalBinding>,
  toolName: string,
): DshApprovalAudit | undefined {
  for (const audit of audits) {
    if (!bindings.has(audit.approvalId) && audit.toolName === toolName) return audit;
  }
  return undefined;
}

/** 按 waterfall 是否有 callId 选路，顺序与原实现三段 for 循环一致。 */
function findPairableAudit(
  audits: Map<string, DshApprovalAudit>,
  bindings: Map<string, DshApprovalBinding>,
  waterfall: DshApprovalWaterfall,
): DshApprovalAudit | undefined {
  if (waterfall.callId) {
    return (
      auditWithCallId(audits.values(), bindings, waterfall.callId) ??
      unboundAuditWithoutCallId(audits.values(), bindings, waterfall.toolName)
    );
  }
  return unboundAuditByToolName(audits.values(), bindings, waterfall.toolName);
}

interface BindingWaitState {
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  onAbort: () => void;
  approvalId: string;
  waiters: Map<string, Set<BindingWaiter>>;
  resolve: (binding: DshApprovalBinding | undefined) => void;
  signal?: AbortSignal;
  finish: BindingWaiter;
}

/** 结束一次等待（幂等）：清 timer、摘监听、从 waiters 移除、resolve。 */
function finishBindingWait(state: BindingWaitState, binding: DshApprovalBinding | undefined): void {
  if (state.settled) return;
  state.settled = true;
  if (state.timer !== undefined) clearTimeout(state.timer);
  state.signal?.removeEventListener('abort', state.onAbort);
  const set = state.waiters.get(state.approvalId);
  set?.delete(state.finish);
  if (set && set.size === 0) state.waiters.delete(state.approvalId);
  state.resolve(binding);
}

function abortBindingWait(state: BindingWaitState): void {
  finishBindingWait(state, undefined);
}

export class DshApprovalTracker {
  private readonly audits = new Map<string, DshApprovalAudit>();
  private readonly waterfallByCallId = new Map<string, DshApprovalWaterfall>();
  private readonly bindings = new Map<string, DshApprovalBinding>();
  private readonly approvalIdByEventId = new Map<string, string>();
  private readonly waiters = new Map<string, Set<BindingWaiter>>();

  /** Record `approval/asked`; pair immediately when its waterfall is known. */
  onAuditAsked(audit: DshApprovalAudit): DshApprovalBinding | undefined {
    const existing = this.bindings.get(audit.approvalId);
    if (existing) return existing;
    this.audits.set(audit.approvalId, audit);
    if (audit.callId) {
      const waterfall = this.waterfallByCallId.get(audit.callId);
      if (waterfall) {
        const boundTo = this.approvalIdByEventId.get(waterfall.eventId);
        if (!boundTo || boundTo === audit.approvalId) {
          return this.bind(audit, waterfall);
        }
        // 该 waterfall 已被兜底配对绑给另一张卡（「无 callId 的 audit 先到 +
        // waterfall 先到」的乱序组合，见 onWaterfall 的 toolName 启发式）：
        // 不再二次绑定——两张卡指向同一可答 waterfall 时，先答的生效、
        // 后答的服务端报错；单卡可答严格好于双卡可答。
        getLogger().debug(
          `[dsh] waterfall already bound to ${boundTo}; skip rebind for ${audit.approvalId}`,
        );
      }
    }
    return undefined;
  }

  /** Record an `approval/request` waterfall; pair when its audit is known. */
  onWaterfall(waterfall: DshApprovalWaterfall): DshApprovalBinding | undefined {
    const existingApprovalId = this.approvalIdByEventId.get(waterfall.eventId);
    if (existingApprovalId) {
      // A reconnect re-delivers the same pending event with a new Client
      // identity. Keep the card binding but refresh the answer channel.
      refreshRedeliveredWaterfall(
        this.bindings,
        this.waterfallByCallId,
        existingApprovalId,
        waterfall,
      );
      return undefined;
    }
    if (waterfall.callId) this.waterfallByCallId.set(waterfall.callId, waterfall);

    // Some approval types omit callId on the durable audit: pair with the
    // oldest unbound audit for the same tool before falling back to Web UI.
    const audit = findPairableAudit(this.audits, this.bindings, waterfall);
    return audit ? this.bind(audit, waterfall) : undefined;
  }

  /** Mark an audit resolved (local response or an external decision). */
  onDecided(approvalId: string): DshApprovalBinding | undefined {
    const binding = this.bindings.get(approvalId);
    this.audits.delete(approvalId);
    this.bindings.delete(approvalId);
    if (binding) {
      this.approvalIdByEventId.delete(binding.waterfall.eventId);
      if (binding.waterfall.callId) {
        const stored = this.waterfallByCallId.get(binding.waterfall.callId);
        if (stored?.eventId === binding.waterfall.eventId) {
          this.waterfallByCallId.delete(binding.waterfall.callId);
        }
      }
    }
    // 无论有无 binding 都要唤醒 waiter：approval/decided 落在「audit 已到、
    // waterfall 未到」的窗口时，waitForBinding 的点击会白等满超时才收到
    // 「审批通道尚未就绪」——而该审批实际上已被外部决策结束。
    this.resolveWaiters(approvalId, undefined);
    return binding;
  }

  /** Mark a waterfall cancelled by the Host (another client answered it). */
  onCancelled(eventId: string): DshApprovalBinding | undefined {
    const approvalId = this.approvalIdByEventId.get(eventId);
    if (!approvalId) return undefined;
    return this.onDecided(approvalId);
  }

  getBinding(approvalId: string): DshApprovalBinding | undefined {
    return this.bindings.get(approvalId);
  }

  /**
   * Wait for a waterfall to arrive after the audit card was rendered. The
   * audit is appended before the waterfall is dispatched, so this window is
   * normally tiny; the bound keeps a fast button click from failing.
   */
  async waitForBinding(
    approvalId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DshApprovalBinding | undefined> {
    const current = this.bindings.get(approvalId);
    if (current) return current;
    if (signal?.aborted) return undefined;

    return new Promise<DshApprovalBinding | undefined>((resolve) => {
      // 状态显式打包；finish/onAbort 用模块级函数 + bind 绑定状态，
      // 不在方法内定义带决策点的闭包。
      const state: BindingWaitState = {
        settled: false,
        onAbort: () => {},
        approvalId,
        waiters: this.waiters,
        resolve,
        signal,
        finish: () => {},
      };
      state.finish = finishBindingWait.bind(null, state);
      state.onAbort = abortBindingWait.bind(null, state);
      state.timer = setTimeout(abortBindingWait.bind(null, state), timeoutMs);
      signal?.addEventListener('abort', state.onAbort, { once: true });
      const set = this.waiters.get(approvalId) ?? new Set<BindingWaiter>();
      set.add(state.finish);
      this.waiters.set(approvalId, set);
    });
  }

  /** Drop all in-flight state when a run ends. */
  clear(): void {
    for (const approvalId of [...this.waiters.keys()]) this.resolveWaiters(approvalId, undefined);
    this.audits.clear();
    this.waterfallByCallId.clear();
    this.bindings.clear();
    this.approvalIdByEventId.clear();
  }

  private bind(audit: DshApprovalAudit, waterfall: DshApprovalWaterfall): DshApprovalBinding {
    const binding = { audit, waterfall };
    this.bindings.set(audit.approvalId, binding);
    this.approvalIdByEventId.set(waterfall.eventId, audit.approvalId);
    this.resolveWaiters(audit.approvalId, binding);
    return binding;
  }

  private resolveWaiters(approvalId: string, binding: DshApprovalBinding | undefined): void {
    const set = this.waiters.get(approvalId);
    if (!set) return;
    this.waiters.delete(approvalId);
    for (const waiter of [...set]) waiter(binding);
  }
}
