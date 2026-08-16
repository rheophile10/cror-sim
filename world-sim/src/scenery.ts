/**
 * Everything in the landscape that is not railway: trees, buildings, roads and
 * the traffic on them.
 *
 * None of it interacts with a train. That is a deliberate line — scenery exists
 * to give the eye a sense of scale and place, and the moment a tree can be hit
 * it needs mass, collision geometry and a wreck state, which is a different
 * feature. The one thing scenery *does* know about the railway is where it is,
 * because a forest that grows over the main track looks worse than no forest.
 *
 * Authored sparsely, like the terrain: a `forest` is a rectangle, a count and a
 * seed rather than two hundred hand-placed trees, and it expands deterministically
 * so a scene renders the same way twice.
 *
 * Coordinates follow the rest of a scene: **cell coordinates** in the JSON,
 * metres everywhere inside.
 */
import type { Terrain } from './terrain.ts';
import type { TrackPath } from './track.ts';
import { trafficStops, type Crossing } from './crossing.ts';
import { clamp } from './units.ts';

export type TreeSpecies = 'conifer' | 'broadleaf' | 'mixed';

export interface TreeSpec {
  kind: 'tree';
  /** Position in cell coordinates. */
  at: [number, number];
  /** Overall height, metres. */
  height?: number;
  species?: TreeSpecies;
  color?: string;
}

export interface ForestSpec {
  kind: 'forest';
  /** Opposite corners of the planting area, in cell coordinates. */
  from: [number, number];
  to: [number, number];
  count?: number;
  seed?: number;
  species?: TreeSpecies;
  minHeight?: number;
  maxHeight?: number;
  /** Keep this far clear of any track, metres. */
  clearance?: number;
  /** Do not plant above this elevation — a crude treeline. */
  maxElevation?: number;
}

export interface BuildingSpec {
  kind: 'building';
  at: [number, number];
  /** Footprint in metres: `width` along its heading, `depth` across. */
  width?: number;
  depth?: number;
  /** Height to the eaves, metres. */
  height?: number;
  /** Heading in degrees. */
  rotation?: number;
  roof?: 'gable' | 'flat';
  /** Ridge height above the eaves, metres. */
  roofHeight?: number;
  color?: string;
  roofColor?: string;
  label?: string;
}

export interface RoadSpec {
  kind: 'road';
  id?: string;
  /** Centre line in cell coordinates. */
  points: [number, number][];
  /** Metres. */
  width?: number;
  color?: string;
}

/**
 * A river, creek or pond: a flat sheet of water at one elevation.
 *
 * Not a road with a blue colour, and the difference is the whole point. A road
 * follows the ground; water is **level**, and a surface that undulated with the
 * terrain under it would read as a painted stripe rather than as water. The
 * scene carves the channel with terrain features and puts the surface here; the
 * two agree because the author makes them agree, which is the same bargain the
 * rest of the sparse terrain description makes.
 */
export interface RiverSpec {
  kind: 'river';
  id?: string;
  /** Centre line in cell coordinates. */
  points: [number, number][];
  /** Metres. May vary along the course by giving one width per point. */
  width?: number | number[];
  /**
   * Surface elevation, metres — one figure, or one per point.
   *
   * A river *flows*, and a single flat level cannot fill a valley whose floor
   * changes elevation along it: the water is either up on the banks at one end
   * or gone at the other. Giving a level per point is the smallest honest fix,
   * and it is what turns a stretch of water into a watercourse.
   */
  level: number | number[];
  color?: string;
}

/**
 * A lake: a body of standing water at one level.
 *
 * The same idea as a river and the same honesty about it — the surface is flat
 * and the *shore* is wherever the ground rises to meet it, found by sampling
 * rather than stated. A scene gives a centre, a nominal size and a level; the
 * terrain decides the outline, which means a lake automatically fits whatever
 * basin was carved for it and never runs up a hillside.
 */
