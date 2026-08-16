/**
 * A scene: terrain, the track on it, the trains on that, and how to look at it.
 *
 * The whole thing is defined by one JSON document and round-trips back to one.
 * That is the constraint everything else is arranged around — a scene is a file
 * you can write by hand, diff, and check in, not a pile of constructor calls —
 * and it is why `Terrain` and `TrackPath` hold on to the spec they were built
 * from rather than trying to reconstruct a sparse description from a baked grid.
 *
 * Live state (where a train is, how fast) is *not* part of the scene spec by
 * default; `toJSON({ state: true })` folds it back in when you want to save a
 * running simulation rather than its starting conditions.
 */
import {
  buildObstruction,
  DEFAULT_COLLISION,
  type CollisionEvent,
  type CollisionOptions,
  type Obstruction,
  type ObstructionSpec,
  resolveCollisions,
} from './collision.ts';
import { EventLog } from './events.ts';
import { chargeToSteadyState, partHoses } from './airbrake.ts';
import { buildBridge, type Bridge, type BridgeSpec } from './bridge.ts';
import {
  buildWildlife,
  DEFAULT_WILDLIFE,
  inWater,
  roamTo,
  stepWildlife,
  type Animal,
  type WildlifeOptions,
  type WildlifeSpec,
} from './wildlife.ts';
import type { AlerterState } from './cab.ts';
import { autoDrive, DEFAULT_DISPATCH, type DispatchOptions } from './dispatch.ts';
import {
  buildCrossing,
  DEFAULT_CROSSING,
  stepCrossings,
  type Crossing,
  type CrossingOptions,
  type CrossingSpec,
} from './crossing.ts';
import { soundHorn, type HeadlightSetting, type HornSignal } from './lights.ts';
import { Network, isHandWorked, restoresToNormal, type NodeSpec, type SwitchPosition } from './network.ts';
import {
  buildPerson,
  canWork,
  checkInjuries,
  locate,
  stepPerson,
  task,
  type Person,
  type PersonContext,
  type PersonSpec,
  type Task,
  type TaskKind,
} from './person.ts';
import { DEFAULT_PHYSICS, type PhysicsOptions, stepTrain, telemetry, type Telemetry } from './physics.ts';
import { buildRoute, Route } from './route.ts';
import { buildScenery, type Scenery, type ScenerySpec, stepScenery } from './scenery.ts';
import {
  buildFlag,
  buildSignal,
  flagsAhead,
  resolveSignals,
  signalAhead,
  SignalWatcher,
  type Flag,
  type FlagSpec,
  type Signal,
  type SignalPassing,
  type SignalSighting,
  type SignalSpec,
} from './signals.ts';
import type { CameraOptions } from './render/camera.ts';
import type { TerrainStyle } from './render/terrain.ts';
import type { TrackStyle } from './render/track.ts';
import type { NetworkStyle } from './render/network.ts';
import type { SceneryStyle } from './render/scenery.ts';
import type { PersonStyle } from './render/person.ts';
import type { SignalStyle } from './render/signals.ts';
import type { TrainStyle } from './render/train.ts';
import type { LightStyle } from './render/lights.ts';
import type { CrossingStyle } from './render/crossings.ts';
import type { BridgeStyle } from './render/bridge.ts';
import type { WildlifeStyle } from './render/wildlife.ts';
import { terraform } from './terraform.ts';
import { smoothstep } from './units.ts';
import { Terrain, type TerrainSpec } from './terrain.ts';
import { TrackPath, type TrackSpec } from './track.ts';
import { Train, type Car, type TrainSpec } from './train.ts';

export interface SceneStyle {
  background?: string;
  terrain?: TerrainStyle;
  track?: TrackStyle;
  train?: TrainStyle;
  /** Switch stands and obstructions. */
  network?: NetworkStyle;
  /** Trees, buildings, roads and traffic. */
  scenery?: SceneryStyle;
  /** Signal masts and field flags. */
  signals?: SignalStyle;
  /** The crew. */
  people?: PersonStyle;
  /** Headlights, ditch lights and the beam decal on the ground. */
  lights?: LightStyle;
  /** Crossing decks, masts, lights and gate arms. */
  crossings?: CrossingStyle;
  /** Trestles and girder spans. */
  bridge?: BridgeStyle;
  /** Moose, wolves, bears — and the other thing. */
  wildlife?: WildlifeStyle;
}

export interface SceneSpec {
  name?: string;
  description?: string;
  terrain: TerrainSpec;
  tracks?: TrackSpec[];
  /** Where tracks meet: joints, ends of steel, and switches. */
  nodes?: NodeSpec[];
  trains?: TrainSpec[];
  /** Things standing on the track that are not trains. */
  obstructions?: ObstructionSpec[];
  /** Trees, buildings, roads and traffic. Decoration; nothing can hit it. */
  scenery?: ScenerySpec[];
  /** Where a road crosses the railway at grade. */
  crossings?: CrossingSpec[];
  /**
   * Stretches carried on a structure instead of on an embankment.
   *
   * These are read *before* the earthworks are cut, because the point of a
   * bridge is that the ground is left alone under it.
   */
  bridges?: BridgeSpec[];
  /** Fixed signals on masts, placed at a mileage on a track and facing one way. */
  signals?: SignalSpec[];
  /** Flags displayed in the field: blue, red, yellow over red, yellow, green. */
  flags?: FlagSpec[];
  /** The crew, and anybody else on the ground. */
  people?: PersonSpec[];
  /** How many people the player may work at once. Two — a crew. */
  crewSize?: number;
  /**
   * Require a body for work that needs one.
   *
   * Off by default, and that default is backwards compatibility rather than a
   * judgement: every scene written before there were people in the world still
   * runs. Turned on, a hand-worked switch or a derail can only be operated by
   * somebody standing at it, and `throwSwitch` called from nowhere is refused
   * with a reason. Power switches are unaffected — they are worked from a
   * control machine, and `isHandWorked` in `network.ts` already knows which is
   * which.
   */
  embodied?: boolean;
  /** Overrides on the physics constants; anything omitted keeps its default. */
  physics?: Partial<PhysicsOptions>;
  /** Overrides on how impacts are resolved. */
  collision?: Partial<CollisionOptions>;
  /** Overrides on warning times and gate travel. */
  crossing?: Partial<CrossingOptions>;
  /** Overrides on how an automatic movement brakes for a signal. */
  dispatch?: Partial<DispatchOptions>;
  /** Moose, wolf packs and bears, salted across the map. */
  wildlife?: WildlifeSpec;
  /** Overrides on what it takes to be hit by something. */
  wildlifeOptions?: Partial<WildlifeOptions>;
  style?: SceneStyle;
  camera?: CameraOptions;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/**
 * Acts that change where a movement would go, and therefore require every route
 * to be rebuilt.
 */
const TOPOLOGY_EVENTS = new Set(['turned', 'derail-set', 'derail-removed']);

/** How much track a movement is routed over ahead of and behind itself. */
const ROUTE_AHEAD = 8000;
const ROUTE_BEHIND = 1200;
/** Rebuild the route when the train gets this close to either end of it. */
const ROUTE_MARGIN = 300;

export class World {
  readonly terrain: Terrain;
  readonly tracks: TrackPath[];
  readonly network: Network;
  /** Movements. Not readonly: cutting a train in two adds one. */
  trains: Train[];
  readonly obstructions: Obstruction[];
  readonly scenery: Scenery;
  readonly signals: Signal[];
  readonly flags: Flag[];
  readonly crossings: Crossing[];
  readonly bridges: Bridge[];
  readonly animals: Animal[];
  readonly people: Person[];
  /** Acts, in order — the seam to the rules layer. See `events.ts`. */
  readonly events = new EventLog();
  /** Whether work that needs a body must have one. */
  readonly embodied: boolean;
  /**
   * How many people can be worked at once.
   *
   * A crew, and a crew is two. Everybody else in a scene — a switchtender, a
   * track foreman, the carmen — is there to be worked around rather than
   * commanded, which is the true situation and stops the simulation turning into
   * a game of moving everybody at once.
   */
  readonly crewSize: number;
  readonly physics: PhysicsOptions;
  readonly collision: CollisionOptions;
  readonly crossingOptions: CrossingOptions;
  readonly dispatchOptions: DispatchOptions;
  readonly wildlifeOptions: WildlifeOptions;
  /** Impacts that happened during the most recent `step`. */
  collisions: CollisionEvent[] = [];
  /**
   * Signals passed during the most recent `step`, and what they were showing.
   * An observation, not a verdict — see `signals.ts`.
   */
  signalsPassed: SignalPassing[] = [];
  readonly style: SceneStyle;
  readonly camera: CameraOptions;
  readonly name: string;
  readonly description: string | undefined;
  /** Seconds of simulated time since the scene was loaded. */
  time = 0;

