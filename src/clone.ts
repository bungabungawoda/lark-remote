import { registerApp, type QRCodeInfo, type RegisterAppResult } from '@larksuite/channel';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { getLogger } from './logger/index.js';
import { renderQrImage } from './config/qr.js';
import { silentlyUnlink } from './common/fs.js';
import { atomicWrite, atomicWriteJson } from './persistence/atomic-write.js';
import { spawnDetachedBridge } from './restart.js';

/**
 * 复制分身（/clone）状态机。
 *
 * 在当前 bridge 进程内引导用户扫码创建一个新飞书应用，并生成一份"分身"
 * 配置目录：除 feishu.appId/appSecret 来自新应用外，其余配置原样复制；
 * 创建完成后用新应用拿到的用户 openId 直接写好绑定（owner 无需再输入
 * 任意内容认领），并 detached 拉起指向新配置目录的新实例——启动后新
 * 实例自己会向新应用发送启动通知，即完成"在新应用主动触达用户"。
 *
 * 状态机（仅在原始应用内运行）：
 * - idle：未进入流程。`/clone [name]` 进入 awaiting_scan。
 * - awaiting_scan：二维码已发出，SDK 后台轮询等扫码。此阶段用户的一切
 *   消息不转发 coding agent：「重发」重新生成二维码，/Q 取消，其余输入
 *   回引导文案。
 * - finalizing：扫码成功，正在写配置/绑定/拉起，短暂过渡态，输入被婉拒。
 *
 * 注册生命周期用「代际判定」管理：runRegistration 捕获本轮 AbortController，
 * then 分支先比对 this.abortController —— /Q 取消或「重发」都会替换/清空
 * controller，过期代际的 resolve/reject 一律静默，防止旧凭证覆盖新一轮。
 *
 * 安全边界：流程由已绑定 owner 在私聊里发起（router 入口已过 OwnerBinder
 * 闸门），新配置目录写入本机，不涉及对外暴露。
 */

type CloneState = 'idle' | 'awaiting_scan' | 'finalizing';

/** 退出命令（不区分大小写）。 */
const EXIT_COMMANDS = new Set(['/q']);
/** 重新生成二维码的关键词（精确匹配，避免误伤普通聊天）。 */
const RESEND_COMMANDS = new Set(['重发', '重发二维码', '重新生成', '重新生成二维码', '重新发送']);

/** win32 保留设备名（不区分大小写），用作分身目录名会在 mkdir 时失败。 */
const WIN_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * 校验用户指定的分身名字：路径分隔符、以 . 开头、尾点/尾空格（win32 会静默
 * 吞掉）、win32 保留设备名一律拒绝。
 */
export function isValidCloneName(name: string): boolean {
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) return false;
  if (/[\s.]$/.test(name)) return false;
  if (WIN_RESERVED_NAMES.has(name.toLowerCase())) return false;
  return true;
}

/** 随机后缀：2 位数字 + 2 位小写字母/数字，如 `37ab`。 */
export function generateCloneSuffix(): string {
  const digits = String(crypto.randomInt(0, 100)).padStart(2, '0');
  const charset = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let chars = '';
  for (let i = 0; i < 2; i++) chars += charset[crypto.randomInt(0, charset.length)];
  return digits + chars;
}

/** clone 流程内发消息所需的上下文（router CommandContext 的结构子集）。 */
export interface CloneContext {
  userId: string;
  chatId: string;
  messageId?: string;
}

/** clone 流程依赖的 connector 发送面（测试用 stub 结构化满足）。 */
export interface CloneConnector {
  sendWithRetry(
    chatId: string,
    input: { text: string } | { markdown: string } | { card: object },
    opts?: { replyTo?: string },
  ): Promise<string>;
  sendImage(chatId: string, filePath: string): Promise<string>;
}

type RegisterAppFn = (options: {
  source: string;
  signal?: AbortSignal;
  /** 分身必须是全新应用：复用已有应用会让两个实例抢同一份凭证。 */
  createOnly?: boolean;
  onQRCodeReady: (info: QRCodeInfo) => void;
  onStatusChange?: (info: { status: string }) => void;
}) => Promise<RegisterAppResult>;

/**
 * 默认新实例拉起：同入口 + 同参数，仅替换 --config-dir（detached，返回 pid）。
 * spawn 骨架（log fd / windowsHide / error 兜底）单源于 restart.ts。
 */
