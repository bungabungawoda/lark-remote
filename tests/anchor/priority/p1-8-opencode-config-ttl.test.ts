import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadOpencodeConfig,
  invalidateOpencodeConfigCache,
} from '../../../src/config/opencode-config.js';

// 直接在模块顶层定义 mock（兼容 bun 的 vitest，与既有 opencode 测试同模式）
const mockExecSync = vi.fn();

vi.mock('node:child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  initLogger: () => ({}),
}));

const FAKE_OUTPUT = `opencode/big-pickle
{
  "id": "big-pickle"
}
deepseek/deepseek-chat
{
  "id": "deepseek-chat"
}
`;

beforeEach(() => {
  invalidateOpencodeConfigCache();
  mockExecSync.mockReset();
});

describe('P1-8 opencode execSync 必须带 TTL 缓存 (anchor)', () => {
  /**
   * 验证什么（target）:
   *   defaultAgent=opencode 时每一次 config.toggle/set/input/save 都走
   *   buildConfigCard → loadOpencodeConfig → 同步 execSync（无缓存），事件循环
   *   阻塞至命令返回（上限 30s），飞书 keepalive 都可能误判断连。修复后：
   *   TTL 内第二次调用必须命中缓存，execSync 只执行一次。
   *
   * 缺失导致什么（importance）:
   *   一次点击两次 execSync（handleFieldChange 内部又调一次）＝最多 60s 事件循环
   *   冻结；阻塞期间 bridge 无法处理消息/看门狗/流式渲染（review.md §P1-8）。
   *
   * 依据: review.md §P1-8 失败用例。
   */
  it('anchor: TTL 内命中缓存不重复 execSync', () => {
    mockExecSync.mockReturnValue(FAKE_OUTPUT);
    loadOpencodeConfig();
    loadOpencodeConfig();
    expect(mockExecSync).toHaveBeenCalledTimes(1); // 现状：2 次 → RED
  });

  /**
   * 验证什么（target）:
   *   命令失败后 30s 负缓存：连续渲染不重复 execSync，直接走 fallback。
   */
  it('anchor: 失败负缓存内不重复 execSync', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('opencode not found');
    });
    const first = loadOpencodeConfig();
    const second = loadOpencodeConfig();
    expect(first.providerNames.length).toBeGreaterThan(0); // fallback 生效
    expect(second.providerNames).toEqual(first.providerNames);
    expect(mockExecSync).toHaveBeenCalledTimes(1); // 现状：2 次 → RED
  });

  /**
   * 回归锁定：TTL 过期后必须重新 execSync（模型列表热更新），防止缓存永不过期。
   */
  it('probe: TTL 过期后重新 execSync', () => {
    vi.useFakeTimers();
    try {
      mockExecSync.mockReturnValue(FAKE_OUTPUT);
      loadOpencodeConfig();
      loadOpencodeConfig(); // 命中缓存
      vi.advanceTimersByTime(61_000);
      loadOpencodeConfig();
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
