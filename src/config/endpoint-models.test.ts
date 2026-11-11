import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockLogger } from '../../tests/lib/logger-mock.js';

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

import {
  fetchEndpointModels,
  cachedEndpointModels,
  warmEndpointModels,
  _invalidateEndpointModelsCacheForTest,
  type EndpointModelsTarget,
} from './endpoint-models.js';

/**
 * 端点模型清单探测的夹具回放测试。
 *
 * 全部经 stub 的 fetch 回放真实方言（OpenAI / Anthropic / Gemini `models[]`
 * 与分页），不联网、不 spawn 任何 CLI。
 */

interface Route {
  status: number;
  body?: unknown;
  /** 直接让 fetch 抛错（网络错误 / abort） */
  throws?: Error;
}

type Router = (url: URL, init: RequestInit) => Route | undefined;

/** stub 全局 fetch，记录每次请求，按 router 回放。 */
function stubFetch(router: Router): { urls: URL[]; inits: RequestInit[] } {
  const urls: URL[] = [];
  const inits: RequestInit[] = [];
  vi.stubGlobal('fetch', (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    urls.push(url);
    inits.push(init);
    const route = router(url, init);
    if (!route) return Promise.resolve(new Response('not found', { status: 404 }));
    if (route.throws) return Promise.reject(route.throws);
    return Promise.resolve(
      new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
        status: route.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { urls, inits };
}

/** 按 pathname 回放：未列出的路径一律 404。 */
function byPathname(table: Record<string, Route | unknown>): Router {
  return (url) => {
    const hit = table[url.pathname];
    if (hit === undefined) return undefined;
    if (typeof hit === 'object' && hit !== null && 'status' in hit) return hit as Route;
    return { status: 200, body: hit };
  };
}

const openAiList = (...ids: string[]) => ({ data: ids.map((id) => ({ id, object: 'model' })) });

let tmp: EndpointModelsTarget;

beforeEach(() => {
  _invalidateEndpointModelsCacheForTest();
  mockLogger.warn.mockReset();
  tmp = { baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test' };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('候选 URL', () => {
  it('Anthropic base 剥掉 /anthropic 后问 root，命中 /v1/models', async () => {
    // 真机回归：Claude Code 配的 base 是 https://api.deepseek.com/anthropic，
    // 该路径下没有模型清单，root 的 /v1/models 才有。
    const { urls } = stubFetch(
      byPathname({
        '/v1/models': openAiList('deepseek-flash', 'deepseek-v4-pro'),
      }),
    );

    const ids = await fetchEndpointModels({
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-test',
      anthropic: true,
    });

    expect(ids).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(urls.map((u) => u.pathname)).toEqual([
      '/anthropic/models',
      '/anthropic/v1/models',
      '/v1/models',
    ]);
  });

  it('带版本段的 base 只按原样问 base/models', async () => {
    const { urls } = stubFetch(byPathname({ '/api/v3/models': openAiList('glm-5.2', 'kimi-k3') }));

    const ids = await fetchEndpointModels({
      baseUrl: 'https://ark.example.com/api/v3',
      apiKey: 'sk-test',
    });

    expect(ids).toEqual(['glm-5.2', 'kimi-k3']);
    expect(urls.map((u) => u.pathname)).toEqual(['/api/v3/models']);
  });

  it('裸 host 会补 /v1 与 /models 两种写法', async () => {
    const { urls } = stubFetch(byPathname({ '/v1/models': openAiList('m1') }));

    await fetchEndpointModels({ baseUrl: 'https://bare.example.com' });

    expect(urls.map((u) => u.pathname)).toEqual(['/models', '/v1/models']);
  });

  it('base 末尾斜杠归一化', async () => {
    const { urls } = stubFetch(byPathname({ '/v1/models': openAiList('m1') }));

    await fetchEndpointModels({ baseUrl: 'https://relay.example.com/v1/', apiKey: 'k' });

    expect(urls.map((u) => u.pathname)).toEqual(['/v1/models']);
  });
});

describe('返回方言', () => {
  it('Gemini 的 models[] 里 name 去掉 models/ 前缀', async () => {
    stubFetch(
      byPathname({
        '/v1beta/models': {
          models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-2.5-flash' }],
        },
      }),
    );

    const ids = await fetchEndpointModels({
      baseUrl: 'https://gem.example.com/v1beta',
      apiKey: 'k',
    });

    expect(ids).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
  });

  it('行内 id 与 name 都缺时跳过，不产生空选项', async () => {
    stubFetch(
      byPathname({
        '/v1/models': { data: [{ id: 'ok' }, {}, { id: '' }, { name: 'by-name' }] },
      }),
    );

    expect(await fetchEndpointModels(tmp)).toEqual(['ok', 'by-name']);
  });

  it('重复 id 去重且保持服务端顺序', async () => {
    stubFetch(byPathname({ '/v1/models': openAiList('b', 'a', 'b') }));

    expect(await fetchEndpointModels(tmp)).toEqual(['b', 'a']);
  });
});

describe('认证', () => {
  it('同时发 Bearer 与 x-api-key；被 401 后改单发 Bearer，命中即停', async () => {
    const seen: string[][] = [];
    stubFetch((_url, init) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      seen.push(Object.keys(headers).sort());
      // 两套认证一起发被拒；只带 Bearer 才认
      const both = 'Authorization' in headers && 'x-api-key' in headers;
      if (both) return { status: 401 };
      if ('Authorization' in headers) return { status: 200, body: openAiList('m-bearer') };
      return { status: 401 };
    });

    const ids = await fetchEndpointModels({
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-test',
    });

    expect(ids).toEqual(['m-bearer']);
    expect(seen.length).toBe(2);
  });

  it('Bearer 也被拒时再试 x-api-key 单发', async () => {
    const seen: string[][] = [];
    stubFetch((_url, init) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      seen.push(Object.keys(headers).sort());
      if ('x-api-key' in headers && 'Authorization' in headers) return { status: 401 };
      if ('x-api-key' in headers) return { status: 200, body: openAiList('m-xk') };
      return { status: 403 };
    });

    const ids = await fetchEndpointModels({
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-test',
    });

    expect(ids).toEqual(['m-xk']);
    expect(seen.length).toBe(3);
  });

  it('404 不换认证再试（同一 URL 只问一次）', async () => {
    const { urls } = stubFetch(() => ({ status: 404 }));

    await fetchEndpointModels({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test' });

    expect(urls.length).toBe(1);
  });

  it('Anthropic base 带 anthropic-version 头', async () => {
    const { inits } = stubFetch(byPathname({ '/models': openAiList('m1') }));

    await fetchEndpointModels({ ...tmp, anthropic: true });

    const headers = inits[0].headers as Record<string, string>;
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('没有 key 时不带认证头也能读公开清单', async () => {
    const { inits } = stubFetch(byPathname({ '/v1/models': openAiList('m1') }));

    await fetchEndpointModels({ baseUrl: 'https://relay.example.com/v1' });

    const headers = inits[0].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['x-api-key']).toBeUndefined();
  });
});

describe('分页', () => {
  it('has_more 时带 after_id 跟到最后一页', async () => {
    stubFetch((url) => {
      if (url.pathname !== '/v1/models') return { status: 404 };
      if (!url.searchParams.has('after_id')) {
        return {
          status: 200,
          body: { data: [{ id: 'a' }], has_more: true, last_id: 'a' },
        };
      }
      return { status: 200, body: { data: [{ id: 'b' }], has_more: false } };
    });

    expect(await fetchEndpointModels(tmp)).toEqual(['a', 'b']);
  });

  it('has_more 却不给 last_id → 视为读不全，返回 null', async () => {
    // 半份清单不是清单：当成「没有清单」比当成「只有这些」安全。
    stubFetch(() => ({ status: 200, body: { data: [{ id: 'a' }], has_more: true } }));

    expect(await fetchEndpointModels(tmp)).toBeNull();
  });

  it('翻页时以 limit=1000 请求', async () => {
    const { urls } = stubFetch((url) => {
      if (!url.searchParams.has('after_id')) {
        return { status: 200, body: { data: [{ id: 'a' }], has_more: true, last_id: 'a' } };
      }
      return { status: 200, body: { data: [{ id: 'b' }] } };
    });

    await fetchEndpointModels(tmp);

    expect(urls[1].searchParams.get('limit')).toBe('1000');
    expect(urls[1].searchParams.get('after_id')).toBe('a');
  });
});

describe('失败路径', () => {
  it('全部候选都 404 → null，不抛', async () => {
    stubFetch(() => ({ status: 404 }));
    expect(await fetchEndpointModels(tmp)).toBeNull();
  });

  it('200 但不是 JSON → 换下一个候选；全不成 → null', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('<html>oops</html>', { status: 200 })),
    );
    expect(await fetchEndpointModels(tmp)).toBeNull();
  });

  it('空清单 → null（不是空数组）', async () => {
    stubFetch(byPathname({ '/v1/models': { data: [] } }));
    expect(await fetchEndpointModels(tmp)).toBeNull();
  });

  it('网络错误 / abort → null', async () => {
    stubFetch(() => ({
      status: 0,
      throws: Object.assign(new Error('aborted'), { name: 'AbortError' }),
    }));
    expect(await fetchEndpointModels(tmp)).toBeNull();
  });

  it('每个请求都带 8s 超时信号', async () => {
    const { inits } = stubFetch(byPathname({ '/v1/models': openAiList('m1') }));

    await fetchEndpointModels(tmp);

    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('缓存', () => {
  it('命中后不再请求；清缓存后重新请求', async () => {
    const { urls } = stubFetch(byPathname({ '/v1/models': openAiList('m1') }));

    await fetchEndpointModels(tmp);
    expect(cachedEndpointModels(tmp)).toEqual(['m1']);
    expect(urls.length).toBe(1);

    _invalidateEndpointModelsCacheForTest();
    expect(cachedEndpointModels(tmp)).toBeUndefined();
  });

  it('未命中时 cachedEndpointModels 触发后台探测', async () => {
    stubFetch(byPathname({ '/v1/models': openAiList('m1') }));

    expect(cachedEndpointModels(tmp)).toBeUndefined();
    await vi.waitFor(() => expect(cachedEndpointModels(tmp)).toEqual(['m1']));
  });

  it('失败进负缓存：冷却期内不重复请求', async () => {
    const { urls } = stubFetch(() => ({ status: 500 }));

    await fetchEndpointModels(tmp);
    warmEndpointModels(tmp);
    await new Promise((r) => setImmediate(r));

    expect(urls.length).toBe(1);
  });

  it('并发探测只发一轮请求', async () => {
    const { urls } = stubFetch(byPathname({ '/v1/models': openAiList('m1') }));

    const [a, b] = await Promise.all([fetchEndpointModels(tmp), fetchEndpointModels(tmp)]);

    expect(a).toEqual(b);
    expect(urls.length).toBe(1);
  });

  it('不同的 key 分开缓存（同 base 换 key 会重探）', async () => {
    const { urls } = stubFetch(byPathname({ '/v1/models': openAiList('m1') }));

    await fetchEndpointModels(tmp);
    await fetchEndpointModels({ ...tmp, apiKey: 'sk-other' });

    expect(urls.length).toBe(2);
  });

  it('没有 baseUrl 时不进入缓存也不请求', async () => {
    const { urls } = stubFetch(byPathname({}));

    expect(cachedEndpointModels({ baseUrl: '  ' })).toBeUndefined();
    expect(await fetchEndpointModels({ baseUrl: '' })).toBeNull();
    expect(urls.length).toBe(0);
  });
});
