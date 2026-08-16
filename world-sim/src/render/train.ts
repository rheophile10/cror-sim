/**
 * Rolling stock: extruded cross-sections on a local frame.
 *
 * Every car body is a polygon in the (lateral, vertical) plane swept along the
 * car's length — see `equipment.ts` for the sections. One routine draws a tank
 * car, an autorack, a well car and the containers stacked in it, which is the
 * only reason having eight car types costs about as much code as having one.
 *
 * The frame a car is drawn on comes from one of two places. On the rails it is
 * read from the track at the car's distance along it: forward along the tangent
 * *including grade*, right across it, up their cross product. Off the rails it
 * comes from the car's own free body, which has its own yaw, pitch and roll —
 * so the same drawing code shows a car standing on a 2% grade and a car lying on
 * its side at the bottom of an embankment.
 *
 * Hidden faces are culled by testing each outward normal against the camera's
 * view direction, then the survivors go to the painter to be sorted with
 * everything else in the scene.
 */
import type { BodyPart, Section2D } from '../equipment.ts';
import type { Guideway } from '../route.ts';
import type { Car, Train } from '../train.ts';
import { clamp } from '../units.ts';
import { IsoCamera } from './camera.ts';
import { parseHex, shade, toHex } from './color.ts';
import type { Painter, Vec3 } from './painter.ts';

export interface TrainStyle {
  ambient?: number;
  /** Tint of a car that has left the rails. */
  derailColor?: string;
  /** Tint cars by the force in their coupler: red in buff, blue in draft. */
  showCouplerForces?: boolean;
  /** Force at which the coupler tint saturates, newtons. */
  forceScale?: number;
  /** Draw the car id above each car. */
  labels?: boolean;
  /** Depth bias in metres — see `TrackStyle.depthBias`. */
  depthBias?: number;
}

export const DEFAULT_TRAIN_STYLE: Required<TrainStyle> = {
  ambient: 0.5,
  derailColor: '#e2483d',
  showCouplerForces: false,
  forceScale: 400_000,
  labels: false,
  depthBias: 0,
};

