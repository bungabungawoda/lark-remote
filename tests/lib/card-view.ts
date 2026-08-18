/**
 * Minimal structural view of a CardKit card for tests that inspect
 * body/header without pulling in the full card renderer types.
 *
 * Replaces `(card as any).body?.elements` patterns with a typed assertion.
 */
export interface CardElementView {
  tag?: string;
  elements?: CardElementView[];
  text?: { content?: string };
}

export interface CardView {
  body?: { elements?: CardElementView[] };
  header?: { title?: { content?: string } };
}