export interface LakeSpec {
  kind: 'lake';
  id?: string;
  /** Centre, in cell coordinates. */
  at: [number, number];
  /** Nominal radii in cells; the shore is found inside these. */
  radiusX: number;
  radiusY?: number;
  /** Surface elevation, metres. */
  level: number;
  /** Points around the rim. More is rounder. */
  points?: number;
  color?: string;
}

/**
 * A sailboat. Drifts a circuit of its lake and turns to face where it is going.
 *
 * There is no sailing here — no wind, no tacking, nothing to get wrong. It is a
 * hull and a sail that move, because a lake with nothing on it reads as a
 * puddle and a lake with a boat on it reads as a lake.
 */
export interface BoatSpec {
  kind: 'boat';
  /** Which lake, by id. */
  lake?: string;
  /** Where round its circuit it starts, 0 to 1. */
  along?: number;
  /** Circuits per hour. Negative goes the other way. */
  speed?: number;
  /** How far in from the shore it sails, 0 (centre) to 1 (shore). */
  reach?: number;
  color?: string;
  sailColor?: string;
}

export interface VehicleSpec {
  kind: 'vehicle';
  /** Standing still somewhere: position in cell coordinates. */
  at?: [number, number];
  rotation?: number;
  /** Or travelling: which road, how far along it in metres, and how fast. */
  road?: string;
  along?: number;
  /** Speed in m/s; negative runs the other way. Zero parks it. */
  speed?: number;
  type?: 'car' | 'truck' | 'bus' | 'semi';
  color?: string;
}

export type ScenerySpec =
  | TreeSpec
  | ForestSpec
  | BuildingSpec
  | RoadSpec
  | RiverSpec
  | LakeSpec
  | BoatSpec
  | VehicleSpec;

/** A lake, ready to draw: a rim of points at one level. */
export interface Lake {
  id: string;
  /** The shore, going round. */
  rim: { x: number; y: number }[];
  cx: number;
  cy: number;
  level: number;
  color: string;
}

export interface Boat {
  x: number;
  y: number;
  z: number;
  heading: number;
  length: number;
  /** Height of the mast above the water. */
  mast: number;
  color: string;
  sailColor: string;
  lake: Lake | undefined;
  /** Position round its circuit, 0 to 1. */
  along: number;
  speed: number;
  reach: number;
}

/** A reach of water, ready to draw: a level ribbon. */
export interface River {
  id: string;
  /** Left and right bank, paired, in world coordinates at the surface level. */
  left: { x: number; y: number }[];
  right: { x: number; y: number }[];
  /** Surface elevation at each point along the course. */
  levels: number[];
  /** The lowest of them, which is what a single figure used to mean. */
  level: number;
  color: string;
}

export interface Tree {
  x: number;
  y: number;
  z: number;
  height: number;
  radius: number;
  species: 'conifer' | 'broadleaf';
  color: string;
}

export interface Building {
  x: number;
  y: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  heading: number;
  roof: 'gable' | 'flat';
  roofHeight: number;
  color: string;
  roofColor: string;
  label: string | undefined;
}

export interface RoadPoint {
  x: number;
  y: number;
  z: number;
  heading: number;
}

export interface Road {
  id: string;
  samples: RoadPoint[];
  length: number;
  width: number;
  color: string;
  /**
   * Where this road meets another, and how far along each.
   *
   * Found once, when the scenery is built. Without them every vehicle is stuck
   * on the road it was put on for ever, which reads as a set of independent
   * conveyor belts rather than a road network.
   */
  junctions: { at: number; road: string; theirAt: number }[];
}

