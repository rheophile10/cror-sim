/**
 * Bridges: the track carried over ground the earthworks are not allowed to fill.
 *
 * A bridge is defined by what it *stops* happening as much as by what it adds.
 * `TrackPath` already puts the railhead on a smoothed, grade-limited profile, and
 * `terraform` normally brings the ground up to meet it — so a line crossing a
 * river valley would, without this, simply fill the valley in. Declaring a span
 * excludes that stretch from the earthworks (`TerraformOptions.spans`), and what
 * is left is a railhead in mid-air with a hole under it. The structure drawn here
 * is what stands in the hole.
 *
 * ── What is modelled, and what is not ──
 *
 * The **geometry** is modelled: where the deck is, how high above the ground,
 * and where each bent stands. That is enough to draw it, enough to see that a
 * grade line is carried rather than cut, and enough to say a movement is on a
 * bridge — which is the fact a rule would ask about.
 *
 * The **structure** is not. There is no load path, nothing fails, and a bridge
 * cannot be washed out. A trestle here is a picture of a trestle with correct
 * dimensions, in the same spirit as a person being a marker that happens to be
 * person-shaped.
 */

export type BridgeKind =
  /** Timber or steel pile bents at close centres. What a prairie river gets. */
  | 'trestle'
  /** A plate-girder span sitting on two abutments and nothing between. */
  | 'deck-girder';

export interface BridgeSpec {
  id?: string;
  label?: string;
  /** Which track it carries. Defaults to the scene's first. */
  track?: string;
  /**
   * Or which **road** it carries, by id.
   *
   * A road crossing a river has the same problem the railway does and the same
   * answer: it cannot simply dip into the water. Given a road, the deck is
   * lifted clear of the surface across the span and this structure is put under
   * it — the same bents, drawn by the same code.
   */
  road?: string;
  /** Distance of each end along that track or road, metres. */
  from: number;
  to: number;
  kind?: BridgeKind;
  /** Spacing of the bents, metres. Ignored by a girder span. */
  bentSpacing?: number;
  /** Width of the deck, metres. */
  width?: number;
  color?: string;
}

/** One frame of piles carrying the deck. */
export interface Bent {
  /** Distance along the track, metres. */
  s: number;
  x: number;
  y: number;
  /** Ground level here — the foot of the piles. */
  ground: number;
  /** Underside of the deck — the head of the piles. */
  deck: number;
  /** Heading of the track through it, so the bent stands square to the line. */
  heading: number;
}

export interface Bridge {
  id: string;
  label: string;
  trackId: string | undefined;
  roadId: string | undefined;
  from: number;
  to: number;
  kind: BridgeKind;
  width: number;
  color: string;
  /** Deck centre line, sampled. */
  deck: { s: number; x: number; y: number; z: number; heading: number }[];
  bents: Bent[];
  /** Greatest height of the railhead above the ground under it, metres. */
  maxHeight: number;
}

export const DEFAULT_BENT_SPACING = 5;

export interface BridgeSource {
  /** Railhead and heading at a distance along the track. */
  at(s: number): { x: number; y: number; z: number; heading: number };
  length: number;
}

export function buildBridge(
  spec: BridgeSpec,
  index: number,
  track: BridgeSource | undefined,
  groundAt: (x: number, y: number) => number,
): Bridge {
  const from = Math.min(spec.from, spec.to);
  const to = Math.max(spec.from, spec.to);
  const kind = spec.kind ?? 'trestle';
  const bridge: Bridge = {
    id: spec.id ?? `bridge-${index}`,
    label: spec.label ?? `Bridge ${index + 1}`,
    trackId: spec.road ? undefined : spec.track,
    roadId: spec.road,
    from,
    to,
    kind,
    width: spec.width ?? 5.2,
    color: spec.color ?? (kind === 'trestle' ? '#5b4a38' : '#6b6f74'),
    deck: [],
    bents: [],
    maxHeight: 0,
  };
  if (!track) return bridge;

  // The deck is sampled finely enough to follow a curve; the bents are placed
  // on their own spacing, because a bent every two metres is a fence.
  const step = 4;
  for (let s = from; s <= to + 1e-6; s = Math.min(s + step, to)) {
    const pt = track.at(s);
    bridge.deck.push({ s, x: pt.x, y: pt.y, z: pt.z, heading: pt.heading });
    if (s >= to) break;
  }

  const spacing = spec.bentSpacing ?? DEFAULT_BENT_SPACING;
  // A girder span stands on its abutments and nothing else, which is the whole
  // difference between the two kinds: one is a row of legs, the other is a beam.
  const positions =
    kind === 'deck-girder'
      ? [from, to]
      : Array.from({ length: Math.max(2, Math.floor((to - from) / spacing) + 1) }, (_, i) =>
          Math.min(to, from + i * spacing),
        );

  for (const s of positions) {
    const pt = track.at(s);
    const ground = groundAt(pt.x, pt.y);
    const height = pt.z - ground;
    if (height > bridge.maxHeight) bridge.maxHeight = height;
    bridge.bents.push({ s, x: pt.x, y: pt.y, ground, deck: pt.z, heading: pt.heading });
  }
  return bridge;
}

/** Whether a distance along a track is out over a bridge. */
export function onBridge(bridges: readonly Bridge[], trackId: string, at: number): Bridge | null {
  for (const bridge of bridges) {
    if (bridge.trackId === trackId && at >= bridge.from && at <= bridge.to) return bridge;
  }
  return null;
}
