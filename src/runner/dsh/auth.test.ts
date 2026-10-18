import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DSH_BROWSER_CREDENTIAL_KEY,
  dshCookieName,
  isDshCredentialsNotFound,
  mintDshBrowserCookie,
  readDshBrowserSecret,
  readDshBrowserSecretSync,
  resolveDshCredentialsFile,
} from './auth.js';

const SECRET = Buffer.alloc(32, 7);
const BASE_URL = 'http://127.0.0.1:3080';
const NOW = 1_700_000_000_000;
const LIFETIME_MS = 60 * 60 * 1000;
const tempDirs: string[] = [];

function fixtureFile(secret = SECRET, mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-dsh-auth-'));
  tempDirs.push(dir);
  const file = path.join(dir, '.credentials.yaml');
  fs.writeFileSync(
    file,
    YAML.stringify({
      version: 1,
      records: {
        [DSH_BROWSER_CREDENTIAL_KEY]: {
          kind: 'grant',
          payload: { version: 1, secret: secret.toString('base64url') },
        },
      },
    }),
    { mode },
  );
  if (process.platform !== 'win32') fs.chmodSync(file, mode);
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('DSH browser auth', () => {
  it('resolves the default credentials file from DSH_HOME or the user home', () => {
    expect(resolveDshCredentialsFile({ DSH_HOME: '/tmp/dsh-home' })).toBe(
      '/tmp/dsh-home/.credentials.yaml',
    );
    expect(resolveDshCredentialsFile({ DSH_HOME: '/tmp/dsh-home' }, '/tmp/configured')).toBe(
      '/tmp/configured/.credentials.yaml',
    );
    expect(resolveDshCredentialsFile({})).toBe(
      path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    );
  });

  it('reads the durable browser-session secret synchronously and asynchronously', async () => {
    const file = fixtureFile();
    expect(readDshBrowserSecretSync(file)).toEqual(SECRET);
    expect(await readDshBrowserSecret(file)).toEqual(SECRET);
  });

  it('does not expose the secret when the credentials file is malformed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-dsh-auth-'));
    tempDirs.push(dir);
    const file = path.join(dir, '.credentials.yaml');
    fs.writeFileSync(file, 'version: 1\nrecords: [secret-value]\n', { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    expect(() => readDshBrowserSecretSync(file)).toThrow(/unsupported format/);
    expect(() => readDshBrowserSecretSync(file)).not.toThrow(/secret-value/);
  });

  it('rejects a credentials file readable beyond its owner on POSIX', () => {
    if (process.platform === 'win32') return;
    const file = fixtureFile(SECRET, 0o644);
    expect(() => readDshBrowserSecretSync(file)).toThrow(/readable beyond its owner/);
  });

  it('reports a missing credentials file without fabricating a secret', () => {
    const file = path.join(os.tmpdir(), 'lark-remote-missing-credentials.yaml');
    try {
      readDshBrowserSecretSync(file);
      throw new Error('expected read to fail');
    } catch (error) {
      expect(isDshCredentialsNotFound(error)).toBe(true);
    }
  });

  it('mints a deterministic v1 cookie bound to the host authority', () => {
    const cookie = mintDshBrowserCookie(BASE_URL, SECRET, NOW, LIFETIME_MS);
    const [name, value] = cookie.split('=');
    expect(name).toBe(dshCookieName('127.0.0.1:3080'));
    const [version, body, signature] = value!.split('.');
    expect(version).toBe('v1');
    expect(signature).toBe(createHmac('sha256', SECRET).update(body!).digest('base64url'));
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf-8')) as {
      version: number;
      authority: string;
      issuedAt: number;
      expiresAt: number;
    };
    expect(payload).toEqual({
      version: 1,
      authority: '127.0.0.1:3080',
      issuedAt: NOW,
      expiresAt: NOW + LIFETIME_MS,
    });
    expect(mintDshBrowserCookie('http://127.0.0.1:3081', SECRET, NOW, LIFETIME_MS)).not.toBe(
      cookie,
    );
  });
});