export interface Vehicle {
  x: number;
  y: number;
  z: number;
  heading: number;
  length: number;
  width: number;
  height: number;
  color: string;
  type: 'car' | 'truck' | 'bus' | 'semi';
  /** Set when the vehicle is driving a road rather than parked. */
  road?: Road;
  along: number;
  /** Speed right now, m/s. Zero while held at a crossing. */
  speed: number;
  /**
   * The speed it wants to be doing, m/s, signed for direction.
   *
   * Kept apart from `speed` so a vehicle stopped at a crossing knows what to go
   * back to, and so "parked" (`cruise === 0`) stays distinguishable from
   * "waiting", which looks identical in a single frame and is not the same
   * thing at all.
   */
  cruise: number;
  /**
   * Written off where it stands.
   *
   * A vehicle that has hit something big enough stops permanently and becomes
   * part of the landscape, which is what one does. Kept as state rather than by
   * deleting the vehicle, because the wreck is the interesting thing.
   */
  wrecked: boolean;
}

export interface Scenery {
  trees: Tree[];
  buildings: Building[];
  roads: Road[];
  rivers: River[];
  lakes: Lake[];
  boats: Boat[];
  vehicles: Vehicle[];
}

const TREE_COLORS = {
  conifer: ['#2f4b33', '#35563a', '#294229'],
  broadleaf: ['#3f6b3a', '#4b7a3f', '#547f46'],
};

const VEHICLE_SIZES = {
  car: { length: 4.4, width: 1.9, height: 1.5 },
  truck: { length: 9.5, width: 2.6, height: 3.4 },
  bus: { length: 12, width: 2.6, height: 3.2 },
  // Tractor and trailer as one body. Long enough that a driver who stops on a
  // crossing has a real problem, which is the reason it is worth having.
  semi: { length: 21, width: 2.6, height: 4.1 },
};

const VEHICLE_COLORS = ['#c0392b', '#2d6ca2', '#c8c8c8', '#2f6b46', '#d8a13a', '#4a4a4a'];

/** Mulberry32: small, fast, and identical everywhere, which is the point. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How close a point is to any railway, in metres.
 *
 * Samples are checked at a stride rather than exhaustively: a track sample every
 * few metres is far finer than the clearance being tested, and stepping over
 * most of them turns planting a forest from noticeable to instant.
 */
function distanceToTrack(x: number, y: number, tracks: readonly TrackPath[], limit: number): number {
  let best = Infinity;
  for (const track of tracks) {
    const stride = Math.max(1, Math.floor(limit / Math.max(1, track.spacing)));
    for (let i = 0; i < track.samples.length; i += stride) {
      const s = track.samples[i]!;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < best) best = d;
      if (best < limit * 0.25) return best;
    }
  }
  return best;
}

function makeTree(
  x: number,
  y: number,
  z: number,
  height: number,
  species: TreeSpecies,
  pick: () => number,
  color?: string,
): Tree {
  const kind: 'conifer' | 'broadleaf' =
    species === 'mixed' ? (pick() < 0.6 ? 'conifer' : 'broadleaf') : species;
  const palette = TREE_COLORS[kind];
  return {
    x,
    y,
    z,
    height,
    radius: height * (kind === 'conifer' ? 0.22 : 0.34),
    species: kind,
    color: color ?? palette[Math.floor(pick() * palette.length) % palette.length]!,
  };
}

