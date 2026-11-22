/**
 * A perception's day tint: one hue per local calendar day, calibrated in OKLCH so every
 * hue carries the same quiet editorial weight in both dark and light themes.
 */
export const DAY_CHROMA = 0.052;

export interface DayPalette {
  rule: Rgb;
  text: Rgb;
  faint: Rgb;
}

const clampL = (L: number) => Math.min(0.95, Math.max(0.14, L));

/** Derive the quiet editorial palette from a theme's muted and foreground lightness. */
export function dayPalette(mutedL: number, textL: number, hue: number): DayPalette {
  const dir = textL - mutedL;
  return {
    rule: oklch(clampL(mutedL - dir * 0.22), DAY_CHROMA, hue),
    text: oklch(clampL(mutedL + dir * 0.16), 0.022, hue),
    faint: oklch(clampL(mutedL - dir * 0.3), 0.028, hue),
  };
}

/** FNV-1a over `YYYY-MM-DD`, finished with murmur's fmix32: neighbouring days land far apart. */
export function dayHue(at: Date): number {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < day.length; i++) h = Math.imul(h ^ day.charCodeAt(i), 0x01000193);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % 360;
}

export type Rgb = [number, number, number];

const toLinear = (c: number) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toByte = (c: number) => Math.round(255 * Math.min(1, Math.max(0,
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));

/** sRGB → OKLab lightness. */
export function lightness([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/** OKLCH → sRGB. */
export function oklch(L: number, C: number, hue: number): Rgb {
  const a = C * Math.cos((hue * Math.PI) / 180), b = C * Math.sin((hue * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
