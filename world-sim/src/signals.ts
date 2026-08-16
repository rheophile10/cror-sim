/**
 * Signals: the ones on a mast, and the ones a person puts in the field.
 *
 * These are two different things and they are modelled separately, following
 * `CROR/sim`'s `entities/infrastructure/signals.ts`. A **fixed signal** stands
 * on a mast, governs movements on a track in one direction, and is read for its
 * aspect. A **field signal** — a flag — is displayed *by somebody*, means
 * workmen or track work, and the rules care about who put it there and whether
 * it sits between the rails or beside them.
 *
 * ── The aspect catalogue ──
 *
 * `ASPECTS` is the CROR signal table, rules 405 to 439: name, indication, the
 * lamps that display it, and the speed it permits. It is transcribed from
 * `internal-tools/seeds/signals-live.json`, which comes in turn from
 * `rail-document-db/pipelines/flashcards/signals.csv` — the same data the study
 * decks are drawn from, so a signal here shows what a signal there shows.
 *
 * Two speeds hang off every aspect and they are not the same question:
 * `passing` is what is permitted *at* the signal, `next` is what must be
 * arranged for by the *next* one. That is the whole grammar of North American
 * speed signalling — "Clear to Medium" is a green over a green, permits track
 * speed here, and requires medium at the signal ahead — and it is why an aspect
 * cannot be reduced to a single number.
 *
 * ── What decides an aspect ──
 *
 * A signal in `automatic` mode reads the railway ahead of it and works out what
 * it should be showing: occupied block gives Stop (or Stop and Proceed if it is
 * permissive), a Stop ahead gives Clear to Stop, a Clear to Stop ahead gives
 * Advance Clear to Stop, and otherwise Clear. That is the classic three- and
 * four-block progression, and it falls out of the catalogue rather than being
 * hard-coded speeds. A signal can also be pinned to a named aspect, which is
 * what a scene does when it wants a particular situation on the ground.
 *
 * What is **not** here: nothing enforces a signal. A movement can and will run
 * straight past a Stop, because whether it should have is a question for the
 * rules layer, not the physics. What this provides is the true answer to "what
 * is the signal ahead of this movement showing, and how far away is it".
 */
import type { Network } from './network.ts';
import { buildRoute } from './route.ts';
import type { TrackPath } from './track.ts';
import type { Train } from './train.ts';
import { mphToMps } from './units.ts';

/**
 * Speed classes as CROR uses them. `normal` means the permissible track speed,
 * whatever that is here; the rest are fixed ceilings.
 */
export type SpeedClass =
  | 'normal'
  | 'limited'
  | 'medium'
  | 'diverging'
  | 'slow'
  | 'restricted'
  | 'stop';

/**
 * Ceilings in mph. `diverging` is "as prescribed in special instructions" and
 * has no single value in the rules; 25 is the common one and a scene can say
 * otherwise. `restricted` carries a second requirement no number can hold —
 * being able to stop within half the range of vision — which is why a rules
 * layer must read the class and not just the ceiling.
 */
export const SPEED_LIMITS: Record<SpeedClass, number | null> = {
  normal: null,
  limited: 45,
  medium: 30,
  diverging: 25,
  slow: 15,
  restricted: 15,
  stop: 0,
};

export function speedLimitMps(cls: SpeedClass, trackSpeedMph?: number): number | null {
  const mph = SPEED_LIMITS[cls];
  if (mph === null) return trackSpeedMph === undefined ? null : mphToMps(trackSpeedMph);
  return mphToMps(mph);
}

/** One row of the CROR signal table. */
export interface Aspect {
  /** The rule that names it: '405' through '439'. */
  rule: string;
  name: string;
  indication: string;
  /** Speed permitted passing this signal. */
  passing: SpeedClass;
  /** Speed to be prepared for at the next signal — or the second one, if `advance`. */
  next: SpeedClass;
  /** True where the requirement applies two signals ahead rather than one. */
  advance?: boolean;
  /** Lamps top to bottom, as displayed on a high mast. */
  lamps: string[];
  /** Plates carried below the heads: L, DV, R, A. */
  plates?: string[];
}