export function buildScenery(
  specs: readonly ScenerySpec[],
  terrain: Terrain,
  tracks: readonly TrackPath[] = [],
): Scenery {
  const cs = terrain.cellSize;
  const out: Scenery = {
    trees: [],
    buildings: [],
    roads: [],
    rivers: [],
    lakes: [],
    boats: [],
    vehicles: [],
  };
  const lakesById = new Map<string, Lake>();
  const roadsById = new Map<string, Road>();

  for (const spec of specs) {
    switch (spec.kind) {
      case 'tree': {
        const x = spec.at[0] * cs;
        const y = spec.at[1] * cs;
        const pick = rng(Math.floor(x * 31 + y * 17));
        out.trees.push(
          makeTree(x, y, terrain.heightAt(x, y), spec.height ?? 12, spec.species ?? 'mixed', pick, spec.color),
        );
        break;
      }

      case 'forest': {
        const pick = rng(spec.seed ?? 1);
        const x0 = Math.min(spec.from[0], spec.to[0]) * cs;
        const x1 = Math.max(spec.from[0], spec.to[0]) * cs;
        const y0 = Math.min(spec.from[1], spec.to[1]) * cs;
        const y1 = Math.max(spec.from[1], spec.to[1]) * cs;
        const clearance = spec.clearance ?? 14;
        const lo = spec.minHeight ?? 8;
        const hi = spec.maxHeight ?? 18;
        const count = Math.max(0, Math.floor(spec.count ?? 120));
        // Rejected candidates are not retried: a forest asked for 200 trees on a
        // hillside that is half right-of-way should come out thinner, not spend
        // an unbounded number of attempts pretending otherwise.
        for (let i = 0; i < count; i++) {
          const x = x0 + pick() * (x1 - x0);
          const y = y0 + pick() * (y1 - y0);
          const height = lo + pick() * (hi - lo);
          if (!terrain.contains(x, y)) continue;
          const z = terrain.heightAt(x, y);
          if (spec.maxElevation !== undefined && z > spec.maxElevation) continue;
          if (clearance > 0 && distanceToTrack(x, y, tracks, clearance) < clearance) continue;
          out.trees.push(makeTree(x, y, z, height, spec.species ?? 'mixed', pick));
        }
        break;
      }

      case 'building': {
        const x = spec.at[0] * cs;
        const y = spec.at[1] * cs;
        out.buildings.push({
          x,
          y,
          z: terrain.heightAt(x, y),
          width: spec.width ?? 14,
          depth: spec.depth ?? 9,
          height: spec.height ?? 6,
          heading: ((spec.rotation ?? 0) * Math.PI) / 180,
          roof: spec.roof ?? 'gable',
          roofHeight: spec.roofHeight ?? 2.4,
          color: spec.color ?? '#8a7461',
          roofColor: spec.roofColor ?? '#4a4038',
          label: spec.label,
        });
        break;
      }

      case 'road': {
        const road = buildRoad(spec, terrain, out.roads.length);
        out.roads.push(road);
        roadsById.set(road.id, road);
        break;
      }

      case 'lake': {
        const lake = buildLake(spec, terrain, out.lakes.length);
        out.lakes.push(lake);
        lakesById.set(lake.id, lake);
        break;
      }

      case 'boat': {
        const lake = spec.lake ? lakesById.get(spec.lake) : out.lakes[0];
        out.boats.push({
          x: 0,
          y: 0,
          z: lake?.level ?? 0,
          heading: 0,
          length: 7.5,
          mast: 8.5,
          color: spec.color ?? '#e8e4da',
          sailColor: spec.sailColor ?? '#f2f0e8',
          lake,
          along: spec.along ?? 0,
          speed: spec.speed ?? 0.35,
          reach: clamp(spec.reach ?? 0.62, 0, 1),
        });
        placeOnLake(out.boats[out.boats.length - 1]!);
        break;
      }

      case 'river': {
        out.rivers.push(buildRiver(spec, terrain, out.rivers.length));
        break;
      }

      case 'vehicle': {
        const size = VEHICLE_SIZES[spec.type ?? 'car'];
        const pick = rng(out.vehicles.length * 7919 + 13);
        const road = spec.road ? roadsById.get(spec.road) : undefined;
        const along = spec.along ?? 0;
        const base: Vehicle = {
          x: 0,
          y: 0,
          z: 0,
          heading: ((spec.rotation ?? 0) * Math.PI) / 180,
          ...size,
          color: spec.color ?? VEHICLE_COLORS[Math.floor(pick() * VEHICLE_COLORS.length)]!,
          type: spec.type ?? 'car',
          road,
          along,
          speed: spec.speed ?? 0,
          cruise: spec.speed ?? 0,
          wrecked: false,
        };
        if (road) {
          placeOnRoad(base, road);
        } else if (spec.at) {
          base.x = spec.at[0] * cs;
          base.y = spec.at[1] * cs;
          base.z = terrain.heightAt(base.x, base.y);
        }
        out.vehicles.push(base);
        break;
      }
    }
  }

  // Where the roads meet each other. Done after every road exists, because a
  // junction is a fact about a pair of them.
  linkRoads(out.roads);

  // Nothing grows in the water. The forests are planted against the *ground*,
  // which knows nothing about the sheets laid over it, so anything that ended
  // up in a lake or a river is taken out afterwards.
  out.trees = out.trees.filter((t) => !inAnyWater(out, t.x, t.y, t.z));

  return out;
}

