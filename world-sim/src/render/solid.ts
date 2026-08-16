/**
 * Lit, back-face-culled polygons.
 *
 * Three renderers now build solids out of flat faces — rolling stock, the fixed
 * plant, and the scenery — and each of them wants the same three things done to
 * a face: work out which way it points, drop it if that is away from the camera,
 * and shade it against the sun. Doing it in one place keeps the lighting
 * consistent, which matters more than it sounds: a tree lit on a different side
 * from the hill it stands on looks pasted on.
 *
 * Faces must be wound counter-clockwise seen from outside. Get one backwards and
 * it is culled exactly when it should be drawn, so the solid appears hollow.
 */
import { clamp } from '../units.ts';
import { IsoCamera } from './camera.ts';
import { parseHex, shade, toHex } from './color.ts';
import type { Painter, Vec3 } from './painter.ts';

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Outward normal of a counter-clockwise wound face. Not normalised. */
export function faceNormal(pts: readonly Vec3[]): Vec3 {
  const a = pts[0]!;
  const b = pts[1]!;
  const c = pts[2]!;
  return cross(subtract(b, a), subtract(c, a));
}

export interface FaceOptions {
  /** Ambient floor, 0–1. */
  ambient?: number;
  depthBias?: number;
  /** Supply the normal when the winding is not reliable, or to force lighting. */
  normal?: Vec3;
  /** Draw regardless of which way it faces — for flat things lying on ground. */
  noCull?: boolean;
  alpha?: number;
}

/**
 * Paint one face, shaded and culled. Returns false if it was culled, which is
 * occasionally worth knowing when counting what a frame actually drew.
 */
export function paintFace(
  painter: Painter,
  pts: readonly Vec3[],
  color: string,
  opts: FaceOptions = {},
): boolean {
  if (pts.length < 3) return false;
  const n = opts.normal ?? faceNormal(pts);
  const len = Math.hypot(n.x, n.y, n.z);
  if (len < 1e-12) return false;
  const view = painter.camera.viewDirection();
  const facing = (n.x * view.x + n.y * view.y + n.z * view.z) / len;
  if (!opts.noCull && facing >= 0) return false;

  const light = IsoCamera.LIGHT;
  const lambert = (n.x * light.x + n.y * light.y + n.z * light.z) / len;
  const ambient = opts.ambient ?? 0.5;
  const level = ambient + (1 - ambient) * clamp(Math.abs(lambert), 0, 1);
  painter.polygon(pts, {
    fill: toHex(shade(parseHex(color), level)),
    depthBias: opts.depthBias ?? 0,
    alpha: opts.alpha ?? 1,
  });
  return true;
}

/**
 * A cone or a spike: a ring of `sides` points at `baseZ`, meeting at a point.
 *
 * `apexZ` above the base gives a conifer; below it gives the lower half of a
 * broadleaf crown, and stacking the two is a cheap round tree that still reads
 * as a solid from any angle.
 */
export function paintCone(
  painter: Painter,
  cx: number,
  cy: number,
  baseZ: number,
  apexZ: number,
  radius: number,
  sides: number,
  color: string,
  opts: FaceOptions = {},
): void {
  const apex: Vec3 = { x: cx, y: cy, z: apexZ };
  const up = apexZ >= baseZ;
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const p0: Vec3 = { x: cx + Math.cos(a0) * radius, y: cy + Math.sin(a0) * radius, z: baseZ };
    const p1: Vec3 = { x: cx + Math.cos(a1) * radius, y: cy + Math.sin(a1) * radius, z: baseZ };
    // Wound so the outside faces out, whichever way the cone points.
    paintFace(painter, up ? [p0, p1, apex] : [p1, p0, apex], color, opts);
  }
}

/** A box on a heading: the workhorse for buildings, vehicles and crates. */
export function paintBox(
  painter: Painter,
  cx: number,
  cy: number,
  baseZ: number,
  length: number,
  width: number,
  height: number,
  heading: number,
  color: string,
  opts: FaceOptions = {},
): void {
  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  const hl = length / 2;
  const hw = width / 2;
  const at = (a: number, b: number, c: number): Vec3 => ({
    x: cx + ch * a - sh * b,
    y: cy + sh * a + ch * b,
    z: baseZ + c,
  });
  const top = height;
  const c000 = at(-hl, -hw, 0);
  const c100 = at(hl, -hw, 0);
  const c110 = at(hl, hw, 0);
  const c010 = at(-hl, hw, 0);
  const c001 = at(-hl, -hw, top);
  const c101 = at(hl, -hw, top);
  const c111 = at(hl, hw, top);
  const c011 = at(-hl, hw, top);

  paintFace(painter, [c001, c101, c111, c011], color, opts);
  paintFace(painter, [c100, c110, c111, c101], color, opts);
  paintFace(painter, [c010, c000, c001, c011], color, opts);
  paintFace(painter, [c000, c100, c101, c001], color, opts);
  paintFace(painter, [c110, c010, c011, c111], color, opts);
}