export const ASPECTS: readonly Aspect[] = [
  {
    rule: '405',
    name: 'Clear',
    indication: 'Proceed.',
    passing: 'normal',
    next: 'normal',
    lamps: ['green', 'red', 'red'],
  },
  {
    rule: '406',
    name: 'Clear To Limited',
    indication: 'Proceed, approaching next signal at LIMITED speed.',
    passing: 'normal',
    next: 'limited',
    lamps: ['green', 'red', 'flashing green'],
  },
  {
    rule: '407',
    name: 'Clear To Medium',
    indication: 'Proceed, approaching next signal at MEDIUM speed.',
    passing: 'normal',
    next: 'medium',
    lamps: ['green', 'red', 'green'],
  },
  {
    rule: '408',
    name: 'Clear To Diverging',
    indication: 'Proceed, approaching next signal at DIVERGING speed.',
    passing: 'normal',
    next: 'diverging',
    lamps: ['green', 'red', 'flashing yellow'],
    plates: ['DV'],
  },
  {
    rule: '409',
    name: 'Clear To Slow',
    indication: 'Proceed, approaching next signal at SLOW speed.',
    passing: 'normal',
    next: 'slow',
    lamps: ['green', 'red', 'flashing yellow'],
  },
  {
    rule: '410',
    name: 'Clear To Restricting',
    indication: 'Proceed, next signal is displaying restricting signal.',
    passing: 'normal',
    next: 'restricted',
    lamps: ['yellow', 'red', 'flashing red'],
  },
  {
    rule: '411',
    name: 'Clear To Stop',
    indication: 'Proceed, preparing to stop at next signal. Freight trains must reduce 10 mph less than permissible track speed. Reduction in speed must commence prior to passing signal.',
    passing: 'normal',
    next: 'stop',
    lamps: ['yellow', 'red', 'red'],
  },
  {
    rule: '412',
    name: 'Advance Clear To Limited',
    indication: 'Proceed, approaching second signal at LIMITED speed.',
    passing: 'normal',
    next: 'limited',
    advance: true,
    lamps: ['flashing yellow', 'flashing green', 'red'],
  },
  {
    rule: '413',
    name: 'Advance Clear To Medium',
    indication: 'Proceed, approaching second signal at MEDIUM speed.',
    passing: 'normal',
    next: 'medium',
    advance: true,
    lamps: ['flashing yellow', 'green', 'red'],
  },
  {
    rule: '414',
    name: 'Advance Clear To Slow',
    indication: 'Proceed, approaching second signal at SLOW speed.',
    passing: 'normal',
    next: 'slow',
    advance: true,
    lamps: ['flashing yellow', 'yellow', 'red'],
  },
  {
    rule: '415',
    name: 'Advance Clear To Stop',
    indication: 'Proceed, prepared to Stop at second signal.',
    passing: 'normal',
    next: 'stop',
    advance: true,
    lamps: ['flashing yellow', 'red', 'red'],
  },
  {
    rule: '416',
    name: 'Limited To Clear',
    indication: 'Proceed, LIMITED speed passing signal and through turnouts',
    passing: 'limited',
    next: 'normal',
    lamps: ['red', 'flashing green', 'red'],
  },
  {
    rule: '417',
    name: 'Limited To Limited',
    indication: 'Proceed, LIMITED speed passing signal and through turnouts, approaching next signal at LIMITED speed.',
    passing: 'limited',
    next: 'limited',
    lamps: ['red', 'flashing green', 'flashing green'],
  },
  {
    rule: '418',
    name: 'Limited To Medium',
    indication: 'Proceed, LIMITED speed passing signal and through turnouts, approaching next signal at MEDIUM speed.',
    passing: 'limited',
    next: 'medium',
    lamps: ['red', 'flashing green', 'green'],
  },
  {
    rule: '419',
    name: 'Limited To Slow',
    indication: 'Proceed, LIMITED speed passing signal and through turnouts, approaching next signal at SLOW speed.',
    passing: 'limited',
    next: 'slow',
    lamps: ['red', 'flashing green', 'flashing yellow'],
  },
  {
    rule: '421',
    name: 'Limited To Stop',
    indication: 'Proceed, LIMITED speed passing signal and through turnouts, preparing to stop at next signal.',
    passing: 'limited',
    next: 'stop',
    lamps: ['red', 'flashing yellow', 'red'],
  },
  {
    rule: '422',
    name: 'Medium To Clear',
    indication: 'Proceed, MEDIUM speed passing signal and through turnouts',
    passing: 'medium',
    next: 'normal',
    lamps: ['red', 'green', 'red'],
  },
  {
    rule: '423',
    name: 'Medium To Limited',
    indication: 'Proceed, MEDIUM speed passing signal and through turnouts, approaching next signal at LIMITED speed.',
    passing: 'medium',
    next: 'limited',
    lamps: ['red', 'green', 'flashing green'],
  },
  {
    rule: '424',
    name: 'Medium To Medium',
    indication: 'Proceed, MEDIUM speed passing signal and through turnouts, approaching next signal at MEDIUM speed.',
    passing: 'medium',
    next: 'medium',
    lamps: ['red', 'green', 'green'],
  },
  {
    rule: '425',
    name: 'Medium To Slow',
    indication: 'Proceed, MEDIUM speed passing signal and through turnouts, approaching next signal at SLOW speed.',
    passing: 'medium',
    next: 'slow',
    lamps: ['red', 'green', 'flashing yellow'],
  },
  {
    rule: '427',
    name: 'Medium To Stop',
    indication: 'Proceed, MEDIUM speed passing signal and through turnouts, preparing to stop at next signal.',
    passing: 'medium',
    next: 'stop',
    lamps: ['red', 'yellow', 'red'],
  },
  {
    rule: '428',
    name: 'Diverging To Clear',
    indication: 'Proceed, DIVERGING speed passing signal and through turnouts',
    passing: 'diverging',
    next: 'normal',
    lamps: ['red', 'red', 'green'],
    plates: ['DV'],
  },
  {
    rule: '429',
    name: 'Diverging To Stop',
    indication: 'Proceed, DIVERGING speed passing signal and through turnouts preparing to stop at next signal.',
    passing: 'diverging',
    next: 'stop',
    lamps: ['red', 'red', 'flashing yellow'],
    plates: ['DV'],
  },
  {
    rule: '430',
    name: 'Diverging',
    indication: 'Proceed at REDUCED speed, not exceeding DIVERGING speed passing signal and through turnouts.',
    passing: 'diverging',
    next: 'diverging',
    lamps: ['red', 'red', 'yellow'],
    plates: ['DV'],
  },
  {
    rule: '431',
    name: 'Slow To Clear',
    indication: 'Proceed, SLOW speed passing signal and through turnouts',
    passing: 'slow',
    next: 'normal',
    lamps: ['red', 'red', 'green'],
  },
  {
    rule: '432',
    name: 'Slow To Limited',
    indication: 'Proceed, SLOW speed passing signal and through turnouts, approaching next signal at LIMITED speed.',
    passing: 'slow',
    next: 'limited',
    lamps: ['red', 'flashing yellow', 'flashing green'],
  },
  {
    rule: '433',
    name: 'Slow To Medium',
    indication: 'Proceed, SLOW speed passing signal and through turnouts, approaching next signal at MEDIUM speed.',
    passing: 'slow',
    next: 'medium',
    lamps: ['red', 'flashing yellow', 'green'],
  },
  {
    rule: '434',
    name: 'Slow To Slow',
    indication: 'Proceed, SLOW speed passing signal and through turnouts, approaching next signal at SLOW speed.',
    passing: 'slow',
    next: 'slow',
    lamps: ['red', 'flashing yellow', 'flashing yellow'],
  },
  {
    rule: '435',
    name: 'Slow To Stop',
    indication: 'Proceed, SLOW speed passing signal and through turnouts, preparing to stop at next signal.',
    passing: 'slow',
    next: 'stop',
    lamps: ['red', 'red', 'flashing yellow'],
  },
  {
    rule: '436',
    name: 'Restricting',
    indication: 'Proceed at RESTRICTED speed.',
    passing: 'restricted',
    next: 'restricted',
    lamps: ['red', 'red', 'yellow'],
  },
  {
    rule: '437',
    name: 'Stop and Proceed',
    indication: 'Stop, then proceed at RESTRICTED speed.',
    passing: 'restricted',
    next: 'restricted',
    lamps: ['red'],
  },
  {
    rule: '439',
    name: 'Stop',
    indication: 'Stop.',
    passing: 'stop',
    next: 'stop',
    lamps: ['red', 'red', 'red'],
  },
  {
    rule: '414A',
    name: 'Advance Clear To Diverging',
    indication: 'Proceed, approaching second signal at DIVERGING speed',
    passing: 'normal',
    next: 'diverging',
    advance: true,
    lamps: ['flashing yellow', 'yellow', 'red'],
    plates: ['DV'],
  },
  {
    rule: '419A',
    name: 'Limited To Diverging',
    indication: 'Proceed, LIMITED speed passing signal and through turnouts, approaching next signal at DIVERGING speed.',
    passing: 'limited',
    next: 'diverging',
    lamps: ['red', 'flashing green', 'flashing yellow'],
    plates: ['DV'],
  },
  {
    rule: '425A',
    name: 'Medium To Diverging',
    indication: 'Proceed, MEDIUM speed passing signal and through turnouts, approaching next signal at DIVERGING speed.',
    passing: 'medium',
    next: 'diverging',
    lamps: ['red', 'green', 'flashing yellow'],
    plates: ['DV'],
  },
  {
    rule: '433A',
    name: 'Diverging To Medium',
    indication: 'Proceed, DIVERGING speed passing signal and through turnouts, approaching next signal at MEDIUM speed.',
    passing: 'diverging',
    next: 'medium',
    lamps: ['red', 'yellow', 'green'],
    plates: ['DV'],
  },
  {
    rule: '434A',
    name: 'Diverging To Diverging',
    indication: 'Proceed, DIVERGING speed passing signal and through turnouts, approaching next signal at DIVERGING speed.',
    passing: 'diverging',
    next: 'diverging',
    lamps: ['red', 'flashing yellow', 'flashing yellow'],
    plates: ['DV'],
  },
];