export function spawnDetachedCloneBridge(targetDir: string): number | undefined {
  const args: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config-dir') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) i++;
      continue;
    }
    args.push(argv[i]);
  }
  args.push('--config-dir', targetDir);

  const entry = process.argv[1];
  if (!entry) return undefined;
  const pid = spawnDetachedBridge(
    [entry, ...args],
    path.join(targetDir, 'logs', 'spawn-child.log'),
  );
  return pid ?? undefined;
}

export interface CloneSessionOptions {
  connector: CloneConnector;
  /** 当前实例的 config.yaml 路径（配置复制源）。 */
  configPath: string;
  /** 当前实例的配置目录（分身目录 = 该目录 + '-' + 后缀/名字）。 */
  configDir: string;
  /** 覆盖 SDK registerApp（测试注入）。 */
  registerAppFn?: RegisterAppFn;
  /** 覆盖随机后缀生成（测试注入确定性序列）。 */
  generateSuffix?: () => string;
  /** 覆盖新实例拉起（测试注入；默认 detached spawn 同入口进程）。 */
  spawnNewInstance?: (targetDir: string) => number | undefined;
}

export class CloneSession {
  private state: CloneState = 'idle';
  private targetDir: string | undefined;
  private abortController: AbortController | undefined;
  private readonly connector: CloneConnector;
  private readonly configPath: string;
  private readonly configDir: string;
  private readonly registerAppFn: RegisterAppFn;
  private readonly generateSuffixFn: () => string;
  private readonly spawnNewInstanceFn: (targetDir: string) => number | undefined;

  constructor(opts: CloneSessionOptions) {
    this.connector = opts.connector;
    this.configPath = opts.configPath;
    this.configDir = opts.configDir;
    this.registerAppFn = opts.registerAppFn ?? (registerApp as unknown as RegisterAppFn);
    this.generateSuffixFn = opts.generateSuffix ?? generateCloneSuffix;
    this.spawnNewInstanceFn = opts.spawnNewInstance ?? spawnDetachedCloneBridge;
  }

  /** 当前状态（测试断言用）。 */
  get currentState(): CloneState {
    return this.state;
  }

  isActive(): boolean {
    return this.state !== 'idle';
  }

  /** 已确定但尚未写入的分身配置目录（测试断言用）。 */
  get pendingTargetDir(): string | undefined {
    return this.targetDir;
  }

  /**
   * 进入创建分身流程：确定新配置目录 → 发二维码 → 等扫码。
   * 目录已存在 / 名字非法时不进入流程（保持 idle），仅回错误说明。
   */
  async start(nameArg: string | undefined, ctx: CloneContext): Promise<void> {
    if (this.isActive()) {
      await this.connector.sendWithRetry(
        ctx.chatId,
        { text: '已在创建分身流程中，请先完成或输入 /Q 退出后再重新发起' },
        { replyTo: ctx.messageId },
      );
      return;
    }

    let suffix: string;
    if (nameArg !== undefined && nameArg.length > 0) {
      const name = nameArg.trim();
      if (!isValidCloneName(name)) {
        await this.connector.sendWithRetry(
          ctx.chatId,
          {
            text:
              `⚠️ 无效的名字：${nameArg}\n` +
              '名字不能包含路径分隔符、不能以 . 开头、不能以点或空格结尾，' +
              '也不能是 Windows 保留设备名（con/nul/com1 等）\n' +
              '用法：/clone <名字>（省略则随机生成）',
          },
          { replyTo: ctx.messageId },
        );
        return;
      }
      suffix = name;
    } else {
      // 随机后缀：先检查目标目录不存在再落定（存在则重新生成，最多 50 次）。
      suffix = this.generateSuffixFn();
      for (let i = 0; i < 50 && fs.existsSync(this.dirFor(suffix)); i++) {
        suffix = this.generateSuffixFn();
      }
      if (fs.existsSync(this.dirFor(suffix))) {
        await this.connector.sendWithRetry(
          ctx.chatId,
          { text: '⚠️ 无法确定分身目录（随机名连续冲突），请稍后重试或用 /clone <名字> 指定' },
          { replyTo: ctx.messageId },
        );
        return;
      }
    }

    const targetDir = this.dirFor(suffix);
    if (fs.existsSync(targetDir)) {
      await this.connector.sendWithRetry(
        ctx.chatId,
        {
          text:
            `⚠️ 目录已存在：${targetDir}\n` + '请换一个名字（/clone <名字>），或省略参数随机生成',
        },
        { replyTo: ctx.messageId },
      );
      return;
    }

    this.targetDir = targetDir;
    this.state = 'awaiting_scan';
    getLogger().info(`[clone] start, target config dir: ${targetDir}`);
    await this.connector.sendWithRetry(
      ctx.chatId,
      {
        text:
          `🧬 开始创建分身\n` +
          `新配置目录：${targetDir}\n` +
          `正在生成二维码，请稍候…（完成后会以图片消息发送）`,
      },
      { replyTo: ctx.messageId },
    );
    this.runRegistration(ctx);
  }

