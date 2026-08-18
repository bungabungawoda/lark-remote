import { EventEmitter } from 'node:events';
import type { ChildProcess, Readable, Writable } from 'node:child_process';

/**
 * Shared mock ChildProcess factory.
 *
 * Test files used to hand-roll `{ ... } as unknown as ChildProcess` /
 * `mockProc as any` per file (G5 no-explicit-any). This factory is the single
 * typed replacement: it returns a real `ChildProcess`-typed object, so
 * `vi.mocked(spawn).mockReturnValue(createMockProc(...))` needs no cast.
 *
 * The returned instance is an EventEmitter, so tests can `proc.emit('exit')`,
 * `proc.emit('error', err)`, or subscribe via the injected `once`/`on` hooks.
 */
export interface MockProcOptions {
  pid?: number | undefined;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  stdout?: Readable | null;
  stderr?: Readable | null;
  stdin?: Writable | null;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
  /** Override EventEmitter.once (e.g. capture 'close'/'error' listeners). */
  once?: EventEmitter['once'];
  /** Override EventEmitter.on (e.g. capture 'data'/'exit' listeners). */
  on?: EventEmitter['on'];
  removeAllListeners?: EventEmitter['removeAllListeners'];
  spawnargs?: string[];
  spawnfile?: string;
  connected?: boolean;
  killed?: boolean;
}

export class MockChildProcess extends EventEmitter implements ChildProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  readonly channel = undefined;
  stdio: [
    Writable | null,
    Readable | null,
    Readable | null,
    Readable | Writable | null | undefined,
    Readable | Writable | null | undefined,
  ] = [null, null, null, undefined, undefined];
  killed: boolean;
  pid?: number;
  connected: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  spawnargs: string[];
  spawnfile: string;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  send = (_message: unknown, ..._args: unknown[]): boolean => false;
  disconnect = (): void => {};
  ref = (): void => {};
  unref = (): void => {};

  [Symbol.dispose](): void {
    /* no-op */
  }

  constructor(opts: MockProcOptions = {}) {
    super();
    this.stdin = opts.stdin ?? null;
    this.stdout = opts.stdout ?? null;
    this.stderr = opts.stderr ?? null;
    this.killed = opts.killed ?? false;
    // Default to a concrete pid (matching the previous per-file mocks) unless
    // the test explicitly passes `pid: undefined` to simulate spawn failure.
    this.pid = 'pid' in opts ? opts.pid : 12345;
    this.connected = opts.connected ?? false;
    this.exitCode = opts.exitCode ?? null;
    this.signalCode = opts.signalCode ?? null;
    this.spawnargs = opts.spawnargs ?? [];
    this.spawnfile = opts.spawnfile ?? '';
    this.kill = opts.kill ?? (() => true);
    if (opts.once) this.once = opts.once;
    if (opts.on) this.on = opts.on;
    if (opts.removeAllListeners) this.removeAllListeners = opts.removeAllListeners;
  }
}

/** Create a mock ChildProcess with controllable fields/events. */
export function createMockProc(opts: MockProcOptions = {}): ChildProcess {
  return new MockChildProcess(opts);
}