const BY_NAME = new Map(ASPECTS.map((a) => [a.name.toLowerCase(), a]));
const BY_RULE = new Map(ASPECTS.map((a) => [a.rule, a]));

export function aspectByName(name: string): Aspect | undefined {
  return BY_NAME.get(name.trim().toLowerCase());
}

export function aspectByRule(rule: string): Aspect | undefined {
  return BY_RULE.get(rule.trim());
}

/** The aspect a signal falls back to when nothing else can be worked out. */
export const STOP = aspectByRule('439')!;


// ─────────────────────────────────────────────────────── signals in the field

/**
 * Which way a signal faces.
 *
 * A signal governs movements running *toward* it, so `up` governs movements
 * travelling with increasing mileage on its track and `down` those travelling
 * against it. A signal facing the wrong way is invisible to a movement, which is
 * correct: you cannot read the back of a signal head.
 */
export type Facing = 'up' | 'down';

export type SignalControl = 'automatic' | 'controlled' | 'fixed';

export interface SignalSpec {
  id?: string;
  label?: string;
  /** Which track it stands beside. Defaults to the scene's first. */
  track?: string;
  /** Mileage along that track, metres. */
  at: number;
  facing?: Facing;
  mast?: 'high' | 'low' | 'dwarf';
  plates?: string[];
  /**
   * Pin the aspect instead of working it out. Give a name ('Restricting') or a
   * rule number ('436').
   */
  aspect?: string;
  /**
   * A permissive signal displays Stop and Proceed rather than Stop when the
   * block ahead is occupied — the difference between an intermediate signal and
   * an absolute one at a controlled location.
   */
  permissive?: boolean;
  /**
   * How the signal is worked.
   *
   *   - `automatic` — an intermediate signal. Nobody operates it; it reads the
   *     block ahead and displays what it finds. Most signals on a subdivision.
   *   - `controlled` — a signal at a controlled location, cleared by the RTC for
   *     a specific route. It displays Stop until somebody clears it, and what it
   *     shows when cleared depends on which way the switches ahead are lined.
   *   - `fixed` — pinned to one aspect by the scene, and left alone.
   */
  control?: SignalControl;
  /** For a controlled signal: whether the RTC has cleared it. */
  cleared?: boolean;
  /**
   * The speed class of the diverging route at a controlled signal — which of
   * the Limited, Medium, Diverging or Slow families it displays when lined for
   * the turnout. CROR hangs this on the physical turnout, not on the signal, so
   * a scene states it.
   */
  divergingClass?: 'limited' | 'medium' | 'diverging' | 'slow';
  /** Which side of the track the mast stands on, seen along `facing`. */
  side?: 'left' | 'right';
}

