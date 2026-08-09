import { describe, it, expect } from 'vitest';

/**
 * Anchor test for the CardSession base class and its subclasses.
 *
 * Both RunCardSession and BashCardSession should eventually share a common
 * base class (CardSession) for lifecycle management. Currently they have
 * separate implementations.
 *
 * This test verifies the current state: CardSession base class exists
 * and both RunCardSession and BashCardSession exist as independent classes.
 */
describe('CardSession base class', () => {
  it('exports CardSession and StreamSettleResult from card-session.ts', async () => {
    const mod = await import('./card-session.js');

    // 1. CardSession base class exists and is a constructor
    expect(mod.CardSession).toBeDefined();
    expect(typeof mod.CardSession).toBe('function');

    // 2. CardChannel is a TypeScript interface (erased at runtime) and
    //    StreamSettleResult is a type alias — neither has a runtime value.
  });

  it('RunCardChannel and BashCardChannel types are available', async () => {
    const runMod = await import('./run-card-session.js');
    const bashMod = await import('./bash-card-session.js');

    // RunCardSession and BashCardSession classes exist
    expect(runMod.RunCardSession).toBeDefined();
    expect(bashMod.BashCardSession).toBeDefined();
    expect(typeof runMod.RunCardSession).toBe('function');
    expect(typeof bashMod.BashCardSession).toBe('function');
  });

  it('RunCardSession and BashCardSession have the expected methods', async () => {
    const runMod = await import('./run-card-session.js');
    const bashMod = await import('./bash-card-session.js');

    // Both should have the lifecycle methods
    const runProto = runMod.RunCardSession.prototype;
    const bashProto = bashMod.BashCardSession.prototype;

    // Check that both have the core streaming methods
    expect(typeof runProto.start).toBe('function');
    expect(typeof runProto.settle).toBe('function');
    expect(typeof runProto.finish).toBe('function');

    expect(typeof bashProto.start).toBe('function');
    expect(typeof bashProto.settle).toBe('function');
    expect(typeof bashProto.finish).toBe('function');
  });
});
