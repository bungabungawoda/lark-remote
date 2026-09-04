/**
 * Shared contract for the config card's custom-model input field.
 *
 * The card behaviors (field presence, custom-value echo, preset-empty input)
 * are identical across agents; only the fixture (config builder + router) and
 * the field key differ. Both the claude and codex suites drive this contract.
 */
import { expect, describe, it } from 'vitest';
import type { CommandRouter } from '../../src/router/index.js';

export interface CustomModelInputContractOpts {
  /** Build a fresh router whose config uses `model` as the agent's current model. */
  makeRouter: (model: string) => CommandRouter;
  /** Field key of the custom model input, e.g. 'claude.model' or 'agents.codex.model'. */
  key: string;
  /** A model that appears in the preset dropdown options. */
  presetModel: string;
  /** A model that does NOT appear in the preset dropdown options. */
  customModel: string;
}

export function runCustomModelInputContract(opts: CustomModelInputContractOpts): void {
  const { makeRouter, key, presetModel, customModel } = opts;

  describe(`custom model input field contract (${key})`, () => {
    it('should include custom model input field with label 自定义模型名', () => {
      const result = makeRouter(presetModel).buildConfigCard() as { card: object };
      const inputFields = extractInputFields(result.card);

      const customModelInput = inputFields.find(
        (f) => f.label.includes('自定义模型名') && f.key === key,
      );
      expect(customModelInput).toBeDefined();
      expect(customModelInput?.key).toBe(key);
    });

    it('should show custom value in input field when model is not in dropdown options', () => {
      const result = makeRouter(customModel).buildConfigCard() as { card: object };
      const inputFields = extractInputFields(result.card);

      const customModelInput = inputFields.find(
        (f) => f.label.includes('自定义模型名') && f.key === key,
      );
      expect(customModelInput?.defaultValue).toBe(customModel);
    });

    it('should show empty input field when model is in preset options', () => {
      const result = makeRouter(presetModel).buildConfigCard() as { card: object };
      const inputFields = extractInputFields(result.card);

      const customModelInput = inputFields.find(
        (f) => f.label.includes('自定义模型名') && f.key === key,
      );
      expect(customModelInput?.defaultValue).toBe('');
    });
  });
}

/**
 * Extract input fields from a CardKit 2.0 config card by traversing the JSON
 * tree. Labels live in a sibling column (`column_set` left column), the input
 * element itself only carries `name`/`default_value`.
 */
function extractInputFields(
  card: object,
): Array<{ key: string; label: string; defaultValue: string }> {
  const results: Array<{ key: string; label: string; defaultValue: string }> = [];

  function traverse(obj: unknown) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item));
      return;
    }

    const record = obj as Record<string, unknown>;

    // When we find a column_set, process both columns together
    if (record.tag === 'column_set' && record.columns) {
      const columns = record.columns as Array<Record<string, unknown>>;
      let label = '';

      // Left column may contain the label
      if (columns[0]?.elements) {
        const leftElements = columns[0].elements as Array<Record<string, unknown>>;
        for (const el of leftElements) {
          if (el.tag === 'div' && (el.text as { content?: string } | undefined)?.content) {
            const content = (el.text as { content: string }).content;
            // Label may be with or without ** markers
            if (content.startsWith('**') && content.endsWith('**')) {
              label = content.slice(2, -2);
            } else {
              label = content;
            }
            break;
          }
        }
      }

      // Right column may contain the input
      if (columns[1]?.elements) {
        const rightElements = columns[1].elements as Array<Record<string, unknown>>;
        for (const el of rightElements) {
          if (el.tag === 'input' && el.name) {
            results.push({
              key: el.name as string,
              label,
              defaultValue: (el.default_value as string) || '',
            });
          }
        }
      }
      return; // Don't recurse into children again
    }

    for (const value of Object.values(record)) {
      traverse(value);
    }
  }

  traverse(card);
  return results;
}
