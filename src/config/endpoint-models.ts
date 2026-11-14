/**
 * 端点模型清单探测 —— 问一个 API base「你现在服务哪些模型」。
 *
 * 用途：claude / codex 指向自定义 base（relay、自建网关、厂商兼容端点）时，
 * 供 Card 的模型下拉补上端点真正列出的模型。它不是配置的事实源，只是补充：
 * 探到的 id 与原配置求并集，探测失败什么都不改。
 *
 * 候选 URL 与认证沿用此前真机实测的规则：
 * - 一个 base 会围绕它试几个常见清单路径（…/models、…/v1/models、剥掉
 *   /anthropic 后的 root 两种）。真机案例：Claude Code 的 base 是
 *   https://api.deepseek.com/anthropic，该路径下没有清单，root 的 /v1/models 才有。
 * - 带版本段的 base（…/v1、…/api/v3、…/v1beta）本身就是完整 API 路径，
 *   只按原样问 base/models —— 再补 /v1 只会 404，白等一个超时。
 * - 认证同时发 Bearer 与 x-api-key；被 401/403 时再各发一次，免得某个 relay
 *   因为多带了一个头就拒绝。
 * - 分页跟到最后一页；跟不完就把整份清单当成没拿到（半份清单会让调用方误判
 *   「这些模型没了」）。
 */

import { createHash } from 'node:crypto';
import { getLogger } from '../logger/index.js';

/** 单次请求超时。清单请求不该占住更久。 */
const REQUEST_TIMEOUT_MS = 8_000;
/** 一页要多少：Anthropic 接受 1000，真实目录一页就够。 */
const PAGE_LIMIT = 1000;
/** 最多跟几页：5 页 × 1000 已远超任何真实目录，翻不完按读不全处理。 */
const MAX_PAGES = 5;
/** 成功结果缓存：端点清单只在厂商上下架时变。 */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** 失败负缓存：没配错的端点不该每次开卡片都等满一次超时。 */
const NEGATIVE_TTL_MS = 30 * 1000;

/** 从 base 剥掉的路径后缀，用于回到 root 再问一次清单。 */
const ROOT_SUFFIXES = ['/anthropic', '/apps/anthropic', '/api/anthropic', '/v1', '/api', '/api/v1'];

/** 问哪个端点、用什么认证。 */
export interface EndpointModelsTarget {
  /** API base URL：…/v1、…/anthropic、裸 host 都可以。 */
  baseUrl: string;
  /** 可选 API key；同时按 Bearer 与 x-api-key 发。 */
  apiKey?: string;
  /** Anthropic 风格端点：带 anthropic-version 头，并允许剥 /anthropic 回 root。 */
  anthropic?: boolean;
}

/** 一次请求的认证形态：两套都发，或只发其中一套。 */
type AuthMode = 'both' | 'bearer' | 'x-api-key';

