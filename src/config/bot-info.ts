/**
 * 飞书应用名解析（配置目录选择器用）。
 *
 * config.yaml 只存 appId/appSecret，应用名必须问飞书：
 *   GET /open-apis/bot/v3/info（Bearer tenant_access_token）→ bot.app_name。
 * 结果按目录缓存在 `bot-info.json`，选择器优先读缓存，缺失/过期才联网。
 *
 * 纪律：
 * - 这里只读 config.yaml，**不调用 loadConfig**（后者失败会 process.exit）。
 * - 缓存文件只写 appId/appName/fetchedAt，绝不落 appSecret。
 * - 全程 best-effort：任何失败都返回 undefined，选择器回退显示 appId 尾号。
 */
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { atomicWriteJson } from '../persistence/atomic-write.js';

export const BOT_INFO_FILE = 'bot-info.json';
/** 应用名很少变；7 天足够新，同时避免每次选择都联网。 */
export const BOT_INFO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** token + bot info 两步共享的总预算。 */
export const BOT_INFO_TIMEOUT_MS = 3000;
/** 并发上限：避免一次性打爆 tenant_access_token 端点。 */
export const BOT_INFO_CONCURRENCY = 8;

const TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const BOT_INFO_URL = 'https://open.feishu.cn/open-apis/bot/v3/info';

export interface BotInfo {
  appId: string;
  appName: string;
  fetchedAt: string;
}

export type BotNameSource = 'cache' | 'fresh' | 'stale' | 'none';

export interface BotName {
  appName?: string;
  source: BotNameSource;
}

export interface BotInfoTarget {
  dir: string;
  appId: string;
  appSecret: string;
}

/** 可注入的 HTTP 传输层：测试不碰真实飞书。 */
export interface BotInfoHttp {
  post(
    url: string,
    body: unknown,
    opts: { timeoutMs: number; signal: AbortSignal; headers: Record<string, string> },
  ): Promise<{ data: unknown }>;
  get(
    url: string,
    opts: { timeoutMs: number; signal: AbortSignal; headers: Record<string, string> },
  ): Promise<{ data: unknown }>;
}

const axiosHttp: BotInfoHttp = {
  post: (url, body, opts) => axios.post(url, body, opts),
  get: (url, opts) => axios.get(url, opts),
};

function botInfoPath(configDir: string): string {
  return path.join(configDir, BOT_INFO_FILE);
}

/** 读缓存。结构不合法（含半截写入）一律当作没有缓存。 */
export function readBotInfo(configDir: string): BotInfo | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(botInfoPath(configDir), 'utf-8')) as Partial<BotInfo>;
    if (typeof parsed.appId !== 'string' || typeof parsed.appName !== 'string') return undefined;
    const appName = parsed.appName.trim();
    if (appName.length === 0) return undefined;
    return {
      appId: parsed.appId,
      appName,
      fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : '',
    };
  } catch {
    return undefined;
  }
}

