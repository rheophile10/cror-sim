/**
 * Track as a network: edges meeting at nodes, and switches that decide which
 * way a movement goes.
 *
 * Up to now a train ran along one `TrackPath` and that was the whole world. A
 * turnout breaks that: past the points the same train is on a different piece of
 * track, and while it is straddling the switch it is on *both*. So tracks become
 * edges between nodes, a switch is a node with three ports, and a movement's
 * path through the network is a `Route` — see `route.ts`.
 *
 * The model is borrowed from `CROR/sim`'s topology (nodes, ports, tracks), and
 * on purpose: that is the model the rules are written against, and the two have
 * to meet eventually.
 *
 * What a switch does with a movement depends entirely on which port it arrives
 * at, which is the distinction between a *facing* and a *trailing* movement:
 *
 *   - arriving at `trunk` — a facing move. The points send it to whichever of
 *     `normal` or `reverse` the switch is lined for. This is the interesting
 *     case and the one that puts a train somewhere it did not intend to go.
 *   - arriving at `normal` or `reverse` — a trailing move. If the switch is
 *     lined for the leg the movement is on, it goes to the trunk. If it is not,
 *     the movement **runs through the switch**: it bursts the points. That is a
 *     real and expensive event, so it is reported rather than quietly allowed.
 */
import type { TrackPath } from './track.ts';

export type Port = 'in' | 'out' | 'trunk' | 'normal' | 'reverse';
export type NodeKind = 'end' | 'joint' | 'switch' | 'derail';
export type SwitchPosition = 'normal' | 'reverse';

/**
 * The six kinds of switch CROR names, and what each one does physically.
 *
 * 104(a) folds semi-automatic, spring, dual control and auto-normal switches
 * into "hand operated switches" *for the purpose of the rules* — every duty in
 * 104 reaches all of them. But they behave differently on the ground, which is
 * what this type is for, and the two facts must not be confused: calling a
 * spring switch a hand operated switch does not make it burst when trailed.
 *
 *   - `hand` — stays where it was left. A trailing movement against it bursts
 *     the points.
 *   - `spring` — the points are held by a spring (104.1). A trailing movement
 *     pushes through and they close again behind it, undamaged. This is why a
 *     movement can leave a siding without anybody getting down.
 *   - `auto-normal` — lined by hand, but returns to normal by itself once the
 *     movement is clear. Trailing it against the lie still bursts it; what is
 *     different is that it does not stay reversed.
 *   - `semi-automatic` — 104.4. Reflectorized targets, and a facing movement
 *     approaches prepared to stop and examines the points. It is **not**
 *     trailable: 104(a) makes it a hand operated switch, and a movement that
 *     trails one lined against it runs through it like any other.
 *   - `dual-control` — power-operated with a hand throw (104.2). In power
 *     position it is worked from a control machine; placed in hand position it
 *     is worked on the ground, and 104.2 requires permission first. `handMode`
 *     carries which.
 *   - `power` — worked from a control machine, no hand throw.
 *
 * Only `spring` is trailable. Everything else bursts.
 */
export type SwitchOperation =
  | 'hand'
  | 'dual-control'
  | 'spring'
  | 'semi-automatic'
  | 'auto-normal'
  | 'power';

/** CROR 104.5: three kinds of derail with three different default positions. */
export type DerailType = 'standard' | 'special' | 'blue-flag';

/**
 * Whether a derail of this kind sits on the rail when nobody has said otherwise.
 *
 * A standard derail is left derailing; a Special Derail only when unattended
 * equipment is present; a blue flag derail only while protection for personnel
 * is required. A scene that says nothing should get the safe default for the
 * kind it asked for.
 */
export const DERAIL_DEFAULT_ON: Record<DerailType, boolean> = {
  standard: true,
  special: false,
  'blue-flag': false,
};

export const PORTS_FOR: Record<NodeKind, readonly Port[]> = {
  end: ['in'],
  joint: ['in', 'out'],
  switch: ['trunk', 'normal', 'reverse'],
  derail: ['in', 'out'],
};

