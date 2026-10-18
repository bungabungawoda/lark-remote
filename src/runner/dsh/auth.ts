/**
 * Persistent DSH browser authentication.
 *
 * `dsh web` rotates its process launch token on every restart. The signed
 * browser cookie is different: it is verified with the durable
 * `client-connection/browser-session` secret in `$DSH_HOME/.credentials.yaml`
 * and does not identify a process-local operator peer. DSH accepts that cookie
 * for both `/api/*` and `/api/remote.mux`, so minting a fresh v1 cookie from
 * the persisted secret survives a DSH restart without copying a new token.
 */

import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

/** Credential record that owns the browser-cookie signing secret. */
export const DSH_BROWSER_CREDENTIAL_KEY = 'client-connection/browser-session';

/** Short lifetime keeps every request safely inside DSH's configurable max age. */
export const DSH_COOKIE_LIFETIME_MS = 60 * 60 * 1000;

const SECRET_BYTES = 32;
const COOKIE_PREFIX = 'dsh-auth-';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve DSH's credentials file using the same `$DSH_HOME` convention.
 * A configured home (agents.dsh.dshHome) wins over the environment so the
 * file matches the `DSH_HOME` lark-remote passes to a process it starts.
 */
export function resolveDshCredentialsFile(
  env: NodeJS.ProcessEnv = process.env,
  configuredHome?: string,
): string {
  const home = configuredHome?.trim() || env.DSH_HOME?.trim();
  return path.join(
    home && home.length > 0 ? home : path.join(os.homedir(), '.dsh'),
    '.credentials.yaml',
  );
}

/** Whether a filesystem error means the credentials file is absent. */
export function isDshCredentialsNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function assertOwnerOnly(file: string, stats: fs.Stats): void {
  if (!stats.isFile()) {
    throw new Error(`DSH credentials file ${file} is not a regular file`);
  }
  // Windows has no POSIX mode bits; DSH itself skips the same check there.
  if (process.platform === 'win32') return;
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `DSH credentials file ${file} is readable beyond its owner ` +
        `(mode ${(stats.mode & 0o777).toString(8)}); run "chmod 600 ${file}"`,
    );
  }
}

function parseBrowserSecret(text: string, file: string): Buffer {
  let document: unknown;
  try {
    document = YAML.parse(text);
  } catch {
    // The parser's message quotes the offending source line, which is secret.
    throw new Error(`DSH credentials file ${file} is not valid YAML`);
  }
  if (!isRecord(document) || document.version !== 1 || !isRecord(document.records)) {
    throw new Error(`DSH credentials file ${file} has an unsupported format`);
  }
  const record = document.records[DSH_BROWSER_CREDENTIAL_KEY];
  if (
    !isRecord(record) ||
    record.kind !== 'grant' ||
    !isRecord(record.payload) ||
    record.payload.version !== 1 ||
    typeof record.payload.secret !== 'string'
  ) {
    throw new Error(`DSH credentials file ${file} does not contain ${DSH_BROWSER_CREDENTIAL_KEY}`);
  }
  const secret = Buffer.from(record.payload.secret, 'base64url');
  if (
    secret.byteLength !== SECRET_BYTES ||
    secret.toString('base64url') !== record.payload.secret
  ) {
    throw new Error(
      `DSH credentials file ${file} contains an invalid ${DSH_BROWSER_CREDENTIAL_KEY} secret`,
    );
  }
  return secret;
}

/** Read and validate the browser-cookie signing secret synchronously. */
export function readDshBrowserSecretSync(file: string): Buffer {
  assertOwnerOnly(file, fs.statSync(file));
  return parseBrowserSecret(fs.readFileSync(file, 'utf-8'), file);
}

/** Read and validate the browser-cookie signing secret asynchronously. */
export async function readDshBrowserSecret(file: string): Promise<Buffer> {
  const stats = await fs.promises.stat(file);
  assertOwnerOnly(file, stats);
  const text = await fs.promises.readFile(file, 'utf-8');
  return parseBrowserSecret(text, file);
}

/** Cookie name binds the signed value to one host:port authority. */
export function dshCookieName(authority: string): string {
  return COOKIE_PREFIX + createHash('sha256').update(authority).digest('base64url');
}

/**
 * Mint a v1 browser cookie accepted by DSH's `/api` admission path.
 *
 * DSH verifies `v1.<base64url(payload)>.<base64url(hmac-sha256(body))>` with
 * the durable browser-session secret. The short default lifetime is refreshed
 * on the next request, so no cookie is persisted by lark-remote.
 */
export function mintDshBrowserCookie(
  baseUrl: string,
  secret: Buffer,
  issuedAt = Date.now(),
  lifetimeMs = DSH_COOKIE_LIFETIME_MS,
): string {
  if (secret.byteLength !== SECRET_BYTES) {
    throw new Error('DSH browser-session secret must be 32 bytes');
  }
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) {
    throw new Error('DSH browser cookie lifetime must be a positive safe integer');
  }
  const authority = new URL(baseUrl).host;
  if (!authority) throw new Error(`DSH host ${baseUrl} has no authority`);
  const expiresAt = issuedAt + lifetimeMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error('DSH browser cookie expiry exceeds the safe integer range');
  }
  const body = Buffer.from(
    JSON.stringify({ version: 1, authority, issuedAt, expiresAt }),
    'utf-8',
  ).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${dshCookieName(authority)}=v1.${body}.${signature}`;
}
