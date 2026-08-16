/**
 * The air brake: a pipe down the length of the train, and what each car does
 * with what it finds in it.
 *
 * This is the piece the rest of the model kept running into. `Train.brake` used
 * to be one number for the whole consist, so a cut was a mechanical parting and
 * nothing else, securement was a boolean, and GOI 7 could not be asked. The
 * substance of railway braking is that **the pipe is not the brake** — it is the
 * signal — and almost everything surprising about handling a train follows from
 * that one inversion.
 *
 * ── How it works, and why it is backwards ──
 *
 * The brake pipe runs the length of the train, car to car through hoses that
 * have to be coupled by hand, with an angle cock at each end of every car. Air
 * in the pipe *holds the brakes off*. The engineer applies the brakes by
 * **reducing** pipe pressure, and every car's control valve reads the drop and
 * moves air from that car's own auxiliary reservoir into its own brake cylinder.
 *
 * Three consequences the model gets for free from doing it this way:
 *
 *   - **Parting the train applies the brakes.** Pull the pin without closing the
 *     angle cocks and the hoses separate, both ends vent to atmosphere, and both
 *     portions go into emergency. That is not a special case here; it is what
 *     falls out of an open end.
 *   - **A cut of cars leaks off and then releases.** A car standing with its
 *     angle cock closed slowly loses pipe pressure, which *applies* its brakes —
 *     and then, over hours, the cylinder leaks too and they come off. That is
 *     the reason 112 is written about handbrakes and not about the air, and it
 *     is why a car left "with the air set" is not secured.
 *   - **The rear of the train does not know yet.** Pressure propagates along the
 *     pipe, so a long train applies from the head end backwards. Run-in on a
 *     service application is a consequence of that delay.
 *
 * ── What is simplified ──
 *
 * One reservoir per car rather than the auxiliary and emergency pair, so an
 * emergency application is modelled as a bigger reduction rather than as a
 * second reservoir dumping. No quick-service, no accelerated release, no
 * two-pipe locomotive brake, no pressure-maintaining feature. Propagation is
 * diffusion along the pipe rather than a wave, which gets the *order* and
 * roughly the timing right and does not pretend to model a serial venting.
 *
 * Pressures are psi throughout, because that is the unit the equipment, the
 * rulebook and the crew all use. It is the one place this package is not SI, and
 * it is deliberate: a brake pipe reduction quoted in kilopascals would be a
 * number nobody could check against anything.
 */
import { clamp } from './units.ts';

/**
 * Retaining valve positions.
 *
 * The retainer holds back some brake cylinder pressure when the engineer
 * releases, so a train descending a long grade can recharge its reservoirs
 * without losing all its braking at once. Set by hand, on each car, by somebody
 * walking the train — which is why it takes as long as it takes.
 *
 * `EX` is direct exhaust: the retainer does nothing and the cylinder empties.
 * The others hold pressure back, `SD` by exhausting slowly rather than by
 * holding a set value. Older retainers had three positions; four is modern.
 */
export type RetainerPosition = 'EX' | 'SD' | 'LP' | 'HP';

/** Cylinder pressure each retainer setting holds back, psi. */
export const RETAINED_PSI: Record<RetainerPosition, number> = {
  EX: 0,
  SD: 0,
  LP: 10,
  HP: 20,
};

/** One car's air, and the fittings a person can reach out and work. */
export interface CarAir {
  /** Pressure in this car's length of brake pipe, psi. */
  brakePipePsi: number;
  /** This car's reservoir, psi. What its own brakes are applied with. */
  reservoirPsi: number;
  /**
   * What the control valve takes a full release to be, psi.
   *
   * The valve does not compare the pipe against the reservoir — that comparison
   * fails the moment the two equalise, which is exactly what happens a few
   * seconds into any application, and it would release the brakes on its own. It
   * compares the pipe against the pressure it was last *released* at, and holds
   * the cylinder at whatever that reduction demands. So this follows the pipe
   * upward, on a recharge, and never downward.
   */
  referencePsi: number;
  /** Brake cylinder pressure, psi. This is what actually stops the car. */
  cylinderPsi: number;