  /**
   * awaiting_scan / finalizing 阶段的一切入站消息都进这里（index.ts 在
   * 消息入队前拦截，不转发 coding agent、不进命令分发）。
   */
  async handleMessage(content: string, ctx: CloneContext): Promise<void> {
    if (this.state === 'finalizing') {
      await this.connector.sendWithRetry(
        ctx.chatId,
        { text: '⏳ 正在完成分身创建（写配置/绑定/拉起新实例），请稍候…' },
        { replyTo: ctx.messageId },
      );
      return;
    }

    const trimmed = content.trim();
    const lowered = trimmed.toLowerCase();

    if (EXIT_COMMANDS.has(lowered)) {
      this.state = 'idle';
      this.targetDir = undefined;
      // 置空 controller 使旧注册变为过期代际：其迟到 resolve/reject 都被静默。
      this.abortController?.abort();
      this.abortController = undefined;
      getLogger().info('[clone] cancelled by user');
      await this.connector.sendWithRetry(
        ctx.chatId,
        { text: '已取消创建分身，未写入任何配置。' },
        { replyTo: ctx.messageId },
      );
      return;
    }

    if (RESEND_COMMANDS.has(trimmed)) {
      // abort 旧注册（变为过期代际，其迟到 resolve/reject 被静默），
      // 再起新一轮注册。awaiting_scan 状态保持不变。
      this.abortController?.abort();
      getLogger().info('[clone] qr resend requested');
      await this.connector.sendWithRetry(
        ctx.chatId,
        { text: '🔄 正在重新生成二维码…' },
        { replyTo: ctx.messageId },
      );
      this.runRegistration(ctx);
      return;
    }

    await this.connector.sendWithRetry(
      ctx.chatId,
      {
        text:
          '🧬 正在创建分身，当前状态：等待你扫码\n' +
          '• 直接用飞书扫描上面的二维码图片即可，无需输入任何内容\n' +
          '• 二维码过期或创建失败：输入「重发」重新生成\n' +
          '• 退出本流程：输入 /Q（不会写入任何配置）',
      },
      { replyTo: ctx.messageId },
    );
  }

  private dirFor(suffix: string): string {
    return `${this.configDir}-${suffix}`;
  }

  /** 起一轮扫码注册：QR 就绪即发图，成功 finalize，失败回引导（保持流程）。 */
  private runRegistration(ctx: CloneContext): void {
    const controller = new AbortController();
    this.abortController = controller;
    this.registerAppFn({
      source: 'lark-remote',
      signal: controller.signal,
      createOnly: true,
      onQRCodeReady: (info) => {
        void this.sendQrCode(info, ctx);
      },
      onStatusChange: (info) => {
        if (info.status === 'domain_switched') {
          getLogger().info('[clone] international tenant detected, switched to larksuite.com');
        } else if (info.status === 'slow_down') {
          getLogger().info('[clone] registration polling slowed down');
        }
      },
    }).then(
      (result) => {
        // 代际判定：/Q 或重发后本注册已是过期代际，忽略迟到 resolve，
        // 防止旧凭证 finalize 覆盖新一轮。
        if (this.abortController !== controller) {
          getLogger().info('[clone] stale registration resolved, ignored');
          return;
        }
        void this.finalize(result, ctx);
      },
      (err: unknown) => {
        if (this.abortController !== controller) {
          // /Q 取消或重发触发的 abort：用户侧已有对应提示，静默即可。
          getLogger().info('[clone] stale registration aborted');
          return;
        }
        this.onRegistrationError(err, ctx);
      },
    );
  }

