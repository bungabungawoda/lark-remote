/**
 * ConnectionManager: manages Codex App Server connections per workspace.
 *
 * Each workspace gets its own connection (transport + client). Connections are
 * created on demand via `acquire()`, cached for reuse, and released after an
 * idle timeout (30 minutes default).
 */

import { JsonlRpcTransport } from './transport.js';
import { CodexAppServerClient } from './client.js';
import type { ClientHooks } from './client.js';
import { getLogger } from '../../../logger/index.js';

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000; // 60 seconds

interface Slot {
  client: CodexAppServerClient;
  idleTimer: ReturnType<typeof setTimeout> | null;
  createPromise: Promise<CodexAppServerClient> | null;
}

export interface ConnectionManagerOptions {
  /** Path to the codex binary. */
  binary: string;
  /** Args to spawn the app server with. Defaults to `['app-server', '--stdio']`. */
  args?: string[];
  /** Environment variables to pass to the binary. */
  env?: Record<string, string | undefined>;
  /** Request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Idle TTL in milliseconds. */
  idleTtlMs?: number;
}

export class ConnectionManager {
  private slots = new Map<string, Slot>();
  private readonly binary: string;
  private readonly args: string[];
  private readonly env: Record<string, string | undefined>;
  private readonly requestTimeoutMs: number;
  private readonly idleTtlMs: number;

  /** Callback when a connection is lost — cleared from slot map. */
  onConnectionLost?: (workspace: string) => void;

  constructor(opts: ConnectionManagerOptions) {
    this.binary = opts.binary;
    this.args = opts.args ?? ['app-server', '--stdio'];
    this.env = opts.env ?? {};
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  /**
   * Acquire a connection for the given workspace.
   * Creates a new connection if one does not exist or the previous one was lost.
   * Serializes creation so concurrent calls share the same connection.
   */
  async acquire(workspace: string): Promise<CodexAppServerClient> {
    const existing = this.slots.get(workspace);
    if (existing) {
      // If a create is in flight, wait for it
      if (existing.createPromise) {
        return existing.createPromise;
      }
      // If the client is ready and its transport is alive, return it
      if (existing.client.ready && existing.client.healthy) {
        return existing.client;
      }
      // Client is disposed, dead (e.g. app-server process killed externally),
      // or not ready — replace it so the next run respawns the process.
      this.disposeSlot(workspace);
    }

    const createPromise = this.createClient(workspace);
    this.slots.set(workspace, {
      client: null as unknown as CodexAppServerClient, // placeholder
      idleTimer: null,
      createPromise: createPromise as unknown as Promise<CodexAppServerClient>,
    });

    try {
      const client = await createPromise;
      // P2-2 竞态：创建期间 release()/disposeAll() 已把 slot 删掉（并可能已
      // dispose 连接）。此时不能再把新连接塞回 slot——否则会复活一个无人管理、
      // 无 idle timer 的连接泄漏。归还给调用者继续使用，但不再缓存。
      const slotAfterCreate = this.slots.get(workspace);
      if (!slotAfterCreate || slotAfterCreate.createPromise !== createPromise) {
        return client;
      }
      this.slots.set(workspace, {
        client,
        idleTimer: null,
        createPromise: null,
      });
      return client;
    } catch (err) {
      // 只删除自己的槽位：并发 release + 重新 acquire 后 slot 可能已被新的
      // createPromise 占据，误删会破坏新连接。
      const current = this.slots.get(workspace);
      if (current && current.createPromise === createPromise) {
        this.slots.delete(workspace);
      }
      throw err;
    }
  }

  /**
   * Release (dispose) a connection for the given workspace.
   */
  async release(workspace: string): Promise<void> {
    this.disposeSlot(workspace);
  }

  /**
   * Dispose all connections.
   */
  async disposeAll(): Promise<void> {
    const workspaces = [...this.slots.keys()];
    await Promise.all(workspaces.map((w) => this.disposeSlot(w)));
  }

  /**
   * Notify that the workspace is active — disarm the idle timer.
   */
  notifyActivity(workspace: string): void {
    const slot = this.slots.get(workspace);
    if (slot) {
      this.clearIdleTimer(slot);
    }
  }

  /**
   * Notify that the workspace is idle — arm the idle timer.
   */
  notifyIdle(workspace: string): void {
    const slot = this.slots.get(workspace);
    if (slot) {
      this.clearIdleTimer(slot);
      slot.idleTimer = setTimeout(() => {
        getLogger().info(
          `[codex-connection-manager] idle timeout for workspace=${workspace}, releasing connection`,
        );
        this.disposeSlot(workspace);
      }, this.idleTtlMs);
    }
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private async createClient(workspace: string): Promise<CodexAppServerClient> {
    const transport = new JsonlRpcTransport({
      binary: this.binary,
      args: this.args,
      cwd: workspace,
      env: this.env,
    });

    let client: CodexAppServerClient | null = null;
    const hooks: ClientHooks = {
      onNotification: (_method: string, _params: unknown) => {
        // Notifications are handled by the runner via translator
      },
      onServerRequest: (_id: number | string, _method: string, _params: unknown) => {
        // Server requests are handled by the runner via translator
      },
      onClose: () => {
        getLogger().info(`[codex-connection-manager] connection closed workspace=${workspace}`);
        // 只清理自己创建的 slot：并发 release + 重新 acquire 后 slot 可能已被
        // 新连接占据，误删会破坏新连接。
        if (this.slots.get(workspace)?.client === client) {
          this.slots.delete(workspace);
          this.onConnectionLost?.(workspace);
        }
      },
    };

    client = new CodexAppServerClient(transport, hooks, this.requestTimeoutMs);
    await client.connect();
    return client;
  }

  private clearIdleTimer(slot: Slot): void {
    if (slot.idleTimer !== null) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
  }

  private async disposeSlot(workspace: string): Promise<void> {
    const slot = this.slots.get(workspace);
    if (!slot) return;
    this.slots.delete(workspace);
    this.clearIdleTimer(slot);
    if (slot.client) {
      try {
        await slot.client.dispose();
      } catch (err) {
        getLogger().warn(`[codex-connection-manager] dispose error workspace=${workspace}: ${err}`);
      }
    }
  }
}