  /** Hose coupled to the car ahead / behind. Bucked up by hand. */
  hoseAhead: boolean;
  hoseBehind: boolean;
  /** Angle cocks at each end. Closed shuts this car's pipe off from that end. */
  cockAhead: boolean;
  cockBehind: boolean;
  /** Branch pipe cut-out: this car's brakes are isolated, pipe still passes air. */
  cutOut: boolean;
  retainer: RetainerPosition;

  /**
   * Brake cylinder piston travel, inches.
   *
   * An inspection item with a limit, and a real one: travel beyond about ten
   * inches means the cylinder runs out of stroke before the shoes are properly
   * against the wheel, and the car brakes badly without anything looking wrong.
   * Derived from cylinder pressure and the slack adjustment.
   */
  pistonTravelIn: number;
  /** Where the slack adjuster has this car set. Nominal is about 7.5 in. */
  nominalTravelIn: number;
  /** Pipe leakage at this car, psi per minute. Every car leaks a little. */
  leakPsiPerMin: number;
}

export interface AirBrakeOptions {
  /** Pressure the locomotive charges the pipe to with the brakes released. */
  regulatingPsi: number;
  /** A full service reduction, psi below regulating. */
  fullServicePsi: number;
  /** How fast pressure moves between adjacent cars. Sets propagation delay. */
  propagation: number;
  /** How fast the locomotive can feed or vent the pipe at the head end. */
  feedRate: number;
  /** How fast an open end dumps to atmosphere. */
  ventRate: number;
  /** How fast a cylinder fills from its own reservoir once applying. */
  applyRate: number;
  /** How fast a cylinder exhausts on release, down to the retained pressure. */
  releaseRate: number;
  /** How fast a reservoir recharges from the pipe. */
  rechargeRate: number;
  /** Cylinder leakage, psi per minute. This is what eventually releases a cut. */
  cylinderLeakPsiPerMin: number;
  /**
   * Reservoir leakage, psi per minute.
   *
   * Slower than the cylinder, and it is what finishes the job: a cut standing
   * long enough loses the pipe first (brakes apply), then the cylinder (brakes
   * come off), and finally the reservoir, after which there is nothing left to
   * apply them with at all. Hours, not minutes — which is exactly the timescale
   * 112 is written against, and exactly why it asks for handbrakes.
   */
  reservoirLeakPsiPerMin: number;
  /** Cylinder pressure at which a car develops its full rated brake force. */
  fullCylinderPsi: number;
  /** Piston travel beyond which braking starts to fall off, inches. */
  travelLimitIn: number;
  /**
   * Cubic feet per minute shown on the air flow indicator per psi per second the
   * head end is feeding into the pipe.
   *
   * The gauge does not read a pressure — it reads how hard the locomotive is
   * working to hold the pressure it has, which is the same thing as how much the
   * train is leaking. Standing charged, a tight train reads low and a leaky one
   * reads high; during a recharge it pins. That is why it is the gauge a brake
   * test is read off, and why 60 CFM is the number people quote.
   */
  flowCfmPerPsiPerSecond: number;
  /** Time constant of the gauge's damping, seconds. A real one is not twitchy. */
  flowDampingSeconds: number;
}

export const DEFAULT_AIR: AirBrakeOptions = {
  regulatingPsi: 90,
  fullServicePsi: 26,
  propagation: 1.6,
  feedRate: 9,
  ventRate: 40,
  applyRate: 14,
  releaseRate: 10,
  rechargeRate: 3.5,
  cylinderLeakPsiPerMin: 1.2,
  reservoirLeakPsiPerMin: 0.4,
  fullCylinderPsi: 50,
  travelLimitIn: 10.5,
  flowCfmPerPsiPerSecond: 100,
  flowDampingSeconds: 2.5,
};

export interface AirSpec {
  hoseAhead?: boolean;
  hoseBehind?: boolean;
  cockAhead?: boolean;
  cockBehind?: boolean;
  cutOut?: boolean;
  retainer?: RetainerPosition;
  nominalTravelIn?: number;
  leakPsiPerMin?: number;
  /** Start with no air at all — a car that has been standing for days. */
  empty?: boolean;
}

