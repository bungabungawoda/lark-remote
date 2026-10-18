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
      if (waterfall) return this.bind(audit, waterfall);
    }
    return undefined;
  }

  /** Record an `approval/request` waterfall; pair when its audit is known. */
  onWaterfall(waterfall: DshApprovalWaterfall): DshApprovalBinding | undefined {
    const existingApprovalId = this.approvalIdByEventId.get(waterfall.eventId);
    if (existingApprovalId) {
      // A reconnect re-delivers the same pending event with a new Client
      // identity. Keep the card binding but refresh the answer channel.
      const binding = this.bindings.get(existingApprovalId);
      if (binding) {
        binding.waterfall.clientId = waterfall.clientId;
        if (waterfall.reason) binding.waterfall.reason = waterfall.reason;
        if (waterfall.callId) {
          this.waterfallByCallId.set(waterfall.callId, binding.waterfall);
        }
      }
      return undefined;
    }
    if (waterfall.callId) this.waterfallByCallId.set(waterfall.callId, waterfall);

    if (waterfall.callId) {
      for (const audit of this.audits.values()) {
        if (audit.callId === waterfall.callId && !this.bindings.has(audit.approvalId)) {
          return this.bind(audit, waterfall);
        }
      }
      // Some approval types omit callId on the durable audit. Pair with the
      // oldest unbound audit for the same tool before falling back to Web UI.
      for (const audit of this.audits.values()) {
        if (
          !audit.callId &&
          !this.bindings.has(audit.approvalId) &&
          audit.toolName === waterfall.toolName
        ) {
          return this.bind(audit, waterfall);
        }
      }
    }

    // A missing callId is unusual but not fatal: pair with the oldest unbound
    // audit for the same tool, preserving the audit id on the card.
    if (!waterfall.callId) {
      for (const audit of this.audits.values()) {
        if (!this.bindings.has(audit.approvalId) && audit.toolName === waterfall.toolName) {
          return this.bind(audit, waterfall);
        }
      }
    }
    return undefined;
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
      this.resolveWaiters(approvalId, undefined);
    }
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
      let settled = false;
      const finish = (binding: DshApprovalBinding | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const set = this.waiters.get(approvalId);
        set?.delete(finish);
        if (set && set.size === 0) this.waiters.delete(approvalId);
        resolve(binding);
      };
      const onAbort = (): void => finish(undefined);
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      const set = this.waiters.get(approvalId) ?? new Set<BindingWaiter>();
      set.add(finish);
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
