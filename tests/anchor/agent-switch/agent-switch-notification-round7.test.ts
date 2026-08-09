import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from '../../../src/session/index.js';

/**
 * Round 7 anchors: spec Round 5 设计（arrival 基线 + 停车语义 + 持久化迁移）的
 * 新建用户分支持久化边界。
 *
 * 攻击点（T2/T4）：
 * - setPreviousSessionId 新建用户分支：cwd 未设时 entry.cwd === ''，
 *   autoPersist 与 load 都按 `if (entry.cwd)` 跳过该用户 → 停车位写进
 *   last-session.json 的条目整个丢失，违背「previousSessions 由进程内存升级
 *   为持久化（停车跨重启存活）」。
 * - setArrivalSessionId 新建用户分支：同样 cwd === ''，arrival 基线落盘后
 *   重建丢失，违背「arrivalSessions 持久化迁移」。
 *
 * 注：既有 anchor（round6、session.test.ts）全部先 setCwd 再写
 * previous/arrival，未覆盖这两个新建分支。
 */

describe('Round7 anchors: new-user-branch persistence of parked previous/arrival', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-switch-round7-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('anchor_r7_parked_previous_survives_rebuild_without_cwd', () => {
    // T2/T4：setPreviousSessionId 对全新用户（未 /cd，cwd 未设）也必须满足
    // 「停车跨重启存活」。new-user 分支 cwd 为 ''，但持久化迁移承诺的是
    // previousSessions 本身落盘，不依赖 cwd 先被设置。
    const filePath = path.join(tmpDir, 'last-session.json');
    const store1 = new SessionStore(filePath);
    store1.setPreviousSessionId('user1', 'codex', 'codex-session-P');

    expect(store1.getPreviousSessionId('user1', 'codex')).toBe('codex-session-P');

    // 重建（模拟重启）：停车位必须还在
    const store2 = new SessionStore(filePath);
    expect(store2.getPreviousSessionId('user1', 'codex')).toBe('codex-session-P');
  });

  it('anchor_r7_arrival_baseline_survives_rebuild_without_cwd', () => {
    // T4：setArrivalSessionId 对全新用户（cwd 未设）也必须满足 arrival 持久化
    // 迁移——arrival 基线（恢复判定依据）不能因 cwd 为空被整条丢弃。
    const filePath = path.join(tmpDir, 'last-session.json');
    const store1 = new SessionStore(filePath);
    store1.setArrivalSessionId('user1', 'codex', 'codex-session-A');

    expect(store1.getArrivalSessionId('user1', 'codex')).toBe('codex-session-A');

    // 重建（模拟重启）：arrival 基线必须还在
    const store2 = new SessionStore(filePath);
    expect(store2.getArrivalSessionId('user1', 'codex')).toBe('codex-session-A');
  });

  it('anchor_r7_explicit_empty_cwd_still_persists_arrival', () => {
    // T4 显式空串变体：setCwd(user, '') 后写入 arrival，重建后同样不得丢。
    // autoPersist/load 的 `entry.cwd` 守卫把空串用户整个跳过，属于同一根因。
    const filePath = path.join(tmpDir, 'last-session.json');
    const store1 = new SessionStore(filePath);
    store1.setCwd('user1', '');
    store1.setArrivalSessionId('user1', 'codex', 'codex-session-A');

    const store2 = new SessionStore(filePath);
    expect(store2.getArrivalSessionId('user1', 'codex')).toBe('codex-session-A');
  });
});
