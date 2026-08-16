/**
 * Longitudinal train dynamics over a graded, curved path.
 *
 * Each car on the rails is a point mass with one degree of freedom — distance
 * along the path — and the forces on it are the ones that decide whether a train
 * moves, stops, or comes apart:
 *
 *   tractive effort   locomotives only, limited by adhesion, not by the engine
 *   grade             m·g·sin θ, the term that makes terrain matter at all
 *   rolling           Davis: a constant, a linear term, and a v² term
 *   curve             empirical, ~4 N per tonne per degree of curve
 *   brake             opposes motion, clamped so it cannot push a car backwards
 *   couplers          slack, then a stiff spring-damper: draft and buff
 *
 * Integration is semi-implicit Euler at a fixed substep. Fixed rather than
 * frame-coupled because the coupler stiffness sets the stability limit, and a
 * dropped frame must not be allowed to blow the consist apart.
 *
 * When a car's L/V exceeds the limit it stops being one of these and becomes a
 * free body — see `derailment.ts`. The rest of the train keeps running; that is
 * the whole point, because what happens to the cars behind a derailment is the
 * interesting part.
 *
 * These are simplified dynamics, honestly labelled: no cant, no vertical
 * dynamics, no air propagation delay down the train line, no per-axle load
 * transfer. The derailment criterion is a Nadal-flavoured L/V estimate, which is
 * the right *shape* — lateral force over vertical load — with coefficients tuned
 * to be illustrative rather than certified.
 */
import { brakingEffort, DEFAULT_AIR, stepAir, type AirBrakeOptions } from './airbrake.ts';
import { DEFAULT_CAB, dynamicBrakeFactor, stepCab, type CabOptions } from './cab.ts';
import { stepLights } from './lights.ts';
import {
  DEFAULT_DERAILMENT,
  type DerailmentOptions,
  propagateDerailment,
  stepFreeBody,
  throwCar,
} from './derailment.ts';
import type { Guideway } from './route.ts';
import type { Terrain } from './terrain.ts';
import type { Car, Train } from './train.ts';
import { G, clamp, curvatureToDegrees, kgToTonnes } from './units.ts';

export interface PhysicsOptions {
  /**
   * Davis rolling resistance, per tonne: `a + b·v + c·v²` newtons, with v in m/s.
   * `a` ≈ 15 N/t is roller-bearing freight at rest.
   */
  davis: { a: number; b: number; c: number };
  /** Curve resistance, newtons per tonne per degree of curve. */
  curveResistance: number;
  /** Wheel-rail adhesion; caps tractive effort at μ·m·g. */
  adhesion: number;
  /** Draft gear stiffness once slack is taken up, N/m. */
  couplerStiffness: number;
  /** Damping ratio of the draft gear. */
  couplerDamping: number;
  /** Free slack per coupler, metres — the clank you hear when a train starts. */
  couplerSlack: number;
  /** The air brake system: pipe, reservoirs, cylinders, leakage. */
  air: AirBrakeOptions;
  /** The rest of the control stand: dynamic brake, sanders, alerter, PCS. */
  cab: CabOptions;
  /** L/V above which a car leaves the rails. */
  derailLV: number;
  /** What happens after it does. */
  derailment: DerailmentOptions;
  /** Integrator substep, seconds. */
  substep: number;
  /** Cap on substeps per call, so a stalled tab cannot spiral. */
  maxSubsteps: number;
}

export const DEFAULT_PHYSICS: PhysicsOptions = {
  davis: { a: 15, b: 0.35, c: 0.0075 },
  curveResistance: 4,
  adhesion: 0.3,
  couplerStiffness: 4e7,
  couplerDamping: 0.35,
  couplerSlack: 0.05,
  air: DEFAULT_AIR,
  cab: DEFAULT_CAB,
  derailLV: 0.8,
  derailment: DEFAULT_DERAILMENT,
  substep: 1 / 240,
  maxSubsteps: 40,
};

/** Rolling resistance in newtons, always opposing motion (magnitude only). */
function davisResistance(car: Car, speed: number, opt: PhysicsOptions): number {
  const t = kgToTonnes(car.mass);
  const v = Math.abs(speed);
  return t * (opt.davis.a + opt.davis.b * v + opt.davis.c * v * v);
}

/**
 * Advance one train by `dt` seconds. Safe to call with a wall-clock frame delta;
 * it substeps internally and clamps runaway deltas.
 *
 * `terrain` is what derailed cars land on. Without it they come off the rails
 * and stop where they were, which is enough for a headless test and not enough
 * for anything you would look at.
 */
