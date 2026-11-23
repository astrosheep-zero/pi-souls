/**
 * Circadian light tint for perceptions: smoothly drifts through dawn, daylight, dusk, and deep night
 * in OKLCH space while bypassing muddy yellow/olive angles [62°, 162°).
 */
export type Rgb = [number, number, number];

// Keyframes [localHour, unwrappedHue] on [196°, 420°] (>360° wraps cleanly into [0°, 60°]).
const CIRCADIAN_STOPS: readonly [hour: number, hue: number][] = [
  [0, 248],    // 00:00 midnight sapphire
  [2.5, 196],  // 02:30 deep-night ice cyan
  [4.75, 276], // 04:45 pre-dawn indigo
  [6.5, 344],  // 06:30 dawn sakura
  [9, 400],    // 09:00 (40°) morning apricot
  [12, 420],   // 12:00 (60°) midday warm gold
  [15.5, 404], // 15:30 (44°) afternoon honey
  [18, 368],   // 18:00 (8°) sunset rose-coral
  [20, 322],   // 20:00 dusk orchid
  [22, 284],   // 22:00 evening violet
  [24, 248],   // 24:00 midnight wrap
];

/** Continuous 24-hour local circadian hue in [0, 360), never entering muddy [62°, 162°). */
export function timeHue(at: Date): number {
  const hour = at.getHours() + at.getMinutes() / 60 + at.getSeconds() / 3600;
  for (let i = 0; i < CIRCADIAN_STOPS.length - 1; i++) {
    const [h0, u0] = CIRCADIAN_STOPS[i]!;
    const [h1, u1] = CIRCADIAN_STOPS[i + 1]!;
    if (hour >= h0 && hour <= h1) {
      const t = (hour - h0) / (h1 - h0);
      const ease = 0.5 - 0.5 * Math.cos(Math.PI * t);
      return (((u0 + (u1 - u0) * ease) % 360) + 360) % 360;
    }
  }
  return 248;
}

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