export function buildAir(spec: AirSpec = {}): CarAir {
  return {
    brakePipePsi: 0,
    reservoirPsi: 0,
    referencePsi: 0,
    cylinderPsi: 0,
    hoseAhead: spec.hoseAhead ?? true,
    hoseBehind: spec.hoseBehind ?? true,
    cockAhead: spec.cockAhead ?? true,
    cockBehind: spec.cockBehind ?? true,
    cutOut: spec.cutOut ?? false,
    retainer: spec.retainer ?? 'EX',
    pistonTravelIn: 0,
    nominalTravelIn: spec.nominalTravelIn ?? 7.5,
    leakPsiPerMin: spec.leakPsiPerMin ?? 0.6,
  };
}

/** The cars of one movement, as the air sees them: an ordered run of pipe. */
export interface AirTrain {
  /** Lead first, as `Train.cars` is. */
  cars: { air: CarAir; handbrake: boolean }[];
  /** The engineer's automatic brake handle, 0 released to 1 full service. */
  brake: number;
  /** True while the brakes are in emergency; cleared only by a full release. */
  emergency: boolean;
  /** Whether a locomotive is on this movement feeding the pipe. */
  hasAir: boolean;
  /** The air flow indicator, cubic feet per minute. Written by `stepAir`. */
  airFlowCfm: number;
}

/**
 * Whether the pipe is continuous between a car and the one behind it.
 *
 * Both angle cocks open *and* the hoses coupled. Either cock shut, or a hose
 * hanging, and the pipe ends there — which is the same condition whether it was
 * done on purpose or happened when somebody pulled a pin.
 */
function continuous(a: CarAir, b: CarAir): boolean {
  return a.cockBehind && b.cockAhead && a.hoseBehind && b.hoseAhead;
}

/**
 * Whether an end of the train is open to atmosphere.
 *
 * An angle cock left open at the end of the pipe with nothing coupled to it is
 * a hole, and the whole system drains through it. Closed, or with the hose hung
 * up, and it holds.
 */
function ventsAhead(air: CarAir): boolean {
  return air.cockAhead && !air.hoseAhead;
}
function ventsBehind(air: CarAir): boolean {
  return air.cockBehind && !air.hoseBehind;
}

/**
 * Advance the air by `dt` seconds.
 *
 * Four passes, in this order, and the order matters: the pipe is fed and vented
 * first, then it equalises along the train, then each car's control valve reads
 * its own local pressure and moves air about, then the mechanical consequences
 * are worked out. A valve that read the pipe before it had settled would react
 * to a pressure that never existed anywhere.
 */