export function stepTrain(
  train: Train,
  path: Guideway,
  dt: number,
  opt: PhysicsOptions = DEFAULT_PHYSICS,
  terrain?: Terrain,
): void {
  if (dt <= 0) return;
  // The alerter and the PCS first, because a penalty application has to be in
  // the brake handle before the pipe is stepped — otherwise the brakes go on a
  // frame late and, worse, the throttle gets one more frame of load after the
  // PCS has supposedly dropped it.
  stepCab(train, dt, opt.cab);
  // A horn signal runs on its own once started: the pattern is the substance of
  // Rule 14, and it plays out over seconds of simulated time that may be passing
  // faster or slower than life.
  stepLights(train.lights, dt);
  // The air is stepped once per frame rather than per substep: pressures move
  // over seconds, while the integrator substeps for coupler stiffness, which is
  // a different problem entirely.
  // The train itself, not a copy of its fields: `stepAir` sets `emergency` when
  // the pipe goes to atmosphere, and writing that into a temporary object threw
  // the fact away — the brakes went on and nothing recorded why.
  stepAir(train, dt, opt.air);

  const steps = Math.min(opt.maxSubsteps, Math.max(1, Math.ceil(dt / opt.substep)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) substep(train, path, h, opt, terrain);
}

function substep(
  train: Train,
  path: Guideway,
  dt: number,
  opt: PhysicsOptions,
  terrain: Terrain | undefined,
): void {
  const cars = train.cars;
  const n = cars.length;
  const dir = train.direction;

  // 1. Coupler forces, from the current configuration. Index i holds the force
  //    in the coupler between car i and car i+1; positive is tension. A coupler
  //    to a derailed car has parted.
  const coupler = new Float64Array(Math.max(0, n - 1));
  if (n > 0) cars[0]!.couplerAhead = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = cars[i]!;
    const b = cars[i + 1]!;
    if (a.derailed || b.derailed) {
      coupler[i] = 0;
      b.couplerAhead = 0;
      continue;
    }
    const gap = dir * (a.s - b.s) - (a.length + b.length) / 2;
    const engaged = Math.abs(gap) - opt.couplerSlack;
    if (engaged <= 0) {
      coupler[i] = 0;
      b.couplerAhead = 0;
      continue;
    }
    const extension = Math.sign(gap) * engaged;
    const closing = dir * (a.v - b.v);
    // Critical damping is referenced to the reduced mass of the pair, so a long
    // string of light cars is not over-damped by a locomotive's mass.
    const reduced = (a.mass * b.mass) / (a.mass + b.mass);
    const c = 2 * opt.couplerDamping * Math.sqrt(opt.couplerStiffness * reduced);
    coupler[i] = opt.couplerStiffness * extension + c * closing;
    b.couplerAhead = coupler[i]!;
  }

  // 2. Net force on each car still on the rails, then integrate.
  const leaving: { car: Car; severity: number; side: number }[] = [];

  for (let i = 0; i < n; i++) {
    const car = cars[i]!;
    if (car.derailed) continue;
    const pt = path.at(car.s);
    let f = 0;

    // What the wheel can put down before it slips, and the one number the
    // sanders change. It caps power and dynamic braking alike, because both go
    // through the same contact patch.
    const grip = opt.adhesion * (train.sand ? opt.cab.sandAdhesion : 1) * car.mass * G;

    // Tractive effort, in the direction the consist faces, adhesion-limited —
    // and only if the reverser is off centre and the PCS is closed. Neither is
    // a soft limit or a warning: with either against you the motors cannot be
    // energised at all, and the handle moves with nothing happening.
    if (
      car.kind === 'locomotive' &&
      train.throttle !== 0 &&
      train.dynamic <= 0 &&
      train.loadAvailable
    ) {
      const demanded = car.maxTractiveEffort * train.throttle;
      f += dir * clamp(demanded, -grip, grip);
    }

    // Grade. sin θ from the tangent, so a 10% grade is not 10% off.
    const sinTheta = pt.grade / Math.sqrt(1 + pt.grade * pt.grade);
    f -= car.mass * G * sinTheta;

    // Couplers: tension from the car ahead pulls this car forward along the
    // consist, tension behind holds it back.
    if (i > 0) f += dir * coupler[i - 1]!;
    if (i < n - 1) f -= dir * coupler[i]!;

    // Everything above is a *driving* force — it has a sign of its own. What
    // follows resists motion, and resistance can only ever bring a car to a
    // stand, never push it the other way. Keeping the two sums apart is what
    // makes that distinction expressible: comparing against a total that already
    // had the brake subtracted from it lets a hard application reverse the
    // train, which is the classic form of this bug.
    const degrees = curvatureToDegrees(pt.curvature);
    const resist =
      davisResistance(car, car.v, opt) + kgToTonnes(car.mass) * opt.curveResistance * degrees;
    // The air brake force comes from this car's own brake cylinder, not from the
    // handle in the cab — so a car cut out, or one whose piston travel is out of
    // limits, brakes badly while everything in the cab looks normal.
    //
    // A handbrake holds whether or not there is any air at all, which is the
    // entire reason 112 is written in terms of handbrakes.
    // The independent brake is straight air to the locomotive's own cylinders,
    // so it holds the engine and nothing behind it. Whichever of the two is
    // asking for more brake is what the engine gets.
    const automatic = brakingEffort(car.air, opt.air);
    const applied =
      car.kind === 'locomotive' ? Math.max(automatic, clamp(train.independent, 0, 1)) : automatic;
    // Dynamic braking belongs here, with the resistances, and not with the
    // driving forces: it can bring a train down to a crawl and it can never
    // push it the other way. It also fades to nothing as the train slows, which
    // is why holding a grade on dynamic alone ends with the train getting away
    // — the retarding force disappears exactly when it is least wanted.
    const dynamic =
      car.kind === 'locomotive' && train.dynamic > 0 && train.loadAvailable
        ? Math.min(
            car.maxDynamicForce *
              clamp(train.dynamic, 0, 1) *
              dynamicBrakeFactor(car.v, opt.cab),
            grip,
          )
        : 0;
    const braking = car.maxBrakeForce * applied + (car.handbrake ? car.handbrakeForce : 0) + dynamic;
    const hold = resist + braking;

    const moving = Math.abs(car.v) > 1e-4;
    let v: number;
    if (!moving) {
      // Stiction: a stopped car stays stopped until the driving forces exceed
      // what resistance and any brake application can hold.
      v = Math.abs(f) <= hold ? 0 : (Math.sign(f) * (Math.abs(f) - hold) * dt) / car.mass;
    } else {
      v = car.v + ((f - Math.sign(car.v) * hold) / car.mass) * dt;
      // If the step took the car through zero, it stopped there — unless the
      // driving forces alone are enough to keep it going the other way.
      if (Math.sign(v) !== Math.sign(car.v)) v = Math.abs(f) <= hold ? 0 : v;
    }

    car.v = v;
    car.s += v * dt;

    // 3. Derailment. Two lateral contributions, both divided by the vertical
    //    wheel load: unbalanced curving force (v²/R), and the lateral component
    //    of buff force through a car body that is chorded across the curve.
    const invR = Math.abs(pt.curvature);
    const curving = (car.v * car.v * invR) / G;
    const buffAhead = i > 0 ? Math.min(0, coupler[i - 1]!) : 0;
    const buffBehind = i < n - 1 ? Math.min(0, coupler[i]!) : 0;
    const buff = Math.max(Math.abs(buffAhead), Math.abs(buffBehind));
    const stringlining = (buff * car.length * invR) / (car.mass * G);
    car.lv = curving + stringlining;

    if (car.lv > opt.derailLV) {
      // Thrown to the outside of the curve, relative to the way it is going. A
      // car on tangent track has no side to be thrown to, so it takes the one
      // the buff force gives it.
      const outward = pt.curvature !== 0 ? Math.sign(pt.curvature) * dir : train.derailSide;
      leaving.push({ car, severity: car.lv / opt.derailLV, side: outward });
    }
  }

  // 4. Take off the rails whatever exceeded the limit this step.
  for (const { car, severity, side } of leaving) {
    const pt = path.at(car.s);
    throwCar(
      train,
      car,
      pt,
      side,
      severity,
      opt.derailment,
      opt.derailment.kick,
      `Car ${car.id} (${car.label}) derailed at ${(pt.s / 1000).toFixed(2)} km:` +
        ` L/V ${car.lv.toFixed(2)} against a limit of ${opt.derailLV.toFixed(2)}.`,
    );
  }

  // 5. Free bodies, and the cars still running that are about to join them.
  if (terrain) {
    for (const car of cars) {
      if (car.derailed) stepFreeBody(car, terrain, dt, opt.derailment);
    }
  }
  propagateDerailment(train, (s) => path.at(s), opt.derailment);

  // 6. The end of the route. A route can end for two different reasons and they
  //    are not the same event: end of steel stops a movement, while a switch
  //    lined against a trailing move gets run through — the points burst and
  //    the movement goes on the ground.
  // Both ends of the route, not just the one ahead: a movement backing up can
  // reach a switch lined against it or a derail on the rail just as easily as
  // one going forward, and the consequences are identical.
  if (!path.closed && n > 0) {
    const ends = [
      { stop: path.stop, at: path.length, sign: 1 },
      { stop: path.stopBehind, at: 0, sign: -1 },
    ] as const;
    for (const end of ends) {
      const reason = end.stop?.reason;
      if (reason !== 'runThrough' && reason !== 'derail') continue;
      const where = end.stop && 'node' in end.stop ? end.stop.node : 'the switch';
      for (const car of cars) {
        if (car.derailed) continue;
        const edge = car.s + (end.sign * car.length) / 2;
        if (end.sign * (edge - end.at) < 0) continue;
        throwCar(
          train,
          car,
          path.at(end.at),
          train.derailSide,
          clamp(Math.abs(car.v) / 6, 0.4, 2),
          opt.derailment,
          opt.derailment.kick * 0.7,
          reason === 'derail'
            ? `Car ${car.id} (${car.label}) was put on the ground by the derail at ${where}.`
            : `Car ${car.id} (${car.label}) ran through the switch at ${where} and derailed.`,
        );
      }
    }
  }

  // 7. End of steel stops the train. Clamping each car where it stands would
  //    shorten the consist into itself and fire the couplers off like a spring,
  //    so the whole train is shifted as one body and stopped.
  if (!path.closed && n > 0) {
    let lo = Infinity;
    let hi = -Infinity;
    let any = false;
    for (const car of cars) {
      if (car.derailed) continue;
      any = true;
      if (car.s - car.length / 2 < lo) lo = car.s - car.length / 2;
      if (car.s + car.length / 2 > hi) hi = car.s + car.length / 2;
    }
    const shift = !any ? 0 : hi > path.length ? path.length - hi : lo < 0 ? -lo : 0;
    if (shift !== 0) {
      // Only the motion that would carry the train further off the end is
      // stopped. Zeroing velocity outright pins a train whose tail happens to
      // start behind the end of steel: it is held against the stop, and every
      // step it tries to pull away it is stopped again.
      const blocked = shift < 0 ? 1 : -1;
      for (const car of cars) {
        if (car.derailed) continue;
        car.s += shift;
        if (Math.sign(car.v) === blocked) car.v = 0;
      }
    }
  }
}