/** Whether a point is under any water in this scenery. */
function inAnyWater(scenery: Scenery, x: number, y: number, z: number): boolean {
  for (const lake of scenery.lakes) {
    if (z > lake.level) continue;
    const dx = x - lake.cx;
    const dy = y - lake.cy;
    const d = Math.hypot(dx, dy);
    if (d < 1) return true;
    const n = lake.rim.length;
    const a = (((Math.atan2(dy, dx) / (Math.PI * 2)) % 1) + 1) % 1;
    const i = Math.floor(a * n) % n;
    const r = Math.hypot(lake.rim[i]!.x - lake.cx, lake.rim[i]!.y - lake.cy);
    if (d <= r) return true;
  }
  for (const river of scenery.rivers) {
    for (let i = 0; i < river.left.length; i++) {
      const l = river.left[i]!;
      const r = river.right[i]!;
      const half = Math.hypot(l.x - r.x, l.y - r.y) / 2;
      if (half < 1) continue;
      const mx = (l.x + r.x) / 2;
      const my = (l.y + r.y) / 2;
      if (Math.hypot(x - mx, y - my) <= half && z <= (river.levels[i] ?? river.level)) return true;
    }
  }
  return false;
}

function buildRoad(spec: RoadSpec, terrain: Terrain, index: number): Road {
  const cs = terrain.cellSize;
  const pts = spec.points.map(([c, r]) => ({ x: c * cs, y: r * cs }));
  const samples: RoadPoint[] = [];
  const step = 5;

  // A road is draped, not graded: it follows the ground, because a road that
  // needed earthworks would be a railway.
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.round(span / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      samples.push({ x, y, z: terrain.heightAt(x, y), heading: Math.atan2(b.y - a.y, b.x - a.x) });
    }
  }
  const last = pts[pts.length - 1]!;
  const prev = pts[pts.length - 2] ?? last;
  samples.push({
    x: last.x,
    y: last.y,
    z: terrain.heightAt(last.x, last.y),
    heading: Math.atan2(last.y - prev.y, last.x - prev.x),
  });

  let length = 0;
  for (let i = 1; i < samples.length; i++) {
    length += Math.hypot(samples[i]!.x - samples[i - 1]!.x, samples[i]!.y - samples[i - 1]!.y);
  }

  return {
    id: spec.id ?? `road-${index}`,
    samples,
    length,
    width: spec.width ?? 7,
    color: spec.color ?? '#3b3e44',
    junctions: [],
  };
}

