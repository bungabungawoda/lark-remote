/**
 * `/restart` 边界探针。
 * spec: restart 自重启方案
 *
 * 探针是 spec 未完全锁定的假设；fail 时由 orchestrator 裁决升级/保留/丢弃。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnReplacementBridge } from '../../src/restart.js';

describe('/restart 边界探针', () => {
  it('test_probe_spawn_replacement_propagates_fs_errors', () => {
    // 假设：logsDir 不可写（mkdir/open 失败）时 spawnReplacementBridge 抛错，
    //   由 cmdRestart 的 catch 转为「重启失败…」文案——异常必须可传播到上层，
    //   不得被吞掉变成"spawn 成功"假象。
    // spec 依据：方案 §5.5 异常路径验收「logsDir 指向只读路径 → 重启失败，
    //   旧进程仍存活」。
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-readonly-'));
    const logsDir = path.join(parent, 'nested', 'logs');
    fs.chmodSync(parent, 0o555);
    try {
      expect(() => spawnReplacementBridge(logsDir)).toThrow();
    } finally {
      fs.chmodSync(parent, 0o755);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