export interface Telemetry {
  /** Speed in the direction of travel, m/s. */
  speed: number;
  /** Distance of the lead coupler along the path, metres. */
  headPosition: number;
  /** Grade under the lead car, signed rise/run. */
  grade: number;
  /** Degree of curve under the lead car. */
  curveDegrees: number;
  /** Largest draft (tension) force anywhere in the train, newtons. */
  maxDraft: number;
  /** Largest buff (compression) force, newtons, as a positive magnitude. */
  maxBuff: number;
  maxLV: number;
  /** Total consist mass, kilograms. */
  mass: number;
  /**
   * The air flow indicator, CFM. Below about 60 is a train that is charged and
   * holding; a number that will not come down is a leak somebody has to find.
   */
  airFlowCfm: number;
  /** Dynamic braking force the whole train is making right now, newtons. */
  dynamicForce: number;
  derailed: boolean;
  /** How many cars are off the rails. */
  derailedCount: number;
  /** Of those, how many ended up on their side. */
  overturned: number;
  reason: string;
}

export function telemetry(train: Train, path: Guideway): Telemetry {
  const lead = train.cars.find((c) => !c.derailed) ?? train.cars[0];
  const pt = path.at(lead ? lead.s : 0);
  let maxDraft = 0;
  let maxBuff = 0;
  let maxLV = 0;
  let overturned = 0;
  let dynamicForce = 0;
  for (const car of train.cars) {
    if (car.couplerAhead > maxDraft) maxDraft = car.couplerAhead;
    if (-car.couplerAhead > maxBuff) maxBuff = -car.couplerAhead;
    if (!car.derailed && car.lv > maxLV) maxLV = car.lv;
    if (car.body?.overturned) overturned++;
    if (!car.derailed && car.kind === 'locomotive' && train.dynamic > 0 && train.loadAvailable) {
      dynamicForce += car.maxDynamicForce * clamp(train.dynamic, 0, 1) * dynamicBrakeFactor(car.v);
    }
  }
  return {
    speed: train.speed,
    headPosition: train.headPosition,
    grade: pt.grade,
    curveDegrees: curvatureToDegrees(pt.curvature),
    maxDraft,
    maxBuff,
    maxLV,
    mass: train.mass,
    airFlowCfm: train.airFlowCfm,
    dynamicForce,
    derailed: train.derailed,
    derailedCount: train.derailedCount,
    overturned,
    reason: train.derailmentReason,
  };
}
