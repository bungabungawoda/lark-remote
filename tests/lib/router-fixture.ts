/**
 * 共享 CommandRouter 测试 harness。
 *
 * 此前 19 个测试文件各自手抄同一段样板：SessionStore + stub connector +
 * stub runner + Bridge + CommandRouter（configPath/workspacePath 指向 tmpDir）。
 * 单源化后各文件只保留差异项（config / runner / 额外 router opts）。
 */
import path from 'node:path';
import { CommandRouter } from '../../src/router/index.js';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import type { SessionReaderRegistry } from '../../src/session/registry.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { Runner } from '../../src/runner/index.js';
import {
  createStubAgentRegistry,
  createStubConnector,
  createStubRunner,
  createStubSessionReaderRegistry,
  type StubConnector,
} from './bridge-stubs.js';

type RouterOpts = ConstructorParameters<typeof CommandRouter>[0];

export interface RouterFixtureOpts {
  /** 测试临时目录；configPath/workspacePath 默认落在这里。 */
  tmpDir: string;
  runner?: Runner;
  sessionStore?: SessionStore;
  /** 不传时用共享 createStubConnector()；connector 返回值保持 StubConnector
   *  精确类型（而非 BridgeChannel 联合），`_sent` 等记录字段才可见。 */
  connector?: StubConnector;
  bridge?: Bridge;
  /** 完整 config；与 configPatch 二选一（此优先级更高）。 */
  config?: AppConfig;
  /** 在默认测试 config 上追加/覆盖的顶层字段。 */
  configPatch?: Record<string, unknown>;
  sessionReaderRegistry?: SessionReaderRegistry;
  /** 透传给 CommandRouter 的其余字段（覆盖默认 configPath/workspacePath）。 */
  routerOpts?: Partial<RouterOpts>;
}

export function createRouterFixture(opts: RouterFixtureOpts) {
  const { tmpDir } = opts;
  const sessionStore = opts.sessionStore ?? new SessionStore();
  const connector = opts.connector ?? createStubConnector();
  const runner = opts.runner ?? createStubRunner({ withStatusInfo: true });
  const config =
    opts.config ??
    AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'claude-opus-4-8', stopGraceMs: 5000 },
      ...opts.configPatch,
    });

  const bridge =
    opts.bridge ??
    new Bridge({
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });

  const router = new CommandRouter({
    sessionStore,
    bridge,
    config,
    configPath: path.join(tmpDir, 'config.yaml'),
    workspacePath: path.join(tmpDir, 'workspace.json'),
    sessionReaderRegistry: opts.sessionReaderRegistry ?? createStubSessionReaderRegistry(),
    ...opts.routerOpts,
  });

  return { router, sessionStore, connector, runner, config, bridge };
}