/** Put a vehicle where its road says, at its distance along it. */
function placeOnRoad(vehicle: Vehicle, road: Road): void {
  const n = road.samples.length;
  if (n === 0) return;
  const spacing = road.length / Math.max(1, n - 1);
  // Clamped, not wrapped: `along` running past the end means the vehicle has
  // left, and `World` recycles it. Wrapping put it back on at the other edge,
  // which on a road that reaches the map boundary is a visible teleport.
  const wrapped = clamp(vehicle.along, 0, road.length);
  const i = clamp(Math.floor(wrapped / spacing), 0, n - 1);
  const pt = road.samples[i]!;
  const next = road.samples[Math.min(i + 1, n - 1)]!;
  const t = clamp((wrapped - i * spacing) / spacing, 0, 1);
  // Half a lane to the right of the centre line, as traffic keeps right.
  const lane = road.width * 0.25 * Math.sign(vehicle.speed || 1);
  const x = pt.x + (next.x - pt.x) * t;
  const y = pt.y + (next.y - pt.y) * t;
  vehicle.heading = pt.heading + (vehicle.speed < 0 ? Math.PI : 0);
  vehicle.x = x + Math.sin(pt.heading) * lane;
  vehicle.y = y - Math.cos(pt.heading) * lane;
  vehicle.z = pt.z + (next.z - pt.z) * t;
}

/**
 * Advance the traffic.
 *
 * Vehicles drive their road and wrap round at the end. They do not steer, brake,
 * queue, or notice level crossings, and they cannot be hit — see the note at the
 * top of this file about where the line is drawn.
 */
export function stepScenery(scenery: Scenery, dt: number, crossings: readonly Crossing[] = []): void {
  for (const boat of scenery.boats) {
    if (boat.speed === 0) continue;
    boat.along += (boat.speed / 3600) * dt;
    placeOnLake(boat);
  }
  for (const vehicle of scenery.vehicles) {
    if (vehicle.wrecked) {
      vehicle.speed = 0;
      continue;
    }
    if (!vehicle.road || vehicle.cruise === 0) continue;
    const held = holdingPoint(vehicle, crossings);
    if (held !== null) {
      // Brake to the stop line and hold there. Traffic that vanished or drove
      // through would make a crossing decorative; the whole point of one is
      // that a road stops.
      const room = (held - vehicle.along) * Math.sign(vehicle.cruise);
      const target = room <= 0 ? 0 : Math.min(Math.abs(vehicle.cruise), room * 0.5);
      vehicle.speed = target * Math.sign(vehicle.cruise);
    } else {
      // Away again, over a couple of seconds. A queue that leaps back to speed
      // reads as a glitch.
      vehicle.speed += (vehicle.cruise - vehicle.speed) * clamp(dt / 2.5, 0, 1);
    }
    const before = vehicle.along;
    vehicle.along += vehicle.speed * dt;
    turnAtJunction(vehicle, before, scenery.roads);
    placeOnRoad(vehicle, vehicle.road!);
  }
}

/**
 * Take a turn, sometimes, where two roads cross.
 *
 * A vehicle that never leaves the road it was put on turns a road network into
 * a set of independent conveyor belts. Whether it turns is decided from its own
 * position rather than from a random number, so a scene runs the same way
 * twice — the same reason everything else here is seeded.
 */
function turnAtJunction(vehicle: Vehicle, before: number, roads: readonly Road[]): void {
  const road = vehicle.road;
  if (!road || road.junctions.length === 0) return;
  const lo = Math.min(before, vehicle.along);
  const hi = Math.max(before, vehicle.along);
  for (const j of road.junctions) {
    if (j.at < lo || j.at > hi) continue;
    // About one in three, from a hash of where and which vehicle.
    const roll = Math.abs(Math.sin((j.at + vehicle.x * 0.37 + vehicle.y * 0.11) * 12.9898) * 43758.5453) % 1;
    if (roll > 0.34) continue;
    const onto = roads.find((r) => r.id === j.road);
    if (!onto) continue;
    vehicle.road = onto;
    vehicle.along = j.theirAt;
    // Which way along the new road: keep whichever direction is closer to the
    // way it was already going, so a turn is a turn and not a reversal.
    const dir = roll < 0.17 ? 1 : -1;
    vehicle.cruise = Math.abs(vehicle.cruise) * dir;
    vehicle.speed = Math.abs(vehicle.speed) * dir;
    return;
  }
}