  private readonly byId = new Map<string, TrackPath>();
  private readonly scenerySpec: ScenerySpec[];
  private readonly signalSpec: SignalSpec[];
  private readonly watcher = new SignalWatcher();
  private readonly flagSpec: FlagSpec[];
  private readonly crossingSpec: CrossingSpec[];
  private readonly bridgeSpec: BridgeSpec[];
  private readonly wildlifeSpec: WildlifeSpec;
  private readonly peopleSpec: PersonSpec[];
  private readonly crewIds: Set<string>;

  constructor(spec: SceneSpec) {
    this.name = spec.name ?? 'scene';
    this.description = spec.description;
    this.terrain = new Terrain(spec.terrain);
    this.tracks = (spec.tracks ?? []).map((t, i) => new TrackPath({ id: `track-${i}`, ...t }, this.terrain));
    for (const t of this.tracks) this.byId.set(t.id, t);
    // Every track is draped on the original ground first, then the earthworks
    // are cut. Doing it in that order keeps two tracks from stacking one
    // embankment on top of another's.
    //
    // Bridge spans are pulled out here, before anything is cut: a bridge is
    // defined by the ground *not* being brought up to the rail, and a span
    // declared after the fact would arrive to find its valley already filled in.
    this.bridgeSpec = spec.bridges ?? [];
    for (const t of this.tracks) {
      const opts = t.toJSON().terraform;
      if (opts === false) continue;
      const spans = this.bridgeSpec
        .filter((b) => (b.track ?? this.tracks[0]?.id) === t.id)
        .map((b) => ({ from: Math.min(b.from, b.to), to: Math.max(b.from, b.to) }));
      terraform(this.terrain, t, { ...(opts ?? {}), spans });
    }
    for (const t of this.tracks) t.refreshGround(this.terrain);

    this.network = new Network(this.tracks, spec.nodes ?? []);
    this.levelJunctions();
    this.obstructions = (spec.obstructions ?? []).map(buildObstruction);
    // Planted after the earthworks, so a forest sits on the finished ground and
    // knows where the right-of-way ended up.
    this.scenery = buildScenery(spec.scenery ?? [], this.terrain, this.tracks);
    this.scenerySpec = spec.scenery ?? [];
    this.signalSpec = spec.signals ?? [];
    this.flagSpec = spec.flags ?? [];
    this.signals = this.signalSpec.map((sig, i) =>
      buildSignal(sig, i, this.track(sig.track)),
    );
    this.flags = this.flagSpec.map((f, i) => buildFlag(f, i, this.track(f.track)));
    // After the earthworks, so a bent's foot is on the ground as it finally is.
    this.bridges = this.bridgeSpec.map((b, i) =>
      buildBridge(b, i, this.track(b.track), (x, y) => this.terrain.heightAt(x, y)),
    );
    // Salted after the track exists, so nothing is standing on the railway when
    // the scene opens — an animal that starts fouling the line is a strike
    // before anybody has done anything, which teaches nothing.
    this.wildlifeSpec = spec.wildlife ?? {};
    this.animals = buildWildlife(this.wildlifeSpec, this.terrain, (x, y) => this.distanceToTrack(x, y));
    this.crossingSpec = spec.crossings ?? [];
    this.crossings = this.crossingSpec.map(buildCrossing);
    this.placeCrossings();
    this.peopleSpec = spec.people ?? [];
    this.embodied = spec.embodied ?? false;
    this.crewSize = spec.crewSize ?? 2;
    this.trains = (spec.trains ?? []).map((t) => new Train(t));
    for (const train of this.trains) this.rebuildRoute(train);
    // People last: somebody may be riding a movement, and placing them needs
    // that movement to exist and to have a route to be placed along.
    this.people = this.peopleSpec.map(buildPerson);
    this.crewIds = new Set(
      this.peopleSpec.filter((p) => p.crew).map((p, i) => p.id ?? `person-${i}`),
    );
    for (const person of this.people) locate(person, this.personContext());
    this.physics = {
      ...DEFAULT_PHYSICS,
      ...spec.physics,
      davis: { ...DEFAULT_PHYSICS.davis, ...spec.physics?.davis },
      derailment: { ...DEFAULT_PHYSICS.derailment, ...spec.physics?.derailment },
    };
    this.collision = { ...DEFAULT_COLLISION, ...spec.collision };
    this.crossingOptions = { ...DEFAULT_CROSSING, ...spec.crossing };
    this.dispatchOptions = { ...DEFAULT_DISPATCH, ...spec.dispatch };
    this.wildlifeOptions = { ...DEFAULT_WILDLIFE, ...spec.wildlifeOptions };
    // Settle the air as though each movement had been standing coupled to a
    // working locomotive: a scene that says `brake: 1` starts with the brakes on
    // rather than with a minute of pumping ahead of it. Done here because it
    // needs the physics options, which are only now assembled.
    for (const train of this.trains) {
      chargeToSteadyState(train, this.physics.air);
    }
    this.style = spec.style ?? {};
    this.camera = spec.camera ?? {};
  }

  static fromJSON(json: string | SceneSpec): World {
    return new World(typeof json === 'string' ? (JSON.parse(json) as SceneSpec) : json);
  }

  track(id: string | undefined): TrackPath | undefined {
    if (id === undefined) return this.tracks[0];
    return this.byId.get(id) ?? this.tracks[0];
  }

  /**
   * The track a train's lead car is actually standing on right now — which,
   * once there are turnouts, is not the same question as which track the scene
   * said it started on.
   */
  trackFor(train: Train): TrackPath | undefined {
    const lead = train.cars.find((c) => !c.derailed) ?? train.cars[0];
    if (train.route && lead) return train.route.locate(lead.s).track;
    return this.track(train.trackId);
  }

