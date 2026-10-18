/**
 * InboundAuthorizer：入站消息/媒体的统一 owner 授权入口。
 *
 * owner 绑定只发生在文本消息的 `binder.authorize()`
 * 里，媒体入口只做只读 `isOwner()` 检查。新安装用户的第一条消息是纯图片/文件
 * 时，媒体处理被静默丢弃、绑定也永远不完成。文本与媒体现在都走这里：
 *
 *  - `rejected`：已绑定但不是 owner → 调用方静默丢弃；
 *  - `bind_success`：首条入站消息完成绑定 → 触发一次 onboarding（默认 cwd、
 *    欢迎语、帮助卡），媒体调用方继续下载（纯媒体最终走 no-text 回执）；
 *  - `owner`：正常放行。
 *
 * onboarding 用一次性 promise 去重：一条 post 同时带图和文字时，connector 会
 * 先后触发媒体与文本两个入口，两个入口都看到 bind_success 也只跑一次。
 */
import type { OwnerBinder } from '../binder.js';
import { getLogger } from '../logger/index.js';

export type InboundAuthorization = 'owner' | 'bind_success' | 'rejected';

export interface InboundAuthorizerOptions {
  binder: OwnerBinder;
  /**
   * 首次绑定时的副作用（同步设置默认 cwd + 异步发欢迎语/帮助卡）。
   * 同步部分必须在返回前完成：用户的下一条消息要能找到已写好的 cwd。
   */
  onBind: (userId: string, chatId: string) => void | Promise<void>;
}

export class InboundAuthorizer {
  private onboarding: Promise<void> | undefined;

  constructor(private readonly opts: InboundAuthorizerOptions) {}

  /** 绑定/授权判定 + 首次绑定时触发 onboarding。 */
  authorize(userId: string, chatId: string): InboundAuthorization {
    const decision = this.opts.binder.authorize(userId, chatId);
    if (decision.kind === 'bind_success' && this.onboarding === undefined) {
      // onBind 同步调用（默认 cwd 的写入必须在返回前生效，下一条消息才会命中
      // 已设置的 cwd）；只把它的异步后续（发欢迎语/帮助卡）挂到 promise 上。
      try {
        this.onboarding = Promise.resolve(this.opts.onBind(userId, chatId)).catch(
          (err: unknown) => {
            getLogger().error('[binder] onboarding failed:', err);
          },
        );
      } catch (err) {
        this.onboarding = Promise.resolve();
        getLogger().error('[binder] onboarding failed:', err);
      }
    }
    return decision.kind;
  }

  /** 等待首次绑定的 onboarding 完成（测试 / 收尾用；生产路径不阻塞）。 */
  whenBound(): Promise<void> {
    return this.onboarding ?? Promise.resolve();
  }
}
