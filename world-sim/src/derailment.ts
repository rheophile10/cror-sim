/**
 * What happens after the wheels leave the rail.
 *
 * Up to the moment of derailment a car has one degree of freedom — distance
 * along the path. After it, the path is no longer a constraint and the car
 * becomes a free body in the landscape: it flies, lands, slides, tumbles, and
 * stops. Nothing about that is the same problem, so it lives in its own file
 * and its own state (`Car.body`), and `Car.s` stops meaning anything.
 *
 * Three things make it read as a derailment rather than as a box falling over:
 *
 *   - **The kick is directed.** A car thrown by curving force goes *outward*
 *     from the curve, carrying its forward speed with it, spinning about its
 *     own centre. That is why a derailment on a curve throws equipment down the
 *     outside of the bank and not straight ahead.
 *   - **The ground is the terrain.** Contact is resolved against the height
 *     field, so a car that leaves the rails on an embankment goes down the
 *     embankment.
 *   - **It propagates.** The train behind a derailed car does not stop; it
 *     arrives. Each following car piles into the wreck a little short of the
 *     last, alternating sides, which is what makes the accordion.
 *
 * The rigid-body model is deliberately crude: no inertia tensor, no contact
 * manifold, no car-to-car collision response beyond the pile-up rule. It is a
 * plausible-looking wreck, not a forensic reconstruction, and the honest use of
 * it is "did this train derail, roughly where, and how much of it went over" —
 * not "which coupler failed first".
 */
import type { Terrain } from './terrain.ts';
import type { TrackPoint } from './track.ts';
import type { Car, Train } from './train.ts';
import { G, clamp } from './units.ts';

/** A derailed car's state: position, velocity, and attitude. */
export interface FreeBody {
  x: number;
  y: number;
  /** Height of the car's reference point — where the railhead was under it. */
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Plan bearing, radians. */
  yaw: number;
  /** Nose-up angle, radians. */
  pitch: number;
  /** Roll about the car's long axis, radians. Past ~π/2 it is on its side. */
  roll: number;
  yawRate: number;
  pitchRate: number;
  rollRate: number;
  /** True once it has stopped moving; skipped by the integrator from then on. */
  settled: boolean;
  /** Whether it ever came to rest on its side. */
  overturned: boolean;
}

export interface DerailmentOptions {
  /** Lateral speed imparted per unit of L/V above the limit, m/s. */
  kick: number;
  /** Upward speed at the moment of derailment, m/s. */
  hop: number;
  /** Spin imparted, radians/s per m/s of lateral kick. */
  spin: number;
  /** Bounce, 0 (dead) to 1 (elastic). Loaded freight cars do not bounce much. */
  restitution: number;
  /** Sliding friction of a car body on ground. */
  friction: number;
  /** Rotational damping per second of ground contact. */
  spinDamping: number;
  /** Below this speed a car is considered stopped, m/s. */
  settleSpeed: number;
  /**
   * Lateral speed given to a car that piles into the wreck, m/s.
   *
   * Much smaller than `kick`, and for a physical reason: a car thrown by
   * curving force is flung, while a car arriving at a pile-up has hit
   * something. Give the second one the first one's energy and the wreck sprays
   * equipment a couple of hundred metres to alternating sides instead of
   * concertinaing beside the track.
   */
  pileupKick: number;
  /** Fraction of forward speed kept when a car piles into the wreck. */
  pileupRetention: number;
  /** How far short of the last wreck the next car stops, in car lengths. */
  pileupSpacing: number;
}

export const DEFAULT_DERAILMENT: DerailmentOptions = {
  kick: 9,
  hop: 1.6,
  spin: 0.3,
  restitution: 0.16,
  friction: 0.8,
  spinDamping: 2.2,
  settleSpeed: 0.25,
  pileupKick: 3.5,
  pileupRetention: 0.15,
  pileupSpacing: 0.55,
};

/**
 * Body roll past which a car is going over rather than settling back.
 *
 * Freight equipment is tall and narrow, and its centre of gravity leaves the
 * wheelbase early; once past about 35° there is nothing bringing it back.
 */
const OVERTURN_ANGLE = 0.6;

