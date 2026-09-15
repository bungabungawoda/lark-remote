import { StartupContactStore } from './startup-contact.js';
import { getLogger } from './logger/index.js';

/** 入站私聊消息的绑定/授权判定结果。 */
type BindDecision = { kind: 'owner' } | { kind: 'rejected' } | { kind: 'bind_success' };

/**
 * Owner 绑定器：首次私聊发送任意消息完成"认领"，此后仅该 openId 可用。
 *
 * 设计依据：lark-remote 进程持有用户本机完整权限，唯一合法主体是 owner 本人。
 * 飞书自建应用的私聊入口本身就是 owner 掌控的（应用只有 owner 能看到/使用，
 * 分享出去属于 owner 的主动行为），因此首次消息即绑定，不再要求输入 PIN。
 * 本类复用已有 startup-contact.json，不新增配置字段。
 *
 * 状态机：
 * - 未绑定：第一条私聊消息（任意内容）即完成绑定 -> 写入 startup-contact.json。
 * - 已绑定：仅 senderId === bound.userId 的消息放行；其余静默丢弃（计数 + debug）。
 *
 * cardAction 同样校验 operator.openId === bound.userId（未绑定也视为非 owner）。
 */
export class OwnerBinder {
  private rejectedTotal = 0;

  constructor(private readonly store: StartupContactStore) {}

  isBound(): boolean {
    return this.store.getContact() !== undefined;
  }

  /** 已绑定的 owner openId；未绑定时 undefined。 */
  boundOpenId(): string | undefined {
    return this.store.getContact()?.userId;
  }

  /** 卡片操作者是否为已绑定的 owner（未绑定返回 false）。 */
  isOwner(openId: string): boolean {
    const bound = this.store.getContact()?.userId;
    return bound !== undefined && bound === openId;
  }

  /** 累计被拒（非 owner）消息/卡片数，用于 DoS 可观测。 */
  get rejectedCount(): number {
    return this.rejectedTotal;
  }

  /**
   * 对入站私聊消息做绑定/授权判定，含副作用：
   * - `owner`：放行，调用方继续正常处理
   * - `rejected`：已绑定但非 owner，静默丢弃（计数 + debug）
   * - `bind_success`：未绑定收到首条消息，写入绑定（任意内容均可）
   */
  classify(senderId: string, content: string, chatId: string): BindDecision {
    const bound = this.store.getContact();
    if (bound) {
      if (senderId === bound.userId) return { kind: 'owner' };
      this.rejectedTotal++;
      getLogger().debug(
        `[binder] rejected message from ${senderId} (total rejected=${this.rejectedCount})`,
      );
      return { kind: 'rejected' };
    }

    // 未绑定：任意内容即绑定（首条消息完成认领）
    this.store.save({ chatId, userId: senderId });
    getLogger().info(`[binder] owner bound: openId=${senderId} chatId=${chatId}`);
    return { kind: 'bind_success' };
  }

  /** 卡片操作被拒时计数（与消息路径共用计数器）。 */
  recordRejectedCardAction(openId: string): void {
    this.rejectedTotal++;
    getLogger().debug(
      `[binder] rejected card action from ${openId} (total rejected=${this.rejectedCount})`,
    );
  }
}

/**
 * 控制台绑定引导文案（首次未绑定时输出到 stderr；守护模式下被 watchdog
 * 重定向到 daemon 日志）。绑定后此文案不再出现。
 */
export function formatBindGuidance(): string {
  return [
    '',
    '🔒 首次绑定',
    '请在飞书私聊本应用，发送任意消息完成绑定：',
    '',
    '绑定后仅该账号可使用本应用。',
    '需更换账号：删除 <configDir>/startup-contact.json 后重启。',
    '',
  ].join('\n');
}
