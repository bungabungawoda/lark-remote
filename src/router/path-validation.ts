import fs from 'node:fs';

export type PathKind = 'directory' | 'file' | 'missing' | 'unreadable';
export type StatResolution =
  { ok: true; stat: fs.Stats } | { ok: false; reason: 'missing' | 'unreadable' };

export type DirectoryResolution =
  | { ok: true; canonical: string }
  | { ok: false; reason: 'missing' | 'not_directory' | 'unreadable' };

/**
 * Inspect a path without a preceding existsSync call.
 *
 * stat already distinguishes missing paths from files/directories and closes
 * the exists→stat race. Permission and other IO failures stay distinguishable
 * from a normal missing path so callers can keep their user-facing messages.
 */
export function statPath(target: string): StatResolution {
  try {
    return { ok: true, stat: fs.statSync(target) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable',
    };
  }
}

export function inspectPath(target: string): PathKind {
  const resolution = statPath(target);
  if (!resolution.ok) return resolution.reason;
  return resolution.stat.isDirectory() ? 'directory' : 'file';
}

export function resolveDirectory(target: string): DirectoryResolution {
  const kind = inspectPath(target);
  if (kind === 'missing') return { ok: false, reason: 'missing' };
  if (kind === 'unreadable') return { ok: false, reason: 'unreadable' };
  if (kind === 'file') return { ok: false, reason: 'not_directory' };

  try {
    return { ok: true, canonical: fs.realpathSync(target) };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

export function isDirectorySafe(target: string): boolean {
  return inspectPath(target) === 'directory';
}