export interface NodeSpec {
  id: string;
  /** Defaults to `switch` if a position is given, `joint` otherwise. */
  kind?: NodeKind;
  /** Which leg a switch is lined for. */
  position?: SwitchPosition;
  label?: string;
  /** How a switch is worked. Decides what a trailing movement does to it. */
  operation?: SwitchOperation;
  /** 104.2: a dual control switch placed in hand position. */
  handMode?: boolean;
  /** 104(b): secured with an approved device, except while being turned. */
  secured?: boolean;
  /** 104(h)/(i): left *locked*, which is not the same as secured. */
  locked?: boolean;
  /** 104(g)(i), 104.4(a): a target, reflector or light to be observed. */
  target?: boolean;
  /** 104.1(e)(ii): points spiked in position. */
  spiked?: boolean;
  /**
   * CROR 114: distance from the points to the clearance point, metres.
   *
   * Normally left out. The clearance point is a fact about the *geometry* — it
   * is wherever the two routes have opened out far enough that equipment
   * standing on one is clear of the other — so it is measured off the tracks
   * rather than declared. Give a number here only to override the measurement,
   * which is worth doing for a place where the real clearance point is marked
   * somewhere the drawing does not justify.
   */
  clearancePoint?: number;
  /** 104.5: which kind of derail this is. */
  derailType?: DerailType;
  /**
   * For `kind: 'derail'`: whether the derail is on the rail. Defaults to what
   * its `derailType` implies. A derail is not a switch — it is an appliance
   * whose entire job is to put equipment on the ground rather than let it foul
   * something worse.
   */
  derailing?: boolean;
}

/**
 * A stretch of one route that is not clear of another.
 *
 * ── What the clearance point is, and why it is worth modelling ──
 *
 * Two routes that meet at a turnout do not become separate railways at the
 * points; they become separate railways at the **clearance point**, which is
 * wherever the centre lines have opened out far enough that a car standing on
 * one will not be struck by a movement on the other. Everything between the
 * points and that mark is foul of both. It is the subject of a rule of its own
 * because it is the commonest way to leave a train where it will be hit by
 * something that has a perfectly good route: the switch is lined against you,
 * the signal is clear for the other movement, and the tail end of your train is
 * still four feet from being clear.
 *
 * It is **measured, not declared**. A clearance point is where the geometry
 * puts it, and a scene that states one has usually stated a number that its own
 * drawing does not support — which is exactly the mistake this replaces.
 */
export interface FoulStretch {
  /** The route that is foul over this stretch. */
  trackId: string;
  /** Distance along that track, metres. Ordered so `from` < `to`. */
  from: number;
  to: number;
  /** The end of the track the points are at — which end of the stretch is the switch. */
  end: 'from' | 'to';
  /** Which other route it is foul of. */
  ofTrackId: string;
}

/**
 * Centre-to-centre separation at which one route is clear of the next, metres.
 *
 * Thirteen feet six is the usual North American figure for a clearance point on
 * plain track, and 4.1 m is that. It is not the same as standard track centres
 * — a siding sits farther from the main than this — because clearing is about
 * the swept width of two cars passing, not about where the track was laid.
 */
export const CLEARANCE_SEPARATION = 4.1;

/**
 * How far out from the points a clearance point is looked for, metres.
 *
 * Generous for a turnout — no clearance point is two hundred metres out — but
 * bounded, because the far end of a short siding converges again and a search
 * without a limit would call the whole siding foul.
 */
const FOUL_SEARCH = 250;

/**
 * How nearly two legs have to point the same way to count as diverging, radians.
 *
 * Sixty degrees. Wide enough for a sharp industrial turnout, narrow enough that
 * the through route — a hundred and eighty degrees round — is never mistaken for
 * a diverging one.
 */
const SAME_WAY = Math.PI / 3;