/**
 * Throw a car off the track.
 *
 * `side` is +1 or −1 and picks which way it goes; on a curve the caller passes
 * the outside of the curve, and in a pile-up it alternates. `severity` scales
 * the kick — how far past the limit the car was, or how hard it hit the wreck.
 */
export function derailCar(
  car: Car,
  pt: TrackPoint,
  dir: 1 | -1,
  side: number,
  severity: number,
  opt: DerailmentOptions = DEFAULT_DERAILMENT,
  kickSpeed = opt.kick,
): void {
  const heading = pt.heading + (dir === 1 ? 0 : Math.PI);
  const forward = car.v * dir;
  // Right-hand normal to the direction of travel, in plan.
  const nx = Math.sin(heading);
  const ny = -Math.cos(heading);
  const lateral = clamp(severity, 0.2, 3) * kickSpeed * Math.sign(side || 1);

  car.derailed = true;
  car.body = {
    x: pt.x,
    y: pt.y,
    z: pt.z,
    vx: Math.cos(heading) * forward + nx * lateral,
    vy: Math.sin(heading) * forward + ny * lateral,
    vz: opt.hop * clamp(severity, 0.3, 2),
    yaw: heading,
    pitch: Math.atan(pt.grade) * dir,
    roll: 0,
    yawRate: (-lateral * opt.spin * 2) / Math.max(4, car.length),
    pitchRate: 0,
    rollRate: lateral * opt.spin,
    settled: false,
    overturned: false,
  };
  car.v = 0;
  car.couplerAhead = 0;
}

/**
 * How far the car's lowest point sits below its reference point, given roll.
 *
 * Upright that is the underframe, a third of a metre down. On its side it is
 * half the car's height, because the car is now resting on what used to be its
 * flank. Interpolating between the two is what lets a car roll over and end up
 * lying at a believable height instead of sunk into the hillside.
 */
function contactDepth(car: Car, roll: number): number {
  const upright = 0.35;
  const onSide = car.height / 2;
  const t = Math.abs(Math.sin(roll));
  return upright * (1 - t) + onSide * t;
}

/** Advance one derailed car. Does nothing once it has settled. */
export function stepFreeBody(
  car: Car,
  terrain: Terrain,
  dt: number,
  opt: DerailmentOptions = DEFAULT_DERAILMENT,
): void {
  const b = car.body;
  if (!b || b.settled) return;

  b.vz -= G * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;
  b.yaw += b.yawRate * dt;
  b.roll += b.rollRate * dt;
  b.pitch += b.pitchRate * dt;

  // Off the edge of the world: stop rather than fall forever.
  if (!terrain.contains(b.x, b.y)) {
    b.x = clamp(b.x, 0, terrain.width);
    b.y = clamp(b.y, 0, terrain.depth);
    b.vx = 0;
    b.vy = 0;
  }

  const ground = terrain.heightAt(b.x, b.y);
  const rest = ground + contactDepth(car, b.roll);

  if (b.z <= rest) {
    b.z = rest;
    if (b.vz < 0) b.vz = -b.vz * opt.restitution;

    // Sliding friction, applied as an impulse that cannot reverse the slide.
    const speed = Math.hypot(b.vx, b.vy);
    if (speed > 0) {
      const drop = Math.min(speed, opt.friction * G * dt);
      b.vx -= (b.vx / speed) * drop;
      b.vy -= (b.vy / speed) * drop;
    }

    // Ground contact kills rotation quickly, and a car already past
    // `OVERTURN_ANGLE` keeps going over rather than righting itself.
    const damp = Math.exp(-opt.spinDamping * dt);
    b.yawRate *= damp;
    b.rollRate *= damp;
    b.pitchRate *= damp;
    if (Math.abs(b.roll) > OVERTURN_ANGLE) {
      b.roll = Math.sign(b.roll) * Math.min(Math.abs(b.roll) + 1.5 * dt, Math.PI / 2);
      b.overturned = true;
    } else {
      b.roll *= Math.exp(-1.5 * dt);
    }

    // Settle onto the slope: sample the ground under each end and lie along it.
    const half = car.length / 2;
    const fx = Math.cos(b.yaw) * half;
    const fy = Math.sin(b.yaw) * half;
    const target = Math.atan2(
      terrain.heightAt(b.x + fx, b.y + fy) - terrain.heightAt(b.x - fx, b.y - fy),
      car.length,
    );
    b.pitch += (target - b.pitch) * Math.min(1, 6 * dt);

    if (
      Math.hypot(b.vx, b.vy, b.vz) < opt.settleSpeed &&
      Math.abs(b.yawRate) + Math.abs(b.rollRate) < 0.1
    ) {
      b.vx = 0;
      b.vy = 0;
      b.vz = 0;
      b.yawRate = 0;
      b.rollRate = 0;
      b.pitchRate = 0;
      b.settled = true;
    }
  }
}

