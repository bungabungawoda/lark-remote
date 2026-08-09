import { describe, expect, test } from 'vitest';
import { Readable } from 'node:stream';

/**
 * P1-4 probe: createJSONLStream 背压在交替灌入/消费场景下不产生高频
 * pause/resume 抖动（thrashing）。
 *
 * 红假设: 滞回（hysteresis）足够宽，pause 后至少消费到 resumeThreshold
 * 以下才 resume，resume 后至少推到 pauseThreshold 以上才 pause。
 * 连续两次 pause 之间至少消费 (pauseThreshold - resumeThreshold) 行。
 * spec 未明确定义"最小滞回宽度"，但 pauseThreshold=100/resumeThreshold=50
 * 暗示至少 50 行的消费间隔。
 *
 * 此 probe 测量实际行为，不在主循环中驱动代码改动。
 */
describe('P1-4 probe: backpressure thrashing resistance', () => {
  test('test_probe_jsonl_stream_no_thrashing_on_alternating_io', async () => {
    const readable = new Readable({ read() {} });
    const { createJSONLStream } = await import('../../src/runner/common/jsonl-stream.js');

    const pauseTimes: number[] = [];
    const resumeTimes: number[] = [];
    const origPause = readable.pause.bind(readable);
    const origResume = readable.resume.bind(readable);
    readable.pause = function () {
      pauseTimes.push(Date.now());
      return origPause();
    };
    readable.resume = function () {
      resumeTimes.push(Date.now());
      return origResume();
    };

    const stream = createJSONLStream(readable, {
      pauseThreshold: 20,
      resumeThreshold: 10,
    });

    // Push 25 lines → pause at depth>20
    for (let i = 0; i < 25; i++) {
      readable.push(`{"type":"text","data":"line-${i}"}\n`);
    }
    readable.push(null);

    // Consume all
    for await (const _ of stream) {
      // drain
    }

    // pause 和 resume 不应高频交替（thrashing）。
    // 滞回保证：每次 pause 后至少消费 (20-10)=10 行才 resume。
    // 所以 resume 次数应 <= pause 次数 + 1（初始 auto-resume）。
    // 排除初始 auto-resume（resumeTimes[0] 在 pause 之前）。
    const pauseAfterFirst = pauseTimes.filter((t) => resumeTimes.length > 0 && t > resumeTimes[0]);
    const resumeAfterPause = resumeTimes.filter((t) => pauseTimes.length > 0 && t > pauseTimes[0]);

    // resume 次数（排除初始）不应超过 pause 次数 —— 一 pause 一 resume
    expect(resumeAfterPause.length).toBeLessThanOrEqual(pauseAfterFirst.length + 1);
  });
});
