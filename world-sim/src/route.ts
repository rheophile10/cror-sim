/**
 * A route: the path a movement actually takes through the network.
 *
 * The physics wants one coordinate — distance — and a way to ask what the track
 * is doing at that distance. A single `TrackPath` gives it that, right up until
 * there is a turnout, at which point the answer depends on which way the switch
 * is lined and on how far the train has already gone.
 *
 * A `Route` restores the simple picture. It is an ordered list of legs, each a
 * stretch of one track travelled in one direction, with a running distance over
 * the whole thing. `route.at(d)` behaves exactly like `path.at(s)`, so nothing
 * downstream of it had to learn what a switch is — and a train straddling a
 * turnout, with cars on two different tracks, needs no special handling at all,
 * because in route coordinates it is just a train.
 *
 * Legs travelled against their track's own direction get their heading turned
 * around and their grade and curvature negated, so that increasing route
 * distance always means "further along the way this movement is going".
 */
import type { Network, RouteStop } from './network.ts';
import type { TrackPath, TrackPoint } from './track.ts';
import { clamp } from './units.ts';

/** Anything a train can run along: a bare track, or a route through several. */
export interface Guideway {
  readonly length: number;
  readonly closed: boolean;
  /**
   * Why the way ends where it does, when it is a route through a network. A
   * bare `TrackPath` has no answer and leaves this undefined; the physics reads
   * it to tell end of steel from a switch that has been run through.
   */
  readonly stop?: RouteStop;
  /** Why the way ends behind the movement. A train can back into trouble too. */
  readonly stopBehind?: RouteStop;
  at(d: number): TrackPoint;
  normalize(d: number): number;
  isOffEnd(d: number): boolean;
}

export interface RouteLeg {
  track: TrackPath;
  /** +1 travels with increasing `s` on that track, −1 against it. */
  dir: 1 | -1;
  /** `s` on the track where this leg begins. */
  from: number;
  /** `s` where it ends. */
  to: number;
  /** Route distance at which this leg begins. */
  start: number;
  length: number;
}

/** A point in the network: which track, where on it, and which way facing. */
export interface RouteLocation {
  track: TrackPath;
  at: number;
  dir: 1 | -1;
}

function wrapAngle(a: number): number {
  const turn = Math.PI * 2;
  let x = a % turn;
  if (x > Math.PI) x -= turn;
  if (x < -Math.PI) x += turn;
  return x;
}

export class Route implements Guideway {
  readonly legs: RouteLeg[];
  readonly length: number;
  readonly closed: boolean;
  /** Why the route ends where it does. */
  readonly stop: RouteStop;
  /** Why the route begins where it does, looking backwards. */
  readonly stopBehind: RouteStop;

  constructor(
    legs: RouteLeg[],
    stop: RouteStop = { reason: 'end' },
    stopBehind: RouteStop = { reason: 'end' },
    closed = false,
  ) {
    this.legs = legs;
    this.closed = closed;
    this.stop = stop;
    this.stopBehind = stopBehind;
    const last = legs[legs.length - 1];
    this.length = last ? last.start + last.length : 0;
  }

  /**
   * A route that is just one track, end to end.
   *
   * This is what a scene with no nodes gets, and it is why every loop scene
   * written before turnouts existed still runs unchanged: a closed track becomes
   * a closed route, and route distance is track distance.
   */
  static single(track: TrackPath): Route {
    return new Route(
      [{ track, dir: 1, from: 0, to: track.length, start: 0, length: track.length }],
      { reason: 'end' },
      { reason: 'end' },
      track.closed,
    );
  }

  get first(): RouteLeg | undefined {
    return this.legs[0];
  }

  /** The leg containing a route distance. */
  legAt(d: number): RouteLeg {
    const clamped = this.normalize(d);
    // Linear scan: routes are a handful of legs, and a binary search here would
    // be more code than it saves.
    for (let i = this.legs.length - 1; i >= 0; i--) {
      const leg = this.legs[i]!;
      if (clamped >= leg.start - 1e-9) return leg;
    }
    return this.legs[0]!;
  }

  locate(d: number): RouteLocation {
    const leg = this.legAt(d);
    const along = clamp(this.normalize(d) - leg.start, 0, leg.length);
    return { track: leg.track, at: leg.from + leg.dir * along, dir: leg.dir };
  }

  /**
   * Route distance of a point on a track, or null if this route does not pass
   * over it. Used to bring other trains, wrecks and obstructions into the
   * coordinate a movement thinks in.
   */
  distanceOf(trackId: string, at: number): number | null {
    for (const leg of this.legs) {
      if (leg.track.id !== trackId) continue;
      const lo = Math.min(leg.from, leg.to);
      const hi = Math.max(leg.from, leg.to);
      if (at < lo - 1e-6 || at > hi + 1e-6) continue;
      return leg.start + leg.dir * (at - leg.from);
    }
    return null;
  }

  normalize(d: number): number {
    if (!this.closed || this.length === 0) return clamp(d, 0, this.length);
    return ((d % this.length) + this.length) % this.length;
  }

