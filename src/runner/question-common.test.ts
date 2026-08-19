import { describe, expect, it } from 'vitest';
import { makeQuestionApprovalEvent, mapAnswersByIndex } from './question-common.js';
import type { UserQuestion } from './types.js';

const QS: UserQuestion[] = [
  {
    question: 'Which database?',
    header: 'Setup',
    options: [
      { label: 'PostgreSQL', description: 'Robust' },
      { label: 'SQLite', description: 'Lightweight' },
    ],
  },
  {
    question: 'Which frameworks?',
    multiSelect: true,
    options: [{ label: 'React' }, { label: 'Vue' }],
  },
];

describe('makeQuestionApprovalEvent', () => {
  it('test_anchor_builds_standard_question_approval_event', () => {
    const evt = makeQuestionApprovalEvent(42, QS, 'th-aaa-222');

    expect(evt.type).toBe('approval_requested');
    expect(evt.requestId).toBe(42);
    expect(evt.kind).toBe('question');
    expect(evt.threadId).toBe('th-aaa-222');
    expect(evt.turnId).toBe('');
    expect(evt.itemId).toBe('');
    expect(evt.view).toEqual({
      requestId: 42,
      kind: 'question',
      questions: QS,
      availableDecisions: [],
    });
    expect(typeof evt.timestamp).toBe('string');
    expect(evt.timeoutMs).toBeUndefined();
  });

  it('test_anchor_passes_through_timeout_override', () => {
    const evt = makeQuestionApprovalEvent(7, QS, 'th-aaa-222', { timeoutMs: 12_000 });
    expect(evt.timeoutMs).toBe(12_000);
  });
});

describe('mapAnswersByIndex', () => {
  it('test_anchor_aligns_text_keyed_answers_to_question_order', () => {
    const mapped = mapAnswersByIndex(QS, {
      'Which database?': 'PostgreSQL',
      'Which frameworks?': ['React', 'Vue'],
    });

    expect(mapped).toEqual(['PostgreSQL', ['React', 'Vue']]);
  });

  it('test_anchor_preserves_unanswered_slots_as_undefined', () => {
    const mapped = mapAnswersByIndex(QS, { 'Which database?': 'SQLite' });
    expect(mapped).toEqual(['SQLite', undefined]);
  });
});