  private async sendQrCode(info: QRCodeInfo, ctx: CloneContext): Promise<void> {
    const qrPath = path.join(os.tmpdir(), `lark-remote-clone-qr-${crypto.randomUUID()}.gif`);
    const mins = Math.max(1, Math.round(info.expireIn / 60));
    try {
      fs.writeFileSync(qrPath, renderQrImage(info.url));
      await this.connector.sendImage(ctx.chatId, qrPath);
    } catch (err) {
      getLogger().warn('[clone] send QR image failed:', err);
      // 图片发送失败不阻断流程：给出浏览器打开兜底。
      await this.connector
        .sendWithRetry(
          ctx.chatId,
          { text: `⚠️ 二维码图片发送失败，请在浏览器打开创建：${info.url}` },
          { replyTo: ctx.messageId },
        )
        .catch(() => {});
      return;
    } finally {
      silentlyUnlink(qrPath);
    }
    await this.connector
      .sendWithRetry(
        ctx.chatId,
        {
          text:
            `📱 请用飞书 App 扫描上面的二维码创建新应用（约 ${mins} 分钟内有效）\n` +
            `也可以直接在浏览器打开：${info.url}\n\n` +
            `• 创建成功后会自动完成绑定并启动新实例，无需再做任何输入\n` +
            `• 需要重新生成：输入「重发」\n` +
            `• 退出：输入 /Q`,
        },
        { replyTo: ctx.messageId },
      )
      .catch((err: unknown) => getLogger().warn('[clone] QR guidance send failed:', err));
  }

  private onRegistrationError(err: unknown, ctx: CloneContext): void {
    // 真实失败（二维码过期/网络等）：保持 awaiting_scan，让用户选「重发」或 /Q。
    getLogger().warn('[clone] registration failed:', err);
    void this.connector
      .sendWithRetry(
        ctx.chatId,
        {
          text:
            '⚠️ 应用创建失败或二维码已过期\n' +
            '• 输入「重发」重新生成二维码\n' +
            '• 输入 /Q 退出本流程',
        },
        { replyTo: ctx.messageId },
      )
      .catch((sendErr: unknown) =>
        getLogger().warn('[clone] failure notice send failed:', sendErr),
      );
  }