export function stepAir(train: AirTrain, dt: number, opt: AirBrakeOptions = DEFAULT_AIR): void {
  const cars = train.cars;
  const n = cars.length;
  if (n === 0) return;

  // Where the engineer's handle is asking the pipe to be. Note that being in
  // emergency does *not* hold this at zero: an emergency application is a hole
  // that has already been made — see `dumpBrakePipe` — and what recovers from it
  // is putting the handle to release and letting the pipe fill again. Holding
  // the target at zero while in emergency is a deadlock, because the emergency
  // only lifts once the pipe is back up.
  const target = opt.regulatingPsi - clamp(train.brake, 0, 1) * opt.fullServicePsi;

  // 1. The head end feeds or vents the pipe, if there is anything there to do it.
  const head = cars[0]!.air;
  let fed = 0;
  if (train.hasAir) {
    const delta = clamp(target - head.brakePipePsi, -opt.feedRate * dt, opt.feedRate * dt);
    head.brakePipePsi += delta;
    // Only air going *in* counts. Venting the pipe to apply the brakes is the
    // engineer letting air out, not the compressor making it up.
    fed = Math.max(0, delta);
  }

  // 2. Leakage, and any open end draining to atmosphere.
  for (const { air } of cars) {
    air.brakePipePsi = Math.max(0, air.brakePipePsi - (air.leakPsiPerMin / 60) * dt);
    if (ventsAhead(air) || ventsBehind(air)) {
      air.brakePipePsi = Math.max(0, air.brakePipePsi - opt.ventRate * dt);
    }
  }

  // 3. Equalise along whatever lengths of pipe are actually joined up. This is
  //    the propagation delay: the rear of a long train is still at running
  //    pressure for a while after the head end has begun to reduce.
  for (let i = 0; i < n - 1; i++) {
    const a = cars[i]!.air;
    const b = cars[i + 1]!.air;
    if (!continuous(a, b)) continue;
    const flow = (a.brakePipePsi - b.brakePipePsi) * clamp(opt.propagation * dt, 0, 0.5);
    a.brakePipePsi -= flow;
    b.brakePipePsi += flow;
  }

  // 4. Each car's control valve, reading only its own pipe pressure.
  let triggered = false;
  for (const car of cars) {
    const air = car.air;

    // A sharp enough drop anywhere puts the whole movement in emergency.
    if (air.brakePipePsi < opt.regulatingPsi * 0.35 && train.hasAir && !train.emergency) {
      triggered = true;
    }

    // The reference follows the pipe up and never down: a recharge is a release,
    // and a reduction is measured from wherever the last release left it.
    if (air.brakePipePsi > air.referencePsi) {
      air.referencePsi = Math.min(
        air.brakePipePsi,
        air.referencePsi + opt.rechargeRate * 2 * dt,
      );
    }

    // How hard this car's brakes are being asked to go on, from the size of the
    // reduction alone. Cap it: a service application can only equalise, while an
    // emergency brings the emergency portion in as well.
    const reduction = Math.max(0, air.referencePsi - air.brakePipePsi);
    const demanded = clamp(
      (reduction / opt.fullServicePsi) * opt.fullCylinderPsi,
      0,
      train.emergency ? opt.fullCylinderPsi * 1.28 : opt.fullCylinderPsi,
    );

    if (air.cutOut) {
      // Cut out: the pipe still passes air through this car, but its own brakes
      // are isolated and do nothing. A car cut out in the middle of a train is
      // a car that is not braking, and nothing about the pipe reveals it.
      air.cylinderPsi = Math.max(0, air.cylinderPsi - opt.releaseRate * dt);
    } else if (air.cylinderPsi < demanded) {
      // Applying: air from this car's own reservoir into its own cylinder. It
      // can never get more than the reservoir has, which is why repeated
      // applications without time to recharge run a train out of brakes.
      const available = Math.min(demanded, air.reservoirPsi);
      if (air.cylinderPsi < available) {
        const moved = Math.min(opt.applyRate * dt, available - air.cylinderPsi);
        air.cylinderPsi += moved;
        air.reservoirPsi = Math.max(0, air.reservoirPsi - moved * 0.55);
      }
    } else if (air.cylinderPsi > demanded) {
      // Releasing, but only down to what the retainer holds back.
      const retained = air.retainer === 'SD' ? air.cylinderPsi * 0.92 : RETAINED_PSI[air.retainer];
      const floor = Math.max(demanded, Math.min(retained, air.cylinderPsi));
      air.cylinderPsi = Math.max(floor, air.cylinderPsi - opt.releaseRate * dt);
    }

    // The reservoir refills from the pipe whenever the pipe is the higher of the
    // two — at the reduced pressure during an application, and back to full once
    // the engineer releases.
    if (air.reservoirPsi < air.brakePipePsi) {
      air.reservoirPsi = Math.min(air.brakePipePsi, air.reservoirPsi + opt.rechargeRate * dt);
    }

    // Everything leaks, including the cylinder and the reservoir — which is why
    // a cut of cars left with the air applied eventually releases itself and
    // rolls away, and why "I left the air on it" is not securement.
    air.cylinderPsi = Math.max(0, air.cylinderPsi - (opt.cylinderLeakPsiPerMin / 60) * dt);
    air.reservoirPsi = Math.max(0, air.reservoirPsi - (opt.reservoirLeakPsiPerMin / 60) * dt);

    // Piston travel: the cylinder strokes further as it fills, from the slack
    // adjuster's setting.
    air.pistonTravelIn =
      air.cylinderPsi <= 0
        ? 0
        : air.nominalTravelIn * (0.55 + 0.45 * clamp(air.cylinderPsi / opt.fullCylinderPsi, 0, 1.3));
  }

  // An emergency does not creep down the train the way a service reduction
  // does: the vent valves open one after another at something like the speed of
  // sound in the pipe, which at this timescale is the whole train at once. So it
  // is applied after the valves have been read, to the whole movement.
  if (triggered) dumpBrakePipe(train);

  // The air flow indicator, damped the way the real gauge is. What the head end
  // had to put in to hold the pipe where it is, which at a steady state is
  // exactly the whole train's leakage.
  const instantaneous = dt > 0 ? (fed / dt) * opt.flowCfmPerPsiPerSecond : 0;
  const blend = opt.flowDampingSeconds > 0 ? clamp(dt / opt.flowDampingSeconds, 0, 1) : 1;
  train.airFlowCfm += (Math.min(instantaneous, 150) - train.airFlowCfm) * blend;

  // Emergency stands until the engineer puts the handle to full release and the
  // pipe has been recharged — which on a long train is minutes, not seconds.
  if (train.emergency && train.brake <= 0.01 && head.brakePipePsi > opt.regulatingPsi * 0.9) {
    train.emergency = false;
  }
}

