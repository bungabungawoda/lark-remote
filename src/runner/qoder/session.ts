/**
 * QoderSession: 长驻交互式 Qoder 会话（stream-json 双向通道）。
 *
 * Qoder CLI 的 headless 面与 Claude Code 高度同构（真机 1.1.72 实测：
 * system/init → assistant(thinking/text 块) → result，usage 字段名与 claude
 * 一致，--resume 同 sessionId 恢复上下文，/compact 被本地拦截为命令以独立
 * result 收尾），因此会话机制整体复用 ClaudeSession，本类只差异 argv 与身份：
 * - spawn argv：Qoder 无 --replay-user-messages（claude 专属）；推理强度走
 *   --reasoning-effort（不是 claude 的 --effort）；权限模式取值是 snake_case；
 *   **不带** --permission-prompt-tool stdio（qoder 拒绝它与
 *   --input-format stream-json 组合）→ 审批无动态 control_request 通道，
 *   由 --permission-mode 静态策略治理（配置卡可改）；**不带** --verbose
 *   （非 -p 形状下 unknown option）与 --include-partial-messages（其增量
 *   stream_event 行需要独立翻译面，v1 事件面保持与 claude 管线逐字一致，
 *   卡片按 assistant 完整块粒度流式）。
 * - 身份：binary 可配（CN 版 qodercn / 国际版 qoder）、pid 前缀/日志 tag/
 *   win32 停止通道 key 随 qoder，避免与 claude 的 pid 文件互相误杀。
 *
 * 坑（写入 argv 约定）：`qodercn` 的入口 dispatcher 会把「首参为已存在文件
 * 路径」劫持给 IDE 启动器——headless 调用必须永远 flag 开头，禁止把裸路径
 * 放进 argv 首位。
 */

import { ClaudeSession, type ClaudeSessionOptions } from '../claude/session.js';
import type { SpawnOptions } from '../types.js';

/**
 * QoderSessionOptions：身份三元组（pid 前缀/日志 tag/agent key）固定随 qoder，
 * 不开放覆盖；binary 开放——CN 版默认 `qodercn`、国际版 `qoder`，由配置下发。
 */
export interface QoderSessionOptions extends Omit<
  ClaudeSessionOptions,
  'binary' | 'pidFilePrefix' | 'logTag' | 'agent'
> {
  /** CLI 二进制名；缺省 `qodercn`（CN 版安装名）。 */
  binary?: string;
  /** 显式上下文窗口（--context-window，正整数 tokens）。缺省 = 跟随 CLI/模型默认。 */
  contextWindow?: number;
}

export class QoderSession extends ClaudeSession {
  private readonly contextWindow?: number;

  constructor(opts: QoderSessionOptions) {
    // contextWindow 是 qoder 专属参数（claude 的 options 没有该字段），
    // 从 super 展开里摘出来，避免作为多余键静默落进 ClaudeSessionOptions。
    const { contextWindow, ...sessionOpts } = opts;
    super({
      ...sessionOpts,
      binary: opts.binary ?? 'qodercn',
      pidFilePrefix: 'qoder',
      logTag: 'qoder-runner',
      agent: 'qoder',
    });
    this.contextWindow = contextWindow;
  }

  protected override buildArgv(opts: SpawnOptions): string[] {
    // flag 开头（见类头注释的 dispatcher 劫持坑）；整体对齐 claude 的
    // buildArgv 顺序，差异项集中在 flags 数组与本文件常量。
    // 刻意不带：--permission-prompt-tool（与 --input-format stream-json 互斥，
    // 真机报错）、--verbose（非 -p 形状 unknown option）、
    // --include-partial-messages（stream_event 行需独立翻译面，v1 不开）。
    const args = ['--output-format', 'stream-json', '--input-format', 'stream-json'];

    // 'default' = Qoder 的未设置模式：省略 --permission-mode（qoder 取值为
    // snake_case，枚举校验在 config schema 层）。审批治理 = 静态模式策略。
    if (this.permissionMode && this.permissionMode !== 'default') {
      args.push('--permission-mode', this.permissionMode);
    }

    if (opts.sessionId) {
      args.push('--resume', opts.sessionId);
    }

    if (opts.model) {
      args.push('--model', opts.model);
    }

    // 显式上下文窗口提示值：影响 CLI 侧的压缩阈值判断；不传 = 跟随模型默认。
    // schema 层（z.number().int().min(1)）已在边界保证正整数，此处只判存在。
    if (this.contextWindow !== undefined) {
      args.push('--context-window', String(this.contextWindow));
    }

    // qoder 的推理强度 flag 与 claude 不同：--reasoning-effort（--effort 是
    // claude 专属）。per-run 覆盖走 reasoningEffort（与 codex 的 run 选项
    // 字段对称；effort 为兼容兜底）。
    const effort = opts.reasoningEffort ?? opts.effort ?? this.defaultEffort;
    if (effort) {
      args.push('--reasoning-effort', effort);
    }

    const settings = this.settings;
    if (settings) {
      args.push('--settings', settings);
    }

    return args;
  }
}