  /**
   * Work out one elevation per node, then re-grade every track to meet them.
   *
   * Each track is graded on its own, over its own length, with no knowledge of
   * what it joins up to — so two tracks meeting at a switch end at different
   * heights, and a route through several turnouts climbs a staircase that exists
   * nowhere in the terrain. That is the bug this fixes.
   *
   * Averaging the heights each track happened to arrive at is not enough, and
   * the reason is worth stating. Grade limiting makes a profile *depart* from
   * the ground, cumulatively, over a distance longer than any one segment: on
   * ground at 4% a 2% railway is 20 m below the hillside after a kilometre. Each
   * track, graded alone, starts afresh near its own local ground and so has none
   * of that accumulated departure — and averaging endpoints that each carry a
   * different amount of it just moves the step around.
   *
   * So the node heights are solved together, as a small graph: every node is
   * pulled toward the natural ground beneath it, and every track acts as a
   * constraint that its two nodes may differ by no more than its ruling grade
   * allows over its length. A few hundred rounds of pull-and-enforce settles it.
   * What comes out is a grade line through control points — which is what a
   * location engineer produces, and, being feasible, is something each track can
   * then actually be graded to hit.
   */
  private levelJunctions(): void {
    interface Junction {
      node: string;
      z: number;
      target: number;
      ends: { track: string; end: 'from' | 'to' }[];
    }

    const junctions = new Map<string, Junction>();
    for (const node of this.network.nodes.values()) {
      const ends: { track: string; end: 'from' | 'to' }[] = [];
      let ground = 0;
      let n = 0;
      for (const conn of node.ports.values()) {
        const track = this.network.tracks.get(conn.track);
        if (!track) continue;
        const pt = conn.end === 'from' ? track.samples[0] : track.samples[track.samples.length - 1];
        if (!pt) continue;
        ends.push({ track: conn.track, end: conn.end });
        ground += pt.naturalGround;
        n++;
      }
      // A node with one track is an end of steel: nothing to agree with, and
      // pinning it would only fight the terrain.
      if (ends.length < 2 || n === 0) continue;
      const target = ground / n + 0.6;
      junctions.set(node.id, { node: node.id, z: target, target, ends });
    }
    if (junctions.size === 0) return;

    // Tracks joining two junctions become the constraints.
    const edges: { a: Junction; b: Junction; maxRise: number }[] = [];
    for (const track of this.tracks) {
      const from = track.startNode && junctions.get(track.startNode.node);
      const to = track.endNode && junctions.get(track.endNode.node);
      if (from && to && from !== to) {
        edges.push({ a: from, b: to, maxRise: Math.max(0.01, track.maxGrade * track.length) });
      }
    }

    const all = [...junctions.values()];
    for (let pass = 0; pass < 400; pass++) {
      for (const j of all) j.z += (j.target - j.z) * 0.12;
      let worst = 0;
      for (const e of edges) {
        const d = e.b.z - e.a.z;
        const over = Math.abs(d) - e.maxRise;
        if (over > 0) {
          worst = Math.max(worst, over);
          const fix = (Math.sign(d) * over) / 2;
          e.a.z += fix;
          e.b.z -= fix;
        }
      }
      if (pass > 20 && worst < 1e-4) break;
    }

    const pins = new Map<string, { start?: number; end?: number }>();
    for (const j of all) {
      for (const e of j.ends) {
        const pin = pins.get(e.track) ?? {};
        if (e.end === 'from') pin.start = j.z;
        else pin.end = j.z;
        pins.set(e.track, pin);
      }
    }
    for (const [id, pin] of pins) this.network.tracks.get(id)?.regrade(pin.start, pin.end);
    this.network.refreshNodePositions();
  }

  /**
   * Give a train a route through the network from where it is now.
   *
   * Called at construction and whenever the train runs near the end of the
   * route it has — and whenever a switch is thrown, because the way ahead may
   * have changed. Rebuilding shifts the origin of route distance, so every
   * car's position moves by the same amount; that offset is the only fiddly
   * part, and getting it wrong teleports the train.
   */
  rebuildRoute(train: Train): void {
    const previous = train.route;
    let start;
    if (previous) {
      // Anchor on the lead car so the new route is laid out from a point that
      // is definitely still on the railway.
      const lead = train.cars.find((c) => !c.derailed) ?? train.cars[0];
      start = previous.locate(lead ? lead.s : 0);
    } else {
      const track = this.track(train.trackId);
      if (!track) return;
      start = { track, at: 0, dir: 1 as const };
    }

    const anchorBefore = previous
      ? (train.cars.find((c) => !c.derailed) ?? train.cars[0])?.s ?? 0
      : 0;
    const route = buildRoute(this.network, start, ROUTE_AHEAD, ROUTE_BEHIND);
    const anchorAfter = route.closed
      ? anchorBefore
      : (route.distanceOf(start.track.id, start.at) ?? 0);

    train.route = route;
    if (previous && !route.closed) {
      const shift = anchorAfter - anchorBefore;
      for (const car of train.cars) {
        if (!car.derailed) car.s += shift;
      }
      if (train.derailAnchor !== null) train.derailAnchor += shift;
    } else if (!previous && !route.closed) {
      // A fresh train was positioned in track coordinates; move it onto the
      // route, which generally starts some way behind the track's own zero.
      const shift = route.distanceOf(start.track.id, 0) ?? 0;
      for (const car of train.cars) car.s += shift;
    }
  }

  /**
   * Whether a switch can be moved right now.
   *
   * Points held down by the wheels of a standing movement do not move, for a
   * hand switch or a power one — the difference between them is who works them,
   * not whether physics applies. Reporting *why* matters more than the boolean:
   * a switch that silently refuses to throw reads as a broken control.
   */
  canThrowSwitch(id: string): { ok: boolean; reason?: string } {
    const node = this.network.nodes.get(id);
    if (!node || node.kind !== 'switch') return { ok: false, reason: 'no such switch' };
    if (node.operation === 'spring') {
      return { ok: false, reason: 'spring switch — the points are held by the spring' };
    }
    const occupier = this.occupantOf(node.x, node.y);
    if (occupier) {
      return { ok: false, reason: `${occupier} is standing on the points` };
    }
    if (this.embodied && isHandWorked(node) && !this.somebodyAt(node.x, node.y)) {
      return { ok: false, reason: 'hand-worked — somebody has to be at it' };
    }
    return { ok: true };
  }

  /** Whether anybody is near enough to work on something here. */
  somebodyAt(x: number, y: number): Person | null {
    return this.people.find((p) => canWork(p, x, y)) ?? null;
  }

  /** The movement standing on a point in the world, if any. */
  private occupantOf(x: number, y: number, radius = 14): string | null {
    for (const train of this.trains) {
      const route = train.route;
      if (!route) continue;
      for (const car of train.cars) {
        if (car.derailed) continue;
        const pt = route.at(car.s);
        if (Math.hypot(pt.x - x, pt.y - y) < radius + car.length / 2) {
          return train.label ?? train.id;
        }
      }
    }
    return null;
  }

  /**
   * Queue work for a person. Returns false only for an unknown person.
   *
   * Everything else — being too far away, the switch being spring-worked, the
   * car not existing — is discovered when the task comes up, refused out loud,
   * and recorded. That is deliberate: a conductor can be *told* to do something
   * impossible, and finding out is part of what the simulation is for.
   */
  assign(personId: string, ...tasks: Task[]): boolean {
    const person = this.people.find((p) => p.id === personId);
    if (!person) return false;
    person.queue.push(...tasks);
    return true;
  }