/**
 * Where this vehicle has to stop, as a distance along its road — or null if
 * nothing is holding it.
 *
 * Only crossings ahead of it on its own road count, and only within a stopping
 * distance: a car half a kilometre away has not started braking yet.
 */
function holdingPoint(vehicle: Vehicle, crossings: readonly Crossing[]): number | null {
  const road = vehicle.road;
  if (!road || road.length <= 0) return null;
  const dir = Math.sign(vehicle.cruise) || 1;
  // `along` grows without bound as a vehicle laps the road, while `roadAt` is a
  // position within one lap. Comparing them directly works exactly once and
  // then never again — the crossing appears to be permanently behind you — so
  // the gap is measured within the lap and then put back into `along`'s frame.
  const lap = ((vehicle.along % road.length) + road.length) % road.length;
  let best: number | null = null;
  for (const crossing of crossings) {
    if (crossing.roadId !== road.id || !trafficStops(crossing)) continue;
    const stop = ((crossing.roadAt - dir * STOP_LINE) % road.length + road.length) % road.length;
    const ahead = dir > 0
      ? ((stop - lap) % road.length + road.length) % road.length
      : ((lap - stop) % road.length + road.length) % road.length;
    // Only a crossing close enough to have started braking for. Half a lap away
    // is not "ahead" in any useful sense.
    if (ahead > 150) continue;
    if (best === null || ahead < best) best = ahead;
  }
  return best === null ? null : vehicle.along + dir * best;
}

/** How far short of the rails a driver stops, metres. */
const STOP_LINE = 11;

/**
 * A reach of water as two banks at one level.
 *
 * The banks are offset from the centre line by the local normal, so the sheet
 * follows the course round a bend without the outside bank cutting the corner.
 */
/** Walk out from the centre line to where the ground meets the water. */
function bank(
  terrain: Terrain,
  p: { x: number; y: number },
  nx: number,
  ny: number,
  maxHalf: number,
  level: number,
): { x: number; y: number } {
  const step = Math.max(1, maxHalf / 16);
  let out = 0;
  for (let d = step; d <= maxHalf; d += step) {
    if (terrain.heightAt(p.x + nx * d, p.y + ny * d) > level) break;
    out = d;
  }
  return { x: p.x + nx * out, y: p.y + ny * out };
}

function buildRiver(spec: RiverSpec, terrain: Terrain, index: number): River {
  const cs = terrain.cellSize;
  const pts = spec.points.map(([cx, cy]) => ({ x: cx * cs, y: cy * cs }));
  const left: { x: number; y: number }[] = [];
  const right: { x: number; y: number }[] = [];
  const levels: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const w = Array.isArray(spec.width)
      ? (spec.width[Math.min(i, spec.width.length - 1)] ?? 30)
      : (spec.width ?? 30);
    const p = pts[i]!;
    // Each bank is walked outward until the ground rises above the surface, and
    // no further than the nominal width. Without this the sheet is a flat slab
    // laid over the landscape and a river runs visibly up a hillside — the
    // surface is level, but where it *ends* is decided by the ground, not by a
    // number in the scene.
    const level = levelAt(spec.level, i, pts.length);
    levels.push(level);
    left.push(bank(terrain, p, nx, ny, w / 2, level));
    right.push(bank(terrain, p, -nx, -ny, w / 2, level));
  }
  return {
    id: spec.id ?? `river-${index}`,
    left,
    right,
    levels,
    level: Math.min(...levels),
    color: spec.color ?? '#2f5f7a',
  };
}

/** One surface elevation, or the one that belongs to this point along the course. */
function levelAt(level: number | number[], i: number, n: number): number {
  if (!Array.isArray(level)) return level;
  if (level.length === 0) return 0;
  // Stretched across the course, so a scene can give four figures for a river
  // sampled at fifteen points and get a smooth fall between them.
  const t = (i / Math.max(1, n - 1)) * (level.length - 1);
  const a = Math.floor(t);
  const b = Math.min(level.length - 1, a + 1);
  return level[a]! + (level[b]! - level[a]!) * (t - a);
}

