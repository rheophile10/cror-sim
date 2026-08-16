/**
 * Where the road meets the railway, once the warning devices have had their say.
 *
 * ── Why this exists separately from `crossing.ts` ──
 *
 * `crossing.ts` models the *protection*: lights that start flashing on the
 * approach, gates that come down, a crew member out flagging. That is the
 * system working. This models what is left when it does not — and it turns out
 * to be the ordinary case rather than the exception:
 *
 *   - A passive crossing has no lights at all. Nothing tells the traffic.
 *   - An out-of-order crossing shows nothing, which is indistinguishable from a
 *     clear one.
 *   - A vehicle already past the stop line when the lights start has nowhere to
 *     go but forward.
 *   - A train **standing** across a road holds the crossing state, but a road
 *     that meets the track somewhere nobody surveyed a crossing has no state to
 *     hold.
 *
 * Before this, all four of those cases had the same outcome: the vehicle drove
 * straight through the train. Protection was the *only* thing keeping the two
 * apart, which meant the simulation could not show what protection is for.
 *
 * ── What it does ──
 *
 * Two things, and they are the same test at two distances. A vehicle looks
 * along its own path for rail equipment. Something in the way further off is a
 * reason to stop; something in the way *now* is a collision — and which of the
 * two it is depends on nothing but how much room is left, exactly as it does at
 * a real crossing.
 *
 * A vehicle that loses is written off where it stands. The train does not
 * notice: forty tonnes of car against six thousand of train is not a collision
 * the train can feel, and pretending otherwise would put a derailment where
 * there should be a delay and a report. The event is emitted so the rest of the
 * simulation can care.
 */
import type { Vehicle } from './scenery.ts';
import type { Guideway } from './route.ts';
import type { Train } from './train.ts';

export interface RoadRailOptions {
  /**
   * How far ahead a vehicle looks for equipment, in seconds of travel.
   *
   * Braking, not sighting. A driver sees a train a long way off; what this sets
   * is how late they may leave it and still stop, and being generous with it is
   * being generous to the driver rather than to the simulation.
   */
  lookaheadSeconds: number;
  /** Shortest look-ahead however slowly the vehicle is going, metres. */
  minLookahead: number;
  /** Half-width of rail equipment for this test, metres. */
  railHalfWidth: number;
  /**
   * Closing speed below which nothing is wrecked, m/s.
   *
   * A movement shoving up to a vehicle at a walking pace pushes it; it does not
   * destroy it. The threshold also keeps a vehicle that has stopped *touching*
   * a standing train from being written off on the frame it arrives.
   */
  wreckSpeed: number;
  /** How far short of the equipment a vehicle brings itself to a stand, metres. */
  standoff: number;
}

export const DEFAULT_ROAD_RAIL: RoadRailOptions = {
  lookaheadSeconds: 4,
  minLookahead: 14,
  railHalfWidth: 1.8,
  wreckSpeed: 1.6,
  standoff: 4,
};

/** A vehicle that lost. */
export interface RoadRailHit {
  vehicleIndex: number;
  trainId: string;
  carId: string;
  /** Closing speed at the moment of the strike, m/s. */
  closing: number;
  x: number;
  y: number;
}

/**
 * Stop road traffic short of rail equipment, and wreck whatever it does not stop
 * short of.
 *
 * `blockedAhead` is written onto each vehicle rather than acted on here, because
 * the vehicle's own step already knows how to bring itself to a stand for a
 * crossing and doing it twice in two places is how the two answers drift apart.
 */
export function stepRoadRail(
  vehicles: Vehicle[],
  trains: readonly Train[],
  opt: RoadRailOptions = DEFAULT_ROAD_RAIL,
): RoadRailHit[] {
  const hits: RoadRailHit[] = [];

  // Every piece of equipment in the scene, as a segment on the ground. Built
  // once per step rather than per vehicle: it is the same list every time, and
  // there are a great many more cars than there are vehicles.
  const bodies: {
    trainId: string;
    carId: string;
    speed: number;
    ax: number;
    ay: number;
    bx: number;
    by: number;
  }[] = [];
  for (const train of trains) {
    const route: Guideway | null = train.route;
    if (!route) continue;
    const speed = Math.abs(train.speed);
    for (const car of train.cars) {
      // A derailed car keeps its own body and its own bearing; one on the rail
      // takes both from the route. `yaw` and `heading` are the same angle under
      // two names, which is the only thing that differs between them here.
      const on = route.at(car.s);
      const at = car.derailed && car.body ? car.body : on;
      const bearing = car.derailed && car.body ? car.body.yaw : on.heading;
      const half = car.length / 2;
      const cx = Math.cos(bearing) * half;
      const cy = Math.sin(bearing) * half;
      bodies.push({
        trainId: train.id,
        carId: car.id,
        speed,
        ax: at.x - cx,
        ay: at.y - cy,
        bx: at.x + cx,
        by: at.y + cy,
      });
    }
  }
  if (bodies.length === 0) {
    for (const v of vehicles) v.blockedAhead = null;
    return hits;
  }

  for (let i = 0; i < vehicles.length; i++) {
    const vehicle = vehicles[i]!;
    vehicle.blockedAhead = null;
    if (vehicle.wrecked) continue;

    const half = vehicle.length / 2;
    const across = vehicle.width / 2 + opt.railHalfWidth;
    // Which way it is pointing. `heading` already carries the reversal for a
    // vehicle running backwards along its road, so this is genuinely forward.
    const fx = Math.cos(vehicle.heading);
    const fy = Math.sin(vehicle.heading);
    const reach = Math.max(opt.minLookahead, Math.abs(vehicle.speed) * opt.lookaheadSeconds);

    let nearest: number | null = null;
    for (const body of bodies) {
      // Cheap reject first: this runs over every car of every train, every
      // frame, for every vehicle on the map.
      const midX = (body.ax + body.bx) / 2;
      const midY = (body.ay + body.by) / 2;
      const away = Math.hypot(midX - vehicle.x, midY - vehicle.y);
      if (away > reach + half + 40) continue;

      // Overlapping now: the vehicle is in among the equipment.
      const gap = segmentGap(vehicle.x, vehicle.y, body);
      if (gap <= across + half * 0.35) {
        const closing = body.speed + Math.abs(vehicle.speed);
        if (closing >= opt.wreckSpeed) {
          vehicle.wrecked = true;
          vehicle.speed = 0;
          vehicle.cruise = 0;
          hits.push({
            vehicleIndex: i,
            trainId: body.trainId,
            carId: body.carId,
            closing,
            x: vehicle.x,
            y: vehicle.y,
          });
        }
        nearest = 0;
        break;
      }

      // Otherwise: is it in the way? Walked forward along the vehicle's own
      // path rather than solved, because a road bends and the answer only has
      // to be good enough to stop for.
      for (let d = half; d <= reach; d += 2) {
        const px = vehicle.x + fx * d;
        const py = vehicle.y + fy * d;
        if (segmentGap(px, py, body) > across) continue;
        const room = d - half;
        if (nearest === null || room < nearest) nearest = room;
        break;
      }
    }

    if (nearest !== null) vehicle.blockedAhead = Math.max(0, nearest - opt.standoff);
  }

  return hits;
}

/** Distance from a point to a car body, in plan. */
function segmentGap(
  px: number,
  py: number,
  body: { ax: number; ay: number; bx: number; by: number },
): number {
  const dx = body.bx - body.ax;
  const dy = body.by - body.ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - body.ax, py - body.ay);
  let t = ((px - body.ax) * dx + (py - body.ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (body.ax + dx * t), py - (body.ay + dy * t));
}