/** base 末尾斜杠归一化；空串原样返回（交给调用方判定无效）。 */
function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** 路径里是否有版本段（v1、v3、v1beta…）：有就说明 base 已是完整 API 路径。 */
function isVersioned(base: string): boolean {
  const rest = base.includes('://') ? base.slice(base.indexOf('://') + 3) : base;
  const slash = rest.indexOf('/');
  if (slash < 0) return false;
  const path = rest.slice(slash + 1).split(/[?#]/)[0];
  return path.split('/').some((seg) => /^v\d/i.test(seg));
}

/** 一个 base 要问的清单 URL，按顺序去重。 */
export function listEndpointUrls(baseUrl: string, anthropic = false): string[] {
  const base = normalizeBase(baseUrl);
  if (!base) return [];
  const urls: string[] = [];
  const add = (u: string): void => {
    if (!urls.includes(u)) urls.push(u);
  };
  add(`${base}/models`);
  if (!anthropic && isVersioned(base)) return urls;
  add(`${base}/v1/models`);
  let root = base;
  for (const suffix of ROOT_SUFFIXES) {
    if (root.endsWith(suffix)) root = root.slice(0, -suffix.length);
  }
  add(`${root}/v1/models`);
  add(`${root}/models`);
  return urls;
}

function headersFor(target: EndpointModelsTarget, auth: AuthMode): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (target.apiKey) {
    if (auth !== 'x-api-key') headers.Authorization = `Bearer ${target.apiKey}`;
    if (auth !== 'bearer') headers['x-api-key'] = target.apiKey;
  }
  if (target.anthropic) headers['anthropic-version'] = '2023-06-01';
  return headers;
}

/** 一页清单解析出的东西。 */
interface ParsedPage {
  ids: string[];
  hasMore: boolean;
  lastId: string;
}

/**
 * 解析一页清单。认 `{data:[…]}`（OpenAI）与 `{models:[…]}`（Gemini 等），
 * 每行取 id，缺 id 时取 name 并去掉 `models/` 前缀。不是清单（HTML、错误体、
 * 没有数组）返回 null，由调用方换下一个候选 URL。
 */
function parsePage(body: string): ParsedPage | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const rec = json as Record<string, unknown>;
  const rows = Array.isArray(rec.data) ? rec.data : Array.isArray(rec.models) ? rec.models : null;
  if (!rows) return null;

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const raw = typeof r.id === 'string' ? r.id : typeof r.name === 'string' ? r.name : '';
    const id = raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return {
    ids,
    hasMore: rec.has_more === true,
    lastId: typeof rec.last_id === 'string' ? rec.last_id : '',
  };
}

/** 一页请求的结果：状态码一律带出来，正文只在 200 时读。 */
interface PageResponse {
  status: number;
  body: string;
}

async function requestPage(
  url: string,
  target: EndpointModelsTarget,
  auth: AuthMode,
): Promise<PageResponse> {
  const res = await fetch(url, {
    headers: headersFor(target, auth),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: res.status, body: res.status === 200 ? await res.text() : '' };
}

/**
 * 在 url 上把清单读到最后一页，返回 id 列表；读不全返回 null。
 *
 * 认证按 both → 单发 的顺序试一次：401/403 才换，别的错误直接放弃这个 URL。
 */
async function readListAt(url: string, target: EndpointModelsTarget): Promise<string[] | null> {
  const modes: AuthMode[] = target.apiKey ? ['both', 'bearer', 'x-api-key'] : ['both'];
  for (const mode of modes) {
    let res: PageResponse;
    try {
      res = await requestPage(url, target, mode);
    } catch {
      return null; // 网络错误 / 超时：换 URL 比换认证有意义
    }
    if (res.status === 200) return readPages(url, target, mode, res.body);
    // 只有「认证不对」值得换一种发法；404/5xx 换认证也还是 404/5xx
    if (res.status !== 401 && res.status !== 403) return null;
  }
  return null;
}

/** 从已拿到的第一页开始往后翻，读不全返回 null。 */
async function readPages(
  url: string,
  target: EndpointModelsTarget,
  auth: AuthMode,
  firstPage: string,
): Promise<string[] | null> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let page: string | null = firstPage;
  let after = '';

  for (let n = 0; page !== null; n++) {
    const parsed = parsePage(page);
    if (!parsed) return null;
    for (const id of parsed.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (!parsed.hasMore) return ids;
    // 说有下一页却给不出起点，或还在同一页打转：整份清单不可信
    if (!parsed.lastId || parsed.lastId === after) return null;
    if (n + 1 >= MAX_PAGES) return null;
    after = parsed.lastId;
    const next = new URL(url);
    next.searchParams.set('after_id', after);
    next.searchParams.set('limit', String(PAGE_LIMIT));
    const res = await requestPage(next.toString(), target, auth);
    page = res.status === 200 ? res.body : null;
  }
  return null;
}

/** 依次问候选 URL，返回第一个读到的清单；都不成返回 null。 */
async function probeEndpoint(target: EndpointModelsTarget): Promise<string[] | null> {
  for (const url of listEndpointUrls(target.baseUrl, target.anthropic)) {
    const ids = await readListAt(url, target);
    if (ids && ids.length > 0) return ids;
  }
  return null;
}

/** 缓存键：端点 + 风格 + key 指纹（key 本身不进键，也不进日志）。 */
function cacheKey(target: EndpointModelsTarget): string | undefined {
  const base = normalizeBase(target.baseUrl);
  if (!base) return undefined;
  const fingerprint = target.apiKey
    ? createHash('sha256').update(target.apiKey).digest('hex').slice(0, 16)
    : '';
  return [base, target.anthropic ? 'anthropic' : 'openai', fingerprint].join('\u0000');
}

interface CacheEntry {
  ids: string[];
  at: number;
  failed: boolean;
}

const cache = new Map<string, CacheEntry>();
/** 同键的并发探测只发一轮（卡片连开、预热与显式调用撞车时）。 */
const inFlight = new Map<string, Promise<string[] | null>>();

/** 冷却期内的条目（成功或失败）；过期为 undefined。 */
function freshEntry(key: string): CacheEntry | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  return Date.now() - hit.at < (hit.failed ? NEGATIVE_TTL_MS : CACHE_TTL_MS) ? hit : undefined;
}

