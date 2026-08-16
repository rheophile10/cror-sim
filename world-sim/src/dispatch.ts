/**
 * Driving a movement nobody is sitting in.
 *
 * The design note in `DESIGN-conductor.md` said plainly that this package gives
 * you *bodies*, not *agents* — that a second person who always complies is a
 * function call with a costume on. That is still true of people. This is the
 * narrow exception, and it is worth making for one reason: **a railway with only
 * one train on it cannot teach you anything about signals.**
 *
 * What an opposing movement has to do to be worth having is small. It has to
 * read the signal in front of it, slow for the ones that ask it to, and stop at
 * a Stop. Everything else — where it goes, whether it takes the siding, whether
 * it is held — is decided by the switches and the signals, exactly as on a
 * railway. There is no dispatcher here making choices, and there should not be:
 * the moment this module starts deciding which train takes the siding, it has
 * taken over the job the signals exist to do, and the simulation stops being
 * about signals.
 *
 * ── Obeying, and not obeying ──
 *
 * `obeySignals: false` is not an oversight. A movement that runs past a Stop is
 * the thing a signalled railway is built to prevent, and being able to *watch*
 * that happen — from the cab of the train it is coming at — is the point of
 * modelling signals at all. A scene can put one on the railway deliberately.
 *
 * ── What is simplified ──
 *
 * Braking is a proportional controller against a stopping distance, not a real
 * brake curve: it reduces early and holds, rather than making the graduated
 * applications an engineer would. It has no memory of the last signal, so it
 * cannot act on an Advance aspect two signals ahead, and it does not know about
 * the rear of its own train. It is a road engine that reads what is in front of
 * it, which is enough to hold a meet and not enough to be called an engineer.
 */
import type { Train } from './train.ts';
import { speedLimitMps, type SignalSighting } from './signals.ts';
import { clamp } from './units.ts';

export interface AutoSpec {
  /** Drive this movement. Absent or false leaves it to whoever is in the cab. */
  drive?: boolean;
  /** Speed to make when the road is clear, m/s. */
  cruise?: number;
  /**
   * Read fixed signals and act on them.
   *
   * False makes a movement that will run past a Stop and into whatever is on
   * the other side of it — which is a thing scenes should be able to stage.
   */
  obeySignals?: boolean;
  /** How far ahead it looks, metres. Beyond this it has seen nothing. */
  sight?: number;
  /** Track speed for aspects that permit it, mph. */
  trackSpeedMph?: number;
}

export interface AutoDriver {
  drive: boolean;
  cruise: number;
  obeySignals: boolean;
  sight: number;
  trackSpeedMph: number;
  /** What it is doing about what it can see, for the log and the label. */
  reason: string;
  /** The speed it is currently working to, m/s. */
  target: number;
}

export interface DispatchOptions {
  /** Service deceleration assumed when working out where to start braking. */
  brakingRate: number;
  /** Extra room left short of a Stop signal, metres. */
  margin: number;
  /** Speed below which a movement is treated as stopped, m/s. */
  stopped: number;
}

export const DEFAULT_DISPATCH: DispatchOptions = {
  // Deliberately gentle: a loaded freight does not stop like a car, and a
  // controller tuned to a rate it cannot achieve overruns every signal.
  brakingRate: 0.28,
  margin: 30,
  stopped: 0.3,
};

export function buildAutoDriver(spec: AutoSpec = {}): AutoDriver {
  return {
    drive: spec.drive ?? false,
    cruise: spec.cruise ?? 17,
    obeySignals: spec.obeySignals ?? true,
    sight: spec.sight ?? 2500,
    trackSpeedMph: spec.trackSpeedMph ?? 45,
    reason: 'standing by',
    target: 0,
  };
}

/**
 * Work out what speed a movement should be making, given what it can see.
 *
 * Split out from the controller so it can be tested on its own, and so the
 * reason is available to a label without running the physics.
 */
export function permittedSpeed(
  driver: AutoDriver,
  sighting: SignalSighting | null,
  speed: number,
  opt: DispatchOptions = DEFAULT_DISPATCH,
): { target: number; reason: string } {
  if (!driver.obeySignals) return { target: driver.cruise, reason: 'not obeying signals' };
  if (!sighting) return { target: driver.cruise, reason: 'no signal in sight' };

  const aspect = sighting.signal.aspect;
  const passing = speedLimitMps(aspect.passing, driver.trackSpeedMph);
  const next = speedLimitMps(aspect.next, driver.trackSpeedMph);
  const name = sighting.signal.label ?? sighting.signal.id;

  // A Stop is not a speed to be made at the signal — it is a place to be
  // stopped short of. Everything else is a speed limit, either here or there.
  if (passing !== null && passing <= 0) {
    const room = Math.max(0, sighting.distance - opt.margin);
    // v² = 2·a·s, the speed from which this movement could still stop in the
    // room it has left. Approaching a Stop, that *is* the permitted speed.
    const stoppable = Math.sqrt(2 * opt.brakingRate * room);
    return {
      target: Math.min(driver.cruise, stoppable),
      reason: `${name}: Stop in ${Math.round(sighting.distance)} m`,
    };
  }

  let target = Math.min(driver.cruise, passing ?? driver.cruise);
  let reason = `${name}: ${aspect.name}`;

  // The requirement at the *next* signal has to be met by the time it is
  // reached, so it starts biting well before this one is passed.
  if (next !== null && next < target) {
    const room = Math.max(0, sighting.distance);
    const allowed = Math.sqrt(next * next + 2 * opt.brakingRate * room);
    if (allowed < target) {
      target = allowed;
      reason = `${name}: ${aspect.name} — reducing for the next`;
    }
  }
  void speed;
  return { target: Math.max(0, target), reason };
}

/**
 * Drive one movement for a step.
 *
 * Sets the throttle and the automatic brake and nothing else; the physics and
 * the air brake do the rest, so an automatic movement is subject to exactly the
 * same brake pipe, adhesion and grade as a driven one.
 */
export function autoDrive(
  train: Train,
  driver: AutoDriver,
  sighting: SignalSighting | null,
  opt: DispatchOptions = DEFAULT_DISPATCH,
): void {
  if (!driver.drive) return;

  const speed = train.speed;
  const { target, reason } = permittedSpeed(driver, sighting, speed, opt);
  driver.target = target;
  driver.reason = reason;

  // The reverser has to be off centre for any of this to do anything, and a
  // movement that has been left centred is one nobody has taken charge of.
  if (train.reverser === 'neutral') train.reverser = 'forward';

  const error = target - speed;
  if (target <= opt.stopped && speed <= opt.stopped) {
    // Stopped where it was asked to stop. Hold it with a service application
    // rather than by pretending it has no momentum.
    train.throttle = 0;
    train.brake = 1;
    return;
  }

  if (error > 0.6) {
    train.brake = 0;
    train.throttle = clamp(error / 4, 0.1, 1);
  } else if (error < -0.4) {
    train.throttle = 0;
    // Harder the further over the mark it is, and no gentler than a minimum
    // reduction — a brake handle that creeps does nothing to a heavy train.
    train.brake = clamp(-error / 3, 0.15, 1);
  } else {
    train.throttle = clamp(error, 0, 0.25);
    train.brake = 0;
  }
}
