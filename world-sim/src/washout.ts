/**
 * Sea level, and what happens to the railway when it rises.
 *
 * A single number for the whole scene that can be changed while it runs. Raise
 * it and the low ground floods; raise it far enough and it reaches the
 * formation, and the stretches it reaches are **washed out**.
 *
 * ── Why this is worth having ──
 *
 * Almost everything else in this package is a hazard a crew can see coming: a
 * signal, a switch, an animal on the right of way. A washout is the other kind
 * — a piece of railway that was there yesterday and is not there now, and which
 * nothing on the train can detect. The rules written about it are about
 * *reporting* and *protecting*, because the only defence is somebody having
 * found it. Modelling it gives that class of rule something to be about.
 *
 * ── What counts as washed out ──
 *
 * Not "under water". The test is whether the water has reached the **base of
 * the formation** — the ballast section under the ties, `Terrain.formationDrop`
 * below the railhead. Water lapping at the toe of an embankment has not taken
 * the railway away; water at the ties has.
 *
 * That is a simplification with a clear name: nothing here erodes, and a
 * washout appears and disappears the moment the level crosses the threshold.
 * Real ones take a storm to make and a work train to fix, and the ground stays
 * gone after the water goes down. What this models is the *state* — which
 * stretches are out — because that is what a movement and a rulebook care about.
 */
import type { Terrain } from './terrain.ts';
import type { TrackPath } from './track.ts';

/** A stretch of one track the water has taken. */
export interface Washout {
  trackId: string;
  /** Distance along that track, metres. */
  from: number;
  to: number;
  /** How far the water is above the base of the formation, metres. */
  depth: number;
}

export interface WashoutOptions {
  /** How finely each track is examined, metres. */
  step: number;
  /**
   * Shortest stretch worth calling a washout, metres.
   *
   * A metre of low formation at the foot of a bridge abutment is not a washout,
   * and reporting one every time the level ticks past a dip would make the
   * global state useless.
   */
  minLength: number;
}

export const DEFAULT_WASHOUT: WashoutOptions = {
  step: 20,
  minLength: 40,
};

/**
 * Every stretch of railway the water has reached.
 *
 * Bridges are given to the caller to exclude: a trestle standing in a flooded
 * river is doing its job, and the deck is well clear of the water. It is the
 * *embankment* that washes out, not the structure built to avoid needing one.
 */
export function findWashouts(
  tracks: readonly TrackPath[],
  terrain: Terrain,
  seaLevel: number | null,
  isBridged: (trackId: string, at: number) => boolean,
  opt: WashoutOptions = DEFAULT_WASHOUT,
): Washout[] {
  if (seaLevel === null) return [];
  const out: Washout[] = [];

  for (const track of tracks) {
    let start: number | null = null;
    let deepest = 0;
    for (let s = 0; s <= track.length + opt.step; s += opt.step) {
      const at = Math.min(s, track.length);
      const pt = track.at(at);
      const formation = pt.z - terrain.formationDrop;
      const under = at <= track.length && !isBridged(track.id, at) && seaLevel >= formation;

      if (under) {
        if (start === null) start = at;
        deepest = Math.max(deepest, seaLevel - formation);
      } else if (start !== null) {
        close(out, track.id, start, at - opt.step, deepest, opt);
        start = null;
        deepest = 0;
      }
    }
    // A run still open at the far end is a track that is under water all the
    // way to its end — the commonest case of all once the sea is high, and the
    // one that produced no washouts at all until it was closed here.
    if (start !== null) close(out, track.id, start, track.length, deepest, opt);
  }
  return out;
}

function close(
  out: Washout[],
  trackId: string,
  from: number,
  to: number,
  depth: number,
  opt: WashoutOptions,
): void {
  if (to - from >= opt.minLength) out.push({ trackId, from, to, depth });
}

/** Whether a point on a track is inside a washout. */
export function washedOutAt(
  washouts: readonly Washout[],
  trackId: string,
  at: number,
): Washout | null {
  for (const w of washouts) {
    if (w.trackId === trackId && at >= w.from && at <= w.to) return w;
  }
  return null;
}