export interface Signal {
  id: string;
  label: string | undefined;
  trackId: string | undefined;
  at: number;
  facing: Facing;
  mast: 'high' | 'low' | 'dwarf';
  plates: string[];
  permissive: boolean;
  control: SignalControl;
  /** For a controlled signal: whether the RTC has cleared it. */
  cleared: boolean;
  divergingClass: 'limited' | 'medium' | 'diverging' | 'slow';
  /** True when the route ahead of it is lined through a turnout. */
  divergingRoute: boolean;
  side: 'left' | 'right';
  /** Set when the scene pinned an aspect; null when it is worked out each step. */
  fixed: Aspect | null;
  /** What it is displaying now. */
  aspect: Aspect;
  /** Where it stands in the world, filled in once the track is known. */
  x: number;
  y: number;
  z: number;
  heading: number;
}

export function buildSignal(spec: SignalSpec, index: number, track: TrackPath | undefined): Signal {
  const fixed = spec.aspect ? (aspectByName(spec.aspect) ?? aspectByRule(spec.aspect) ?? null) : null;
  const facing = spec.facing ?? 'up';
  const signal: Signal = {
    id: spec.id ?? `signal-${index}`,
    label: spec.label,
    trackId: spec.track ?? track?.id,
    at: spec.at,
    facing,
    mast: spec.mast ?? 'high',
    plates: spec.plates ?? [],
    permissive: spec.permissive ?? false,
    control: spec.control ?? (fixed ? 'fixed' : 'automatic'),
    cleared: spec.cleared ?? false,
    divergingClass: spec.divergingClass ?? 'medium',
    divergingRoute: false,
    side: spec.side ?? 'right',
    fixed,
    aspect: fixed ?? STOP,
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
  };
  if (track) {
    const pt = track.at(spec.at);
    signal.x = pt.x;
    signal.y = pt.y;
    signal.z = pt.z;
    signal.heading = pt.heading + (facing === 'up' ? 0 : Math.PI);
  }
  return signal;
}

/** Flags, as `CROR/sim` has them: displayed by a person, meaning workmen or track work. */
export type FlagColour = 'blue' | 'red' | 'yellow' | 'green';

export interface FlagSpec {
  id?: string;
  label?: string;
  track?: string;
  at: number;
  /**
   * The flags on the staff, top first. Usually one — but Rule 42's advance
   * signal is a yellow over red on a single staff, and treating that as two
   * objects would let a scene say something that cannot exist in the field.
   */
  colours: FlagColour[];
  facing?: Facing;
  /** 41: track work protection is displayed *between the rails*. */
  placement?: 'between-rails' | 'beside' | 'on-equipment';
  form?: 'flag' | 'light' | 'both';
  /** 26(c): the class of workmen who put it there, and only they may remove it. */
  displayedBy?: string;
  /** The rule it is displayed under: 26, 41, 42, 43. */
  rule?: string;
}

