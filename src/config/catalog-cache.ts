/**
 * 配置卡模型目录的统一同步读契约（stale-while-revalidate）。
 *
 * 起因：`/config` 卡片每次点击都会 buildFields，四个 agent 的目录 loader 各自
 * 在 TTL 过期时同步 spawn CLI（opencode/kimi 上限 10s、codex 8s、pi 8s），直接
 * 阻塞整个事件循环——不只是配置卡回包，正在流式 patch 的 run 卡也一起卡住。
 * qoder/codebuddy 早就用「同步读快照 + 后台刷新」解决了同一个问题，这里把它
 * 抽成所有 agent 共用的契约。
 *
 * 语义（所有 agent 一致）：
 * - 命中未过期快照：直接返回，零 IO。
 * - 命中过期快照：返回旧快照（stale），同时点火一次后台异步刷新；「最后一次
 *   状态赢」，连点不会排队等刷新。
 * - 缓存键变化（binary / 配置目录 / 文件指纹）：**不返回旧清单**，改返 fallback
 *   并点火刷新——旧身份的清单冒充新身份，会让 UI 展示/写回一个不属于当前
 *   binary 或配置目录的模型 id。旧快照只作为刷新的 previous 值保留。
 * - 无快照且刷新在途：返回 fallback，不重复点火。
 * - 无快照（冷启动）：允许一次同步冷加载，保证首帧就有真实清单；启动时由
 *   `warm()` 后台预热，生产路径几乎不会走到这里。
 * - 刷新失败：负缓存（短 TTL）保留上次成功快照，不反复点火拖垮 CLI。
 *
 * 同步读路径**永不因 TTL 过期而 spawn**；刷新一律走调用方提供的异步 loader。
 * 每次读都打一条 `event=catalog` 埋点：`hit=cold` 的 `sync_spawn=true` 是冷启动
 * 唯一允许的一次同步加载，其它 hit 值出现 `sync_spawn=true` 即回归。
 */
import { getLogger } from '../logger/index.js';
import { logConfigPerf, ConfigPerfSpan } from '../common/config-perf.js';

export type CatalogHit = 'fresh' | 'stale' | 'inflight' | 'cold' | 'negative' | 'key-shift';

export interface SyncCatalogOptions<T, C = void> {
  /** 埋点里的 agent 名（pi/codex/opencode/kimi…）。 */
  agent: string;
  /** 缓存键默认值：binary/configDir/文件指纹等，变化时旧快照作废。 */
  key: () => string;
  /** 冷启动同步加载（仅无快照时调用一次）。 */
  loadSync: (ctx: C) => T;
  /** 后台异步刷新（不得使用同步 spawn）。 */
  loadAsync: (ctx: C) => Promise<T>;
  /** 无快照/刷新在途时的兜底值。 */
  fallback: () => T;
  /** 判定结果为空（失败），空结果走负缓存。 */
  isEmpty?: (value: T) => boolean;
  /** 成功快照 TTL。 */
  ttlMs?: number;
  /** 失败负缓存 TTL。 */
  negativeTtlMs?: number;
}

interface Snapshot<T> {
  key: string;
  value: T;
  ts: number;
  failed: boolean;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_NEGATIVE_TTL_MS = 30_000;

export class SyncCatalog<T, C = void> {
  private snapshot: Snapshot<T> | undefined;
  private inFlight: Promise<T> | undefined;

  constructor(private readonly opts: SyncCatalogOptions<T, C>) {}

  /** 同步读：绝不因缓存过期而阻塞事件循环。keyOverride 供参数化 loader 传入。 */
  read(keyOverride?: string, ctx?: C): T {
    const key = keyOverride ?? this.opts.key();
    const snap = this.snapshot;
    const now = Date.now();

    if (snap) {
      const ttl = snap.failed
        ? (this.opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS)
        : (this.opts.ttlMs ?? DEFAULT_TTL_MS);
      if (snap.key === key && now - snap.ts < ttl) {
        this.logRead(snap.failed ? 'negative' : 'fresh', false);
        return snap.value;
      }
      // 过期（stale）或键漂移：点火一次后台刷新（in-flight 去重）。
      void this.refresh(keyOverride, ctx);
      if (snap.key !== key) {
        // 键变了就是另一个身份：旧清单不得冒充新身份，交回 fallback。
        this.logRead('key-shift', false);
        return this.opts.fallback();
      }
      this.logRead('stale', false);
      return snap.value;
    }

    if (this.inFlight) {
      this.logRead('inflight', false);
      return this.opts.fallback();
    }

    // 冷启动：保留一次同步加载，首帧就能显示真实清单；后续全部走缓存/后台刷新。
    const span = new ConfigPerfSpan();
    let value: T;
    let failed = false;
    try {
      value = this.opts.loadSync(ctx as C);
      failed = this.opts.isEmpty?.(value) ?? false;
    } catch (err) {
      getLogger().warn(`[catalog] ${this.opts.agent} cold load failed: ${(err as Error).message}`);
      value = this.opts.fallback();
      failed = true;
    }
    span.segment('cold');
    this.snapshot = { key, value, ts: Date.now(), failed };
    this.logRead('cold', true, span.fields());
    return value;
  }

  /** 后台刷新：单飞（并发点火只跑一次），返回刷新后的值。 */
  refresh(keyOverride?: string, ctx?: C): Promise<T> {
    if (this.inFlight) return this.inFlight;
    const key = keyOverride ?? this.opts.key();
    const span = new ConfigPerfSpan();
    const previous = this.snapshot;
    const task = (async (): Promise<T> => {
      try {
        const value = await this.opts.loadAsync(ctx as C);
        const failed = this.opts.isEmpty?.(value) ?? false;
        this.snapshot = { key, value, ts: Date.now(), failed };
        logConfigPerf('catalog', {
          agent: this.opts.agent,
          phase: 'refresh',
          ok: !failed,
          ...span.fields(),
        });
        return value;
      } catch (err) {
        getLogger().warn(`[catalog] ${this.opts.agent} refresh failed: ${(err as Error).message}`);
        // 负缓存保留上次成功快照：刷新失败不该让下拉框变空。
        this.snapshot = {
          key,
          value: previous?.value ?? this.opts.fallback(),
          ts: Date.now(),
          failed: true,
        };
        logConfigPerf('catalog', {
          agent: this.opts.agent,
          phase: 'refresh',
          ok: false,
          ...span.fields(),
        });
        return this.snapshot.value;
      } finally {
        this.inFlight = undefined;
      }
    })();
    this.inFlight = task;
    return task;
  }

  /** 启动预热：fire-and-forget，让首次打开配置卡就命中快照。 */
  warm(): void {
    void this.refresh();
  }

  /** 测试用：清空快照与在途刷新。 */
  invalidate(): void {
    this.snapshot = undefined;
    this.inFlight = undefined;
  }

  private logRead(hit: CatalogHit, syncSpawn: boolean, timing?: Record<string, number>): void {
    logConfigPerf('catalog', {
      agent: this.opts.agent,
      phase: 'read',
      hit,
      sync_spawn: syncSpawn,
      ...timing,
    });
  }
}
