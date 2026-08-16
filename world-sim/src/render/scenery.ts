/**
 * Drawing the landscape's furniture.
 *
 * Everything here is a few flat faces — a cone on a stick is a tree, a box with
 * two sloped quads is a house — and that is not a limitation to apologise for.
 * At the scale an isometric view of a subdivision is drawn, a tree is a dozen
 * pixels; what it needs to do is sit on the ground, cast its shading the same
 * way as the hillside behind it, and be the right size next to a boxcar. Detail
 * beyond that would cost frames and read as noise.
 *
 * Order matters at the end: roads are painted flat on the terrain, so they take
 * a depth bias like the track does, while trees and buildings stand up and sort
 * on their own geometry.
 */
import type { Boat, Building, Lake, River, Road, Scenery, Tree, Vehicle } from '../scenery.ts';
import { paintBox, paintCone, paintFace } from './solid.ts';
import type { Painter, Vec3 } from './painter.ts';

export interface SceneryStyle {
  ambient?: number;
  /** Trunk colour, shared by every tree. */
  trunkColor?: string;
  /** Draw building labels. */
  labels?: boolean;
  /** Sides on a tree crown. Four is a cheap pyramid; eight is round enough. */
  treeSides?: number;
  depthBias?: number;
}

export const DEFAULT_SCENERY_STYLE: Required<SceneryStyle> = {
  ambient: 0.45,
  trunkColor: '#4a3b2e',
  labels: false,
  treeSides: 6,
  depthBias: 0,
};

export function drawScenery(painter: Painter, scenery: Scenery, style: SceneryStyle = {}): void {
  const st = { ...DEFAULT_SCENERY_STYLE, ...style };
  // Water first: everything else stands on the ground or beside it, and a road
  // or a bridge crossing a river must sort in front of the sheet.
  for (const lake of scenery.lakes) drawLake(painter, lake, st);
  for (const river of scenery.rivers) drawRiver(painter, river, st);
  for (const road of scenery.roads) drawRoad(painter, road, st);
  // Everything standing on the ground is culled against the viewport before it
  // is built. Roads do it per segment already; trees, buildings and vehicles did
  // not, and on a subdivision-sized scene that was the whole frame — seven
  // thousand trees at nine faces each, all of them drawn, nearly all of them
  // kilometres away.
  for (const building of scenery.buildings) {
    if (onScreen(painter, building.x, building.y, building.z + building.height, 140)) {
      drawBuilding(painter, building, st);
    }
  }
  for (const tree of scenery.trees) {
    if (onScreen(painter, tree.x, tree.y, tree.z + tree.height * 0.5, 90)) {
      drawTree(painter, tree, st);
    }
  }
  for (const vehicle of scenery.vehicles) {
    if (onScreen(painter, vehicle.x, vehicle.y, vehicle.z, 90)) drawVehicle(painter, vehicle, st);
  }
  for (const boat of scenery.boats) {
    if (onScreen(painter, boat.x, boat.y, boat.z + boat.mast, 110)) drawBoat(painter, boat, st);
  }
}

/**
 * A lake, as a fan of triangles from the centre out to the rim.
 *
 * A fan rather than one polygon because the outline follows the basin and can
 * be markedly concave, and a concave polygon filled as one shape crosses itself.
 */
function drawLake(painter: Painter, lake: Lake, st: Required<SceneryStyle>): void {
  const cam = painter.camera;
  const margin = 200;
  const n = lake.rim.length;
  for (let i = 0; i < n; i++) {
    const a = lake.rim[i]!;
    const b = lake.rim[(i + 1) % n]!;
    // A wedge whose rim has collapsed to the centre is dry land.
    if (Math.hypot(a.x - lake.cx, a.y - lake.cy) < 1 && Math.hypot(b.x - lake.cx, b.y - lake.cy) < 1) {
      continue;
    }
    const mid = cam.project((a.x + b.x + lake.cx) / 3, (a.y + b.y + lake.cy) / 3, lake.level);
    if (mid.sx < -margin || mid.sy < -margin || mid.sx > cam.width + margin || mid.sy > cam.height + margin) {
      continue;
    }
    painter.polygon(
      [
        { x: lake.cx, y: lake.cy, z: lake.level },
        { x: a.x, y: a.y, z: lake.level },
        { x: b.x, y: b.y, z: lake.level },
      ],
      { fill: lake.color, alpha: 0.82, depthBias: st.depthBias + 0.2 },
    );
  }
}

/** A hull and a triangle of sail. */
function drawBoat(painter: Painter, boat: Boat, st: Required<SceneryStyle>): void {
  const opts = { ambient: st.ambient + 0.25, depthBias: st.depthBias + 2 };
  paintBox(painter, boat.x, boat.y, boat.z - 0.3, boat.length, 2.1, 1.1, boat.heading, boat.color, opts);
  // The sail: a tall thin cone reads as a triangle from any angle, and a
  // triangle above a hull is the whole of what makes a sailboat legible.
  paintCone(painter, boat.x, boat.y, boat.z + 0.8, boat.z + boat.mast, 1.9, 3, boat.sailColor, {
    ambient: 0.95,
    depthBias: st.depthBias + 2.2,
  });
}