  /**
   * 扫码成功后的自动绑定落地：
   * 1. 复制当前 config.yaml，仅替换 feishu.appId/appSecret；
   * 2. 同步 workspace / 常用指令 / 会话状态（session 按 openId 重绑）；
   * 3. 用 registerApp 返回的新应用 openId 写 startup-contact.json（免认领绑定）；
   * 4. detached 拉起指向新目录的新实例（启动后自动向新应用发启动通知）；
   * 5. 在原应用回执「绑定完成 + 配置目录」，退出流程。
   */
  private async finalize(result: RegisterAppResult, ctx: CloneContext): Promise<void> {
    this.state = 'finalizing';
    const targetDir = this.targetDir;
    if (!targetDir) {
      this.state = 'idle';
      return;
    }
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const cloned = YAML.parse(raw) as Record<string, unknown>;
      const feishu = (cloned.feishu ?? {}) as Record<string, unknown>;
      feishu['appId'] = result.client_id;
      feishu['appSecret'] = result.client_secret;
      cloned['feishu'] = feishu;
      fs.mkdirSync(targetDir, { recursive: true });
      atomicWrite(path.join(targetDir, 'config.yaml'), YAML.stringify(cloned));
      getLogger().info(`[clone] config written to ${targetDir} (appId=${result.client_id})`);

      // 全局状态文件（workspace 别名 / 常用指令）与主键化状态（会话）同步
      this.copyGlobalStateFiles(targetDir);

      // 自动绑定：openId 是新应用作用域的，只能来自 registerApp 的 user_info。
      let sessionSynced = false;
      const newOpenId = result.user_info?.open_id;
      if (newOpenId) {
        atomicWriteJson(path.join(targetDir, 'startup-contact.json'), { userId: newOpenId });
        getLogger().info(`[clone] pre-bound owner openId=${newOpenId} in new config dir`);
        sessionSynced = this.copySessionState(targetDir, newOpenId);
      } else {
        getLogger().warn('[clone] registerApp returned no user open_id; skip pre-bind');
      }

      const spawnPid = this.spawnNewInstanceFn(targetDir);
      getLogger().info(`[clone] new instance spawn pid=${spawnPid ?? 'failed'}`);

      const lines = [
        '✅ 分身创建完成，已自动绑定',
        `• 新应用 App ID：${result.client_id}`,
        `• 配置目录：${targetDir}`,
      ];
      if (sessionSynced) {
        lines.push('• workspace / 常用指令 / 会话与工作目录状态已同步');
      } else {
        lines.push('• workspace / 常用指令状态已同步');
      }
      if (!newOpenId) {
        lines.push('• 未拿到新应用侧的用户 ID：首次向新应用发消息时会自动完成绑定');
      }
      if (spawnPid !== undefined) {
        lines.push(`• 新实例已自动启动（pid=${spawnPid}），启动后会向新应用发送启动通知`);
      } else {
        lines.push(`• 新实例自动启动失败，请手动启动：lark-remote --config-dir ${targetDir}`);
      }
      await this.connector.sendWithRetry(ctx.chatId, { text: lines.join('\n') });
      getLogger().info('[clone] finalized, flow exited');
    } catch (err) {
      getLogger().error('[clone] finalize failed:', err);
      this.cleanupPartialDir(targetDir);
      await this.connector
        .sendWithRetry(
          ctx.chatId,
          {
            text:
              `⚠️ 分身配置写入失败：${(err as Error).message}\n` +
              `新应用凭证（请妥善保管）：App ID ${result.client_id}\n` +
              '可修复本机问题后用 /clone 重新走一遍流程（会创建新应用）',
          },
          { replyTo: ctx.messageId },
        )
        .catch(() => {});
    } finally {
      this.state = 'idle';
      this.targetDir = undefined;
      this.abortController = undefined;
    }
  }

  /** 全局状态文件（workspace 别名 / 常用指令）原样复制到分身目录。 */
  private copyGlobalStateFiles(targetDir: string): void {
    for (const name of ['workspace.json', 'orders.json']) {
      const src = path.join(this.configDir, name);
      if (fs.existsSync(src)) {
        // 源文件由旧实例原子写维护，copyFile 读到的总是完整版本
        fs.copyFileSync(src, path.join(targetDir, name));
        getLogger().info(`[clone] state file copied: ${name}`);
      }
    }
  }

  /**
   * last-session.json 按 openId 重绑后复制。SessionStore 以 userId 为主键，
   * 旧应用的 openId 在新应用无效：只迁移旧 owner 的条目并挂到新 openId 名下
   * （cwd / 各 agent sessionId / 停车位 / 到达基线 / sessionCwds 原样保留——
   * session 文件在同一台机器上，分身实例自动恢复即可续聊）。其余用户条目
   * 不迁移：分身实例只服务新 owner。
   */
  private copySessionState(targetDir: string, newOpenId: string): boolean {
    const src = path.join(this.configDir, 'last-session.json');
    if (!fs.existsSync(src)) return false;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(src, 'utf-8')) as Record<string, unknown>;
    } catch {
      getLogger().warn('[clone] last-session.json unreadable, skip session state copy');
      return false;
    }
    const oldOwnerId = this.readOldOwnerId();
    const entry = oldOwnerId !== undefined ? parsed[oldOwnerId] : undefined;
    if (typeof entry !== 'object' || entry === null) {
      getLogger().info('[clone] no session entry for previous owner, skip last-session copy');
      return false;
    }
    atomicWriteJson(path.join(targetDir, 'last-session.json'), { [newOpenId]: entry });
    getLogger().info(`[clone] session state re-keyed ${oldOwnerId} -> ${newOpenId}`);
    return true;
  }

  /** 旧实例绑定的 owner openId（来自当前目录 startup-contact.json）。 */
  private readOldOwnerId(): string | undefined {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(this.configDir, 'startup-contact.json'), 'utf-8'),
      ) as { userId?: unknown };
      return typeof raw.userId === 'string' && raw.userId ? raw.userId : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 写配置失败时清理半成品目录。守卫：只删内容全部是本次产物
   * （config.yaml / startup-contact.json 及其 .tmp）的目录，混入其他
   * 文件时保留现场不动。
   */
  private cleanupPartialDir(targetDir: string): void {
    try {
      const allowed = /^(config\.yaml|startup-contact\.json)(\.tmp)?$/;
      const entries = fs.readdirSync(targetDir);
      if (!entries.every((e) => allowed.test(e))) {
        getLogger().warn(`[clone] target dir has foreign entries, kept: ${targetDir}`);
        return;
      }
      fs.rmSync(targetDir, { recursive: true, force: true });
      getLogger().info(`[clone] partial target dir removed: ${targetDir}`);
    } catch {
      // 目录不存在等：无需清理
    }
  }
}
