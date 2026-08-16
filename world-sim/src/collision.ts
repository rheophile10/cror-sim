/**
 * Running into things.
 *
 * A train's own couplers already stop it from running into itself. Everything
 * else on the track — another movement, a car lying where it derailed, a truck
 * stalled on a crossing — was previously invisible to it, and a train would run
 * straight through.
 *
 * The problem is that all of those live in different coordinates: one train
 * measures distance along *its* route, another along its own, a wreck is a free
 * body somewhere in the landscape, and an obstruction is parked at a mileage.
 * The fix is to put everything into one common frame — position on a **track**,
 * which is the thing they all ultimately sit on — collect them as `Blocker`s,
 * and then translate each blocker back into the route coordinate of whichever
 * movement is about to hit it.
 *
 * Impacts are resolved as a single inelastic impulse between the two bodies that
 * touched, plus a position correction to undo the overlap. The rest of each
 * consist finds out through its couplers over the next few steps, which is both
 * cheaper and more honest than pretending a train is one rigid mass.
 *
 * What decides whether an impact is a coupling or a wreck is closing speed:
 * under a couple of km/h things simply come together; past `derailSpeed` the
 * cars that touched go on the ground. That is the same threshold the rules care
 * about when they talk about coupling speed.
 */
import { throwCar, type DerailmentOptions } from './derailment.ts';
import type { Route } from './route.ts';
import type { Car, Train } from './train.ts';
import { clamp } from './units.ts';

export interface CollisionOptions {
  /** Closing speed above which the cars that touched leave the rails, m/s. */
  derailSpeed: number;
  /** Bounce in an impact. Freight equipment is not springy. */
  restitution: number;
  /**
   * An obstruction lighter than this fraction of the striking car is swept
   * aside without derailing anything, however fast it is hit. A train destroys
   * a car at a crossing; a loaded truck or a rock is a different matter.
   */
  obstructionMassRatio: number;
  /** How close a derailed car must be to the track to be fouling it, metres. */
  foulRadius: number;
  /**
   * Most interpenetration undone in one step, metres.
   *
   * Pushing two bodies fully apart the instant they are found overlapping is
   * violent: the car being moved is coupled to others, and a metre of sudden
   * displacement against a draft gear stiff enough to hold a train together is
   * tens of meganewtons. Correcting a little each step lets the overlap bleed
   * off without the couplers ever seeing a step change.
   */
  maxCorrection: number;
  /** Overlap below this is left alone, metres — bodies in contact stay in contact. */
  slop: number;
}

export const DEFAULT_COLLISION: CollisionOptions = {
  derailSpeed: 4.5,
  restitution: 0.08,
  obstructionMassRatio: 0.06,
  foulRadius: 3.2,
  maxCorrection: 0.15,
  slop: 0.02,
};

export interface ObstructionSpec {
  id?: string;
  label?: string;
  /** Which track it is standing on. */
  track?: string;
  /** Where along that track, metres. */
  at: number;
  /** Mass in tonnes. Heavy things derail trains; light things do not. */
  mass?: number;
  /** Extent along the track, metres. */
  length?: number;
  width?: number;
  height?: number;
  color?: string;
}

/** A thing standing on the track that is not a train. */
export interface Obstruction {
  id: string;
  label: string;
  trackId: string | undefined;
  at: number;
  /** Mass in kilograms. */
  mass: number;
  length: number;
  width: number;
  height: number;
  color: string;
  /** True once something has hit it. */
  struck: boolean;
  /** Where it was shoved to, metres along the track; equals `at` until struck. */
  displaced: number;
  /**
   * Knocked clear of the track and no longer an obstruction.
   *
   * Something light enough to be swept aside has to *stop being in the way*, or
   * it rides along in front of the pilot being struck again every frame for the
   * rest of the run. A heavy obstruction is different: it stays on the track and
   * goes on being shoved, which is the correct behaviour and is left alone.
   */
  cleared: boolean;
  /** How far to the side it ended up, metres. */
  offset: number;
}

export function buildObstruction(spec: ObstructionSpec, index: number): Obstruction {
  return {
    id: spec.id ?? `obstruction-${index}`,
    label: spec.label ?? 'Obstruction',
    trackId: spec.track,
    at: spec.at,
    mass: (spec.mass ?? 18) * 1000,
    length: spec.length ?? 6,
    width: spec.width ?? 2.6,
    height: spec.height ?? 3.2,
    color: spec.color ?? '#c9642f',
    struck: false,
    displaced: spec.at,
    cleared: false,
    offset: 0,
  };
}

/**
 * Something occupying a stretch of one track.
 *
 * `v` is along increasing `s` on that track — not along anybody's route — which
 * is the point: it is the one frame two movements approaching each other from
 * opposite directions can both be expressed in.
 */