export interface Flag {
  id: string;
  label: string | undefined;
  trackId: string | undefined;
  at: number;
  colours: FlagColour[];
  facing: Facing | undefined;
  placement: 'between-rails' | 'beside' | 'on-equipment';
  form: 'flag' | 'light' | 'both';
  displayedBy: string | undefined;
  rule: string | undefined;
  x: number;
  y: number;
  z: number;
  heading: number;
}

export function buildFlag(spec: FlagSpec, index: number, track: TrackPath | undefined): Flag {
  const flag: Flag = {
    id: spec.id ?? `flag-${index}`,
    label: spec.label,
    trackId: spec.track ?? track?.id,
    at: spec.at,
    colours: spec.colours.length > 0 ? spec.colours : ['red'],
    facing: spec.facing,
    placement: spec.placement ?? (spec.colours[0] === 'red' ? 'between-rails' : 'beside'),
    form: spec.form ?? 'flag',
    displayedBy: spec.displayedBy,
    rule: spec.rule,
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
  };
  if (track) {
    const pt = track.at(spec.at);
    flag.x = pt.x;
    flag.y = pt.y;
    flag.z = pt.z;
    flag.heading = pt.heading;
  }
  return flag;
}

// ──────────────────────────────────────────────────────────── block signalling

/** Everything a movement needs to know about the signal in front of it. */
export interface SignalSighting {
  signal: Signal;
  /** Metres from the movement's leading end to the signal. */
  distance: number;
}

/**
 * The aspect that approaches a signal requiring `cls` at the next one.
 *
 * This is the grammar of speed signalling written down once: "Clear to X" means
 * proceed now and be at X speed at the next signal, and the catalogue already
 * holds one for every X. Looking the aspect up by name from the class is what
 * makes an approach to a diverging route fall out for free — the signal behind
 * a Medium to Clear shows Clear to Medium without anybody writing that case.
 */
function approachTo(cls: SpeedClass): Aspect {
  switch (cls) {
    case 'stop':
      return aspectByRule('411')!; // Clear To Stop
    case 'restricted':
      return aspectByRule('410')!; // Clear To Restricting
    case 'limited':
      return aspectByRule('406')!;
    case 'medium':
      return aspectByRule('407')!;
    case 'diverging':
      return aspectByRule('408')!;
    case 'slow':
      return aspectByRule('409')!;
    case 'normal':
      return aspectByRule('405')!; // Clear
  }
}

/** The advance aspect that gives a second signal's worth of warning. */
function advanceTo(cls: SpeedClass): Aspect | null {
  switch (cls) {
    case 'stop':
      return aspectByRule('415')!;
    case 'limited':
      return aspectByRule('412')!;
    case 'medium':
      return aspectByRule('413')!;
    case 'slow':
      return aspectByRule('414')!;
    case 'diverging':
      return aspectByRule('414A')!;
    default:
      return null;
  }
}

/** `<Family> To <next>`, the aspect a controlled signal shows over a turnout. */
function turnoutAspect(family: string, next: SpeedClass): Aspect {
  const word: Record<SpeedClass, string> = {
    normal: 'Clear',
    limited: 'Limited',
    medium: 'Medium',
    diverging: 'Diverging',
    slow: 'Slow',
    restricted: 'Restricting',
    stop: 'Stop',
  };
  const family_ = family.charAt(0).toUpperCase() + family.slice(1);
  return (
    aspectByName(`${family_} To ${word[next]}`) ??
    aspectByName(`${family_} To Stop`) ??
    aspectByRule('436')!
  );
}

/**
 * Whether the railway ahead of a signal is lined through a turnout.
 *
 * Built by routing forward from the signal for a few hundred metres and asking
 * whether any switch on the way is reversed *and* on the route — which is not
 * the same as "there is a reversed switch nearby". A siding switch lined for the
 * siding matters to the signal protecting the siding, not to the one on the main
 * a quarter mile back.
 */
function divergingAhead(network: Network, signal: Signal, within = 600): boolean {
  const track = signal.trackId ? network.tracks.get(signal.trackId) : undefined;
  if (!track) return false;
  const route = buildRoute(
    network,
    { track, at: signal.at, dir: signal.facing === 'up' ? 1 : -1 },
    within,
  );
  const onRoute = new Set(route.legs.map((l) => l.track.id));
  for (const node of network.switches) {
    if (node.position !== 'reverse') continue;
    const trunk = node.ports.get('trunk')?.track;
    const reverse = node.ports.get('reverse')?.track;
    if (trunk && reverse && onRoute.has(trunk) && onRoute.has(reverse)) return true;
  }
  return false;
}