/**
 * Whether a point is near enough the viewport to bother drawing what stands at
 * it. Generous, because the test is against one point and the thing itself has
 * height and width — a tree whose trunk is just off screen still has a crown on.
 */
function onScreen(painter: Painter, x: number, y: number, z: number, margin: number): boolean {
  const cam = painter.camera;
  const p = cam.project(x, y, z);
  return p.sx >= -margin && p.sy >= -margin && p.sx <= cam.width + margin && p.sy <= cam.height + margin;
}

/**
 * A river: quads between the two banks, at one level.
 *
 * Drawn per reach rather than as one polygon so a long course can be culled
 * piece by piece, and so a bend does not become a bow-tie.
 */
function drawRiver(painter: Painter, river: River, st: Required<SceneryStyle>): void {
  const cam = painter.camera;
  const margin = 160;
  for (let i = 0; i < river.left.length - 1; i++) {
    const a = river.left[i]!;
    const b = river.left[i + 1]!;
    const c = river.right[i + 1]!;
    const d = river.right[i]!;
    // A reach whose banks have collapsed onto the centre line is one where the
    // course runs out of water — the ground there is above the surface — so it
    // is simply not drawn. A river that stopped at a hard edge would be wrong;
    // one painted up a hillside would be worse.
    const wa = Math.hypot(a.x - d.x, a.y - d.y);
    const wb = Math.hypot(b.x - c.x, b.y - c.y);
    if (wa < 0.5 && wb < 0.5) continue;
    // Each reach lies at its own level, so the surface steps gently downstream
    // instead of being one slab that leaves the valley at both ends.
    const za = river.levels[i] ?? river.level;
    const zb = river.levels[i + 1] ?? za;
    const mid = cam.project((a.x + c.x) / 2, (a.y + c.y) / 2, (za + zb) / 2);
    if (mid.sx < -margin || mid.sy < -margin || mid.sx > cam.width + margin || mid.sy > cam.height + margin) {
      continue;
    }
    painter.polygon(
      [
        { x: a.x, y: a.y, z: za },
        { x: b.x, y: b.y, z: zb },
        { x: c.x, y: c.y, z: zb },
        { x: d.x, y: d.y, z: za },
      ],
      { fill: river.color, alpha: 0.82, depthBias: st.depthBias + 0.2 },
    );
  }
}

