import qrcode from 'qrcode-generator';
import { currentPlatform, isWin32 } from '../platform/select.js';

/**
 * Terminal rendering for the first-run wizard's QR symbol.
 *
 * Everything is drawn from one module matrix. Two renderers exist because
 * terminals disagree about block glyphs:
 *
 * - `full-block` draws each module as two `█` columns. It only relies on the
 *   full block glyph, which every console font has, and stays square in a
 *   typical 1:2 terminal cell. This is the Windows-safe rendering.
 * - `half-block` packs two QR rows into one text row with `▀`/`▄`. It is half
 *   as tall, but needs a font that draws those glyphs as exact half-height
 *   blocks — Windows consoles (raster/CJK fonts, extra line spacing) often
 *   don't, which is why the symbol printed there often cannot be scanned.
 *
 * Both renderers emit the 4-module light quiet zone the QR spec requires;
 * `qrcode-terminal`'s half-block output had none, and a missing quiet zone
 * alone can make scanners fail.
 *
 * Polarity follows `qrcode-terminal`: glyphs are painted in the foreground
 * colour and stand for the *light* modules, so the terminal's dark background
 * supplies the dark modules (the common default theme).
 */

/** Light modules that must surround a symbol for scanners to lock on (QR spec). */
const QUIET_ZONE = 4;

const LIGHT_FULL = '██';
const DARK_FULL = '  ';
const LIGHT_HALF_BOTH = '█';
const LIGHT_HALF_TOP = '▀';
const LIGHT_HALF_BOTTOM = '▄';
const DARK_HALF_BOTH = ' ';

/** Used when stdout reports no width — non-TTY pipes, and consoles that report 0. */
const DEFAULT_COLUMNS = 80;

export type TerminalQrMode = 'full-block' | 'half-block';

export interface TerminalQr {
  mode: TerminalQrMode;
  /** Columns the rendered symbol occupies — compare against the terminal width. */
  columns: number;
  /** Symbol rows, one text row per line, no trailing newline. */
  text: string;
}

type QrSymbol = ReturnType<typeof qrcode>;

function buildSymbol(text: string): QrSymbol {
  const symbol = qrcode(0, 'L');
  symbol.addData(text);
  symbol.make();
  return symbol;
}

function renderFullBlock(symbol: QrSymbol): string {
  const count = symbol.getModuleCount();
  const lightRow = LIGHT_FULL.repeat(count + QUIET_ZONE * 2);
  const pad = LIGHT_FULL.repeat(QUIET_ZONE);
  const rows = new Array<string>(count + QUIET_ZONE * 2).fill(lightRow);
  for (let row = 0; row < count; row++) {
    let line = pad;
    for (let col = 0; col < count; col++) {
      line += symbol.isDark(row, col) ? DARK_FULL : LIGHT_FULL;
    }
    rows[QUIET_ZONE + row] = line + pad;
  }
  return rows.join('\n');
}

function renderHalfBlock(symbol: QrSymbol): string {
  const count = symbol.getModuleCount();
  // Module counts are always odd (4 * version + 17), so the final row pairs
  // with an implicit light row.
  const textRows = Math.ceil(count / 2);
  const quietRows = QUIET_ZONE / 2;
  const lightRow = LIGHT_HALF_BOTH.repeat(count + QUIET_ZONE * 2);
  const rows = new Array<string>(textRows + quietRows * 2).fill(lightRow);
  for (let pair = 0; pair < count; pair += 2) {
    let line = LIGHT_HALF_BOTH.repeat(QUIET_ZONE);
    for (let col = 0; col < count; col++) {
      const top = symbol.isDark(pair, col);
      const bottom = pair + 1 < count && symbol.isDark(pair + 1, col);
      if (!top && !bottom) line += LIGHT_HALF_BOTH;
      else if (!top) line += LIGHT_HALF_TOP;
      else if (!bottom) line += LIGHT_HALF_BOTTOM;
      else line += DARK_HALF_BOTH;
    }
    rows[quietRows + pair / 2] = line + LIGHT_HALF_BOTH.repeat(QUIET_ZONE);
  }
  return rows.join('\n');
}

/**
 * Render a scannable symbol for the current terminal.
 *
 * Prefers the Windows-safe full-block rendering; when it is too wide for the
 * terminal, POSIX terminals fall back to the compact half-block rendering
 * (macOS/Linux terminals draw its glyphs correctly). Windows deliberately does
 * not: half blocks are exactly what does not scan there, so the caller falls
 * back to the image file instead. Returns `null` when nothing fits.
 */
export function renderTerminalQr(
  text: string,
  options: { columns?: number; platform?: NodeJS.Platform } = {},
): TerminalQr | null {
  const columns = options.columns && options.columns > 0 ? options.columns : DEFAULT_COLUMNS;
  const platform = options.platform ?? currentPlatform;
  const symbol = buildSymbol(text);
  const width = symbol.getModuleCount() + QUIET_ZONE * 2;

  if (width * 2 <= columns) {
    return { mode: 'full-block', columns: width * 2, text: renderFullBlock(symbol) };
  }
  if (!isWin32(platform) && width <= columns) {
    return { mode: 'half-block', columns: width, text: renderHalfBlock(symbol) };
  }
  return null;
}

/**
 * Render the symbol as a GIF.
 *
 * The escape hatch for terminals where block rendering still does not scan
 * (narrow window, missing glyphs): a real image file always scans.
 */
export function renderQrImage(text: string, cellSize = 8): Buffer {
  const symbol = buildSymbol(text);
  const dataUrl = symbol.createDataURL(cellSize);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

/**
 * Whether the wizard should also write the QR image file.
 *
 * Windows always gets the file: its consoles are exactly where block glyphs
 * render unreliably, so the image is the dependable path there. Elsewhere the
 * file is only written when the terminal could not show a symbol at all.
 */
export function needsQrImage(
  terminalQr: TerminalQr | null,
  platform: NodeJS.Platform = currentPlatform,
): boolean {
  return terminalQr === null || isWin32(platform);
}
