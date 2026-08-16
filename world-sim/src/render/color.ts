/**
 * Colour helpers, and the terrain ramp.
 *
 * Kept to hex in, hex out, with no dependency on the DOM, so a scene can be
 * rendered headlessly later (node-canvas, an SVG back end) without dragging a
 * colour library along.
 */
import { clamp } from '../units.ts';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): Rgb {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const u = clamp(t, 0, 1);
  return { r: a.r + (b.r - a.r) * u, g: a.g + (b.g - a.g) * u, b: a.b + (b.b - a.b) * u };
}

/** Multiply toward black (`f` < 1) or toward white (`f` > 1). */
export function shade(c: Rgb, f: number): Rgb {
  if (f <= 1) return { r: c.r * f, g: c.g * f, b: c.b * f };
  const t = clamp(f - 1, 0, 1);
  return mix(c, { r: 255, g: 255, b: 255 }, t);
}

export interface RampStop {
  /** Normalised height, 0 at the lowest ground, 1 at the highest. */
  at: number;
  color: string;
}

/**
 * Default ground ramp: wet lowland through grass and scrub to bare rock and
 * snow. Hypsometric, the way a topographic map is coloured, because the point
 * of the colour here is to let you read elevation off a still frame.
 */
export const DEFAULT_RAMP: RampStop[] = [
  { at: 0.0, color: '#3f5d4b' },
  { at: 0.18, color: '#4e7351' },
  { at: 0.4, color: '#6b8355' },
  { at: 0.62, color: '#8a8560' },
  { at: 0.8, color: '#8c7f74' },
  { at: 0.92, color: '#9a9a99' },
  { at: 1.0, color: '#e8ecef' },
];

export function sampleRamp(stops: readonly RampStop[], t: number): Rgb {
  if (stops.length === 0) return { r: 128, g: 128, b: 128 };
  const u = clamp(t, 0, 1);
  let lo = stops[0]!;
  let hi = stops[stops.length - 1]!;
  for (let i = 0; i < stops.length - 1; i++) {
    if (u >= stops[i]!.at && u <= stops[i + 1]!.at) {
      lo = stops[i]!;
      hi = stops[i + 1]!;
      break;
    }
  }
  const span = hi.at - lo.at;
  return mix(parseHex(lo.color), parseHex(hi.color), span === 0 ? 0 : (u - lo.at) / span);
}