/** Signed difference between two headings, wrapped to ±180°. */
function angleBetween(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Which node and port one end of a track is attached to. */
export interface TrackEndSpec {
  node: string;
  port?: Port;
}

/** Where a route arrives when it leaves a track. */
export interface Connection {
  track: string;
  /** The end of that track the movement enters by. */
  end: 'from' | 'to';
}

export interface NetworkNode {
  id: string;
  kind: NodeKind;
  position: SwitchPosition;
  label: string | undefined;
  operation: SwitchOperation;
  /** 104.2: a dual control switch placed in hand position. */
  handMode: boolean;
  secured: boolean;
  locked: boolean;
  target: boolean;
  spiked: boolean;
  /** As declared in the scene, if it was. See `foul` for what is actually used. */
  clearancePoint: number | undefined;
  /**
   * The stretch of each diverging route that is **inside the clearance point**:
   * where standing equipment fouls the other route. Measured from the geometry
   * at construction. Empty for anything that is not a switch.
   */
  foul: FoulStretch[];
  /** 104.5: which kind of derail this is. */
  derailType: DerailType;
  /** For a derail: whether it is set to derail. */
  derailing: boolean;
  /** Which track is attached to each port. */
  ports: Map<Port, Connection>;
  /** Where the node sits, taken from the geometry of the tracks meeting there. */
  x: number;
  y: number;
  z: number;
}

/** Why a route stopped. */
export type RouteStop =
  /** End of steel, or a track with nothing attached. */
  | { reason: 'end'; node?: string }
  /** A trailing move against a hand or power switch lined the other way. */
  | { reason: 'runThrough'; node: string }
  /** A derail, on the rail. */
  | { reason: 'derail'; node: string }
  /** The route hit its length budget; there is more track beyond. */
  | { reason: 'budget' };

export interface Exit {
  next: Connection;
  node: NetworkNode;
  /** True when a trailing movement pushed through a spring switch to get here. */
  sprung?: boolean;
}

export class Network {
  readonly tracks: Map<string, TrackPath>;
  readonly nodes: Map<string, NetworkNode>;

  constructor(tracks: readonly TrackPath[], nodeSpecs: readonly NodeSpec[] = []) {
    this.tracks = new Map(tracks.map((t) => [t.id, t]));
    this.nodes = new Map();

    for (const spec of nodeSpecs) {
      const kind = spec.kind ?? (spec.position ? 'switch' : 'joint');
      this.nodes.set(spec.id, {
        id: spec.id,
        kind,
        position: spec.position ?? 'normal',
        label: spec.label,
        operation: spec.operation ?? 'hand',
        handMode: spec.handMode ?? false,
        secured: spec.secured ?? true,
        locked: spec.locked ?? false,
        target: spec.target ?? true,
        spiked: spec.spiked ?? false,
        clearancePoint: spec.clearancePoint,
        foul: [],
        derailType: spec.derailType ?? 'standard',
        derailing: spec.derailing ?? DERAIL_DEFAULT_ON[spec.derailType ?? 'standard'],
        ports: new Map(),
        x: 0,
        y: 0,
        z: 0,
      });
    }

    // Attach tracks to nodes. A track that names a node nobody declared gets one
    // invented for it — a scene should not have to list every plain joint.
    for (const track of tracks) {
      for (const end of ['from', 'to'] as const) {
        const ref = end === 'from' ? track.startNode : track.endNode;
        if (!ref) continue;
        let node = this.nodes.get(ref.node);
        if (!node) {
          node = {
            id: ref.node,
            kind: 'joint',
            position: 'normal',
            label: undefined,
            operation: 'hand',
            handMode: false,
            secured: true,
            locked: false,
            target: true,
            spiked: false,
            clearancePoint: undefined,
            foul: [],
            derailType: 'standard',
            derailing: false,
            ports: new Map(),
            x: 0,
            y: 0,
            z: 0,
          };
          this.nodes.set(ref.node, node);
        }
        // Two tracks can meet tail to tail, in which case both want the same
        // default port; the second one takes whichever is still free rather than
        // silently evicting the first.
        let port = ref.port ?? defaultPort(node.kind, end);
        if (!ref.port && node.ports.has(port)) {
          port = PORTS_FOR[node.kind].find((p) => !node!.ports.has(p)) ?? port;
        }
        node.ports.set(port, { track: track.id, end });
      }
    }

    // A node with one attachment is the end of steel whatever it claims to be.
    for (const node of this.nodes.values()) {
      if (node.kind !== 'switch' && node.kind !== 'derail' && node.ports.size < 2) node.kind = 'end';
      this.locate(node);
    }
    this.measureFoul();
  }

  /** Recompute every node's position from the tracks meeting it. */
  refreshNodePositions(): void {
    for (const node of this.nodes.values()) {
      node.x = 0;
      node.y = 0;
      node.z = 0;
      this.locate(node);
    }
    this.measureFoul();
  }

  /**
   * Work out, for every switch, how much of each diverging route is foul of the
   * other.
   *
   * Walked outward from the points a couple of metres at a time until the two
   * centre lines are `CLEARANCE_SEPARATION` apart. Done once, at construction:
   * the answer only changes if the track moves, and track does not move.
   */
  measureFoul(): void {
    for (const node of this.nodes.values()) {
      node.foul = [];
      if (node.kind !== 'switch') continue;
      // The two routes that leave the points **the same way**.
      //
      // Not "normal and reverse": a spur trailing off the main leaves by the
      // reverse port and runs back the way the trunk came, so the pair that
      // actually diverges is the trunk and the spur. Taking the ports on faith
      // measured a trailing turnout against the leg pointing the other way and
      // reported it clear six metres from the points. Which two legs share a
      // direction is a question the geometry answers.
      const arms: { track: TrackPath; end: 'from' | 'to'; heading: number }[] = [];
      for (const conn of node.ports.values()) {
        const track = this.tracks.get(conn.track);
        if (!track) continue;
        const at = conn.end === 'from' ? track.samples[0] : track.samples[track.samples.length - 1];
        const out =
          conn.end === 'from'
            ? track.at(Math.min(FOUL_SEARCH / 4, track.length))
            : track.at(Math.max(0, track.length - FOUL_SEARCH / 4));
        if (!at) continue;
        arms.push({ track, end: conn.end, heading: Math.atan2(out.y - at.y, out.x - at.x) });
      }
      if (arms.length < 2) continue;

      const legs: typeof arms = [];
      for (const arm of arms) {
        for (const mate of arms) {
          if (mate === arm) continue;
          if (Math.abs(angleBetween(arm.heading, mate.heading)) > SAME_WAY) continue;
          if (!legs.includes(arm)) legs.push(arm);
        }
      }
      if (legs.length < 2) continue;

      for (const leg of legs) {
        for (const other of legs) {
          if (other === leg) continue;
          if (Math.abs(angleBetween(leg.heading, other.heading)) > SAME_WAY) continue;
          const d = node.clearancePoint ?? clearanceAlong(leg, other);
          if (d === null) continue;
          node.foul.push({
            trackId: leg.track.id,
            from: leg.end === 'from' ? 0 : Math.max(0, leg.track.length - d),
            to: leg.end === 'from' ? Math.min(d, leg.track.length) : leg.track.length,
            end: leg.end,
            ofTrackId: other.track.id,
          });
        }
      }
    }
  }

  /** Put the node where the tracks meeting it say it is. */
  private locate(node: NetworkNode): void {
    let n = 0;
    for (const conn of node.ports.values()) {
      const track = this.tracks.get(conn.track);
      if (!track) continue;
      const pt = conn.end === 'from' ? track.samples[0] : track.samples[track.samples.length - 1];
      if (!pt) continue;
      node.x += pt.x;
      node.y += pt.y;
      node.z += pt.z;
      n++;
    }
    if (n > 0) {
      node.x /= n;
      node.y /= n;
      node.z /= n;
    }
  }

  get switches(): NetworkNode[] {
    return [...this.nodes.values()].filter((n) => n.kind === 'switch');
  }

  setPosition(id: string, position: SwitchPosition): boolean {
    const node = this.nodes.get(id);
    if (!node || node.kind !== 'switch') return false;
    node.position = position;
    return true;
  }

  toggle(id: string): SwitchPosition | null {
    const node = this.nodes.get(id);
    if (!node || node.kind !== 'switch') return null;
    node.position = node.position === 'normal' ? 'reverse' : 'normal';
    return node.position;
  }

  /**
   * Where a movement goes when it runs off `track` by `end`.
   *
   * Returns the connection to take, or why it cannot go on.
   */
  exit(trackId: string, end: 'from' | 'to'): Exit | RouteStop {
    const track = this.tracks.get(trackId);
    if (!track) return { reason: 'end' };
    const ref = end === 'from' ? track.startNode : track.endNode;
    if (!ref) return { reason: 'end' };
    const node = this.nodes.get(ref.node);
    if (!node) return { reason: 'end' };

    if (node.kind === 'derail' && node.derailing) {
      return { reason: 'derail', node: node.id };
    }

    const arrived = ref.port ?? defaultPort(node.kind, end);
    const exitPort = this.exitPort(node, arrived);
    if (exitPort === null) {
      return node.kind === 'switch'
        ? { reason: 'runThrough', node: node.id }
        : { reason: 'end', node: node.id };
    }
    const next = node.ports.get(exitPort);
    if (!next) return { reason: 'end', node: node.id };
    const sprung =
      node.kind === 'switch' && node.operation === 'spring' && arrived !== 'trunk' && arrived !== node.position;
    return sprung ? { next, node, sprung } : { next, node };
  }

  /** The port a movement arriving at `arrived` leaves by, or null if it cannot. */
  private exitPort(node: NetworkNode, arrived: Port): Port | null {
    switch (node.kind) {
      case 'end':
        return null;
      case 'joint':
      case 'derail':
        return arrived === 'in' ? 'out' : 'in';
      case 'switch':
        // Facing: the points decide, whatever kind of switch it is.
        if (arrived === 'trunk') return node.position;
        // Trailing: the lined leg gets through. The other one bursts the points
        // — unless they are spring points, which is exactly what a spring switch
        // is for: it is pushed open and closes again behind the movement. A
        // semi-automatic switch is *not* in that company, however much 104(a)
        // groups them together for the rules' purposes.
        if (arrived === node.position) return 'trunk';
        return isTrailable(node) ? 'trunk' : null;
    }
  }
}

function defaultPort(kind: NodeKind, end: 'from' | 'to'): Port {
  if (kind === 'switch') return 'trunk';
  return end === 'from' ? 'in' : 'out';
}

/** Whether this node is something a movement can be lined through. */
export function isSwitch(node: NetworkNode): boolean {
  return node.kind === 'switch';
}

/** Whether a trailing movement can push through the points without bursting them. */
export function isTrailable(node: NetworkNode): boolean {
  return node.kind === 'switch' && node.operation === 'spring';
}

/**
 * Whether a switch restores itself to normal once the movement is clear.
 *
 * A spring switch never left normal in the first place — it was pushed open and
 * closed again — so only `auto-normal` needs the world to put it back.
 */
export function restoresToNormal(node: NetworkNode): boolean {
  return node.kind === 'switch' && node.operation === 'auto-normal';
}

/** Whether a switch is worked on the ground rather than from a control machine. */
export function isHandWorked(node: NetworkNode): boolean {
  if (node.kind !== 'switch') return false;
  if (node.operation === 'power') return false;
  if (node.operation === 'dual-control') return node.handMode;
  return true;
}

/**
 * How far from the points one route has to run before it is clear of another.
 *
 * Walked outward two metres at a time, comparing against the other route's
 * samples near the switch. Returns `null` if the two never separate inside
 * `FOUL_SEARCH` — a pair of tracks running alongside each other the whole way,
 * which is a drawing mistake rather than a turnout, and is better reported as
 * "no clearance point" than as a number.
 *
 * The **last** point at which the two are still foul, not the first at which
 * they are clear. Track wanders, and a siding that opens past the mark and then
 * eases back inside it is foul over the whole of that; taking the first
 * crossing put clearance points twenty metres short of where a car would still
 * be struck.
 */
function clearanceAlong(
  leg: { track: TrackPath; end: 'from' | 'to' },
  other: { track: TrackPath; end: 'from' | 'to' },
): number | null {
  const STEP = 2;
  // Only the other route's first stretch: beyond that it has gone somewhere
  // else entirely, and a track that loops back near the switch would otherwise
  // read as still fouling it.
  // Never look further than halfway along a leg. A siding converges again at
  // its far switch, and a fixed search ran past the middle of a short one and
  // found it foul at the *other* end — reporting no clearance point for a
  // turnout that has a perfectly good one.
  const limit = Math.min(FOUL_SEARCH, leg.track.length / 2, other.track.length / 2);
  const near = other.track.samples.filter((sm) => {
    const along = other.end === 'from' ? sm.s : other.track.length - sm.s;
    return along <= limit + STEP;
  });
  if (near.length < 2) return null;

  let lastFoul = 0;
  for (let d = STEP; d <= limit; d += STEP) {
    const at = leg.end === 'from' ? d : leg.track.length - d;
    const pt = leg.track.at(at);
    let closest = Infinity;
    // To the **segments**, not to the sample points. A track is sampled every
    // six or eight metres, and measuring only to vertices puts a floor of half
    // that under every answer — which read as three metres of separation right
    // at the points, where the two routes are the same piece of track.
    for (let i = 1; i < near.length; i++) {
      const gap = toSegment(pt, near[i - 1]!, near[i]!);
      if (gap < closest) closest = gap;
    }
    if (closest < CLEARANCE_SEPARATION) lastFoul = d;
  }
  // Still foul at the end of the search: a pair of tracks running alongside each
  // other the whole way, which is a drawing mistake rather than a turnout, and
  // is better reported as no clearance point than as a number.
  if (lastFoul >= limit - STEP) return null;
  return lastFoul + STEP;
}

/** Distance from a point to a line segment, in plan. */
function toSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}