/**
 * A lake's shore.
 *
 * Rays are cast out from the centre and each one stops where the ground rises
 * to the surface — so the outline is the basin's, not an ellipse drawn over it.
 * A ray that finds dry land immediately gives a rim point at the centre, which
 * collapses that wedge to nothing; a lake sited on a hilltop is simply not there.
 */
function buildLake(spec: LakeSpec, terrain: Terrain, index: number): Lake {
  const cs = terrain.cellSize;
  const cx = spec.at[0] * cs;
  const cy = spec.at[1] * cs;
  const rx = spec.radiusX * cs;
  const ry = (spec.radiusY ?? spec.radiusX) * cs;
  const n = Math.max(8, spec.points ?? 28);
  const rim: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const max = Math.hypot(dx * rx, dy * ry);
    const step = Math.max(1, max / 24);
    let out = 0;
    for (let d = step; d <= max; d += step) {
      if (terrain.heightAt(cx + dx * d, cy + dy * d) > spec.level) break;
      out = d;
    }
    rim.push({ x: cx + dx * out, y: cy + dy * out });
  }
  return {
    id: spec.id ?? `lake-${index}`,
    rim,
    cx,
    cy,
    level: spec.level,
    color: spec.color ?? '#2c5a75',
  };
}

/** Put a boat where its circuit says it is. */
function placeOnLake(boat: Boat): void {
  const lake = boat.lake;
  if (!lake || lake.rim.length < 3) return;
  const n = lake.rim.length;
  const wrapped = ((boat.along % 1) + 1) % 1;
  const i = Math.floor(wrapped * n) % n;
  const t = wrapped * n - Math.floor(wrapped * n);
  const a = lake.rim[i]!;
  const b = lake.rim[(i + 1) % n]!;
  // Along the rim, then pulled in toward the middle so it is on the water
  // rather than aground on the shore.
  const ex = a.x + (b.x - a.x) * t;
  const ey = a.y + (b.y - a.y) * t;
  const x = lake.cx + (ex - lake.cx) * boat.reach;
  const y = lake.cy + (ey - lake.cy) * boat.reach;
  boat.heading = Math.atan2(y - boat.y, x - boat.x);
  boat.x = x;
  boat.y = y;
  boat.z = lake.level;
}

/** Find every place two roads cross, and record it on both of them. */
function linkRoads(roads: Road[]): void {
  for (const road of roads) road.junctions = [];
  for (let a = 0; a < roads.length; a++) {
    for (let b = a + 1; b < roads.length; b++) {
      const ra = roads[a]!;
      const rb = roads[b]!;
      const sa = ra.length / Math.max(1, ra.samples.length - 1);
      const sb = rb.length / Math.max(1, rb.samples.length - 1);
      for (let i = 0; i < ra.samples.length - 1; i++) {
        for (let j = 0; j < rb.samples.length - 1; j++) {
          const hit = segmentsMeet(ra.samples[i]!, ra.samples[i + 1]!, rb.samples[j]!, rb.samples[j + 1]!);
          if (!hit) continue;
          const atA = (i + hit.t) * sa;
          const atB = (j + hit.u) * sb;
          // One junction per pair per place: a wandering pair can clip twice
          // within a few metres and that is one intersection.
          if (ra.junctions.some((x) => x.road === rb.id && Math.abs(x.at - atA) < 60)) continue;
          ra.junctions.push({ at: atA, road: rb.id, theirAt: atB });
          rb.junctions.push({ at: atB, road: ra.id, theirAt: atA });
        }
      }
    }
  }
}

function segmentsMeet(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number },
): { t: number; u: number } | null {
  const d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d;
  const u = ((b1.x - a1.x) * (a2.y - a1.y) - (b1.y - a1.y) * (a2.x - a1.x)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}