/** 缓存是否可用于当前 appId 且未过期。 */
export function isBotInfoFresh(info: BotInfo, appId: string, now = Date.now()): boolean {
  if (info.appId !== appId) return false;
  const fetchedAt = Date.parse(info.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return false;
  return now - fetchedAt < BOT_INFO_TTL_MS;
}

/** best-effort 写缓存：写失败不影响选择器。 */
function writeBotInfo(configDir: string, info: BotInfo): void {
  try {
    atomicWriteJson(botInfoPath(configDir), info);
  } catch {
    // 选择器运行在 logger 初始化之前，且缓存只是加速手段，静默即可。
  }
}

interface ResolveBotNamesOptions {
  now?: number;
  http?: BotInfoHttp;
  timeoutMs?: number;
  concurrency?: number;
  /**
   * false = 只读缓存、绝不联网。非交互场景（管道/无 TTY）用，避免启动错误信息
   * 被一次 3 秒的网络请求拖住。
   */
  remote?: boolean;
  /** 确实需要联网时回调一次（用于打印“正在读取…”提示）。 */
  onStart?: (pending: number) => void;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function appNameFrom(data: unknown): string | undefined {
  const raw = (data as { bot?: { app_name?: unknown } } | null)?.bot?.app_name;
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim();
  return name.length > 0 ? name : undefined;
}

interface HttpCallOptions {
  timeoutMs: number;
  signal: AbortSignal;
}

async function requestTenantToken(
  http: BotInfoHttp,
  target: Pick<BotInfoTarget, 'appId' | 'appSecret'>,
  opts: HttpCallOptions,
): Promise<string | undefined> {
  const resp = await http.post(
    TOKEN_URL,
    { app_id: target.appId, app_secret: target.appSecret },
    {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    },
  );
  const data = resp.data as { code?: unknown; tenant_access_token?: unknown };
  if (data.code !== 0) return undefined;
  return stringValue(data.tenant_access_token);
}

async function requestBotAppName(
  http: BotInfoHttp,
  token: string,
  opts: HttpCallOptions,
): Promise<string | undefined> {
  const resp = await http.get(BOT_INFO_URL, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = resp.data as { code?: unknown };
  if (data.code !== 0) return undefined;
  return appNameFrom(resp.data);
}

/**
 * 取单个应用名。token 与 bot info 共用同一个 AbortController 预算；
 * 超时/网络/业务错误一律返回 undefined。
 */
export async function fetchBotInfo(
  target: Pick<BotInfoTarget, 'appId' | 'appSecret'>,
  opts: { http?: BotInfoHttp; timeoutMs?: number; now?: number } = {},
): Promise<BotInfo | undefined> {
  const http = opts.http ?? axiosHttp;
  const timeoutMs = opts.timeoutMs ?? BOT_INFO_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const callOptions: HttpCallOptions = { timeoutMs, signal: controller.signal };
  try {
    const token = await requestTenantToken(http, target, callOptions);
    if (!token) return undefined;
    const appName = await requestBotAppName(http, token, callOptions);
    if (!appName) return undefined;
    return {
      appId: target.appId,
      appName,
      fetchedAt: new Date(opts.now ?? Date.now()).toISOString(),
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function cachedName(cache: BotInfo | undefined, appId: string, now: number): BotName {
  if (!cache || cache.appId !== appId) return { source: 'none' };
  return {
    appName: cache.appName,
    source: isBotInfoFresh(cache, appId, now) ? 'cache' : 'stale',
  };
}

function cacheOnlyResults(targets: BotInfoTarget[], now: number): Map<string, BotName> {
  const result = new Map<string, BotName>();
  for (const target of targets) {
    result.set(target.dir, cachedName(readBotInfo(target.dir), target.appId, now));
  }
  return result;
}

async function fetchOneName(
  target: BotInfoTarget,
  cached: BotInfo | undefined,
  opts: ResolveBotNamesOptions,
): Promise<BotName> {
  const info = await fetchBotInfo(target, opts);
  if (info) {
    writeBotInfo(target.dir, info);
    return { appName: info.appName, source: 'fresh' };
  }
  return cached && cached.appId === target.appId
    ? { appName: cached.appName, source: 'stale' }
    : { source: 'none' };
}

/**
 * 为每个目录解析应用名：缓存命中直接用；未命中/过期并行补取（受并发上限约束）。
 * 返回 key = 目录绝对路径。
 */
interface CacheScan {
  result: Map<string, BotName>;
  pending: BotInfoTarget[];
  cacheByDir: Map<string, BotInfo | undefined>;
}

function scanCache(targets: BotInfoTarget[], now: number): CacheScan {
  const result = new Map<string, BotName>();
  const pending: BotInfoTarget[] = [];
  const cacheByDir = new Map<string, BotInfo | undefined>();
  for (const target of targets) {
    const cache = readBotInfo(target.dir);
    cacheByDir.set(target.dir, cache);
    if (cache && isBotInfoFresh(cache, target.appId, now)) {
      result.set(target.dir, { appName: cache.appName, source: 'cache' });
    } else {
      pending.push(target);
    }
  }
  return { result, pending, cacheByDir };
}

export async function resolveBotNames(
  targets: BotInfoTarget[],
  opts: ResolveBotNamesOptions = {},
): Promise<Map<string, BotName>> {
  const now = opts.now ?? Date.now();
  if (opts.remote === false) return cacheOnlyResults(targets, now);

  const { result, pending, cacheByDir } = scanCache(targets, now);
  if (pending.length === 0) return result;

  opts.onStart?.(pending.length);
  const concurrency = opts.concurrency ?? BOT_INFO_CONCURRENCY;
  for (const batch of chunk(pending, concurrency)) {
    await Promise.all(
      batch.map(async (target) => {
        result.set(target.dir, await fetchOneName(target, cacheByDir.get(target.dir), opts));
      }),
    );
  }
  return result;
}
