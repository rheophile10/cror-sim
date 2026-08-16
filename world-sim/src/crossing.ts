/**
 * Crossings at grade: where the railway and a road are the same piece of ground.
 *
 * This is the one place in the model where the railway has to deal with people
 * who are not railroaders, and it is worth having for that reason alone. Almost
 * everything else in this package is a conversation between a crew and a
 * rulebook. A crossing is a conversation with a driver who has never read one.
 *
 * ── Three levels of protection, and they behave differently ──
 *
 *   `passive`          crossbucks and nothing else. Nothing warns anybody; a
 *                      driver is expected to look. Traffic stops only when
 *                      there is visibly something on the crossing.
 *   `flashing-lights`  lights and a bell, started by the train's approach.
 *   `gates`            the same, plus arms that come down a few seconds later.
 *
 * ── Constant warning time ──
 *
 * A crossing is not triggered by a fixed distance but by a fixed *time*: the
 * system is set to give about twenty seconds of warning, so it starts further
 * out for a fast train than a slow one. That is why a slow movement can sit on
 * the approach with the lights going for a very long while, and it is why the
 * warning distance here is a speed times a duration rather than a constant.
 *
 * ── When the system is out of order ──
 *
 * `outOfOrder` stops the lights and gates working. Traffic then does not stop,
 * which is exactly the situation in which a crew member has to get down and
 * protect the crossing on foot — `World.flagCrossing`. That is the whole reason
 * the flag exists in this model: it is not decoration, it is the only thing
 * standing between a movement and the road when the equipment has failed.
 */
import { clamp } from './units.ts';

export type CrossingProtection = 'passive' | 'flashing-lights' | 'gates';

/** What the crossing is doing right now. */
export type CrossingState =
  /** Nothing coming; traffic moves. */
  | 'clear'
  /** A movement is on the approach. Lights going, gates coming down. */
  | 'warning'
  /** Equipment is standing on the crossing itself. */
  | 'occupied';

export interface CrossingSpec {
  id?: string;
  label?: string;
  /** Which track it crosses. Defaults to the first in the scene. */
  track?: string;
  /** Where along that track, metres. */
  at: number;
  /** Which scenery road, by id, so traffic on it can be stopped. */
  road?: string;
  /** Angle of the roadway to the track, degrees. 90 is square. */
  angle?: number;
  /** Width of the roadway, metres. */
  width?: number;
  protection?: CrossingProtection;
  /** Warning time the system is set for, seconds. Twenty is the usual minimum. */
  warningSeconds?: number;
  /** The warning system has failed. Then somebody has to protect it on foot. */
  outOfOrder?: boolean;
  /**
   * A road vehicle is stopped on the crossing.
   *
   * Modelled as a real `Obstruction` on the track rather than as a special case,
   * so the existing collision code strikes it, shoves it and reports it without
   * knowing what a crossing is.
   */
  stalled?: boolean;
  /** What is stalled there. A truck is heavy enough to matter; a car is not. */
  stalledType?: 'car' | 'truck' | 'bus';
}

export interface Crossing {
  id: string;
  label: string;
  trackId: string | undefined;
  at: number;
  roadId: string | undefined;
  /** Distance along that road, metres. Found once, at build. */
  roadAt: number;
  angle: number;
  width: number;
  protection: CrossingProtection;
  warningSeconds: number;
  outOfOrder: boolean;

  /** World position and the track's heading through it. */
  x: number;
  y: number;
  z: number;
  heading: number;

  state: CrossingState;
  /** Seconds the warning has been running. The gates lag the lights by design. */
  since: number;
  /** 0 fully up, 1 fully down. */
  gate: number;
  /** Gap to the nearest movement last step, so closing can be told from opening. */
  lastGap: number;
  /** Who is protecting it on foot, if anybody. A person id. */
  flaggedBy: string | null;
  /** Obstruction id of the vehicle stopped on it, if there is one. */
  stalledId: string | null;
}

export interface CrossingOptions {
  /** Warning never starts closer in than this, however slow the movement. */
  minApproach: number;
  /** Nor further out than this, however fast. */
  maxApproach: number;
  /** Seconds of lights before the gates start down. */
  gateDelay: number;
  /** Seconds for an arm to travel from up to down. */
  gateTravel: number;
  /** Half-width of the crossing for "something is standing on it", metres. */
  occupiedHalfWidth: number;
  /** How far short of the rails traffic stops, metres. */
  stopLine: number;
}

