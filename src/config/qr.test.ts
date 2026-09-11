import { describe, it, expect } from 'vitest';
import qrcode from 'qrcode-generator';
import { needsQrImage, renderQrImage, renderTerminalQr, type TerminalQr } from './qr.js';

const URL = 'https://accounts.example.com/oauth/v1/app/registration?user_code=A1B2-C3D4';
const QUIET_ZONE = 4;

/** The matrix the encoder produced, as the renderers must reproduce it. */
function encodedMatrix(text: string): boolean[][] {
  const symbol = qrcode(0, 'L');
  symbol.addData(text);
  symbol.make();
  const count = symbol.getModuleCount();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => symbol.isDark(row, col)),
  );
}

/** Full-block rows are two columns per module; `██` is a light module. */
function parseFullBlock(text: string): boolean[][] {
  return text
    .split('\n')
    .map((line) => [...line].filter((_, index) => index % 2 === 0).map((glyph) => glyph === ' '));
}

/** Half-block glyphs pack two QR rows per text row. */
const HALF_BLOCK_MODULES: Record<string, [boolean, boolean]> = {
  '█': [false, false],
  '▀': [false, true],
  '▄': [true, false],
  ' ': [true, true],
};

function parseHalfBlock(text: string): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of text.split('\n')) {
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const [upper, lower] of [...line].map((glyph) => HALF_BLOCK_MODULES[glyph])) {
      top.push(upper);
      bottom.push(lower);
    }
    rows.push(top, bottom);
  }
  return rows;
}

function stripQuietZone(matrix: boolean[][]): boolean[][] {
  const size = matrix.length - QUIET_ZONE * 2;
  return matrix
    .slice(QUIET_ZONE, QUIET_ZONE + size)
    .map((row) => row.slice(QUIET_ZONE, QUIET_ZONE + size));
}

function rowsOf(qr: TerminalQr): string[] {
  return qr.text.split('\n');
}

describe('renderTerminalQr', () => {
  it('draws full blocks without the half-height glyphs Windows renders wrong', () => {
    const qr = renderTerminalQr(URL, { columns: 200, platform: 'win32' });

    expect(qr?.mode).toBe('full-block');
    expect(qr?.text).toContain('█');
    expect(qr?.text).not.toContain('▀');
    expect(qr?.text).not.toContain('▄');
    expect(qr?.text).not.toContain('\u001b');
  });

  it('reproduces the encoded matrix inside a 4-module quiet zone', () => {
    const qr = renderTerminalQr(URL, { columns: 200, platform: 'win32' })!;
    const matrix = parseFullBlock(qr.text);

    expect(stripQuietZone(matrix)).toEqual(encodedMatrix(URL));
    for (const row of [0, 1, 2, 3, matrix.length - 4, matrix.length - 1]) {
      expect(matrix[row].every((dark) => !dark)).toBe(true);
    }
    for (const line of matrix) {
      expect(line.slice(0, QUIET_ZONE).every((dark) => !dark)).toBe(true);
      expect(line.slice(-QUIET_ZONE).every((dark) => !dark)).toBe(true);
    }
  });

  it('renders every row at the reported column width', () => {
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      const qr = renderTerminalQr(URL, { columns: 200, platform })!;
      expect(new Set(rowsOf(qr).map((line) => [...line].length))).toEqual(new Set([qr.columns]));
    }
  });

  it('falls back to half blocks on POSIX when full blocks do not fit', () => {
    const full = renderTerminalQr(URL, { columns: 200, platform: 'linux' })!;
    const half = renderTerminalQr(URL, { columns: 70, platform: 'linux' })!;
    const modules = encodedMatrix(URL).length;
    const matrix = parseHalfBlock(half.text);

    expect(half.mode).toBe('half-block');
    expect(rowsOf(half).length).toBeLessThan(rowsOf(full).length);
    const symbol = matrix
      .slice(QUIET_ZONE, QUIET_ZONE + modules)
      .map((row) => row.slice(QUIET_ZONE, -QUIET_ZONE));
    expect(symbol).toEqual(encodedMatrix(URL));
    // Odd module counts leave a light padding row before the bottom quiet zone.
    for (const row of [0, 1, 2, 3, matrix.length - 4, matrix.length - 1]) {
      expect(matrix[row].every((dark) => !dark)).toBe(true);
    }
  });

  it('never falls back to half blocks on Windows', () => {
    expect(renderTerminalQr(URL, { columns: 70, platform: 'win32' })).toBeNull();
  });

  it('returns null when the symbol cannot fit any terminal width', () => {
    expect(renderTerminalQr(URL, { columns: 10, platform: 'linux' })).toBeNull();
  });

  it('treats a missing or zero terminal width as 80 columns', () => {
    const expected = renderTerminalQr(URL, { columns: 80, platform: 'linux' })!;

    expect(renderTerminalQr(URL, { platform: 'linux' })?.text).toBe(expected.text);
    expect(renderTerminalQr(URL, { columns: 0, platform: 'linux' })?.text).toBe(expected.text);
  });
});

describe('renderQrImage', () => {
  it('encodes the symbol as a GIF at the requested scale', () => {
    const modules = encodedMatrix(URL).length;
    const size = modules + QUIET_ZONE * 2;

    for (const cellSize of [1, 8]) {
      const image = renderQrImage(URL, cellSize);

      expect(image.subarray(0, 6).toString('ascii')).toBe('GIF87a');
      expect(image.readUInt16LE(6)).toBe(size * cellSize);
      expect(image.readUInt16LE(8)).toBe(size * cellSize);
    }
  });
});

describe('needsQrImage', () => {
  const qr: TerminalQr = { mode: 'full-block', columns: 60, text: '' };

  it('always writes the image on Windows', () => {
    expect(needsQrImage(qr, 'win32')).toBe(true);
  });

  it('writes the image elsewhere only when no symbol was shown', () => {
    expect(needsQrImage(qr, 'darwin')).toBe(false);
    expect(needsQrImage(null, 'darwin')).toBe(true);
  });
});
