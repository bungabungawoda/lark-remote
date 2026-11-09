/**
 * 模型事实源：解析上游 400 的账号可用清单、挑模型、落盘与回读。
 *
 * 用临时目录隔离状态文件，不读写真实配置目录；会话 jsonl 用脱敏 fixture。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configureCodebuddyModelState,
  loadCodebuddyModelState,
  parseRejectedModel,
  parseSupportedModels,
  pickCodebuddyModel,
  readCodebuddyAccountModel,
  readCodebuddyModelError,
  recordCodebuddyModelRejection,
  recordCodebuddyModelSuccess,
  resetCodebuddyModelState,
  resolveCodebuddyModel,
} from './codebuddy-model-state.js';

let tmpDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-model-state-'));
  statePath = path.join(tmpDir, 'codebuddy-model-state.json');
  configureCodebuddyModelState(statePath);
});

afterEach(() => {
  resetCodebuddyModelState();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseSupportedModels', () => {
  const errorText = [
    '400 model [deepseek-v4.1-flash-sg] service info not found (req-1/sess-1)',
    'Currently supported models for your account:',
    '  - hy4free',
    '  - hy3',
    '  - deepseek-v4.1-flash',
    '',
    'Please use --model <model_id> to specify a valid model.',
  ].join('\n');

  it('从 400 错误文本抽出账号可用清单', () => {
    expect(parseSupportedModels(errorText)).toEqual(['hy4free', 'hy3', 'deepseek-v4.1-flash']);
  });

  it('没有清单段落时返回空数组', () => {
    expect(parseSupportedModels('401 Unauthorized')).toEqual([]);
    expect(parseSupportedModels(undefined)).toEqual([]);
  });

  it('同一段文本里有多份清单时取最后一份', () => {
    const text = [
      'Currently supported models for your account:',
      '  - old-a',
      '  - old-b',
      '',
      'Currently supported models for your account:',
      '  - new-a',
      '',
    ].join('\n');
    expect(parseSupportedModels(text)).toEqual(['new-a']);
  });

  it('过滤明显不是模型 id 的条目', () => {
    const text = ['Currently supported models for your account:', '  - ok-1', '  - 带 空格'].join(
      '\n',
    );
    expect(parseSupportedModels(text)).toEqual(['ok-1']);
  });
});

describe('parseRejectedModel', () => {
  it('取出被拒的模型 id', () => {
    expect(parseRejectedModel('400 model [deepseek-v4.1-flash-sg] service info not found')).toBe(
      'deepseek-v4.1-flash-sg',
    );
  });

  it('非模型类错误返回 undefined', () => {
    expect(parseRejectedModel('401 Unauthorized')).toBeUndefined();
    expect(parseRejectedModel(undefined)).toBeUndefined();
  });
});

describe('pickCodebuddyModel', () => {
  it('清单未知时原样保留配置值（不猜）', () => {
    expect(pickCodebuddyModel({ configured: 'sg-model', supported: [] })).toBe('sg-model');
  });

  it('配置值在清单里就用配置值', () => {
    expect(pickCodebuddyModel({ configured: 'hy3', supported: ['hy3', 'other'] })).toBe('hy3');
  });

  it('配置值不在清单里：优先上次成功值', () => {
    expect(
      pickCodebuddyModel({
        configured: 'sg-model',
        supported: ['hy3', 'deepseek-v4.1-flash'],
        lastSuccess: 'hy3',
        accountModel: 'deepseek-v4.1-flash',
      }),
    ).toBe('hy3');
  });

  it('上次成功值也不可用：回落到账号当前模型', () => {
    expect(
      pickCodebuddyModel({
        configured: 'sg-model',
        supported: ['hy3', 'deepseek-v4.1-flash'],
        lastSuccess: 'gone',
        accountModel: 'deepseek-v4.1-flash',
      }),
    ).toBe('deepseek-v4.1-flash');
  });

  it('账号模型也不可用：按偏好顺序挑', () => {
    expect(
      pickCodebuddyModel({
        configured: 'sg-model',
        supported: ['hy3', 'deepseek-v4-pro', 'deepseek-v4.1-flash'],
      }),
    ).toBe('deepseek-v4.1-flash');
  });

  it('只剩别名 id 时才选别名', () => {
    expect(pickCodebuddyModel({ configured: 'sg-model', supported: ['default-model'] })).toBe(
      'default-model',
    );
  });

  it('未配置模型时也从清单里挑一个能用的', () => {
    expect(pickCodebuddyModel({ supported: ['hy3', 'glm-5.3'] })).toBe('hy3');
  });
});

describe('状态落盘与回读', () => {
  it('记录拒绝后写入清单，重新加载仍可读', () => {
    recordCodebuddyModelRejection({
      model: 'deepseek-v4.1-flash-sg',
      supported: ['hy3', 'deepseek-v4.1-flash'],
    });

    const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { supported: string[] };
    expect(raw.supported).toEqual(['hy3', 'deepseek-v4.1-flash']);

    // 模拟进程重启：清缓存后按同一路径重新加载。
    resetCodebuddyModelState();
    configureCodebuddyModelState(statePath);
    expect(loadCodebuddyModelState().supported).toEqual(['hy3', 'deepseek-v4.1-flash']);
  });

  it('清单为空时不动状态（不完整信息不覆盖已知清单）', () => {
    recordCodebuddyModelRejection({ model: 'x', supported: ['hy3'] });
    recordCodebuddyModelRejection({ model: 'x', supported: [] });
    expect(loadCodebuddyModelState().supported).toEqual(['hy3']);
  });

  it('上次成功值不在新清单里时被清掉', () => {
    recordCodebuddyModelRejection({ model: 'a', supported: ['hy3', 'glm-5.3'] });
    recordCodebuddyModelSuccess('hy3');
    expect(loadCodebuddyModelState().lastSuccess).toBe('hy3');

    recordCodebuddyModelRejection({ model: 'hy3', supported: ['glm-5.3'] });
    expect(loadCodebuddyModelState().lastSuccess).toBeUndefined();
  });

  it('状态文件损坏时按空状态处理，不抛错', () => {
    fs.writeFileSync(statePath, '{not json');
    resetCodebuddyModelState();
    configureCodebuddyModelState(statePath);
    expect(loadCodebuddyModelState().supported).toEqual([]);
  });
});

describe('readCodebuddyModelError', () => {
  function writeSession(rows: unknown[]): string {
    const file = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    return file;
  }

  it('从会话 jsonl 的 assistant 错误行解析被拒模型与清单', () => {
    const file = writeSession([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] },
      {
        type: 'message',
        role: 'assistant',
        status: 'incomplete',
        content: [
          {
            type: 'output_text',
            text: [
              '400 model [deepseek-v4.1-flash-sg] service info not found (req-1/sess-1)',
              'Currently supported models for your account:',
              '  - hy3',
              '  - deepseek-v4.1-flash',
            ].join('\n'),
          },
        ],
      },
    ]);
    expect(readCodebuddyModelError(file)).toEqual({
      model: 'deepseek-v4.1-flash-sg',
      supported: ['hy3', 'deepseek-v4.1-flash'],
    });
  });

  it('普通会话没有模型错误时返回 null', () => {
    const file = writeSession([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] },
    ]);
    expect(readCodebuddyModelError(file)).toBeNull();
  });

  it('文件不存在时返回 null', () => {
    expect(readCodebuddyModelError(path.join(tmpDir, 'missing.jsonl'))).toBeNull();
  });
});

describe('readCodebuddyAccountModel', () => {
  it('读取 settings.json 的 model 字段', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({ model: 'deepseek-v4.1-flash' }),
    );
    expect(readCodebuddyAccountModel(tmpDir)).toBe('deepseek-v4.1-flash');
  });

  it('缺失/损坏时返回 undefined', () => {
    expect(readCodebuddyAccountModel(tmpDir)).toBeUndefined();
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), 'broken');
    expect(readCodebuddyAccountModel(tmpDir)).toBeUndefined();
  });
});

describe('resolveCodebuddyModel', () => {
  it('没有学到清单时保持配置值', () => {
    expect(resolveCodebuddyModel('deepseek-v4.1-flash-sg')).toBe('deepseek-v4.1-flash-sg');
  });

  it('学到清单后把账号无权的配置值换掉', () => {
    recordCodebuddyModelRejection({
      model: 'deepseek-v4.1-flash-sg',
      supported: ['hy3', 'deepseek-v4.1-flash'],
    });
    // 具体挑中哪个由 pickCodebuddyModel 的优先级决定（上面已单测），这里只
    // 钉住「不再返回账号无权的 id」——避免依赖本机 settings.json 的模型。
    expect(['hy3', 'deepseek-v4.1-flash']).toContain(
      resolveCodebuddyModel('deepseek-v4.1-flash-sg'),
    );
    expect(resolveCodebuddyModel('hy3')).toBe('hy3');
  });
});
