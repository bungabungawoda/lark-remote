/**
 * 每 agent 的协议停止通道注册表（design.md §3.3）。
 *
 * Windows 没有可拦截的跨进程 SIGTERM，优雅停止只能靠协议通道（claude 的 stdin
 * 控制通道、codex 的 turn interrupt、ACP 的 abort…）。「无通道」是**合法状态**：
 * 由 Terminator 显式跳过优雅段并打日志，绝不允许悄悄等一个永远不会来的退出事件。
 *
 * 独立成文件是为了避免 `terminator.ts`（接口 + 分发）与 `terminator-win32.ts`
 * 互相 import 形成循环依赖。
 */
import type { ChildProcess } from 'node:child_process';

export type AgentStopper = (proc: ChildProcess) => void | Promise<void>;

/** agent key → 协议停止通道。测试请自建实例以隔离。 */
export class AgentStopperRegistry {
  private readonly stoppers = new Map<string, AgentStopper>();

  register(agent: string, stopper: AgentStopper): void {
    this.stoppers.set(agent, stopper);
  }

  get(agent: string): AgentStopper | undefined {
    return this.stoppers.get(agent);
  }

  has(agent: string): boolean {
    return this.stoppers.has(agent);
  }

  clear(): void {
    this.stoppers.clear();
  }
}

/** 接线用的进程级单例；runner 在 run 启动时注册自己的停止通道。 */
export const agentStopperRegistry = new AgentStopperRegistry();