function store(key: string, ids: string[] | null): string[] | null {
  if (ids && ids.length > 0) {
    cache.set(key, { ids, at: Date.now(), failed: false });
    return ids;
  }
  cache.set(key, { ids: [], at: Date.now(), failed: true });
  return null;
}

/** 实际探测（去重、落缓存）。没有可用清单时记一条 warn，且只记一次。 */
function probe(target: EndpointModelsTarget, key: string): Promise<string[] | null> {
  const running = inFlight.get(key);
  if (running) return running;

  const p = (async () => {
    try {
      const ids = await probeEndpoint(target);
      if (!ids) {
        getLogger().warn(`[endpoint-models] no model list at ${normalizeBase(target.baseUrl)}`);
      }
      return store(key, ids);
    } catch (err) {
      getLogger().warn(`[endpoint-models] probe failed: ${(err as Error).message}`);
      return store(key, null);
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return p;
}

/**
 * 探测端点的模型清单。
 *
 * 冷却期内直接返回缓存（失败时返回 null）；否则真的发一轮请求。并发调用共享
 * 同一轮请求。
 */
export async function fetchEndpointModels(target: EndpointModelsTarget): Promise<string[] | null> {
  const key = cacheKey(target);
  if (!key) return null;
  const hit = freshEntry(key);
  if (hit && !hit.failed) return hit.ids;
  return probe(target, key);
}

/**
 * 同步读缓存，顺便在未命中时踢一次后台探测。
 *
 * 卡片构建是同步的：拿不到就返回 undefined（调用方保持原列表）。探测落地后
 * 由 router 比目录签名决定是否补刷卡片（§9.29），本模块不碰视图；冷却期内
 * （含失败）不重复踢。显式刷新走 `forceEndpointModels` 绕过冷却。
 */
export function cachedEndpointModels(target: EndpointModelsTarget): string[] | undefined {
  const key = cacheKey(target);
  if (!key) return undefined;
  const hit = freshEntry(key);
  if (hit) return hit.failed ? undefined : hit.ids;
  void probe(target, key);
  return undefined;
}

/** 启动预热：后台探一次，让首次卡片构建命中缓存。 */
export function warmEndpointModels(target: EndpointModelsTarget): void {
  const key = cacheKey(target);
  if (!key || freshEntry(key)) return;
  void probe(target, key);
}

/**
 * 配置卡「刷新模型」：绕过成功/失败冷却重探一次。
 *
 * 仍走 `probe` 的按 key 单飞——已有一轮探测在跑时复用它，不并发发请求。
 * 探测失败落负缓存但清单不变，调用方按目录签名判定后不会补刷卡片。
 */
export async function forceEndpointModels(target: EndpointModelsTarget): Promise<string[] | null> {
  const key = cacheKey(target);
  if (!key) return null;
  return probe(target, key);
}

/** Test utility: drop every cached list and in-flight probe. */
export function _invalidateEndpointModelsCacheForTest(): void {
  cache.clear();
  inFlight.clear();
}
