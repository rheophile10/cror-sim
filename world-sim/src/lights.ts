/**
 * Headlights, ditch lights, the bell and the horn.
 *
 * These are the controls a locomotive uses to say something to the world
 * outside it, and every one of them is the subject of a rule. Modelling them is
 * cheap; the interesting question was what "modelling a light" can honestly mean
 * in this renderer, and the answer shapes the whole module.
 *
 * ── Why there is no illumination ──
 *
 * The painter is depth-sorted with one depth value per face and no z-buffer, and
 * there is no lighting pass: every face is shaded by a fixed Lambert term
 * against a constant light direction. Adding a real headlight would mean a
 * second light source evaluated per face, shadow casting to make it read as a
 * beam rather than a wash, and a depth buffer so the beam stops at the first
 * thing it hits. That is a renderer, not a feature.
 *
 * So what is drawn is what you would actually *see from a distance in daylight*,
 * which is the view this simulation has: **bright lamp faces** on the nose, and
 * a **translucent beam on the ground** ahead of them. The beam is a decal, not
 * light — it does not brighten anything, it is not occluded by what stands in
 * it, and it is drawn at ground level so the painter can sort it like any other
 * flat thing. Called what it is, it reads correctly. Called illumination, it
 * would be a lie that got worse the closer you looked.
 *
 * ── The horn ──
 *
 * Sequences of long and short sounds, held over time, because the whole point of
 * Rule 14 is the *pattern* and a horn modelled as a boolean has thrown away the
 * only part that matters. A sounding runs on its own once started; the engineer
 * cannot be asked to hold a button down for eight seconds of simulated time
 * that may be passing at four times life speed.
 *
 * The rule letters below are given only where they are not in doubt. The
 * patterns are the substance; check the letters against the edition of the book
 * you are working to rather than trusting them from here.
 */
import { clamp } from './units.ts';

export type HeadlightSetting = 'off' | 'dim' | 'bright';

/** One element of a horn signal. */
export type HornElement = 'long' | 'short';

export interface HornSignal {
  id: string;
  name: string;
  /** What it means to whoever hears it. */
  meaning: string;
  pattern: HornElement[];
  /**
   * Hold the last element for this many seconds instead of its normal length.
   *
   * The crossing signal's final long is not a fixed blast: it is prolonged until
   * the leading end is on the crossing, which is why the pattern alone does not
   * tell you how long you will be leaning on the horn.
   */
  holdLast?: number;
}

/** Seconds each element sounds for, and the silence between them. */
export const HORN_LONG = 2;
export const HORN_SHORT = 0.6;
export const HORN_GAP = 0.45;

export const HORN_SIGNALS: HornSignal[] = [
  {
    id: 'crossing',
    name: 'Crossing (— — o —)',
    meaning: 'Approaching a public crossing at grade. CROR 14(l).',
    pattern: ['long', 'long', 'short', 'long'],
    holdLast: 6,
  },
  {
    id: 'alarm',
    name: 'Alarm (o o o o …)',
    meaning: 'Persons or livestock on or near the track. CROR 14(n).',
    pattern: ['short', 'short', 'short', 'short', 'short', 'short'],
  },
  {
    id: 'stop',
    name: 'Stop (o)',
    meaning: 'Stop; apply brakes.',
    pattern: ['short'],
  },
  {
    id: 'proceed',
    name: 'Proceed (— —)',
    meaning: 'Brakes released; about to proceed.',
    pattern: ['long', 'long'],
  },
  {
    id: 'back-up',
    name: 'Back up (o o o)',
    meaning: 'When standing, about to move in the reverse direction.',
    pattern: ['short', 'short', 'short'],
  },
  {
    id: 'acknowledge',
    name: 'Acknowledge (o o)',
    meaning: 'Answer to any signal not otherwise provided for.',
    pattern: ['short', 'short'],
  },
];

