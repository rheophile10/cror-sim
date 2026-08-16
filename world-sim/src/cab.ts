/**
 * The rest of the control stand: dynamic brake, sanders, the alerter, and the
 * pneumatic control switch.
 *
 * The air brake and the throttle are what an engineer *uses*; these are the
 * things that shape how they can be used, and two of them are things that take
 * control away. That is why they belong in a rules simulation at all — a model
 * where the engineer's hand is the only thing that ever moves the train cannot
 * show you a penalty application, and a penalty application is precisely the
 * kind of event the rulebook is written around.
 *
 * ── Dynamic brake ──
 *
 * The traction motors run as generators and the current is burned off in the
 * roof grids. It retards; it does not stop. Two properties matter and both are
 * modelled:
 *
 *   - **It fades out at low speed.** Below a walking pace it produces nothing,
 *     because there is no rotation to generate from. A train held on a grade by
 *     dynamic brake alone will start to roll as it slows, which is the classic
 *     way of getting into trouble with it.
 *   - **It is adhesion-limited like tractive effort.** Retarding force still goes
 *     through the wheel-rail contact, so a locomotive can slide its wheels
 *     braking as easily as pulling.
 *
 * It also uses no air at all, which is the whole reason it exists: a train can
 * be held down a long grade indefinitely without touching the reservoirs.
 *
 * ── The alerter ──
 *
 * A timer that has to be reset by moving a control or pressing the button. Let
 * it run out and it flashes and sounds; ignore that and it makes a full service
 * application for you and opens the PCS. Nothing about it is negotiable from the
 * seat, and modelling it is what makes "the engineer became unable to respond"
 * an expressible state rather than an absence of input.
 *
 * ── The PCS ──
 *
 * The pneumatic control switch drops the load whenever the brakes go on hard:
 * an emergency application, or a penalty. While it is open the throttle and the
 * dynamic brake do nothing at all, and it will not reset until the throttle is
 * back at idle — which is why the first thing you do after an undesired
 * emergency is close the throttle, before anything else.
 */
import type { Reverser } from './train.ts';
import { clamp } from './units.ts';

export type AlerterState = 'quiet' | 'asking' | 'penalty';

/** Why the PCS is open, which decides what it takes to close it again. */
export type PcsReason = 'none' | 'emergency' | 'penalty';

export interface Alerter {
  enabled: boolean;
  /** Seconds since the last acknowledgement or control movement. */
  since: number;
  state: AlerterState;
  /**
   * A signature of where the controls were standing last step. Any change is an
   * acknowledgement — an engineer working the train is by definition awake, and
   * that is exactly how the real device behaves.
   */
  mark: number;
}

export interface Pcs {
  open: boolean;
  reason: PcsReason;
  /** Seconds the reset conditions have been continuously satisfied. */
  settled: number;
}

export interface CabOptions {
  /** Seconds of no control movement before the alerter asks. */
  alerterSeconds: number;
  /** Seconds of flashing and sounding before it applies the brakes. */
  alerterWarningSeconds: number;
  /** Speed below which the alerter stops running, m/s. */
  alerterCutoutSpeed: number;
  /**
   * Automatic brake handle position that counts as suppression.
   *
   * Recovering from a penalty means putting the handle here — far enough into
   * the service zone that the brake valve stops fighting the penalty — and
   * leaving it there while the PCS times out.
   */
  suppressionBrake: number;
  /** Seconds the reset conditions must hold before the PCS closes. */
  pcsResetSeconds: number;
  /** Full dynamic brake force, as a fraction of a locomotive's tractive effort. */
  dynamicFraction: number;
  /** Speed at which dynamic braking has come up to full effort, m/s. */
  dynamicPeakSpeed: number;
  /** Speed above which it fades away again as constant power, m/s. */
  dynamicFadeSpeed: number;
  /** Multiplier on wheel-rail adhesion with the sanders working. */
  sandAdhesion: number;
}

export const DEFAULT_CAB: CabOptions = {
  alerterSeconds: 25,
  alerterWarningSeconds: 7,
  alerterCutoutSpeed: 0.5,
  suppressionBrake: 0.85,
  pcsResetSeconds: 8,
  dynamicFraction: 0.62,
  dynamicPeakSpeed: 5.5,
  dynamicFadeSpeed: 17,
  sandAdhesion: 1.35,
};

/** What the cab looks like to this module. `Train` satisfies it. */
export interface CabTrain {
  /**
   * Somebody is at the controls.
   *
   * The alerter watches the engineer, not the locomotive, so this is what
   * decides whether it runs at all. It is also why a headless scenario — a cut
   * rolling down a grade, a physics test with nobody in it — is never penalised:
   * there is no one there to be asked.
   */
  attended: boolean;
  throttle: number;
  /** 0 to 1 on the dynamic brake handle. */
  dynamic: number;
  brake: number;
  independent: number;
  reverser: Reverser;
  emergency: boolean;
  sand: boolean;
  alerter: Alerter;
  pcs: Pcs;
  /** Signed speed in the direction of travel, m/s. */
  readonly speed: number;
}