  /** Drop everything a person has been told to do, including what they are doing. */
  cancel(personId: string): boolean {
    const person = this.people.find((p) => p.id === personId);
    if (!person) return false;
    person.task = null;
    person.queue = [];
    person.walkFrom = null;
    return true;
  }

  person(id: string): Person | undefined {
    return this.people.find((p) => p.id === id);
  }

  /**
   * The people the player is working: at most `crewSize` of them, and never
   * anybody who has been hurt.
   *
   * A scene marks its crew with `crew: true`; failing that the first two are
   * taken, which is what a two-person crew looks like in every scene written so
   * far.
   */
  get crew(): Person[] {
    const marked = this.people.filter((p) => this.crewIds.has(p.id) && p.injury === 'none');
    const pool = marked.length > 0 ? marked : this.people.filter((p) => p.injury === 'none');
    return pool.slice(0, this.crewSize);
  }

  /**
   * Send somebody to a place and have them do something when they get there.
   *
   * The two-task form is the whole control scheme: you say where and what, and
   * the walking takes however long the walking takes. It is the middle ground
   * between driving a body around with arrow keys and issuing an order that
   * teleports — the player picks the destination, and the world decides how long
   * it takes and whether the job can be done from there.
   */
  send(personId: string, to: { track?: string; at: number; offset?: number }, then?: Task): boolean {
    const walk = task('walk', { to, label: `walk to ${to.track ?? 'here'} ${Math.round(to.at)} m` });
    return then ? this.assign(personId, walk, then) : this.assign(personId, walk);
  }

  /**
   * Send somebody to a switch and have them line it — the commonest job there is.
   *
   * The person is put beside the stand rather than on the centre line, which is
   * where 104(j) says they should be and where `network.ts` draws the stand.
   */
  sendToSwitch(personId: string, nodeId: string, position?: SwitchPosition): boolean {
    const node = this.network.nodes.get(nodeId);
    if (!node) return false;
    const at = this.nearestPointOnTrack(node.x, node.y);
    if (!at) return false;
    return this.send(
      personId,
      { track: at.track, at: at.at, offset: 3.4 },
      task('line-switch', {
        target: nodeId,
        position,
        label: `line ${node.label ?? nodeId} ${position ?? 'over'}`,
      }),
    );
  }

  /**
   * Where two movements come closest, and how far apart they are there.
   *
   * Only the four end faces are considered — a movement alongside another on a
   * parallel track is not coupled to it however near it passes.
   */
  couplingGap(a: Train, b: Train): { x: number; y: number; distance: number } | null {
    if (!a.route || !b.route) return null;
    const ends = (t: Train) => {
      const route = t.route!;
      const lead = t.cars[0];
      const tail = t.cars[t.cars.length - 1];
      if (!lead || !tail) return [];
      return [
        route.at(lead.s + (t.direction * lead.length) / 2),
        route.at(tail.s - (t.direction * tail.length) / 2),
      ];
    };
    let best: { x: number; y: number; distance: number } | null = null;
    for (const p of ends(a)) {
      for (const q of ends(b)) {
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (!best || d < best.distance) {
          best = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, distance: d };
        }
      }
    }
    return best;
  }

  /**
   * Where the coupling behind a car is — the place somebody has to stand to cut
   * it off. Exposed so a UI can walk them there rather than to the car.
   */
  couplingBehind(carId: string): { track: string; at: number; x: number; y: number } | null {
    for (const train of this.trains) {
      const index = train.cars.findIndex((c) => c.id === carId);
      if (index < 0 || index === train.cars.length - 1 || !train.route) continue;
      const mid = (train.cars[index]!.s + train.cars[index + 1]!.s) / 2;
      const pt = train.route.at(mid);
      const loc = train.route.locate(mid);
      return { track: loc.track.id, at: loc.at, x: pt.x, y: pt.y };
    }
    return null;
  }

  /** The nearest point on any track to a place in the world. */
  nearestPointOnTrack(x: number, y: number): { track: string; at: number; distance: number } | null {
    let best: { track: string; at: number; distance: number } | null = null;
    for (const track of this.tracks) {
      for (const sample of track.samples) {
        const d = Math.hypot(sample.x - x, sample.y - y);
        if (!best || d < best.distance) best = { track: track.id, at: sample.s, distance: d };
      }
    }
    return best;
  }

  /**
   * What this person could do without moving.
   *
   * The other half of the control scheme: having walked somewhere, you are
   * offered what is actually within reach from there — which is the difference
   * between a menu of everything and a menu of what a body can touch.
   */
  actionsAt(personId: string): { kind: TaskKind; target: string; label: string }[] {
    const person = this.people.find((p) => p.id === personId);
    if (!person) return [];
    const out: { kind: TaskKind; target: string; label: string }[] = [];

    if (person.posture !== 'on-ground') {
      out.push({ kind: 'dismount', target: person.trainId ?? '', label: 'get down' });
      if (person.trainId) {
        if (person.posture === 'riding') {
          out.push({ kind: 'ride-cab', target: person.trainId, label: 'climb into the cab' });
        }
        if (person.atControls) {
          out.push({ kind: 'leave-controls', target: person.trainId, label: 'leave the controls' });
        } else {
          out.push({ kind: 'take-controls', target: person.trainId, label: 'take the controls' });
        }
      }
      return out;
    }

    for (const node of this.network.nodes.values()) {
      if (!canWork(person, node.x, node.y)) continue;
      if (node.kind === 'switch' && node.operation !== 'spring') {
        const other = node.position === 'normal' ? 'reverse' : 'normal';
        out.push({ kind: 'line-switch', target: node.id, label: `line ${node.label ?? node.id} ${other}` });
        out.push({ kind: 'point-and-call', target: node.id, label: `point and call at ${node.label ?? node.id}` });
      } else if (node.kind === 'derail') {
        out.push({
          kind: 'set-derail',
          target: node.id,
          label: node.derailing ? `take off the derail` : `set the derail`,
        });
      }
    }

    for (const crossing of this.crossings) {
      if (!canWork(person, crossing.x, crossing.y)) continue;
      out.push(
        crossing.flaggedBy === person.id
          ? { kind: 'release-crossing', target: crossing.id, label: `stand down from ${crossing.label}` }
          : { kind: 'protect-crossing', target: crossing.id, label: `stop traffic at ${crossing.label}` },
      );
    }

    for (const train of this.trains) {
      for (const car of train.cars) {
        const route = train.route;
        if (!route) continue;
        const pt = car.derailed && car.body ? car.body : route.at(car.s);
        if (!canWork(person, pt.x, pt.y)) continue;

        // A locomotive is a thing you climb into, and that is a different act
        // from riding the side of a car.
        if (car.kind === 'locomotive') {
          out.push({
            kind: 'ride-cab',
            target: train.id,
            label: `climb into the cab of ${train.label ?? train.id}`,
          });
          out.push({
            kind: 'take-controls',
            target: train.id,
            label: `take the controls of ${train.label ?? train.id}`,
          });
        }
        out.push({
          kind: car.handbrake ? 'release-handbrake' : 'apply-handbrake',
          target: car.id,
          label: `${car.handbrake ? 'release' : 'apply'} the handbrake on ${car.id}`,
        });
        if (car.air.cylinderPsi > 1 || car.air.reservoirPsi > 1) {
          out.push({ kind: 'bleed', target: car.id, label: `bleed off ${car.id}` });
        }
        out.push({ kind: 'board', target: car.id, label: `get on ${car.id}` });
      }

      // Cutting is offered at the *coupling*, which is half a car length from
      // the middle of either car standing beside it.
      const route = train.route;
      if (!route) continue;
      for (let i = 0; i < train.cars.length - 1; i++) {
        const joint = route.at((train.cars[i]!.s + train.cars[i + 1]!.s) / 2);
        if (!canWork(person, joint.x, joint.y)) continue;
        out.push({
          kind: 'uncouple',
          target: train.cars[i]!.id,
          label: `cut off behind ${train.cars[i]!.id} (${train.cars.length - i - 1} cars)`,
        });
      }
    }

    // Standing at the joint between two movements: couple them up.
    for (const train of this.trains) {
      for (const other of this.trains) {
        if (train === other) continue;
        if (Math.abs(train.speed) > 0.3 || Math.abs(other.speed) > 0.3) continue;
        const gap = this.couplingGap(train, other);
        if (gap === null || gap.distance > 2.5) continue;
        if (!canWork(person, gap.x, gap.y)) continue;
        out.push({
          kind: 'couple',
          target: `${train.id}|${other.id}`,
          label: `couple ${train.label ?? train.id} to ${other.label ?? other.id}`,
        });
      }
    }
    return out;
  }

