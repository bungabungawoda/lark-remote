/**
 * Shared contract for the config card's custom-model input field.
 *
 * The card behaviors (field presence, custom-value echo, preset-empty input)
 * are identical across agents; only the fixture (config builder + router) and
 * the field key differ. Both the claude and codex suites drive this contract.
 */
import { expect, describe, it } from 'vitest';
import type { CommandRouter } from '../../src/router/index.js';
import { extractInputFields } from './card-tree.js';

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