export const DEFAULT_CROSSING: CrossingOptions = {
  minApproach: 60,
  maxApproach: 900,
  gateDelay: 4,
  gateTravel: 8,
  occupiedHalfWidth: 9,
  stopLine: 9,
};

export function buildCrossing(spec: CrossingSpec, index: number): Crossing {
  return {
    id: spec.id ?? `crossing-${index}`,
    label: spec.label ?? `Crossing ${index + 1}`,
    trackId: spec.track,
    at: spec.at,
    roadId: spec.road,
    roadAt: 0,
    angle: spec.angle ?? 90,
    width: spec.width ?? 8,
    protection: spec.protection ?? 'passive',
    warningSeconds: spec.warningSeconds ?? 22,
    outOfOrder: spec.outOfOrder ?? false,
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
    state: 'clear',
    since: 0,
    gate: 0,
    lastGap: Infinity,
    flaggedBy: null,
    stalledId: null,
  };
}

/** Where a movement is, as the crossings need to see it. */
export interface CrossingOccupant {
  trackId: string;
  /** Distance along that track of the nearest part of the movement, metres. */
  at: number;
  /** Speed, m/s, unsigned — used only to size the approach. */
  speed: number;
}

/**
 * Advance every crossing.
 *
 * `occupants` is one entry per car on a track, which is what `World.occupancy`
 * already produces. Working from every car rather than from the head end is what
 * makes a train *standing across* a crossing hold it, which is the case that
 * matters: a movement stopped over a road is the thing crews get in trouble for.
 */
export function stepCrossings(
  crossings: Crossing[],
  occupants: CrossingOccupant[],
  dt: number,
  opt: CrossingOptions = DEFAULT_CROSSING,
): void {
  for (const crossing of crossings) {
    let gap = Infinity;
    let speed = 0;
    for (const o of occupants) {
      if (o.trackId !== crossing.trackId) continue;
      const d = Math.abs(o.at - crossing.at);
      if (d < gap) {
        gap = d;
        speed = o.speed;
      }
    }

    const reach = clamp(speed * crossing.warningSeconds, opt.minApproach, opt.maxApproach);
    const closing = gap < crossing.lastGap - 1e-6;
    const previous = crossing.state;

    if (gap <= opt.occupiedHalfWidth) {
      crossing.state = 'occupied';
    } else if (gap <= reach && (closing || gap <= opt.minApproach)) {
      // A movement that has stopped short still holds it. That is what the real
      // equipment does — it cannot tell "stopped" from "about to start" — and it
      // is why a crew that stops on the approach ties up a road.
      crossing.state = 'warning';
    } else {
      crossing.state = 'clear';
    }
    crossing.lastGap = gap;

    if (crossing.state !== previous) crossing.since = 0;
    else crossing.since += dt;

    // The gates. A passive crossing has none, and a failed system leaves them
    // where they are — which for arms in the up position means up, and is the
    // whole hazard.
    const wants =
      crossing.protection === 'gates' && !crossing.outOfOrder && crossing.state !== 'clear';
    const rate = dt / Math.max(1e-6, opt.gateTravel);
    if (wants && crossing.since >= (crossing.state === 'occupied' ? 0 : opt.gateDelay)) {
      crossing.gate = Math.min(1, crossing.gate + rate);
    } else if (!wants) {
      crossing.gate = Math.max(0, crossing.gate - rate);
    }
  }
}

/**
 * Whether the lights are showing, and which lamp is lit this instant.
 *
 * Alternating, about fifty flashes a minute, which is what the standard asks
 * for. A system out of order shows nothing at all — and showing nothing is
 * indistinguishable from a clear crossing, which is the point.
 */
export function crossingLights(
  crossing: Crossing,
  time: number,
): { on: boolean; left: boolean } {
  if (crossing.protection === 'passive' || crossing.outOfOrder || crossing.state === 'clear') {
    return { on: false, left: false };
  }
  return { on: true, left: Math.floor(time * 1.7) % 2 === 0 };
}

/**
 * Whether road traffic has to stop.
 *
 * Three reasons, and they are not the same reason:
 *
 *   - somebody is standing there stopping it by hand, which works whatever the
 *     equipment is doing and is the only thing that works when the equipment
 *     has failed;
 *   - the warning system is telling it to, which needs the system to work;
 *   - there is visibly something on the crossing, which stops a driver at a
 *     passive crossing too because they can see it.
 */
export function trafficStops(crossing: Crossing): boolean {
  if (crossing.flaggedBy) return true;
  if (crossing.state === 'occupied') return true;
  if (crossing.protection === 'passive' || crossing.outOfOrder) return false;
  return crossing.state === 'warning';
}