/** An orthonormal frame: where the car is and which way it is pointing. */
interface Frame {
  pos: Vec3;
  f: Vec3;
  r: Vec3;
  u: Vec3;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Frame from heading, pitch and roll, with the origin at the railhead. */
function frameFrom(pos: Vec3, heading: number, pitch: number, roll: number): Frame {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  const f: Vec3 = { x: ch * cp, y: sh * cp, z: sp };
  let r: Vec3 = { x: sh, y: -ch, z: 0 };
  let u = cross(r, f);
  if (roll !== 0) {
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const r2: Vec3 = { x: r.x * cr + u.x * sr, y: r.y * cr + u.y * sr, z: r.z * cr + u.z * sr };
    const u2: Vec3 = { x: u.x * cr - r.x * sr, y: u.y * cr - r.y * sr, z: u.z * cr - r.z * sr };
    r = r2;
    u = u2;
  }
  return { pos, f, r, u };
}

/** Where a car should be drawn: on the track, or wherever it ended up. */
function frameForCar(car: Car, path: Guideway): Frame {
  if (car.derailed && car.body) {
    const b = car.body;
    return frameFrom({ x: b.x, y: b.y, z: b.z }, b.yaw, b.pitch, b.roll);
  }
  const pt = path.at(car.s);
  return frameFrom({ x: pt.x, y: pt.y, z: pt.z }, pt.heading, Math.atan(pt.grade), 0);
}

function at(fr: Frame, along: number, lateral: number, up: number): Vec3 {
  return {
    x: fr.pos.x + fr.f.x * along + fr.r.x * lateral + fr.u.x * up,
    y: fr.pos.y + fr.f.y * along + fr.r.y * lateral + fr.u.y * up,
    z: fr.pos.z + fr.f.z * along + fr.r.z * lateral + fr.u.z * up,
  };
}

/**
 * Sweep a cross-section along the car and draw the visible faces.
 *
 * The section is wound counter-clockwise in (lateral, vertical), so the outward
 * normal of the edge from p1 to p2 is (dz, −dy) in section coordinates — which
 * is what lets a non-convex section like a gondola's U get its inside walls
 * shaded as inside walls.
 */
function drawExtrusion(
  painter: Painter,
  fr: Frame,
  section: readonly Section2D[],
  from: number,
  to: number,
  color: string,
  ambient: number,
  depthBias: number,
): void {
  const n = section.length;
  if (n < 3) return;
  const view = painter.camera.viewDirection();
  const light = IsoCamera.LIGHT;
  const rgb = parseHex(color);

  const paint = (pts: Vec3[], normal: Vec3) => {
    if (normal.x * view.x + normal.y * view.y + normal.z * view.z >= 0) return;
    const lambert = normal.x * light.x + normal.y * light.y + normal.z * light.z;
    const level = ambient + (1 - ambient) * clamp(lambert, 0, 1);
    painter.polygon(pts, { fill: toHex(shade(rgb, level)), depthBias });
  };

  // End caps.
  const cap = (along: number, normal: Vec3) =>
    paint(
      section.map((p) => at(fr, along, p.y, p.z)),
      normal,
    );
  cap(to, fr.f);
  cap(from, { x: -fr.f.x, y: -fr.f.y, z: -fr.f.z });

  // Sides.
  for (let i = 0; i < n; i++) {
    const p1 = section[i]!;
    const p2 = section[(i + 1) % n]!;
    const dy = p2.y - p1.y;
    const dz = p2.z - p1.z;
    const len = Math.hypot(dy, dz);
    if (len < 1e-9) continue;
    const ny = dz / len;
    const nz = -dy / len;
    const normal: Vec3 = {
      x: fr.r.x * ny + fr.u.x * nz,
      y: fr.r.y * ny + fr.u.y * nz,
      z: fr.r.z * ny + fr.u.z * nz,
    };
    paint(
      [
        at(fr, from, p1.y, p1.z),
        at(fr, to, p1.y, p1.z),
        at(fr, to, p2.y, p2.z),
        at(fr, from, p2.y, p2.z),
      ],
      normal,
    );
  }
}

function carColor(car: Car, part: BodyPart, st: Required<TrainStyle>): string {
  if (car.derailed) {
    // Tinted toward the derail colour rather than replaced by it. Painting a
    // wreck flat red loses exactly the information the wreck is about — which
    // cars went over, and whether any of them were the tank cars.
    if (part.color !== car.color) return part.color;
    const base = parseHex(part.color);
    const flag = parseHex(st.derailColor);
    return toHex({
      r: base.r + (flag.r - base.r) * 0.45,
      g: base.g + (flag.g - base.g) * 0.45,
      b: base.b + (flag.b - base.b) * 0.45,
    });
  }
  if (!st.showCouplerForces || part.color !== car.color) return part.color;
  const t = clamp(car.couplerAhead / st.forceScale, -1, 1);
  const base = parseHex(part.color);
  const target = t >= 0 ? parseHex('#4d8fe0') : parseHex('#e05a4d');
  const a = Math.abs(t);
  return toHex({
    r: base.r + (target.r - base.r) * a,
    g: base.g + (target.g - base.g) * a,
    b: base.b + (target.b - base.b) * a,
  });
}

export function drawCar(
  painter: Painter,
  car: Car,
  path: Guideway,
  style: TrainStyle = {},
): void {
  const st = { ...DEFAULT_TRAIN_STYLE, ...style };
  const fr = frameForCar(car, path);
  for (const part of car.parts) {
    const half = (car.length * part.span) / 2;
    drawExtrusion(
      painter,
      fr,
      part.section,
      part.offset - half,
      part.offset + half,
      carColor(car, part, st),
      st.ambient,
      st.depthBias + 1.2 + (part.bias ?? 0),
    );
  }
  if (st.labels) {
    painter.text(at(fr, 0, 0, car.height + 1.6), car.id, {
      fill: '#e8e8e8',
      font: '10px ui-monospace, monospace',
      depthBias: st.depthBias + 4,
    });
  }
}

export function drawTrain(
  painter: Painter,
  train: Train,
  path: Guideway,
  style: TrainStyle = {},
): void {
  for (const car of train.cars) drawCar(painter, car, path, style);
}
