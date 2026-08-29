import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

vi.mock('@larksuite/channel', () => ({ registerApp: vi.fn() }));
vi.mock('qrcode-terminal', () => ({ default: { generate: vi.fn() } }));

import { registerApp } from '@larksuite/channel';
import { ensureConfig } from './wizard.js';

const mockedRegisterApp = vi.mocked(registerApp);

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

let tmpDir: string;
const originalTTY = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-test-'));
  vi.clearAllMocks();
  setTTY(false);
});

afterEach(() => {
  setTTY(Boolean(originalTTY.stdin));
  Object.defineProperty(process.stdout, 'isTTY', {
    value: Boolean(originalTTY.stdout),
    configurable: true,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ensureConfig', () => {
  it('no-ops when feishu credentials already exist', async () => {
    const cfg = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(cfg, 'feishu:\n  appId: "app_x"\n  appSecret: "secret_y"\n', 'utf-8');

    await ensureConfig(cfg);

    expect(mockedRegisterApp).not.toHaveBeenCalled();
    expect(fs.readFileSync(cfg, 'utf-8')).toContain('appId: "app_x"');
  });

  it('no-ops in a non-interactive terminal with missing credentials', async () => {
    const cfg = path.join(tmpDir, 'config.yaml');
    setTTY(false);

    await ensureConfig(cfg);

    expect(mockedRegisterApp).not.toHaveBeenCalled();
    expect(fs.existsSync(cfg)).toBe(false);
  });

  it('treats unreadable YAML as missing credentials and no-ops non-interactively', async () => {
    const cfg = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(cfg, '::: not valid yaml :::\n', 'utf-8');
    setTTY(false);

    await ensureConfig(cfg);

    expect(mockedRegisterApp).not.toHaveBeenCalled();
  });

  it('treats feishu section without appSecret as missing credentials', async () => {
    const cfg = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(cfg, 'feishu:\n  appId: "app_x"\n', 'utf-8');
    setTTY(false);

    await ensureConfig(cfg);

    expect(mockedRegisterApp).not.toHaveBeenCalled();
  });

  it('runs the wizard in an interactive terminal and writes credentials back', async () => {
    const cfg = path.join(tmpDir, 'nested', 'deep', 'config.yaml');
    setTTY(true);
    mockedRegisterApp.mockImplementation(async ({ onQRCodeReady, onStatusChange }) => {
      onQRCodeReady?.({ url: 'https://example.com/qr', expireIn: 300 });
      onStatusChange?.({ status: 'domain_switched' });
      onStatusChange?.({ status: 'slow_down' });
      return {
        client_id: 'cli_wizard',
        client_secret: 'secret_wizard',
        user_info: { tenant_brand: 'Acme' },
      };
    });

    await ensureConfig(cfg);

    expect(mockedRegisterApp).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'lark-remote' }),
    );
    const written = YAML.parse(fs.readFileSync(cfg, 'utf-8'));
    expect(written.feishu.appId).toBe('cli_wizard');
    expect(written.feishu.appSecret).toBe('secret_wizard');
  });

  it('writes credentials when the tenant brand is absent', async () => {
    const cfg = path.join(tmpDir, 'config.yaml');
    setTTY(true);
    mockedRegisterApp.mockResolvedValue({
      client_id: 'cli_plain',
      client_secret: 'secret_plain',
    });

    await ensureConfig(cfg);

    const written = YAML.parse(fs.readFileSync(cfg, 'utf-8'));
    expect(written.feishu.appId).toBe('cli_plain');
    expect(written.feishu.appSecret).toBe('secret_plain');
  });
});
