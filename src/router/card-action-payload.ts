/**
 * Card action payload assembly (entry layer).
 *
 * Feishu card callbacks arrive as a normalized `CardActionEvent` whose
 * `action` only carries `value/tag/name/option/formValue` — the
 * `@larksuite/channel` normalizer drops everything else (e.g. `input_value`,
 * multi-select `options`). This module rebuilds the full payload that the
 * router consumes, merging the button's behavior `value` with component
 * out-of-band fields.
 *
 * Extracted from src/index.ts so the entry transform is behavior-testable
 * (the main() wiring itself cannot be injected, see index-wiring.test.ts).
 */

import type { CardActionEvent } from '@larksuite/channel';
import type { CardActionPayload } from './index.js';

/**
 * Build the full card action payload for router.handleCardAction.
 *
 * - `option`/`formValue`: select/form components deliver the user's choice
 *   out-of-band in `action.option`/`action.formValue`; button callbacks carry
 *   it in the behavior `value` instead (and `action.option` is absent). The
 *   behavior-value field must survive for buttons, so the component field
 *   only wins when it is actually present.
 * - `inputValue`: CardKit 2.0 input submit-icon callbacks deliver the text in
 *   the raw event (`action.raw.action.input_value`); the SDK normalizer drops
 *   `action.action.input_value`.
 * - `options`: reserved for multi-select components (future agent support);
 *   the SDK normalizer drops `action.options`, so it is read from raw.
 */
export function buildCardActionFullValue(
  actionValue: CardActionPayload,
  action: CardActionEvent,
): CardActionPayload {
  return {
    ...actionValue,
    option: action.action.option ?? actionValue.option,
    formValue: action.action.formValue ?? actionValue.formValue,
    options:
      (action.raw as { action?: { options?: string[] } } | undefined)?.action?.options ??
      actionValue.options,
    inputValue:
      (action.raw as { action?: { input_value?: string } } | undefined)?.action?.input_value ??
      (action.action as { input_value?: string }).input_value,
  };
}