  isOffEnd(d: number): boolean {
    return !this.closed && (d < 0 || d > this.length);
  }

  at(d: number): TrackPoint {
    const leg = this.legAt(d);
    const along = clamp(this.normalize(d) - leg.start, 0, leg.length);
    const pt = leg.track.at(leg.from + leg.dir * along);
    if (leg.dir === 1) return { ...pt, s: this.normalize(d) };
    // Travelling against the track's own direction: the same physical curve
    // turns the other way, the same physical grade falls instead of rising, and
    // the heading is reversed.
    return {
      ...pt,
      s: this.normalize(d),
      heading: wrapAngle(pt.heading + Math.PI),
      curvature: -pt.curvature,
      grade: -pt.grade,
    };
  }
}

/**
 * Build a route through the network, running `ahead` metres forward from
 * `start` and `behind` metres back from it.
 *
 * Walking backwards is the same walk with the direction flipped, so it is done
 * as its own forward walk and then turned around. The reason to have it at all
 * is that a train needs track behind it as well as in front: to be shoved, to
 * back up, and simply to have somewhere for its rear cars to be.
 */
export function buildRoute(
  network: Network,
  start: RouteLocation,
  ahead: number,
  behind = 0,
): Route {
  const track = start.track;

  // A closed track with nothing attached is a loop; it needs no walking and it
  // must not be cut into legs, or the seam becomes an end of steel.
  if (track.closed && !track.startNode && !track.endNode) {
    return Route.single(track);
  }

  const forward = walk(network, start, ahead);
  if (behind <= 0) {
    return new Route(forward.legs, forward.stop, { reason: 'end' });
  }

  const back = walk(
    network,
    { track: start.track, at: start.at, dir: (start.dir === 1 ? -1 : 1) as 1 | -1 },
    behind,
  );

  // Reverse the backward walk: flip each leg's direction, swap its ends, and
  // lay them out from the far end forwards.
  const legs: RouteLeg[] = [];
  let cursor = 0;
  for (let i = back.legs.length - 1; i >= 0; i--) {
    const leg = back.legs[i]!;
    legs.push({
      track: leg.track,
      dir: (leg.dir === 1 ? -1 : 1) as 1 | -1,
      from: leg.to,
      to: leg.from,
      start: cursor,
      length: leg.length,
    });
    cursor += leg.length;
  }
  for (const leg of forward.legs) {
    legs.push({ ...leg, start: cursor + leg.start });
  }
  return new Route(merge(legs), forward.stop, back.stop);
}

/** Join consecutive legs that run over the same track in the same direction. */
function merge(legs: RouteLeg[]): RouteLeg[] {
  const out: RouteLeg[] = [];
  for (const leg of legs) {
    const prev = out[out.length - 1];
    if (prev && prev.track === leg.track && prev.dir === leg.dir && Math.abs(prev.to - leg.from) < 1e-6) {
      prev.to = leg.to;
      prev.length += leg.length;
      continue;
    }
    out.push({ ...leg, start: out.length === 0 ? 0 : lastEnd(out) });
  }
  // Re-lay the running distances after merging.
  let cursor = 0;
  for (const leg of out) {
    leg.start = cursor;
    cursor += leg.length;
  }
  return out;
}

function lastEnd(legs: RouteLeg[]): number {
  const prev = legs[legs.length - 1]!;
  return prev.start + prev.length;
}

function walk(
  network: Network,
  start: RouteLocation,
  budget: number,
): { legs: RouteLeg[]; stop: RouteStop } {
  const legs: RouteLeg[] = [];
  let track = start.track;
  let dir = start.dir;
  let at = start.at;
  let remaining = budget;
  let cursor = 0;
  let stop: RouteStop = { reason: 'budget' };
  // A route that closes on itself would otherwise walk forever; a generous cap
  // on legs is simpler than cycle detection and cannot be hit by a real scene.
  const maxLegs = 64;

  while (remaining > 1e-6 && legs.length < maxLegs) {
    const toEnd = dir === 1 ? track.length - at : at;
    const span = Math.min(toEnd, remaining);
    const end = at + dir * span;
    if (span > 1e-9) {
      legs.push({ track, dir, from: at, to: end, start: cursor, length: span });
      cursor += span;
      remaining -= span;
    }
    if (span < toEnd - 1e-9) {
      stop = { reason: 'budget' };
      break;
    }

    const exit = network.exit(track.id, dir === 1 ? 'to' : 'from');
    if ('reason' in exit) {
      stop = exit;
      break;
    }
    const next = network.tracks.get(exit.next.track);
    if (!next) {
      stop = { reason: 'end', node: exit.node.id };
      break;
    }
    // Entering by the `from` end means running with increasing s, and vice versa.
    track = next;
    dir = exit.next.end === 'from' ? 1 : -1;
    at = exit.next.end === 'from' ? 0 : next.length;
  }

  if (legs.length === 0) {
    legs.push({ track: start.track, dir: start.dir, from: start.at, to: start.at, start: 0, length: 0 });
  }
  return { legs, stop };
}