export interface Lights {
  /**
   * Headlight at each end of the movement. Not one switch: a locomotive has a
   * front and a rear headlight and the rules about which is displayed bright,
   * dim or off depend on which end is leading and what is standing beside you.
   */
  front: HeadlightSetting;
  rear: HeadlightSetting;
  /** Ditch lights. On most road power they flash while the horn is sounding. */
  ditch: boolean;
  bell: boolean;
  /** The sounding in progress, if any, and how far into it we are. */
  horn: { signal: HornSignal; elapsed: number } | null;
}

export interface LightsSpec {
  front?: HeadlightSetting;
  rear?: HeadlightSetting;
  ditch?: boolean;
  bell?: boolean;
}

export function buildLights(spec: LightsSpec = {}): Lights {
  return {
    // Bright ahead and dim behind is how a road engine runs, and starting there
    // means a scene that says nothing about lights still looks like a railway.
    front: spec.front ?? 'bright',
    rear: spec.rear ?? 'dim',
    ditch: spec.ditch ?? true,
    bell: spec.bell ?? false,
    horn: null,
  };
}

/** How long a whole sounding takes, seconds. */
export function hornDuration(signal: HornSignal): number {
  let total = 0;
  signal.pattern.forEach((element, i) => {
    const last = i === signal.pattern.length - 1;
    const held = last && signal.holdLast !== undefined ? signal.holdLast : null;
    total += held ?? (element === 'long' ? HORN_LONG : HORN_SHORT);
    if (!last) total += HORN_GAP;
  });
  return total;
}

/**
 * Start a sounding. Refused while one is already running — a horn signal
 * interrupted halfway through is a different signal, and usually a wrong one.
 */
export function soundHorn(lights: Lights, id: string): HornSignal | null {
  if (lights.horn) return null;
  const signal = HORN_SIGNALS.find((s) => s.id === id);
  if (!signal) return null;
  lights.horn = { signal, elapsed: 0 };
  return signal;
}

/** Whether the horn is actually making a noise this instant, rather than in a gap. */
export function hornSounding(lights: Lights): boolean {
  const state = lights.horn;
  if (!state) return false;
  let t = state.elapsed;
  const pattern = state.signal.pattern;
  for (let i = 0; i < pattern.length; i++) {
    const last = i === pattern.length - 1;
    const held = last && state.signal.holdLast !== undefined ? state.signal.holdLast : null;
    const length = held ?? (pattern[i] === 'long' ? HORN_LONG : HORN_SHORT);
    if (t < length) return true;
    t -= length;
    if (last) return false;
    if (t < HORN_GAP) return false;
    t -= HORN_GAP;
  }
  return false;
}

/**
 * Ditch lights alternating.
 *
 * They flash while the horn is sounding — the crossing behaviour on most road
 * power — and burn steady otherwise. `phase` alternates so the two lamps can be
 * drawn out of step with each other.
 */
export function ditchPhase(lights: Lights, time: number): { on: boolean; left: boolean } {
  if (!lights.ditch || lights.front === 'off') return { on: false, left: false };
  if (!lights.horn) return { on: true, left: true };
  // About 65 flashes a minute, which is what the regulation asks for.
  return { on: true, left: Math.floor(time * 1.1) % 2 === 0 };
}

/** Advance a sounding. Returns the signal that just finished, if one did. */
export function stepLights(lights: Lights, dt: number): HornSignal | null {
  const state = lights.horn;
  if (!state) return null;
  state.elapsed += dt;
  if (state.elapsed >= hornDuration(state.signal)) {
    lights.horn = null;
    return state.signal;
  }
  return null;
}

/** Brightness of a lamp, 0 to 1 — what the renderer washes the lamp face with. */
export function lampLevel(setting: HeadlightSetting): number {
  return setting === 'bright' ? 1 : setting === 'dim' ? 0.45 : 0;
}

/** How far a beam is drawn on the ground, metres. */
export function beamReach(setting: HeadlightSetting): number {
  return clamp(lampLevel(setting), 0, 1) * 120;
}