/**
 * Work out what every signal should be displaying.
 *
 * The block a signal governs runs from the signal to the next one facing the
 * same way along the same track. Occupancy is tested against every movement on
 * the railway, and what a signal shows follows from two things: whether its own
 * block is clear, and what the next signal is asking for.
 *
 *     block occupied     → Stop, or Stop and Proceed if it is permissive
 *     next asks for X    → Clear to X
 *     next says Clear to X → Advance Clear to X
 *     next is Clear      → Clear
 *
 * Note what that second line does. It is not a list of cases; it is the same
 * rule for every speed class in the catalogue, so the signal behind one lined
 * over a turnout shows Clear to Medium without that ever being written down.
 *
 * A **controlled** signal is not worked by the railway ahead of it but by
 * whoever holds the location: it shows Stop until it is cleared, and once
 * cleared it shows a turnout aspect if the route is lined through the points.
 * That is the difference between an automatic signal and one an RTC operates,
 * and it is why a movement can sit at a red on clear track.
 *
 * Resolution runs from the far end of each track backwards, so a signal has
 * already-settled information about the one ahead of it. That ordering is the
 * only subtle part: do it forwards and every signal spends a step reacting to
 * what its neighbour showed a moment ago, and a train produces a wave of stale
 * aspects rolling down the subdivision behind it.
 */
export function resolveSignals(
  signals: readonly Signal[],
  occupancy: readonly { trackId: string; from: number; to: number }[],
  network?: Network,
): void {
  // With a network to walk, a block runs from a signal to the next one facing
  // the same way **through the turnouts**, which is what a block actually is.
  // Without one, it can only run to the end of the signal's own track.
  //
  // This mattered the moment a main track was cut into segments at every
  // switch: each signal's block ended at its own segment boundary, so a train
  // one segment ahead was invisible and nothing ever showed Stop for it.
  if (network) {
    resolveAcrossNetwork(signals, occupancy, network);
    return;
  }
  const byTrack = new Map<string, Signal[]>();
  for (const signal of signals) {
    if (signal.control === 'fixed' || !signal.trackId) continue;
    if (network && signal.control === 'controlled') {
      signal.divergingRoute = divergingAhead(network, signal);
    }
    const list = byTrack.get(signal.trackId) ?? [];
    list.push(signal);
    byTrack.set(signal.trackId, list);
  }

  for (const [trackId, list] of byTrack) {
    for (const facing of ['up', 'down'] as const) {
      const facingThisWay = list
        .filter((s) => s.facing === facing)
        .sort((a, b) => (facing === 'up' ? a.at - b.at : b.at - a.at));

      // Backwards from the far end: each signal reads a neighbour that is
      // already settled this step, not one settled last step.
      let ahead: Signal | null = null;
      for (let i = facingThisWay.length - 1; i >= 0; i--) {
        const signal = facingThisWay[i]!;
        const blockEnd = ahead ? ahead.at : facing === 'up' ? Infinity : -Infinity;
        const lo = Math.min(signal.at, blockEnd);
        const hi = Math.max(signal.at, blockEnd);
        const occupied = occupancy.some((o) => o.trackId === trackId && o.to > lo && o.from < hi);
        const nextClass: SpeedClass = ahead ? ahead.aspect.passing : 'normal';

        signal.aspect = aspectFor(signal, occupied, ahead, nextClass);
        ahead = signal;
      }
    }
  }
}

/**
 * Resolve every signal against blocks that follow the railway.
 *
 * For each signal, a route is walked forward from it in the direction it faces
 * until the next signal facing the same way. Everything between the two is the
 * block, and the aspect follows from whether anything is standing in it and
 * from what the signal at the far end is showing.
 *
 * Settled far-to-near in one pass so a signal reads a neighbour that has
 * already been decided this step — which is what makes an approach aspect step
 * back from a Stop rather than lagging a frame behind it.
 */
function resolveAcrossNetwork(
  signals: readonly Signal[],
  occupancy: readonly { trackId: string; from: number; to: number }[],
  network: Network,
): void {
  const live = signals.filter((s) => s.control !== 'fixed' && s.trackId);
  for (const signal of live) {
    if (signal.control === 'controlled') signal.divergingRoute = divergingAhead(network, signal);
  }

  // The block ahead of each signal, and which signal closes it.
  const blocks = new Map<Signal, { spans: Span[]; next: Signal | null }>();
  for (const signal of live) blocks.set(signal, blockAhead(signal, live, network));

  // Order them so a signal is settled after the one it reads. A signal's
  // "next" forms a chain; resolving by how far each is from the end of its
  // chain settles them far-to-near without needing the chain to be a line.
  const depth = new Map<Signal, number>();
  const depthOf = (s: Signal, seen: Set<Signal>): number => {
    const cached = depth.get(s);
    if (cached !== undefined) return cached;
    if (seen.has(s)) return 0;
    seen.add(s);
    const next = blocks.get(s)?.next ?? null;
    const d = next ? depthOf(next, seen) + 1 : 0;
    depth.set(s, d);
    return d;
  };
  for (const s of live) depthOf(s, new Set());

  for (const signal of [...live].sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0))) {
    const block = blocks.get(signal)!;
    const occupied = block.spans.some((span) =>
      occupancy.some((o) => o.trackId === span.trackId && o.to > span.from && o.from < span.to),
    );
    const ahead = block.next;
    signal.aspect = aspectFor(signal, occupied, ahead, ahead ? ahead.aspect.passing : 'normal');
  }
}