/**
 * Take a car off the rails *and* record the consequences for the train: the
 * reason, and the anchor that the cars behind will pile into.
 *
 * This is the entry point to use from outside the integrator — to stage a wreck
 * as an initial condition, say, or to model a car on the ground blocking the
 * main. `derailCar` alone throws one car and tells the train nothing.
 */
export function throwCar(
  train: Train,
  car: Car,
  pt: TrackPoint,
  side: number,
  severity: number,
  opt: DerailmentOptions = DEFAULT_DERAILMENT,
  kickSpeed = opt.kick,
  reason?: string,
): void {
  const dir = train.direction;
  const speed = Math.abs(car.v);
  // Remember where on the actual track it came off, so the wreck can be found
  // by anything else that comes along that piece of railway.
  const where = train.route?.locate(car.s);
  derailCar(car, pt, dir, side, severity, opt, kickSpeed);
  if (where) {
    car.foulTrack = where.track.id;
    car.foulAt = where.at;
  }
  train.derailSide = Math.sign(side) || 1;
  if (!train.derailed) {
    train.derail(
      reason ??
        `Car ${car.id} (${car.label}) derailed at ${(pt.s / 1000).toFixed(2)} km` +
          ` doing ${(speed * 3.6).toFixed(0)} km/h.`,
    );
  }
  // The wreck sits across the track a little behind where the car came off, so
  // the next car back reaches it before reaching where this one actually stopped.
  const anchor = car.s - dir * car.length * opt.pileupSpacing;
  train.derailAnchor =
    train.derailAnchor === null
      ? anchor
      : dir > 0
        ? Math.min(train.derailAnchor, anchor)
        : Math.max(train.derailAnchor, anchor);
}

/**
 * Run the cars still on the rails into the wreck ahead of them.
 *
 * The anchor is a position along the path, set where the first car came off and
 * walked backwards as the pile grows. A railed car whose leading end reaches it
 * goes off too, thrown to the opposite side of the one before — which is what
 * gives a pile-up its zigzag — keeping a fraction of its speed, the rest having
 * gone into bending steel.
 *
 * Note what this does *not* model: the cars ahead of the derailment are not
 * dragged back. Their couplers to the wreck are treated as parted, and the head
 * end keeps going. That is the common outcome and it is cheap; a train that
 * pulls apart at both ends of the wreck is the case this gets wrong.
 */
export function propagateDerailment(
  train: Train,
  at: (s: number) => TrackPoint,
  opt: DerailmentOptions = DEFAULT_DERAILMENT,
): void {
  if (train.derailAnchor === null) return;
  const dir = train.direction;

  // A car can only join the pile-up if the car *immediately ahead of it in the
  // consist* is already in it. Testing position alone is not enough and is
  // actively wrong: the cars ahead of the wreck are also "past" the anchor, and
  // a purely positional rule derails the whole head end the instant anything
  // behind it comes off.
  for (let i = 1; i < train.cars.length; i++) {
    const car = train.cars[i]!;
    if (car.derailed || !train.cars[i - 1]!.derailed) continue;
    const leading = car.s + (dir * car.length) / 2;
    if (dir * (leading - train.derailAnchor) < 0) continue;

    const severity = clamp(Math.abs(car.v) / 8, 0.3, 2);
    const pt = at(car.s);
    // The collision takes most of the energy out before the car is thrown, and
    // each car goes to the opposite side of the one before: the accordion.
    car.v *= opt.pileupRetention;
    throwCar(train, car, pt, -train.derailSide, severity, opt, opt.pileupKick);
    train.derailAnchor = car.s - dir * car.length * opt.pileupSpacing;
  }
}