export function buildAlerter(spec: { enabled?: boolean } = {}): Alerter {
  return { enabled: spec.enabled ?? true, since: 0, state: 'quiet', mark: NaN };
}

export function buildPcs(): Pcs {
  return { open: false, reason: 'none', settled: 0 };
}

/**
 * How much of its rated dynamic braking a locomotive is making at this speed,
 * 0 to 1.
 *
 * Rises from nothing to full as the motors come up to useful speed, holds, then
 * falls away above the fade speed because the grids can only dissipate so much
 * power and above that the force must come down as speed goes up.
 */
export function dynamicBrakeFactor(speed: number, opt: CabOptions = DEFAULT_CAB): number {
  const v = Math.abs(speed);
  const rise = clamp(v / Math.max(1e-6, opt.dynamicPeakSpeed), 0, 1);
  const fade = v > opt.dynamicFadeSpeed ? opt.dynamicFadeSpeed / v : 1;
  return rise * fade;
}

/** A number that changes whenever any control is touched. */
function controlSignature(train: CabTrain): number {
  const reverser = train.reverser === 'forward' ? 1 : train.reverser === 'reverse' ? 2 : 0;
  return (
    Math.round(train.throttle * 100) * 1e6 +
    Math.round(train.dynamic * 100) * 1e4 +
    Math.round(train.brake * 100) * 1e2 +
    Math.round(train.independent * 10) * 10 +
    reverser +
    (train.sand ? 0.5 : 0)
  );
}

/**
 * Tell the alerter somebody is there.
 *
 * Called by the reset button and by anything else that counts as an act of
 * vigilance. A penalty already made is *not* cleared by this — that takes the
 * automatic brake handle and the PCS timer, which is the point of a penalty.
 */
export function acknowledgeAlerter(train: CabTrain): void {
  train.alerter.since = 0;
  if (train.alerter.state === 'asking') train.alerter.state = 'quiet';
}

/**
 * Advance the alerter and the PCS by `dt` seconds.
 *
 * Called once per frame from `stepTrain`, before the air, because a penalty
 * application has to be in the brake handle before the pipe is stepped or the
 * brakes would go on a frame late.
 */
export function stepCab(train: CabTrain, dt: number, opt: CabOptions = DEFAULT_CAB): void {
  const alerter = train.alerter;

  // Any control movement is an acknowledgement. The first step of a scene has
  // no previous signature, so it establishes one rather than counting as a move.
  const signature = controlSignature(train);
  if (!Number.isNaN(alerter.mark) && signature !== alerter.mark && alerter.state !== 'penalty') {
    alerter.since = 0;
    if (alerter.state === 'asking') alerter.state = 'quiet';
  }
  alerter.mark = signature;

  // It only runs on a moving train, with somebody in the seat and the reverser
  // off centre. A locomotive standing set and centred is not being operated, and
  // one with nobody in the cab has no engineer to ask.
  const running =
    alerter.enabled &&
    train.attended &&
    train.reverser !== 'neutral' &&
    Math.abs(train.speed) > opt.alerterCutoutSpeed;

  if (!running) {
    if (alerter.state !== 'penalty') {
      alerter.since = 0;
      alerter.state = 'quiet';
    }
  } else if (alerter.state !== 'penalty') {
    alerter.since += dt;
    if (alerter.since >= opt.alerterSeconds + opt.alerterWarningSeconds) {
      // Nobody answered. A full service application, and the load comes off.
      alerter.state = 'penalty';
      train.brake = 1;
      train.throttle = 0;
      train.dynamic = 0;
      openPcs(train, 'penalty');
    } else if (alerter.since >= opt.alerterSeconds) {
      alerter.state = 'asking';
    }
  }

  // An emergency application opens the PCS too, and for the same reason: no
  // power while the brakes are on hard.
  if (train.emergency && !train.pcs.open) openPcs(train, 'emergency');

  // Resetting. Throttle at idle and the dynamic brake off, always; plus,
  // depending on why it opened, either the emergency cleared or the automatic
  // brake handle held in suppression.
  if (train.pcs.open) {
    const idle = train.throttle === 0 && train.dynamic === 0;
    const condition =
      train.pcs.reason === 'penalty'
        ? idle && train.brake >= opt.suppressionBrake
        : idle && !train.emergency;
    train.pcs.settled = condition ? train.pcs.settled + dt : 0;
    if (train.pcs.settled >= opt.pcsResetSeconds) {
      train.pcs.open = false;
      train.pcs.reason = 'none';
      train.pcs.settled = 0;
      // Only now does a penalty stop being one, and the handle is still in
      // suppression: releasing the train is the engineer's next move, not this
      // module's.
      if (alerter.state === 'penalty') {
        alerter.state = 'quiet';
        alerter.since = 0;
      }
    }
  }
}

function openPcs(train: CabTrain, reason: PcsReason): void {
  train.pcs.open = true;
  train.pcs.reason = reason;
  train.pcs.settled = 0;
  train.throttle = 0;
  train.dynamic = 0;
}
