import crypto from 'node:crypto';
import { StartupContactStore } from './startup-contact.js';
import { getLogger } from './logger/index.js';

/** 绑定 PIN 位数。4 位数字便于人工输入。 */
const PIN_DIGITS = 4;

/** 入站私聊消息的绑定/授权判定结果。 */
type BindDecision =
  { kind: 'owner' } | { kind: 'rejected' } | { kind: 'bind_success' } | { kind: 'pin_wrong' };

/** 用 CSPRNG 生成固定长度、零填充的数字 PIN（首位可为 0）。 */
function generatePin(): string {
  const n = crypto.randomInt(0, 10 ** PIN_DIGITS);
  return String(n).padStart(PIN_DIGITS, '0');
}

/**
 * Owner 绑定器：首次私聊输入正确 PIN 完成"认领"，此后仅该 openId 可用。
 *
 * 设计依据（第一性原理）：bridge 进程持有用户本机完整权限，唯一合法主体是
 * owner 本人。任何入站事件都必须认证到该单一主体。`chatType==='p2p'` 不是认证
 * （任何能私聊机器人的用户都满足）。本类以"首次绑定 + openId 强校验"实现认证，
 * 复用已有 startup-contact.json，不新增配置字段。
 *
 * 状态机：
 * - 未绑定：生成 PIN（控制台展示），等待 owner 私聊输入正确 PIN -> 写入绑定。
 *   输错 PIN 完全静默（不回复、不提醒）；首次启动仅用户本机可见，无需严格防枚举。
 * - 已绑定：仅 senderId === bound.userId 的消息放行；其余静默丢弃（计数 + debug）。
 *
 * cardAction 同样校验 operator.openId === bound.userId（未绑定也视为非 owner）。
 */
export class OwnerBinder {
  private pin: string | undefined;
  private rejectedTotal = 0;

  constructor(private readonly store: StartupContactStore) {
    if (!store.getContact()) {
      this.pin = generatePin();
    }
  }

  /** 仅未绑定时返回待输入的 PIN（控制台展示用）。 */
  get pendingPin(): string | undefined {
    return this.pin;
  }

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
   * - `bind_success`：未绑定且 PIN 正确，写入绑定并清除 PIN
   * - `pin_wrong`：未绑定且 PIN 错误，静默丢弃（不回复、不提醒）
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

    // 未绑定：要求 PIN（精确匹配 trim 后内容，避免部分匹配绕过）
    if (this.pin !== undefined && content.trim() === this.pin) {
      this.store.save({ chatId, userId: senderId });
      this.pin = undefined;
      getLogger().info(`[binder] owner bound: openId=${senderId} chatId=${chatId}`);
      return { kind: 'bind_success' };
    }

    // 输错 PIN：完全静默（不回复、不提醒、不计数），仅内部 debug 日志
    getLogger().debug('[binder] wrong pin (unbound, ignored)');
    return { kind: 'pin_wrong' };
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
 * 控制台 PIN 引导文案（首次未绑定时输出到 stderr；守护模式下被 watchdog
 * 重定向到 daemon 日志）。绑定后此文案不再出现。
 */
export function formatPinGuidance(pin: string): string {
  return [
    '',
    '🔒 首次绑定',
    '请在飞书私聊本应用，发送以下 4 位数字完成绑定：',
    '',
    `    ${pin}`,
    '',
    '绑定后仅该账号可使用本应用。',
    '需更换账号：删除 <configDir>/startup-contact.json 后重启。',
    '',
  ].join('\n');
}
