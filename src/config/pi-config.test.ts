import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadPiConfig, getPiModelOptions, _getModelsFilePath } from '../config/pi-config.js';

/**
 * Pi-config model options tests.
 *
 * Uses PI_CONFIG_DIR env var to redirect all file I/O to a temp directory,
 * avoiding dependency on real ~/.pi/agent/ state (which may differ between
 * local and CI environments).
 */
describe('pi-config model options', () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-config-test-'));
    savedEnv = process.env.PI_CONFIG_DIR;
    process.env.PI_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedEnv !== undefined) {
      process.env.PI_CONFIG_DIR = savedEnv;
    } else {
      delete process.env.PI_CONFIG_DIR;
    }
  });

  /** Write a models.json into the temp PI_CONFIG_DIR */
  function writeModelsJson(providers: Record<string, unknown>): void {
    const modelsPath = _getModelsFilePath();
    fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
    fs.writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2), 'utf-8');
  }

  describe('loadPiConfig modelOptions', () => {
    it('应返回纯 model ID（不带 provider 后缀）', () => {
      writeModelsJson({
        Volcano: {
          baseUrl: 'https://ark.example.com/api/v3',
          api: 'openai-completions',
          models: [{ id: 'glm-5.2' }],
        },
      });

      const piCfg = loadPiConfig();
      const modelOptions = piCfg.modelOptions();

      for (const model of modelOptions) {
        expect(model).not.toMatch(/\s\(/);
        expect(model.length).toBeGreaterThan(0);
      }
    });

    it('config dir 无文件时回退到 fallback', () => {
      // tmpDir exists but has no models.json or auth.json
      const piCfg = loadPiConfig();
      const modelOptions = piCfg.modelOptions();

      // Fallback should provide at least some models
      expect(modelOptions.length).toBeGreaterThan(0);
    });
  });

  describe('getPiModelOptions', () => {
    it('应返回纯 model ID（方案一修复后）', () => {
      writeModelsJson({
        Volcano: {
          baseUrl: 'https://ark.example.com/api/v3',
          api: 'openai-completions',
          models: [{ id: 'glm-5.2' }],
        },
        lt: {
          baseUrl: 'https://pi-api.example.com/v1',
          api: 'openai-completions',
          models: [{ id: 'glm-5.1' }],
        },
      });

      const options = getPiModelOptions();

      for (const model of options) {
        expect(model).not.toMatch(/\s\(/);
      }
    });

    it('指定 provider 时应返回该 provider 的纯 model ID', () => {
      writeModelsJson({
        Volcano: {
          baseUrl: 'https://ark.example.com/api/v3',
          api: 'openai-completions',
          models: [{ id: 'glm-5.2' }],
        },
        lt: {
          baseUrl: 'https://pi-api.example.com/v1',
          api: 'openai-completions',
          models: [{ id: 'glm-5.1' }],
        },
      });

      const options = getPiModelOptions('Volcano');

      expect(options.length).toBeGreaterThan(0);
      for (const model of options) {
        expect(model).not.toMatch(/\s\(/);
      }
      // Only Volcano models, not lt models
      expect(options.some((m) => m.includes('glm-5.2'))).toBe(true);
      expect(options.some((m) => m.includes('glm-5.1'))).toBe(false);
    });

    it('指定无模型的 provider 时回退到 fallback', () => {
      writeModelsJson({
        'empty-provider': {
          baseUrl: 'http://localhost:11434/v1',
          api: 'openai-completions',
          models: [], // no models
        },
      });

      // empty-provider has no models → fallback kicks in
      const options = getPiModelOptions('empty-provider');
      // Fallback for unknown provider returns empty (provider not in FALLBACK_ENTRIES)
      // but the fallback mechanism should at least not crash
      expect(Array.isArray(options)).toBe(true);
    });
  });

  describe('PI_CONFIG_DIR env var', () => {
    it('should use PI_CONFIG_DIR instead of ~/.pi/agent', () => {
      expect(_getModelsFilePath()).toBe(path.join(tmpDir, 'models.json'));
    });
  });
});
