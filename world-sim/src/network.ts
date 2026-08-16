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
  /** CROR 114: distance from the points to the clearance point, metres. */
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
  clearancePoint: number | undefined;
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
  }

  /** Recompute every node's position from the tracks meeting it. */
  refreshNodePositions(): void {
    for (const node of this.nodes.values()) {
      node.x = 0;
      node.y = 0;
      node.z = 0;
      this.locate(node);
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