interface Blocker {
  kind: 'car' | 'wreck' | 'obstruction';
  trackId: string;
  from: number;
  to: number;
  mass: number;
  v: number;
  car?: Car;
  train?: Train;
  obstruction?: Obstruction;
}

interface Movement {
  train: Train;
  route: Route;
}

/** Where a car sits on the actual track it is standing on. */
function carSpan(car: Car, route: Route): { trackId: string; from: number; to: number; v: number } | null {
  const loc = route.locate(car.s);
  const half = car.length / 2;
  const a = route.locate(car.s - half);
  const b = route.locate(car.s + half);
  // A car straddling a switch has its two ends on different tracks; take the
  // track its centre is on and accept the small error at the ends.
  const from = a.track.id === loc.track.id ? a.at : loc.at - loc.dir * half;
  const to = b.track.id === loc.track.id ? b.at : loc.at + loc.dir * half;
  return {
    trackId: loc.track.id,
    from: Math.min(from, to),
    to: Math.max(from, to),
    v: car.v * loc.dir,
  };
}

function collect(
  movements: readonly Movement[],
  obstructions: readonly Obstruction[],
  opt: CollisionOptions,
): Blocker[] {
  const out: Blocker[] = [];

  for (const { train, route } of movements) {
    for (const car of train.cars) {
      if (car.derailed) {
        // A wreck blocks the track only while it is still lying on it. One that
        // slid down the embankment is somebody else's problem.
        const body = car.body;
        if (!body || car.foulTrack === undefined) continue;
        const track = route.legs.find((l) => l.track.id === car.foulTrack)?.track;
        if (!track) continue;
        const pt = track.at(car.foulAt ?? 0);
        if (Math.hypot(body.x - pt.x, body.y - pt.y) > opt.foulRadius + car.length / 2) continue;
        out.push({
          kind: 'wreck',
          trackId: car.foulTrack,
          from: (car.foulAt ?? 0) - car.length / 2,
          to: (car.foulAt ?? 0) + car.length / 2,
          mass: car.mass,
          v: 0,
          car,
          train,
        });
        continue;
      }
      const span = carSpan(car, route);
      if (!span) continue;
      out.push({
        kind: 'car',
        trackId: span.trackId,
        from: span.from,
        to: span.to,
        mass: car.mass,
        v: span.v,
        car,
        train,
      });
    }
  }

  for (const ob of obstructions) {
    if (!ob.trackId || ob.cleared) continue;
    out.push({
      kind: 'obstruction',
      trackId: ob.trackId,
      from: ob.displaced - ob.length / 2,
      to: ob.displaced + ob.length / 2,
      mass: ob.mass,
      v: 0,
      obstruction: ob,
    });
  }

  return out;
}

export interface CollisionEvent {
  train: Train;
  car: Car;
  /** What it hit. */
  what: string;
  /** Closing speed at impact, m/s. */
  closing: number;
  derailed: boolean;
}

/**
 * Find and resolve every impact this step.
 *
 * Called once per frame rather than once per integrator substep: at any speed a
 * train can reach, a frame moves it well under a car length, so nothing tunnels
 * through anything, and cross-train work does not belong inside a single
 * train's integrator.
 */
export function resolveCollisions(
  movements: readonly Movement[],
  obstructions: readonly Obstruction[],
  opt: CollisionOptions = DEFAULT_COLLISION,
  derailment?: DerailmentOptions,
): CollisionEvent[] {
  const blockers = collect(movements, obstructions, opt);
  const events: CollisionEvent[] = [];
  const handled = new Set<string>();

  for (const { train, route } of movements) {
    for (const car of train.cars) {
      if (car.derailed) continue;
      const mine = carSpan(car, route);
      if (!mine) continue;

      for (const other of blockers) {
        if (other.car === car) continue;
        if (other.train === train && other.kind === 'car') continue;
        if (other.trackId !== mine.trackId) continue;
        if (other.to <= mine.from || other.from >= mine.to) continue;

        // One pair, one impact per step, whichever way round it is found.
        const key = [car.id + train.id, other.car ? other.car.id + (other.train?.id ?? '') : other.obstruction!.id]
          .sort()
          .join('|');
        if (handled.has(key)) continue;
        handled.add(key);

        const event = resolve(car, mine, other, route, train, opt, derailment);
        if (event) events.push(event);
      }
    }
  }
  return events;
}