  /**
   * Cut a movement in two, behind the given car.
   *
   * The car keeps its place with the head end and everything behind it becomes
   * a movement of its own, standing exactly where it was standing. The fiddly
   * part is the coordinates: the new movement's cars still carry distances
   * measured along the *old* route, so it is handed that route and then
   * immediately re-routed, which rebases every distance in one place —
   * `rebuildRoute` already does that arithmetic and already warns that getting
   * it wrong teleports a train.
   *
   * What this does not model, and it matters: there is no train line here, so
   * nothing is said about angle cocks, the air going into emergency on the
   * portion cut away, or a brake test afterwards. A cut here is a mechanical
   * parting and nothing else.
   */
  uncouple(carId: string, by?: string): boolean {
    const train = this.trains.find((t) => t.cars.some((c) => c.id === carId));
    if (!train) return false;
    const index = train.cars.findIndex((c) => c.id === carId);
    if (index < 0 || index === train.cars.length - 1) return false;

    const ahead = train.cars[index]!;
    const behind = train.cars[index + 1]!;
    // The hoses come apart with the coupling. Whether that dumps the air depends
    // entirely on whether somebody closed the angle cocks first — which is the
    // decision the rule is about, and the reason this is not tidied away.
    const wasOpen = ahead.air.cockBehind || behind.air.cockAhead;
    partHoses(ahead.air, behind.air);

    const rear = train.cars.splice(index + 1);
    const id = this.uniqueTrainId(train.id);
    const cut = Train.of(id, rear, train);
    // Whatever the head end is doing, the cut is standing still and unbraked
    // apart from any handbrakes that were tied on it — which is the whole
    // reason 112 is written the way it is.
    cut.throttle = 0;
    cut.brake = 0;
    this.trains.push(cut);
    this.rebuildRoute(cut);

    this.events.emit({
      kind: 'uncoupled',
      at: this.time,
      by,
      subject: carId,
      detail: { from: train.id, cut: cut.id, cars: rear.length, cocksOpen: wasOpen },
    });
    if (wasOpen) {
      train.emergency = true;
      cut.emergency = true;
      this.events.emit({
        kind: 'emergency-brake',
        at: this.time,
        by,
        subject: carId,
        detail: { why: 'the hoses parted with the angle cocks open' },
      });
    }
    return true;
  }

  /**
   * Join two movements that are standing together.
   *
   * The merged order is worked out from where the cars actually are, not from
   * which end of which movement was coupled to which: every car is placed on one
   * route and sorted by distance along it. That sidesteps a nest of cases about
   * facing and direction flags, and it cannot produce a consist whose order
   * disagrees with the ground.
   */
  couple(trainId: string, otherId: string, by?: string): boolean {
    const a = this.trains.find((t) => t.id === trainId);
    const b = this.trains.find((t) => t.id === otherId);
    if (!a || !b || a === b || !a.route || !b.route) return false;
    // Coupling is done at a stand. Two movements rolling together is a
    // collision, and `collision.ts` already has opinions about that.
    if (Math.abs(a.speed) > 0.3 || Math.abs(b.speed) > 0.3) return false;

    // Bring B's cars into A's coordinates, refusing if A's route does not run
    // over the track B is standing on.
    const moved: { car: Car; s: number }[] = [];
    for (const car of b.cars) {
      const where = b.route.locate(car.s);
      const s = a.route.distanceOf(where.track.id, where.at);
      if (s === null) return false;
      moved.push({ car, s });
    }
    for (const { car, s } of moved) car.s = s;

    const all = [...a.cars, ...b.cars];
    all.sort((x, y) => (x.s - y.s) * -a.direction);
    a.cars = all;
    this.trains = this.trains.filter((t) => t !== b);
    this.rebuildRoute(a);

    this.events.emit({
      kind: 'coupled',
      at: this.time,
      by,
      subject: otherId,
      detail: { into: a.id, cars: a.cars.length },
    });
    return true;
  }

  private uniqueTrainId(base: string): string {
    for (let i = 2; ; i++) {
      const id = `${base}-${i}`;
      if (!this.trains.some((t) => t.id === id)) return id;
    }
  }

  /**
   * How far the nearest rail is from a point, metres.
   *
   * Used for salting animals somewhere that is not the right of way. Sampled
   * rather than solved: a track is a polyline and the nearest point on it is a
   * search, and for scattering wildlife an answer good to a few metres is an
   * answer.
   */
  distanceToTrack(x: number, y: number): number {
    let best = Infinity;
    for (const track of this.tracks) {
      const step = Math.max(20, track.length / 400);
      for (let s = 0; s <= track.length; s += step) {
        const pt = track.at(s);
        const d = Math.hypot(pt.x - x, pt.y - y);
        if (d < best) best = d;
      }
    }
    return best;
  }

  /**
   * The nearest point on any track, in track coordinates.
   *
   * What a roaming person's destination is turned into: people live on tracks,
   * so a place in the world has to be expressed as somewhere along one with an
   * offset to the side. Somebody wandering a long way from the railway is
   * simply a long way off to one side of it.
   */
  nearestTrackPoint(x: number, y: number): { track: string; at: number; offset: number } | null {
    let best: { track: string; at: number; offset: number } | null = null;
    let bestD = Infinity;
    for (const track of this.tracks) {
      const step = Math.max(10, track.length / 600);
      for (let s = 0; s <= track.length; s += step) {
        const pt = track.at(s);
        const d = Math.hypot(pt.x - x, pt.y - y);
        if (d >= bestD) continue;
        bestD = d;
        const dx = x - pt.x;
        const dy = y - pt.y;
        best = {
          track: track.id,
          at: s,
          offset: dx * Math.sin(pt.heading) - dy * Math.cos(pt.heading),
        };
      }
    }
    return best;
  }

