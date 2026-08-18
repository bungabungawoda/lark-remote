/**
 * Shared CardKit stream connector stubs for card session tests.
 *
 * Parametrized factory for the `streamCard`/`updateCard` connector shape used
 * by RunCardSession/BashCardSession tests. Behavior variants are selected via
 * opts; the factory returns the connector plus the created controller so tests
 * can assert/inspect the update path.
 */
import type { CardStreamController, CardStreamProducer } from '@larksuite/channel';
import { vi } from 'vitest';

export interface StreamCardConnectorOpts {
  messageId?: string;
  /**
   * `update` behavior for the controller produced by streamCard. A function is
   * called as-is; an `Error` (or array of errors) is thrown (sequentially for
   * arrays). Default: resolves (no-op).
   */
  controllerUpdate?:
    (() => Promise<void> | void) | Error | Array<() => Promise<void> | void | Error>;
  /**
   * `updateCard` behavior for the connector. A function is called as-is; an
   * `Error` is thrown. Default: resolves (no-op).
   */
  updateCard?: (() => Promise<void> | void) | Error;
  /** If set, streamCard throws this error instead of invoking the producer. */
  streamCardThrows?: Error;
  /** If set, streamCard invokes the producer then throws this error. */
  streamCardThrowsAfterProducer?: Error;
  /** Called with the created controller (e.g. to toggle update behavior later). */
  captureController?: (controller: CardStreamController) => void;
}

export interface StreamCardConnector {
  streamCard: (chatId: string, initial: object, producer: CardStreamProducer) => Promise<string>;
  updateCard: (messageId: string, card: object) => Promise<void>;
}

export function makeStreamCardConnector(opts: StreamCardConnectorOpts = {}): {
  connector: StreamCardConnector;
  controller: CardStreamController;
} {
  const messageId = opts.messageId ?? 'card-1';
  let updateCall = 0;
  const makeUpdate = () => {
    const behavior = opts.controllerUpdate;
    return async () => {
      if (behavior instanceof Error) throw behavior;
      if (Array.isArray(behavior)) {
        const item = behavior[Math.min(updateCall++, behavior.length - 1)];
        if (item instanceof Error) throw item;
        return item();
      }
      return behavior?.();
    };
  };

  const controller: CardStreamController = {
    messageId,
    current: {},
    update: vi.fn(makeUpdate()),
  };
  opts.captureController?.(controller);

  const connector: StreamCardConnector = {
    streamCard: async (_chatId: string, _initial: object, producer: CardStreamProducer) => {
      if (opts.streamCardThrows) throw opts.streamCardThrows;
      await producer(controller);
      if (opts.streamCardThrowsAfterProducer) throw opts.streamCardThrowsAfterProducer;
      return messageId;
    },
    updateCard:
      typeof opts.updateCard === 'function'
        ? (opts.updateCard as (messageId: string, card: object) => Promise<void>)
        : async () => {
            if (opts.updateCard instanceof Error) throw opts.updateCard;
          },
  };

  return { connector, controller };
}