function drawRoad(painter: Painter, road: Road, st: Required<SceneryStyle>): void {
  const half = road.width / 2;
  const cam = painter.camera;
  const margin = 120;

  for (let i = 0; i < road.samples.length - 1; i++) {
    const a = road.samples[i]!;
    const b = road.samples[i + 1]!;
    const mid = cam.project((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    if (mid.sx < -margin || mid.sy < -margin || mid.sx > cam.width + margin || mid.sy > cam.height + margin) {
      continue;
    }
    const off = (p: typeof a, s: number): Vec3 => ({
      x: p.x + Math.sin(p.heading) * s,
      y: p.y - Math.cos(p.heading) * s,
      z: p.z + 0.08,
    });
    // Lying flat on the ground, so it is never facing away from the camera —
    // culling it by normal would drop it at low camera pitches.
    paintFace(painter, [off(a, half), off(b, half), off(b, -half), off(a, -half)], road.color, {
      ambient: 0.72,
      noCull: true,
      normal: { x: 0, y: 0, z: 1 },
      depthBias: st.depthBias + 0.4,
    });
  }
}

function drawTree(painter: Painter, tree: Tree, st: Required<SceneryStyle>): void {
  const trunkTop = tree.z + tree.height * (tree.species === 'conifer' ? 0.22 : 0.42);
  paintBox(
    painter,
    tree.x,
    tree.y,
    tree.z,
    tree.radius * 0.28,
    tree.radius * 0.28,
    trunkTop - tree.z,
    0,
    st.trunkColor,
    { ambient: st.ambient, depthBias: st.depthBias + 1 },
  );

  const opts = { ambient: st.ambient, depthBias: st.depthBias + 1.2 };
  if (tree.species === 'conifer') {
    // Two overlapping skirts: one cone reads as a paper dart, two as a spruce.
    paintCone(painter, tree.x, tree.y, trunkTop, tree.z + tree.height * 0.72, tree.radius, st.treeSides, tree.color, opts);
    paintCone(
      painter,
      tree.x,
      tree.y,
      trunkTop + tree.height * 0.3,
      tree.z + tree.height,
      tree.radius * 0.68,
      st.treeSides,
      tree.color,
      opts,
    );
  } else {
    // A bipyramid: the crown's widest point sits two-thirds up, and the lower
    // half closes underneath so the tree is solid seen from a low camera.
    const waist = tree.z + tree.height * 0.7;
    paintCone(painter, tree.x, tree.y, waist, trunkTop, tree.radius, st.treeSides, tree.color, opts);
    paintCone(painter, tree.x, tree.y, waist, tree.z + tree.height, tree.radius, st.treeSides, tree.color, opts);
  }
}

function drawBuilding(painter: Painter, b: Building, st: Required<SceneryStyle>): void {
  const opts = { ambient: st.ambient, depthBias: st.depthBias + 1.4 };
  const ch = Math.cos(b.heading);
  const sh = Math.sin(b.heading);
  const at = (a: number, c: number, z: number): Vec3 => ({
    x: b.x + ch * a - sh * c,
    y: b.y + sh * a + ch * c,
    z: b.z + z,
  });

  // Walls. Sunk slightly so a building on a slope does not stand on one corner.
  paintBox(painter, b.x, b.y, b.z - 0.4, b.width, b.depth, b.height + 0.4, b.heading, b.color, opts);

  const hw = b.width / 2;
  const hd = b.depth / 2;
  if (b.roof === 'flat') {
    paintFace(
      painter,
      [at(-hw, -hd, b.height), at(hw, -hd, b.height), at(hw, hd, b.height), at(-hw, hd, b.height)],
      b.roofColor,
      opts,
    );
    return;
  }

  // Gable: a ridge along the building's length, two slopes, two end triangles.
  const ridge = b.height + b.roofHeight;
  const eaveA = at(-hw, -hd, b.height);
  const eaveB = at(hw, -hd, b.height);
  const eaveC = at(hw, hd, b.height);
  const eaveD = at(-hw, hd, b.height);
  const ridgeA = at(-hw, 0, ridge);
  const ridgeB = at(hw, 0, ridge);

  paintFace(painter, [eaveA, eaveB, ridgeB, ridgeA], b.roofColor, opts);
  paintFace(painter, [eaveC, eaveD, ridgeA, ridgeB], b.roofColor, opts);
  paintFace(painter, [eaveB, eaveC, ridgeB], b.color, opts);
  paintFace(painter, [eaveD, eaveA, ridgeA], b.color, opts);

  if (st.labels && b.label) {
    painter.text({ x: b.x, y: b.y, z: b.z + ridge + 2 }, b.label, {
      fill: '#d8dde3',
      font: '10px ui-monospace, monospace',
      depthBias: st.depthBias + 4,
    });
  }
}

function drawVehicle(painter: Painter, v: Vehicle, st: Required<SceneryStyle>): void {
  // A wreck sits lower and duller than a vehicle under its own power, which is
  // the only way a plan view can say "this one is not going anywhere".
  const opts = {
    ambient: v.wrecked ? st.ambient * 0.55 : st.ambient,
    depthBias: st.depthBias + 1.3,
  };
  const bodyHeight = v.type === 'car' ? v.height * 0.55 : v.height * 0.42;
  paintBox(painter, v.x, v.y, v.z + 0.25, v.length, v.width, bodyHeight, v.heading, v.color, opts);

  // A cabin or box on top: a saloon gets a shorter greenhouse set back, a truck
  // gets a body over most of its length.
  const ch = Math.cos(v.heading);
  const sh = Math.sin(v.heading);
  const offset = v.type === 'car' ? -v.length * 0.05 : v.length * 0.12;
  paintBox(
    painter,
    v.x + ch * offset,
    v.y + sh * offset,
    v.z + 0.25 + bodyHeight,
    v.length * (v.type === 'car' ? 0.5 : 0.72),
    v.width * 0.92,
    v.height - bodyHeight - 0.25,
    v.heading,
    v.type === 'car' ? '#2a3138' : v.color,
    opts,
  );

  // A semi is a tractor with a trailer behind it, not one long box.
  if (v.type === 'semi') {
    const back = -v.length * 0.22;
    paintBox(
      painter,
      v.x + ch * back,
      v.y + sh * back,
      v.z + 0.9,
      v.length * 0.62,
      v.width,
      v.height - 1.4,
      v.heading,
      '#c8c8c2',
      opts,
    );
  }

  if (v.wrecked) return;

  // Headlights: two small bright faces on the nose. Like the locomotive's, they
  // light nothing — see `render/lights.ts` for why there is no illumination in
  // this renderer — but a road with lit vehicles on it reads as a road in use.
  const nose = v.length * 0.48;
  const nx = -sh;
  const ny = ch;
  for (const side of [1, -1] as const) {
    paintBox(
      painter,
      v.x + ch * nose + nx * v.width * 0.33 * side,
      v.y + sh * nose + ny * v.width * 0.33 * side,
      v.z + 0.45,
      0.3,
      0.3,
      0.3,
      v.heading,
      '#fff4cf',
      { ambient: 1, depthBias: st.depthBias + 1.6 },
    );
  }
}