function resolve(
  car: Car,
  mine: { trackId: string; from: number; to: number; v: number },
  other: Blocker,
  route: Route,
  train: Train,
  opt: CollisionOptions,
  derailment?: DerailmentOptions,
): CollisionEvent | null {
  // Which side it is on, and how deep in.
  const ahead = other.from + other.to > mine.from + mine.to ? 1 : -1;
  const overlap = ahead > 0 ? mine.to - other.from : other.to - mine.from;
  if (overlap <= 0) return null;

  // Closing speed, in the frame of the track they are both standing on. A
  // positive value means they are coming together.
  const closing = (mine.v - other.v) * ahead;
  if (closing <= 0.005 && overlap < 0.05) return null;

  const m1 = car.mass;
  const m2 = other.mass;
  const total = m1 + m2;
  const e = opt.restitution;

  // Inelastic impulse along the track.
  const v1 = mine.v;
  const v2 = other.v;
  const v1p = (m1 * v1 + m2 * v2 + m2 * e * (v2 - v1)) / total;
  const v2p = (m1 * v1 + m2 * v2 + m1 * e * (v1 - v2)) / total;

  const loc = route.locate(car.s);
  const swept =
    other.kind === 'obstruction' && other.mass < car.mass * opt.obstructionMassRatio;

  if (closing > 0) {
    // A light obstruction takes the whole impulse and the train barely notices.
    car.v = (swept ? v1 - (v1 - v1p) * 0.15 : v1p) * loc.dir;
  }

  // Undo the interpenetration, a little at a time, sharing it by mass so a
  // train does not get shoved back by a stalled car.
  const correction = Math.max(0, Math.min(overlap - opt.slop, opt.maxCorrection));
  const share = other.kind === 'obstruction' || other.kind === 'wreck' ? 0.15 : m2 / total;
  car.s -= ahead * correction * share * loc.dir;

  if (other.kind === 'obstruction' && other.obstruction) {
    const ob = other.obstruction;
    ob.struck = true;
    if (swept) {
      // Thrown clear: off the track, off to one side, and out of the way.
      ob.cleared = true;
      ob.displaced += ahead * Math.max(4, Math.abs(mine.v) * 0.6);
      ob.offset = (ahead > 0 ? 1 : -1) * (2.5 + Math.abs(mine.v) * 0.12);
    } else {
      ob.displaced += ahead * (correction + Math.abs(v2p) * 0.5);
    }
  } else if (other.car && other.kind === 'car') {
    const otherLoc = otherLocation(other);
    other.car.v = v2p * otherLoc;
    other.car.s += ahead * correction * (1 - share) * otherLoc;
  } else if (other.car && other.kind === 'wreck' && other.car.body) {
    // Shove the wreck: it is a free body, so it takes the impulse in world space.
    const pt = route.at(car.s);
    const push = Math.max(0, closing) * (m1 / total);
    other.car.body.vx += Math.cos(pt.heading) * push * ahead * loc.dir;
    other.car.body.vy += Math.sin(pt.heading) * push * ahead * loc.dir;
    other.car.body.settled = false;
  }

  const hard = closing > opt.derailSpeed && !swept;
  if (hard && derailment) {
    const pt = route.at(car.s);
    throwCar(
      train,
      car,
      pt,
      train.derailSide,
      clamp(closing / opt.derailSpeed, 0.5, 2.5),
      derailment,
      derailment.pileupKick * 1.4,
      `Car ${car.id} (${car.label}) struck ${describe(other)} at ${(closing * 3.6).toFixed(0)} km/h and derailed.`,
    );
    if (other.kind === 'car' && other.car && other.train && !other.car.derailed) {
      const otherRoute = routeOf(other.train);
      if (otherRoute) {
        throwCar(
          other.train,
          other.car,
          otherRoute.at(other.car.s),
          -other.train.derailSide,
          clamp(closing / opt.derailSpeed, 0.5, 2.5),
          derailment,
          derailment.pileupKick * 1.4,
          `Car ${other.car.id} (${other.car.label}) was struck by ${train.label ?? train.id}.`,
        );
      }
    }
  }

  return { train, car, what: describe(other), closing, derailed: hard };
}

/** Sign that converts the blocker's track-frame velocity back to its own route. */
function otherLocation(other: Blocker): 1 | -1 {
  const route = other.train ? routeOf(other.train) : undefined;
  if (!route || !other.car) return 1;
  return route.locate(other.car.s).dir;
}

/**
 * Routes hang off trains, set by `World`. Reaching for it here rather than
 * threading it through every call keeps the collision code from having to know
 * how the world stores things.
 */
function routeOf(train: Train): Route | undefined {
  return train.route ?? undefined;
}

function describe(other: Blocker): string {
  if (other.kind === 'obstruction') return other.obstruction?.label ?? 'an obstruction';
  if (other.kind === 'wreck') return `wrecked car ${other.car?.id ?? ''}`.trim();
  const train = other.train?.label ?? other.train?.id ?? 'another movement';
  return `${train}`;
}
