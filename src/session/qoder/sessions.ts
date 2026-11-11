/**
 * Qoder 会话读取内核：jsonl 与 Claude Code 同构
 * （parentUuid/uuid/type:user|assistant/message/sessionId/cwd/version +
 * Qoder 私有行类型 workspace-directories/runtime-config/attachment/
 * task_reminder/skill_listing），因此 list/read/active 直接复用 claude 的
 * 函数内核（src/session/claude/sessions.ts），只差异目录：
 *
 *   `<configDir>/projects/<encodeProjectDirName(cwd)>/<sessionId>.jsonl`
 *
 * configDir 缺省按 ~/.qoder-cn（CN 版）→ ~/.qoder（国际版）顺序探测
 * （resolveQoderConfigDir）。目录编码与 claude 同款（前导 `-`、`_`→`-`）。
 *
 * claude 内核对未知行类型（Qoder 私有行）一律按「无 content blocks 的元数据
 * 行」处理，不会误进事件流；Qoder 私有行是否携带终态标记（影响
 * isSessionActive 的末行判定）待真机验证，v1 沿用 claude 的终态集合。
 *
 * 复用处的错误文案重打 qoder 标签：claude 内核抛「claude session list 读取
 * 失败」，qoder 侧原样透传会让用户误以为在读 claude 的会话。
 */

import path from 'node:path';
import {
  listClaudeSessions,
  readSessionContent,
  isClaudeSessionActive,
} from '../claude/sessions.js';
import { resolveQoderConfigDir } from '../../config/qoder-config.js';
import type { AgentSession, AgentSessionReader, SessionContent } from '../../session-contract.js';
import { paginate } from '../common/pagination.js';

interface QoderReaderOptions {
  /** Qoder 配置根目录；缺省自动探测（~/.qoder-cn → ~/.qoder）。 */
  configDir?: string;
}

/** projectsDir = `<configDir>/projects`；未显式给 configDir 时自动探测。 */
function qoderProjectsDir(configDir?: string): string {
  return path.join(resolveQoderConfigDir(configDir), 'projects');
}

function listQoderSessions(
  cwd: string,
  opts: { limit?: number; configDir?: string } = {},
): AgentSession[] {
  try {
    // 不传 limit = 返回全集不切片；total 由 reader 用全集长度计算。
    return listClaudeSessions(cwd, { projectsDir: qoderProjectsDir(opts.configDir) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // claude 内核的错误文案重打 qoder 标签（保留 cause 供日志链路）。
    throw new Error(`qoder session list 读取失败: ${msg}`, { cause: err });
  }
}

function readQoderSessionContent(
  sessionId: string,
  cwd: string,
  opts: { maxEvents?: number; configDir?: string } = {},
): ReturnType<typeof readSessionContent> {
  return readSessionContent(sessionId, cwd, {
    projectsDir: qoderProjectsDir(opts.configDir),
    maxEvents: opts.maxEvents,
  });
}

function isQoderSessionActive(
  sessionId: string,
  cwd: string,
  opts: { configDir?: string } = {},
): boolean {
  return isClaudeSessionActive(sessionId, cwd, {
    projectsDir: qoderProjectsDir(opts.configDir),
  });
}

/**
 * Adapter that exposes Qoder's session-reading functions through the unified
 * `AgentSessionReader` interface. Thin wrapper over `sessions.ts` exports —
 * same shape as ClaudeSessionReader（projectsDir 换成 Qoder 的 configDir 探测）。
 */
export class QoderSessionReader implements AgentSessionReader {
  private readonly configDir?: string;

  constructor(opts: QoderReaderOptions = {}) {
    this.configDir = opts.configDir;
  }

  listSessions(
    cwd: string,
    opts?: { limit?: number; offset?: number },
  ): { sessions: AgentSession[]; total: number } {
    // 先拿全集（不传 limit → 不切片），total 用全集长度，再按 [offset, offset+limit) 切片。
    const all = listQoderSessions(cwd, { configDir: this.configDir });
    const { items, total } = paginate(all, opts ?? {});
    return { sessions: items, total };
  }

  getNewestSession(cwd: string): AgentSession | null {
    const sessions = listQoderSessions(cwd, { limit: 1, configDir: this.configDir });
    return sessions[0] ?? null;
  }

  readSessionContent(
    sessionId: string,
    cwd: string,
    opts?: { maxEvents?: number },
  ): SessionContent {
    return readQoderSessionContent(sessionId, cwd, { ...opts, configDir: this.configDir });
  }

  isSessionActive(sessionId: string, cwd: string): boolean {
    return isQoderSessionActive(sessionId, cwd, { configDir: this.configDir });
  }
}