interface Span {
  trackId: string;
  from: number;
  to: number;
}

/**
 * The stretch of railway a signal governs, and the signal that closes it.
 *
 * Walked through the network rather than along one track, so a block crosses
 * switches exactly as a movement does. The walk is bounded: a signal with
 * nothing ahead of it governs as far as the route can be built and no further,
 * which is the honest answer for the last signal on a subdivision.
 */
function blockAhead(
  signal: Signal,
  signals: readonly Signal[],
  network: Network,
): { spans: Span[]; next: Signal | null } {
  const track = network.tracks.get(signal.trackId!);
  if (!track) return { spans: [], next: null };
  const dir = signal.facing === 'up' ? 1 : -1;
  const route = buildRoute(network, { track, at: signal.at, dir }, BLOCK_REACH, 0);

  const spans: Span[] = [];
  let next: Signal | null = null;
  for (const leg of route.legs) {
    const lo = Math.min(leg.from, leg.to);
    const hi = Math.max(leg.from, leg.to);
    // The nearest signal on this leg facing the same way as the movement is
    // travelling over it, beyond where this one stands.
    let best: { signal: Signal; along: number } | null = null;
    for (const other of signals) {
      if (other === signal || other.trackId !== leg.track.id) continue;
      if (other.at < lo || other.at > hi) continue;
      // Facing the way this leg is being travelled, and ahead of the start.
      const along = leg.start + (other.at - leg.from) * leg.dir;
      if (along <= 1) continue;
      const sameWay = (other.facing === 'up' ? 1 : -1) === leg.dir;
      if (!sameWay) continue;
      if (!best || along < best.along) best = { signal: other, along };
    }
    if (best) {
      spans.push({
        trackId: leg.track.id,
        from: Math.min(leg.from, best.signal.at),
        to: Math.max(leg.from, best.signal.at),
      });
      next = best.signal;
      break;
    }
    spans.push({ trackId: leg.track.id, from: lo, to: hi });
  }
  return { spans, next };
}

/** How far a block is allowed to run before it is simply "the road ahead". */
const BLOCK_REACH = 12_000;

function aspectFor(
  signal: Signal,
  occupied: boolean,
  ahead: Signal | null,
  nextClass: SpeedClass,
): Aspect {
  if (signal.control === 'controlled') {
    // A controlled signal is absolute and displays Stop until it is cleared,
    // whatever the track ahead is doing.
    if (!signal.cleared || occupied) return aspectByRule('439')!;
    return signal.divergingRoute
      ? turnoutAspect(signal.divergingClass, nextClass)
      : approachToNext(ahead, nextClass);
  }

  if (occupied) return aspectByRule(signal.permissive ? '437' : '439')!;
  return approachToNext(ahead, nextClass);
}

function approachToNext(ahead: Signal | null, nextClass: SpeedClass): Aspect {
  if (!ahead) return aspectByRule('405')!;
  if (nextClass !== 'normal') return approachTo(nextClass);
  // The next signal is not itself restricting, but it may be warning of
  // something a block further on — in which case this one gives the advance.
  if (!ahead.aspect.advance && ahead.aspect.next !== 'normal') {
    return advanceTo(ahead.aspect.next) ?? aspectByRule('405')!;
  }
  return aspectByRule('405')!;
}

/**
 * The next signal a movement will come to, and how far off it is.
 *
 * Read along the movement's own route, so it crosses turnouts correctly and
 * ignores signals facing the other way or standing on track this movement is
 * not routed over.
 */
export function signalAhead(
  train: Train,
  signals: readonly Signal[],
  within = 4000,
): SignalSighting | null {
  const route = train.route;
  if (!route) return null;
  const dir = train.direction;
  const lead = train.cars.find((c) => !c.derailed) ?? train.cars[0];
  if (!lead) return null;
  const nose = lead.s + (dir * lead.length) / 2;

  let best: SignalSighting | null = null;
  for (const signal of signals) {
    if (!signal.trackId) continue;
    const d = route.distanceOf(signal.trackId, signal.at);
    if (d === null) continue;
    const gap = (d - nose) * dir;
    if (gap < 0 || gap > within) continue;
    // A signal governs movements coming toward it: the leg's direction tells us
    // whether this movement is reading its face or its back.
    const leg = route.legAt(d);
    const governs = (signal.facing === 'up' ? 1 : -1) * leg.dir === dir;
    if (!governs) continue;
    if (!best || gap < best.distance) best = { signal, distance: gap };
  }
  return best;
}