  /** Whoever is at the controls of a movement, if anybody is. */
  cabOccupant(trainId: string): Person | null {
    // Whoever is *at the controls*, not merely in the cab. A conductor rides in
    // the cab for most of a trip and is not driving, and everything gated on
    // this — the throttle, the horn, the alerter — follows the seat.
    return this.people.find((p) => p.atControls && p.trainId === trainId) ?? null;
  }

  /** Anybody in the cab of a movement, driving or not. */
  cabRiders(trainId: string): Person[] {
    return this.people.filter((p) => p.posture === 'in-cab' && p.trainId === trainId);
  }

  /** Whether one person can see a place over the ground between. */
  canSee(personId: string, x: number, y: number, targetHeight = 1.5): boolean {
    const person = this.people.find((p) => p.id === personId);
    if (!person) return false;
    return this.terrain.hasLineOfSight(
      person.x,
      person.y,
      person.z + 1.6,
      x,
      y,
      this.terrain.heightAt(x, y) + targetHeight,
    );
  }

  /** Throw a switch, and re-route every movement that might be affected. */
  throwSwitch(id: string, position?: SwitchPosition): boolean {
    if (!this.canThrowSwitch(id).ok) return false;
    const changed =
      position === undefined ? this.network.toggle(id) !== null : this.network.setPosition(id, position);
    if (!changed) return false;
    for (const train of this.trains) this.rebuildRoute(train);
    return true;
  }

  /** Set a derail on or off the rail. */
  setDerail(id: string, derailing: boolean): boolean {
    const node = this.network.nodes.get(id);
    if (!node || node.kind !== 'derail') return false;
    node.derailing = derailing;
    for (const train of this.trains) this.rebuildRoute(train);
    return true;
  }

  /** Everything a person needs to know about the world to act in it. */
  private personContext(): PersonContext {
    return {
      tracks: this.network.tracks,
      network: this.network,
      people: this.people,
      terrain: this.terrain,
      trains: this.trains,
      events: this.events,
      time: this.time,
      uncouple: (carId, by) => this.uncouple(carId, by),
      couple: (trainId, otherId, by) => this.couple(trainId, otherId, by),
      protectCrossing: (id, by) => this.flagCrossing(id, by),
      releaseCrossing: (id, by) => this.releaseCrossing(id, by),
    };
  }

  /** Advance every train by `dt` seconds of simulated time. */
  step(dt: number): void {
    this.events.beginStep();
    for (const train of this.trains) {
      const route = train.route;
      if (!route) continue;
      // What the cab looked like going in, so anything the alerter or the PCS
      // did on its own can be recorded. These are the two things that act
      // without anybody having touched a control, which is exactly why they
      // have to be seen from outside rather than inferred from the handles.
      // An automatic movement is driven before it is stepped, and it sets the
      // same throttle and brake handle a person would — so it is subject to the
      // same air, adhesion and grade, and can get it just as wrong.
      if (train.auto.drive) {
        autoDrive(train, train.auto, this.signalAhead(train, train.auto.sight), this.dispatchOptions);
      }
      const before = { alerter: train.alerter.state, pcs: train.pcs.open };
      // The alerter watches whoever is in the seat, so it has to be told there
      // is one. A movement nobody is driving is never penalised.
      train.attended = this.cabOccupant(train.id) !== null;
      stepTrain(train, route, dt, this.physics, this.terrain);
      this.recordCab(train, before, dt);
      // Keep enough railway in front of and behind the movement to work with.
      if (!route.closed) {
        const positions = train.cars.filter((c) => !c.derailed).map((c) => c.s);
        if (positions.length > 0) {
          const lo = Math.min(...positions);
          const hi = Math.max(...positions);
          const ranOut =
            (hi > route.length - ROUTE_MARGIN && route.stop.reason === 'budget') ||
            (lo < ROUTE_MARGIN && route.stopBehind.reason === 'budget');
          if (ranOut) this.rebuildRoute(train);
        }
      }
    }

    // Crossings before the traffic, so a car braking this step is braking for
    // the state the railway is actually in rather than last frame's.
    stepCrossings(this.crossings, this.crossingOccupants(), dt, this.crossingOptions);
    stepScenery(this.scenery, dt, this.crossings);
    // The animals, and everything else the country does to anybody standing in
    // it. Always run, even with no animals in the scene: this pass is also what
    // resolves being run down on a road and being drowned, and guarding it on
    // `animals.length` quietly turned those off wherever there was no wildlife.
    // After the traffic, so a vehicle that has just moved takes what is now in
    // front of it rather than what was there last frame.
    stepWildlife(
      this.animals,
      {
        terrain: this.terrain,
        animals: this.animals,
        people: this.people,
        trains: this.trains,
        scenery: this.scenery,
        events: this.events,
        time: this.time + dt,
        inWater: (x, y) => inWater(this.scenery, x, y),
      },
      dt,
      this.wildlifeOptions,
    );
    // Anybody who wanders goes somewhere new when they have run out of places
    // to be. Nobody sends a trespasser anywhere.
    for (const person of this.people) {
      if (!person.roam || person.injury !== 'none' || person.task || person.queue.length > 0) {
        continue;
      }
      const to = roamTo(person, this.terrain, this.time + dt);
      const near = this.nearestTrackPoint(to.x, to.y);
      if (near) this.send(person.id, { track: near.track, at: near.at, offset: near.offset });
    }
    // People after the trains: somebody riding a car is slaved to where that car
    // has just got to, and a task that finishes this step should act on the
    // railway as it now is rather than as it was.
    const ctx = this.personContext();
    ctx.time = this.time + dt;
    for (const person of this.people) stepPerson(person, ctx, dt);
    checkInjuries(this.people, ctx);
    // Somebody who has just turned a switch has changed the way ahead of every
    // movement, exactly as the control machine would have. Reading it off the
    // event log rather than diffing the network keeps `person.ts` from needing
    // to know that routes exist.
    if (this.events.recent.some((e) => TOPOLOGY_EVENTS.has(e.kind))) {
      for (const train of this.trains) this.rebuildRoute(train);
    }
    this.restoreAutoNormalSwitches();
    if (this.signals.length > 0) {
      resolveSignals(this.signals, this.occupancy(), this.network);
      // Watched after resolving, so a passing is recorded against what the
      // signal was actually showing as the movement went by it.
      this.signalsPassed = this.watcher.step(this.trains, this.signals, this.time + dt);
    }
    this.collisions = resolveCollisions(
      this.trains.filter((t) => t.route).map((t) => ({ train: t, route: t.route as Route })),
      this.obstructions,
      this.collision,
      this.physics.derailment,
    );
    this.time += dt;
  }

