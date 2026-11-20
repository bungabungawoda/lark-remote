import path from 'node:path';
import type { AgentKind } from '../agent-kinds.js';
import { getAgentConfig, type AppConfig } from '../config/index.js';
import {
  defaultCodebuddyProductConfigCacheDir,
  ensureCodebuddyRegion,
  invalidateCodebuddyCatalogCache,
  invalidateCodebuddyRegion,
  scheduleCodebuddyRegionRedetect,
} from '../config/codebuddy-catalog.js';
import {
  readCodebuddyModelError,
  recordCodebuddyModelRejection,
  recordCodebuddyModelSuccess,
  resolveCodebuddyModel,
} from '../config/codebuddy-model-state.js';
import { getLogger } from '../logger/index.js';
import {
  codebuddyProjectsDir,
  encodeCodebuddyProjectDirName,
} from '../session/codebuddy/sessions.js';
import type { AgentEvent } from '../runner/types.js';

/**
 * 401 终态的恢复指引。只追加到 errorMsg 文本上，不动最终回答卡片结构。
 */
const CODEBUDDY_AUTH_RECOVERY_HINT =
  '\n\n【已自动重置】登录态或区域已失效：旧会话、模型目录与长驻连接均已清除。' +
  '\n区域正在后台重新判定，下一条消息会新建会话并自动使用判定结果。' +
  '\n若仍失败，请在终端执行 codebuddy /login 重新登录；也可在 /config 的「区域」里手动选 internal / external 锁定端点。' +
  '\n重新打开 /config 可刷新模型列表。';

type ResultEvent = Extract<AgentEvent, { type: 'result' }>;
type LearnedModelError = ReturnType<typeof readCodebuddyModelError>;

export interface CodebuddyRuntimeDeps {
  getConfig(): AppConfig;
  sessionStore: { clearSessionId(userId: string, agent: AgentKind): void };
  clearRunners(): void;
  codebuddyHome?: string;
}

/**
 * CodeBuddy identity/region/model-rejection state machine.
 *
 * These rules depend on CodeBuddy's private catalog and session jsonl, not on
 * Bridge's run/queue lifecycle. Keeping them out of Bridge prevents new agents
 * from having to edit the generic layer.
 */
export class CodebuddyRuntime {
  constructor(private readonly deps: CodebuddyRuntimeDeps) {}

  /** Wait for the region probe before the first CodeBuddy turn. */
  async ensureRegion(): Promise<void> {
    const conf = getAgentConfig(this.deps.getConfig(), 'codebuddy');
    await ensureCodebuddyRegion(conf?.env, {
      binary: conf?.acp?.binary,
      hostProductConfigCacheDir: defaultCodebuddyProductConfigCacheDir(),
    });
  }

  /** `/config` discovered a different account/region: drop all derived state. */
  reset(userId: string): void {
    this.deps.sessionStore.clearSessionId(userId, 'codebuddy');
    this.deps.clearRunners();
    getLogger().warn('[lark-remote] codebuddy identity changed: session/runner reset');
  }

  /** Apply result-event side effects (401 reset, model-list learning). */
  onResult(
    event: ResultEvent,
    opts: {
      preInitResult: boolean;
      userId: string;
      agentKind: AgentKind;
      runId: string;
      cwd: string;
    },
  ): void {
    if (opts.preInitResult) return;
    if (event.authFailure) {
      this.invalidateIdentity(event, opts);
      return;
    }
    const conf = getAgentConfig(this.deps.getConfig(), 'codebuddy');
    if (event.subtype === 'success') {
      recordCodebuddyModelSuccess(resolveCodebuddyModel(conf?.model));
    } else if (event.subtype === 'error') {
      this.learnModelRejection(event, opts, conf);
    }
  }

  private invalidateIdentity(
    event: ResultEvent,
    opts: { userId: string; agentKind: AgentKind; runId: string },
  ): void {
    invalidateCodebuddyCatalogCache();
    invalidateCodebuddyRegion();
    this.deps.sessionStore.clearSessionId(opts.userId, opts.agentKind);
    this.deps.clearRunners();
    const conf = getAgentConfig(this.deps.getConfig(), 'codebuddy');
    scheduleCodebuddyRegionRedetect(conf?.env, {
      binary: conf?.acp?.binary,
      hostProductConfigCacheDir: defaultCodebuddyProductConfigCacheDir(),
    });
    event.errorMessage = `${event.errorMessage ?? '上游认证失效'}${CODEBUDDY_AUTH_RECOVERY_HINT}`;
    getLogger().warn(
      `[lark-remote] codebuddy auth failure: catalog/region/session/runner invalidated, redetect scheduled runId=${opts.runId}`,
    );
  }

  private learnModelRejection(
    event: ResultEvent,
    opts: { userId: string; agentKind: AgentKind; runId: string; cwd: string },
    conf: { model?: string } | undefined,
  ): void {
    const learned = this.readModelError(event, opts.cwd);
    if (!learned) return;

    if (learned.supported.length === 0) {
      this.appendUnsupportedModelHint(event, learned);
      return;
    }
    this.applyLearnedModelList(event, opts, learned, conf);
  }

  private applyLearnedModelList(
    event: ResultEvent,
    opts: { userId: string; agentKind: AgentKind; runId: string },
    learned: NonNullable<LearnedModelError>,
    conf: { model?: string } | undefined,
  ): void {
    const state = recordCodebuddyModelRejection({
      model: learned.model,
      supported: learned.supported,
    });
    if (!state) return;

    const corrected = resolveCodebuddyModel(conf?.model);
    if (!corrected || corrected === conf?.model) {
      getLogger().info(
        `[lark-remote] codebuddy model list learned (${state.supported.length} ids), configured model still valid runId=${opts.runId}`,
      );
      return;
    }

    this.applyCorrection(event, opts, learned.model ?? conf?.model, corrected);
  }

  private readModelError(event: ResultEvent, cwd: string): LearnedModelError {
    const sessionFile = path.join(
      codebuddyProjectsDir(this.deps.codebuddyHome),
      encodeCodebuddyProjectDirName(cwd),
      `${path.basename(event.session_id)}.jsonl`,
    );
    return readCodebuddyModelError(sessionFile);
  }

  private appendUnsupportedModelHint(
    event: ResultEvent,
    learned: NonNullable<LearnedModelError>,
  ): void {
    if (!learned.model) return;
    event.errorMessage =
      `${event.errorMessage ?? '上游拒绝该模型'}` +
      `\n\n【提示】模型 ${learned.model} 可能不属于当前账号，请在 /config 换一个模型。`;
  }

  private applyCorrection(
    event: ResultEvent,
    opts: { userId: string; agentKind: AgentKind; runId: string },
    rejected: string | undefined,
    corrected: string,
  ): void {
    this.deps.sessionStore.clearSessionId(opts.userId, opts.agentKind);
    this.deps.clearRunners();
    event.errorMessage =
      `${event.errorMessage ?? '上游拒绝该模型'}` +
      `\n\n【已自动校正】模型 ${rejected ?? '(未配置)'} 不属于当前账号，已切换为 ${corrected}。` +
      '\n请重发本条消息。';
    getLogger().warn(
      `[lark-remote] codebuddy model rejected: ${rejected ?? '(unknown)'} -> ${corrected}, session/runner invalidated runId=${opts.runId}`,
    );
  }
}