/** Flags a movement will come to, nearest first. */
export function flagsAhead(train: Train, flags: readonly Flag[], within = 4000): {
  flag: Flag;
  distance: number;
}[] {
  const route = train.route;
  if (!route) return [];
  const dir = train.direction;
  const lead = train.cars.find((c) => !c.derailed) ?? train.cars[0];
  if (!lead) return [];
  const nose = lead.s + (dir * lead.length) / 2;

  const out: { flag: Flag; distance: number }[] = [];
  for (const flag of flags) {
    if (!flag.trackId) continue;
    const d = route.distanceOf(flag.trackId, flag.at);
    if (d === null) continue;
    const gap = (d - nose) * dir;
    if (gap < 0 || gap > within) continue;
    out.push({ flag, distance: gap });
  }
  return out.sort((a, b) => a.distance - b.distance);
}


// ─────────────────────────────────────────────── what the movement actually did

/**
 * A movement passing a signal.
 *
 * This is a **physical observation, not a judgement**: it records which signal
 * was passed, what it was displaying at the time, and how fast the movement was
 * going. Whether that was a violation of Rule 439 is a question for the rules
 * layer, which has the rulebook; this layer has the railway. Keeping the two
 * apart is what lets an engineer run past a Stop and see exactly what they did,
 * rather than being prevented from doing it.
 */
export interface SignalPassing {
  trainId: string;
  signal: Signal;
  /**
   * The aspect the movement was **given** — the last one displayed while the
   * signal was still ahead of it.
   *
   * Not the aspect at the instant of passing, and the difference is not
   * pedantic: a signal drops to Stop as the movement takes its block, so every
   * signal is red by the time you are level with it. Recording that would make
   * an engineer who obeyed a Clear look like one who ran a red.
   */
  aspect: Aspect;
  /** What it was actually displaying as the nose went by, usually knocked down. */
  displayedAtPassing: Aspect;
  /** Speed at that moment, m/s. */
  speed: number;
  /** Simulated time it happened. */
  time: number;
  /** True where the aspect required a stop and the movement did not make one. */
  passedAtStop: boolean;
  /** True where the speed exceeded what the aspect permitted passing it. */
  overspeed: boolean;
}

/** Where a movement's nose is, in route distance. */
function nosePosition(train: Train): number | null {
  const dir = train.direction;
  const lead = train.cars.find((c) => !c.derailed) ?? train.cars[0];
  if (!lead || !train.route) return null;
  return lead.s + (dir * lead.length) / 2;
}

/**
 * Watches movements go by signals.
 *
 * Kept as an object with memory because the event is a *crossing*, not a state:
 * it needs where the nose was last step as well as where it is now, and a train
 * standing on a signal must not generate one every frame.
 */
export class SignalWatcher {
  private last = new Map<string, number>();
  /** The aspect each movement was last given by each signal, while approaching. */
  private given = new Map<string, Aspect>();

  /**
   * Advance the watch. Returns whatever was passed this step.
   *
   * `trackSpeedMph` is what the aspect's `normal` class means here; without it a
   * Clear permits any speed, which is true as far as the signal is concerned.
   */
  step(
    trains: readonly Train[],
    signals: readonly Signal[],
    time: number,
    trackSpeedMph?: number,
  ): SignalPassing[] {
    const out: SignalPassing[] = [];
    for (const train of trains) {
      const route = train.route;
      const nose = nosePosition(train);
      if (!route || nose === null) continue;
      const previous = this.last.get(train.id);
      this.last.set(train.id, nose);
      const dir = train.direction;

      // Remember what each signal is showing while it is still ahead. This is
      // the aspect the movement is being given, and it is the one that counts.
      for (const signal of signals) {
        if (!signal.trackId) continue;
        const d = route.distanceOf(signal.trackId, signal.at);
        if (d === null) continue;
        if ((d - nose) * dir > 0) {
          this.given.set(`${train.id}|${signal.id}`, signal.aspect);
        }
      }

      if (previous === undefined || previous === nose) continue;

      for (const signal of signals) {
        if (!signal.trackId) continue;
        const d = route.distanceOf(signal.trackId, signal.at);
        if (d === null) continue;
        // Crossed it this step, going the way the signal governs.
        const wasBefore = (d - previous) * dir > 0;
        const isBehind = (d - nose) * dir <= 0;
        if (!wasBefore || !isBehind) continue;
        const leg = route.legAt(d);
        if ((signal.facing === 'up' ? 1 : -1) * leg.dir !== dir) continue;

        const speed = Math.abs(train.speed);
        const key = `${train.id}|${signal.id}`;
        const given = this.given.get(key) ?? signal.aspect;
        this.given.delete(key);
        const limit = speedLimitMps(given.passing, trackSpeedMph);
        out.push({
          trainId: train.id,
          signal,
          aspect: given,
          displayedAtPassing: signal.aspect,
          speed,
          time,
          passedAtStop: given.passing === 'stop' && speed > 0.3,
          overspeed: limit !== null && speed > limit + 0.5,
        });
      }
    }
    return out;
  }

  /** Forget a movement's history — after a reset, or when it is re-routed. */
  forget(trainId?: string): void {
    if (trainId === undefined) {
      this.last.clear();
      this.given.clear();
      return;
    }
    this.last.delete(trainId);
    for (const key of this.given.keys()) {
      if (key.startsWith(`${trainId}|`)) this.given.delete(key);
    }
  }
}