/**
 * How hard one car's brakes are gripping, 0 to 1 of its rated force.
 *
 * Piston travel past the limit costs braking, and this is where the inspection
 * item becomes a physical consequence rather than a note: a car with ten and a
 * half inches of travel does not stop as well as one with seven, and nothing
 * about the way it sounds or looks from the cab says so.
 */
export function brakingEffort(air: CarAir, opt: AirBrakeOptions = DEFAULT_AIR): number {
  if (air.cutOut) return 0;
  const pressure = clamp(air.cylinderPsi / opt.fullCylinderPsi, 0, 1.3);
  const over = Math.max(0, air.pistonTravelIn - opt.travelLimitIn);
  const stroke = clamp(1 - over / 6, 0.25, 1);
  return pressure * stroke;
}

/**
 * Charge the system to a steady state, as though it had been standing coupled to
 * a working locomotive long enough to settle.
 *
 * Called when a scene loads, so a train that says `brake: 1` starts with its
 * brakes actually applied rather than spending the first minute of the scene
 * pumping air. Anything not connected to the head end is left as it is — a cut
 * of cars standing in a siding has whatever air it was left with, which is the
 * honest starting condition and usually not much.
 */
export function chargeToSteadyState(train: AirTrain, opt: AirBrakeOptions = DEFAULT_AIR): void {
  if (!train.hasAir) return;
  const target = opt.regulatingPsi - clamp(train.brake, 0, 1) * opt.fullServicePsi;
  let reached = true;
  // What the gauge would already be reading: the standing leakage of every car
  // the pipe actually reaches. Seeded rather than left at zero so a scene does
  // not open with an impossibly tight train that then drifts up.
  let leaking = 0;
  for (let i = 0; i < train.cars.length; i++) {
    const air = train.cars[i]!.air;
    const previous = i > 0 ? train.cars[i - 1]!.air : null;
    if (previous && !continuous(previous, air)) reached = false;
    if (!reached || ventsAhead(air) || ventsBehind(air)) continue;
    leaking += air.leakPsiPerMin / 60;

    air.brakePipePsi = target;
    air.reservoirPsi = opt.regulatingPsi;
    air.referencePsi = opt.regulatingPsi;
    if (air.cutOut) {
      air.cylinderPsi = 0;
    } else {
      const reduction = opt.regulatingPsi - target;
      air.cylinderPsi = clamp(
        (reduction / opt.fullServicePsi) * opt.fullCylinderPsi,
        0,
        opt.fullCylinderPsi,
      );
    }
    air.pistonTravelIn =
      air.cylinderPsi <= 0
        ? 0
        : air.nominalTravelIn * (0.55 + 0.45 * clamp(air.cylinderPsi / opt.fullCylinderPsi, 0, 1.3));
  }
  train.airFlowCfm = Math.min(150, leaking * opt.flowCfmPerPsiPerSecond);
}

/**
 * Open both ends of a parted coupling to atmosphere.
 *
 * Called when a coupling is broken without closing the angle cocks first. The
 * hoses come apart and stay apart; whether that dumps the air depends entirely
 * on whether somebody closed the cocks, which is exactly the decision the rule
 * is about.
 */
/**
 * Put a movement in emergency, and open the pipe to do it.
 *
 * Setting the flag alone is not enough and the difference is not cosmetic: the
 * emergency releases when the pipe is back at running pressure, so a flag set
 * against a pipe that is still full clears itself on the very next step and
 * nothing happens at all. An emergency application is a hole in the pipe. This
 * makes the hole.
 */
export function dumpBrakePipe(train: AirTrain): void {
  train.emergency = true;
  for (const { air } of train.cars) air.brakePipePsi = 0;
}

export function partHoses(ahead: CarAir, behind: CarAir): void {
  ahead.hoseBehind = false;
  behind.hoseAhead = false;
}
