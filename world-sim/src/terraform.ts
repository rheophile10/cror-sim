/**
 * Earthworks: cutting and filling the terrain to carry the track.
 *
 * `TrackPath` already decides where the railhead goes — a smoothed, grade-limited
 * profile that generally sits well above the ground on the approaches and well
 * below it at the summits. Without this step that profile is a ribbon floating
 * over, or buried inside, a landscape that knows nothing about it.
 *
 * So the ground is made to agree with the railhead: a level formation out to
 * `width` either side, then a side slope at `batter` (run per unit rise) back to
 * whatever the ground was doing. Fills and cuts fall out of the same rule — the
 * only difference is the sign of the difference being blended away.
 *
 * This mutates the height field in place, and it happens *after* every track has
 * been draped, so a second track drapes on the original ground rather than on
 * the first track's embankment. That ordering is a simplification, and it is the
 * thing to revisit when two tracks are meant to share one grade.
 */
import type { Terrain } from './terrain.ts';
import type { TrackPath } from './track.ts';
import { clamp, smoothstep } from './units.ts';

export interface TerraformOptions {
  /** Half-width of the level formation either side of centre line, metres. */
  width?: number;
  /** Side slope, run per unit rise. 2 is a 2:1 batter, about 27°. */
  batter?: number;
  /**
   * Hard cap on how far the earthworks may reach from the centre line, metres.
   *
   * This caps the *length of the side slope*, not the search: works deep enough
   * to want more simply get a steeper batter, and the ground still meets its
   * natural level exactly at the edge. Capping the search instead leaves the
   * slope truncated part-way down, which shows up as a scalloped step ringing
   * every deep cut — continuity here matters more than honouring the batter.
   */
  maxReach?: number;
  /**
   * Stretches of the path the earthworks must leave alone, as distances along
   * it in metres.
   *
   * This is what a bridge is, as far as the ground is concerned: the track
   * crosses without the ground being brought up to meet it. Without it, a
   * trestle over a river valley would arrive to find the valley already filled
   * in by its own embankment.
   *
   * The exclusion is tapered at each end over `abutment` metres so the
   * embankment runs out to nothing at the abutment instead of ending in a wall.
   */
  spans?: readonly { from: number; to: number }[];
  /** Metres over which the earthworks fade out at each end of an excluded span. */
  abutment?: number;
}

export const DEFAULT_TERRAFORM: Required<TerraformOptions> = {
  width: 5,
  batter: 2.5,
  maxReach: 90,
  spans: [],
  abutment: 14,
};

/**
 * Cut and fill `terrain` so it carries `path`.
 *
 * Nodes are claimed by the nearest point on the path, which is what stops a
 * hairpin from having its two legs fight over the ground between them: the
 * closer leg wins outright instead of the two blending into a mound.
 */
export function terraform(
  terrain: Terrain,
  path: TrackPath,
  options: TerraformOptions = {},
): void {
  const opt = { ...DEFAULT_TERRAFORM, ...options };
  const cs = terrain.cellSize;
  const nx = terrain.cols + 1;
  const ny = terrain.rows + 1;

  // The ground as it was, so every node is blended from its own original height
  // and repeated samples cannot ratchet it toward the rail.
  const original = Float64Array.from(terrain.heights);
  // Nearest path sample per node: its distance, and the railhead there.
  const bestDist = new Float64Array(nx * ny).fill(Infinity);
  const bestRail = new Float64Array(nx * ny);
  /** 1 where the earthworks apply in full, 0 under a bridge, between on a taper. */
  const bestWeight = new Float64Array(nx * ny);

  // Every node inside `maxReach` is considered, and how far the works actually
  // extend is decided per node by the blend below. Deriving a tighter search
  // radius from the rise at the *sample* looks like an optimisation and is a
  // bug: the two disagree wherever the ground rises away from the line, which
  // truncates the side slope part-way and leaves a row of teeth along the cut.
  const reach = opt.maxReach;
  for (const sample of path.samples) {
    // How much of the earthworks this sample is entitled to: none in the middle
    // of a bridge, all of it clear of one, and a taper across the abutment.
    const weight = spanWeight(sample.s, opt.spans, opt.abutment);
    if (weight <= 0) continue;
    const c0 = Math.max(0, Math.floor((sample.x - reach) / cs));
    const c1 = Math.min(terrain.cols, Math.ceil((sample.x + reach) / cs));
    const r0 = Math.max(0, Math.floor((sample.y - reach) / cs));
    const r1 = Math.min(terrain.rows, Math.ceil((sample.y + reach) / cs));

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot(c * cs - sample.x, r * cs - sample.y);
        if (d > reach) continue;
        const i = r * nx + c;
        if (d < bestDist[i]!) {
          bestDist[i] = d;
          bestRail[i] = sample.z;
          bestWeight[i] = weight;
        }
      }
    }
  }

  const formation = terrain.formationDrop;
  for (let i = 0; i < bestDist.length; i++) {
    const d = bestDist[i]!;
    if (!Number.isFinite(d)) continue;
    // The formation sits a little below the railhead: the ballast section has
    // depth, and without this the ground would poke through the ties.
    const w = bestWeight[i]!;
    const ground = original[i]!;
    // Under a bridge the ground is left exactly as it was. On the taper the
    // railhead the works aim for is pulled back toward the natural ground, so
    // the embankment shrinks to nothing rather than stopping in a cliff.
    const rail = ground + (bestRail[i]! - formation - ground) * w;
    if (d <= opt.width) {
      terrain.heights[i] = rail;
      continue;
    }
    const slopeLength = clamp(
      opt.batter * Math.abs(rail - ground),
      1e-6,
      Math.max(1e-6, opt.maxReach - opt.width),
    );
    const t = clamp((d - opt.width) / slopeLength, 0, 1);
    terrain.heights[i] = rail + (ground - rail) * smoothstep(t);
  }

  terrain.refreshExtent();
}

/**
 * How much earthwork a point along the path gets, 0 to 1.
 *
 * One inside an excluded span's abutment taper, zero in the middle of it, one
 * everywhere else.
 */
function spanWeight(
  s: number,
  spans: readonly { from: number; to: number }[],
  abutment: number,
): number {
  let weight = 1;
  for (const span of spans) {
    const lo = Math.min(span.from, span.to);
    const hi = Math.max(span.from, span.to);
    if (s <= lo - abutment || s >= hi + abutment) continue;
    if (s >= lo && s <= hi) return 0;
    const into = s < lo ? (lo - s) / abutment : (s - hi) / abutment;
    weight = Math.min(weight, clamp(smoothstep(into), 0, 1));
  }
  return weight;
}
