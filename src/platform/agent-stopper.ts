/**
 * 每 agent 的协议停止通道注册表（design.md §3.3）。
 *
 * Windows 没有可拦截的跨进程 SIGTERM，优雅停止只能靠协议通道（claude 的 stdin
 * 控制通道、codex 的 turn interrupt、ACP 的 session/cancel…）。「无通道」是
 * **合法状态**：由 Terminator 显式跳过优雅段并打日志，绝不允许悄悄等一个永远
 * 不会来的退出事件。
 *
 * **键 = agent + pid，不是 agent 单维**。两条理由：
 *   1. 同一 agent 可以同时有多个存活子进程（每个 workspace 一条长驻连接，外加
 *      claude 的进程代际更替）。按 agent 单键索引时后注册的连接会**覆盖**前一个
 *      的通道，Terminator 便拿着 A 工作区的通道去停 B 工作区的进程；
 *   2. Terminator 手上只有 `proc`，只有 pid 能把「这条通道」与「正要停的那个
 *      进程」对上——agent 键圈族，pid 键定归属。
 * 反例（pid 键必要性的现成证据）：kimi 的 `terminal/kill` 复用同一个 agent 键
 * （'kimi'）去停 bash 终端子进程，pid 不同 → 查表落空 → 走树杀，语义正确，
 * 而不是误用 agent 的 turn-cancel 通道。
 *
 * 独立成文件是为了避免 `terminator.ts`（接口 + 分发）与 `terminator-win32.ts`
 * 互相 import 形成循环依赖。
 */
import type { ChildProcess } from 'node:child_process';

export type AgentStopper = (proc: ChildProcess) => void | Promise<void>;

/** agent key → pid → 协议停止通道。测试请自建实例以隔离。 */
export class AgentStopperRegistry {
  private readonly stoppers = new Map<string, Map<number, AgentStopper>>();

  register(agent: string, pid: number, stopper: AgentStopper): void {
    let byPid = this.stoppers.get(agent);
    if (!byPid) {
      byPid = new Map<number, AgentStopper>();
      this.stoppers.set(agent, byPid);
    }
    byPid.set(pid, stopper);
  }

  get(agent: string, pid: number): AgentStopper | undefined {
    return this.stoppers.get(agent)?.get(pid);
  }

  has(agent: string, pid: number): boolean {
    return this.stoppers.get(agent)?.has(pid) === true;
  }

  /**
   * 注销通道。
   *
   * 传 `stopper` 时只在该 pid 上仍是**同一条**通道时才删：重连/进程换代可能让
   * 同一 pid 上已经换了新通道，无脑删等于让新连接裸奔（win32 上退化成直接树杀）。
   *
   * @returns 是否真的删掉了
   */
  unregister(agent: string, pid: number, stopper?: AgentStopper): boolean {
    const byPid = this.stoppers.get(agent);
    const current = byPid?.get(pid);
    if (!byPid || current === undefined) return false;
    if (stopper !== undefined && current !== stopper) return false;
    byPid.delete(pid);
    if (byPid.size === 0) this.stoppers.delete(agent);
    return true;
  }

  clear(): void {
    this.stoppers.clear();
  }

  /** 当前登记的通道条数（诊断 / 测试断言不泄漏用）。 */
  get size(): number {
    let total = 0;
    for (const byPid of this.stoppers.values()) total += byPid.size;
    return total;
  }
}

/** 接线用的进程级单例；runner 在子进程起来时注册自己的停止通道。 */
export const agentStopperRegistry = new AgentStopperRegistry();