  /**
   * Put each crossing where its track and its road actually meet.
   *
   * The world position comes from the track, which is the authority: a crossing
   * is a place on the railway that a road happens to reach. The road distance is
   * then found by walking that road for its nearest sample, so traffic knows
   * where to stop without the scene having to state the same place twice.
   */
  private placeCrossings(): void {
    for (const crossing of this.crossings) {
      const track = this.track(crossing.trackId);
      if (!track) continue;
      const pt = track.at(crossing.at);
      crossing.x = pt.x;
      crossing.y = pt.y;
      crossing.z = pt.z;
      crossing.heading = pt.heading;

      const road = this.scenery.roads.find((r) => r.id === crossing.roadId);
      if (road && road.samples.length > 1) {
        let best = 0;
        let bestD = Infinity;
        const spacing = road.length / (road.samples.length - 1);
        road.samples.forEach((sample, i) => {
          const d = Math.hypot(sample.x - pt.x, sample.y - pt.y);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        crossing.roadAt = best * spacing;

        // Bring the road up (or down) to the rail across the crossing, blended
        // out over a short approach. A road is draped on the ground and the
        // track is graded onto it, so at a crossing the two disagree by whatever
        // the earthworks did — and a highway that dives under the rails or rides
        // over them is the one place that discrepancy is unmissable.
        const blend = 45;
        const span = Math.ceil(blend / spacing);
        for (let i = Math.max(0, best - span); i <= Math.min(road.samples.length - 1, best + span); i++) {
          const sample = road.samples[i]!;
          const t = Math.abs(i - best) / Math.max(1, span);
          const w = smoothstep(1 - t);
          sample.z = sample.z + (pt.z - sample.z) * w;
        }
      }
    }

    // A vehicle stopped on the crossing is a real obstruction on the track, not
    // a special case: the collision code already knows how to strike one, shove
    // it and report the closing speed, and it should not have to learn what a
    // crossing is to do that.
    this.crossings.forEach((crossing, i) => {
      const spec = this.crossingSpec[i];
      if (!spec?.stalled) return;
      const type = spec.stalledType ?? 'car';
      const id = `${crossing.id}-stalled`;
      this.obstructions.push(
        buildObstruction(
          {
            id,
            label: type === 'car' ? 'Car on the crossing' : `${type} on the crossing`,
            track: crossing.trackId,
            at: crossing.at,
            mass: type === 'car' ? 1.6 : type === 'bus' ? 13 : 24,
            length: type === 'car' ? 4.4 : type === 'bus' ? 12 : 9.5,
            width: 2.4,
            height: type === 'car' ? 1.5 : 3.2,
            color: '#b03a2e',
          },
          this.obstructions.length,
        ),
      );
      crossing.stalledId = id;
    });
  }

  /**
   * Stand at a crossing and stop the road by hand.
   *
   * The act that matters when the warning system has failed, and the only thing
   * that works then. Refused unless the person is actually at the crossing —
   * flagging one from half a mile away protects nobody.
   */
  flagCrossing(crossingId: string, personId: string): boolean {
    const crossing = this.crossings.find((c) => c.id === crossingId);
    const person = this.people.find((p) => p.id === personId);
    if (!crossing || !person) return false;
    if (!canWork(person, crossing.x, crossing.y)) {
      this.events.emit({
        kind: 'refused',
        at: this.time,
        by: personId,
        subject: crossingId,
        detail: { why: 'not at the crossing' },
      });
      return false;
    }
    crossing.flaggedBy = personId;
    this.events.emit({
      kind: 'crossing-protected',
      at: this.time,
      by: personId,
      subject: crossingId,
      detail: { protection: crossing.protection, outOfOrder: crossing.outOfOrder },
    });
    return true;
  }

  /** Stand down, and let the road go. */
  releaseCrossing(crossingId: string, personId?: string): boolean {
    const crossing = this.crossings.find((c) => c.id === crossingId);
    if (!crossing || !crossing.flaggedBy) return false;
    const by = personId ?? crossing.flaggedBy;
    crossing.flaggedBy = null;
    this.events.emit({ kind: 'crossing-released', at: this.time, by, subject: crossingId });
    return true;
  }

  /** Log what the alerter and the PCS did to a train by themselves. */
  private recordCab(
    train: Train,
    before: { alerter: AlerterState; pcs: boolean },
    dt: number,
  ): void {
    const at = this.time + dt;
    if (before.alerter !== 'asking' && train.alerter.state === 'asking') {
      this.events.emit({ kind: 'alerter-warning', at, subject: train.id });
    }
    if (before.alerter !== 'penalty' && train.alerter.state === 'penalty') {
      this.events.emit({
        kind: 'penalty-brake',
        at,
        subject: train.id,
        detail: { speed: Math.round(Math.abs(train.speed) * 10) / 10 },
      });
    }
    if (!before.pcs && train.pcs.open) {
      this.events.emit({ kind: 'pcs-open', at, subject: train.id, detail: { why: train.pcs.reason } });
    }
    if (before.pcs && !train.pcs.open) {
      this.events.emit({ kind: 'pcs-reset', at, subject: train.id });
    }
  }

  /**
   * Sound a horn signal, and record which one.
   *
   * Refused with nobody in the seat, and refused while a sounding is already
   * running — a Rule 14 pattern interrupted halfway through is a different
   * signal, and usually a wrong one. Returns the signal that started.
   */
  sound(train: Train, id: string, by?: string): HornSignal | null {
    const occupant = this.cabOccupant(train.id);
    if (!occupant) return null;
    const signal = soundHorn(train.lights, id);
    if (!signal) return null;
    this.events.emit({
      kind: 'horn',
      at: this.time,
      by: by ?? occupant.id,
      subject: train.id,
      detail: { signal: signal.id, pattern: signal.pattern.join(' '), name: signal.name },
    });
    return signal;
  }

  /** The bell on or off. Recorded because 17 and the crossing rules ask. */
  setBell(train: Train, on: boolean, by?: string): boolean {
    const occupant = this.cabOccupant(train.id);
    if (!occupant || train.lights.bell === on) return false;
    train.lights.bell = on;
    this.events.emit({
      kind: on ? 'bell-on' : 'bell-off',
      at: this.time,
      by: by ?? occupant.id,
      subject: train.id,
    });
    return true;
  }

  /** A headlight set bright, dim or off, at one end or the other. */
  setHeadlight(train: Train, end: 'front' | 'rear', to: HeadlightSetting, by?: string): boolean {
    const occupant = this.cabOccupant(train.id);
    if (!occupant || train.lights[end] === to) return false;
    train.lights[end] = to;
    this.events.emit({
      kind: 'headlight',
      at: this.time,
      by: by ?? occupant.id,
      subject: train.id,
      detail: { end, to },
    });
    return true;
  }

  /** Ditch lights on or off. */
  setDitchLights(train: Train, on: boolean, by?: string): boolean {
    const occupant = this.cabOccupant(train.id);
    if (!occupant || train.lights.ditch === on) return false;
    train.lights.ditch = on;
    this.events.emit({
      kind: 'ditch-lights',
      at: this.time,
      by: by ?? occupant.id,
      subject: train.id,
      detail: { on },
    });
    return true;
  }

  /**
   * Answer the alerter, on behalf of whoever is in the seat.
   *
   * Refused if nobody is — an alerter that resets itself with an empty cab is
   * the one failure the device exists to prevent.
   */
  acknowledge(train: Train, by?: string): boolean {
    const occupant = this.cabOccupant(train.id);
    if (!occupant) return false;
    train.acknowledge();
    this.events.emit({
      kind: 'acknowledged',
      at: this.time,
      by: by ?? occupant.id,
      subject: train.id,
    });
    return true;
  }

  /** Every car's position on its track, with a speed, as the crossings see it. */
  private crossingOccupants(): { trackId: string; at: number; speed: number }[] {
    const out: { trackId: string; at: number; speed: number }[] = [];
    for (const train of this.trains) {
      const route = train.route;
      if (!route) continue;
      const speed = Math.abs(train.speed);
      for (const car of train.cars) {
        const loc = route.locate(car.s);
        out.push({ trackId: loc.track.id, at: loc.at, speed });
      }
    }
    return out;
  }

  /**
   * Where every movement is, in track coordinates.
   *
   * The signals need this and so does anything else asking "is that stretch of
   * railway clear". Derailed cars count: a car on the ground beside the track
   * has not vacated the block, and a signal that cleared behind a wreck would be
   * the worst thing in here.
   */
  occupancy(): { trackId: string; from: number; to: number }[] {
    const out: { trackId: string; from: number; to: number }[] = [];
    for (const train of this.trains) {
      const route = train.route;
      if (!route) continue;
      for (const car of train.cars) {
        const loc = route.locate(car.s);
        const half = car.length / 2;
        out.push({ trackId: loc.track.id, from: loc.at - half, to: loc.at + half });
      }
    }
    return out;
  }

  /**
   * Clear or restore a controlled signal — what an RTC does from a desk.
   *
   * Returns false for a signal that is not controlled: an automatic signal has
   * nobody to clear it, which is the whole distinction.
   */
  clearSignal(id: string, cleared = true): boolean {
    const signal = this.signals.find((s) => s.id === id);
    if (!signal || signal.control !== 'controlled') return false;
    signal.cleared = cleared;
    return true;
  }

  /** The next signal governing a movement, and how far ahead it is. */
  signalAhead(train: Train, within?: number): SignalSighting | null {
    return signalAhead(train, this.signals, within);
  }

  /** Flags a movement is coming up on, nearest first. */
  flagsAhead(train: Train, within?: number): { flag: Flag; distance: number }[] {
    return flagsAhead(train, this.flags, within);
  }

  /**
   * Put auto-normal switches back once the movement that reversed them is clear
   * of the points — which is the entire difference between one of those and a
   * plain hand switch.
   */
  private restoreAutoNormalSwitches(): void {
    for (const node of this.network.nodes.values()) {
      if (!restoresToNormal(node) || node.position === 'normal') continue;
      if (this.occupantOf(node.x, node.y)) continue;
      node.position = 'normal';
      for (const train of this.trains) this.rebuildRoute(train);
    }
  }

  telemetry(train: Train): Telemetry | undefined {
    return train.route ? telemetry(train, train.route) : undefined;
  }

  /** World-space bounding box of the terrain, for framing the camera. */
  bounds(): Bounds {
    return {
      minX: 0,
      minY: 0,
      maxX: this.terrain.width,
      maxY: this.terrain.depth,
      minZ: this.terrain.minHeight,
      maxZ: this.terrain.maxHeight,
    };
  }

  /**
   * Serialise back to a scene spec. With `state: true` the trains carry their
   * current position, speed and controls, so reloading resumes rather than
   * restarts.
   */
  toJSON(opts: { state?: boolean } = {}): SceneSpec {
    const trains: TrainSpec[] = this.trains.map((train) => {
      const base: TrainSpec = {
        id: train.id,
        label: train.label,
        track: train.trackId,
        direction: train.direction,
        throttle: train.throttle,
        dynamic: train.dynamic,
        brake: train.brake,
        // The rest of the stand. Left out, a scene saved with the reverser
        // centred and the independent set came back with the engine live and
        // nothing holding it — the same class of loss that dropped `locked` off
        // a switch, and worth more here.
        independent: train.independent,
        reverser: train.reverser,
        sand: train.sand,
        ...(train.auto.drive
          ? {
              auto: {
                drive: true,
                cruise: train.auto.cruise,
                obeySignals: train.auto.obeySignals,
                sight: train.auto.sight,
                trackSpeedMph: train.auto.trackSpeedMph,
              },
            }
          : {}),
        lights: {
          front: train.lights.front,
          rear: train.lights.rear,
          ditch: train.lights.ditch,
          bell: train.lights.bell,
        },
        ...(train.alerter.enabled ? {} : { alerter: { enabled: false } }),
        // Serialised as type plus load rather than as baked dimensions: the
        // point of the catalogue is that a scene says "a loaded tank car", and
        // a round trip that came back as a pile of numbers would lose that.
        cars: train.cars.map((car) => ({
          id: car.id,
          type: car.type,
          label: car.label,
          load: car.load,
          ...(car.containers.length > 0
            ? {
                containers: car.containers.map((c) => ({
                  length: c.nominal,
                  load: c.load,
                  color: c.color,
                })),
              }
            : {}),
          color: car.color,
        })),
      };
      if (opts.state) {
        base.position = train.headPosition;
        base.speed = train.speed;
      }
      return base;
    });
    return {
      name: this.name,
      description: this.description,
      terrain: this.terrain.toJSON(),
      tracks: this.tracks.map((t) => t.toJSON()),
      nodes: this.network.switches.length > 0 || this.network.nodes.size > 0
        ? [...this.network.nodes.values()].map((n) => ({
            id: n.id,
            kind: n.kind,
            position: n.position,
            label: n.label,
            operation: n.operation,
            handMode: n.handMode,
            // These were being dropped, so a conductor who locked a switch and
            // exported the scene lost the lock. They are the fields the rules
            // layer reads; losing them silently is the worst kind of bug.
            secured: n.secured,
            locked: n.locked,
            target: n.target,
            spiked: n.spiked,
            clearancePoint: n.clearancePoint,
            derailType: n.derailType,
            derailing: n.derailing,
          }))
        : undefined,
      scenery: this.scenerySpec,
      signals: this.signalSpec,
      flags: this.flagSpec,
      embodied: this.embodied,
      // Serialised from live state, not from the spec: a person walks, and a
      // scene saved mid-tour should reload with them where they got to.
      people: this.people.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        ...(p.posture === 'on-ground'
          ? { track: p.trackId, at: p.at, offset: p.offset }
          : p.posture === 'in-cab'
            ? { inCabOf: p.trainId, atControls: p.atControls }
            : { ridingOn: p.trainId, ridingCar: p.carId, ridingSide: p.ridingSide }),
        walkSpeed: p.walkSpeed,
        reach: p.reach,
      })),
      bridges: this.bridges.map((b) => ({
        id: b.id,
        label: b.label,
        track: b.trackId,
        from: b.from,
        to: b.to,
        kind: b.kind,
        width: b.width,
      })),
      crossings: this.crossings.map((c, i) => ({
        id: c.id,
        label: c.label,
        track: c.trackId,
        at: c.at,
        road: c.roadId,
        angle: c.angle,
        width: c.width,
        protection: c.protection,
        warningSeconds: c.warningSeconds,
        outOfOrder: c.outOfOrder,
        ...(this.crossingSpec[i]?.stalled
          ? { stalled: true, stalledType: this.crossingSpec[i]!.stalledType }
          : {}),
      })),
      // Obstructions a crossing generated are left out: the crossing spec above
      // already says a vehicle is stalled there, and serialising both would
      // stand a second car on the rails every time a scene round-tripped.
      obstructions: this.obstructions
        .filter((o) => !this.crossings.some((c) => c.stalledId === o.id))
        .map((o) => ({
          id: o.id,
          label: o.label,
          track: o.trackId,
          at: o.at,
          mass: o.mass / 1000,
          length: o.length,
          width: o.width,
          height: o.height,
          color: o.color,
        })),
      trains,
      style: this.style,
      camera: this.camera,
    };
  }
}
