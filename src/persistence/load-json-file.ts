import fs from 'node:fs';
import { getLogger } from '../logger/index.js';

/**
 * Load and parse a JSON file with fallback on corruption.
 * Returns the parsed data or the fallback value if loading fails.
 *
 * @param filePath - Path to the JSON file
 * @param fallback - Value to return if file doesn't exist or is corrupted
 * @param parseFn - Optional custom parser (defaults to JSON.parse)
 */
export function loadJsonFile<T>(
  filePath: string,
  fallback: T,
  parseFn: (raw: string) => T = JSON.parse,
): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return parseFn(raw);
  } catch (err) {
    getLogger().warn(`[persistence] failed to load ${filePath}, using fallback:`, err);
    return fallback;
  }
}
