/**
 * Crossings at grade: the deck, the crossbucks, the lights and the arms.
 *
 * The one piece of geometry here that is not a box is the **gate arm**, and it
 * is the reason this file exists rather than being three calls in the scenery
 * renderer. `paintBox` takes a heading — a yaw — and an arm coming down rotates
 * about a horizontal axis, which a yaw cannot express. So the arm is built as a
 * quad between its pivot and its computed tip and handed to `paintFace` with
 * culling off, which works at any angle and costs one face.
 *
 * The lights alternate, and both lamps are drawn every frame with the dark one
 * dimmed rather than omitted: a lamp that vanishes reads as a mast with one
 * light on it, and the pair is what makes a crossing signal recognisable.
 */
import { crossingLights, type Crossing } from '../crossing.ts';
import { paintBox, paintFace } from './solid.ts';
import type { Painter, Vec3 } from './painter.ts';

export interface CrossingStyle {
  /** Timber deck between the rails and out to the roadway. */
  deckColor?: string;
  mastColor?: string;
  lampOnColor?: string;
  lampOffColor?: string;
  /** The white-and-red striped arm. */
  gateColor?: string;
  gateStripe?: string;
  crossbuckColor?: string;
  /** Draw a mark where somebody is standing the traffic down by hand. */
  flagColor?: string;
  labels?: boolean;
  depthBias?: number;
}

export const DEFAULT_CROSSING_STYLE: Required<CrossingStyle> = {
  deckColor: '#4a443c',
  mastColor: '#d8d8d0',
  lampOnColor: '#ff3b2f',
  lampOffColor: '#4a2320',
  gateColor: '#f2f2ee',
  gateStripe: '#d8332a',
  crossbuckColor: '#e8e8e2',
  flagColor: '#e2483d',
  labels: true,
  depthBias: 0,
};

export function drawCrossings(
  painter: Painter,
  crossings: readonly Crossing[],
  time: number,
  style: CrossingStyle = {},
): void {
  const st = { ...DEFAULT_CROSSING_STYLE, ...style };
  const cam = painter.camera;
  const margin = 120;

  for (const crossing of crossings) {
    const p = cam.project(crossing.x, crossing.y, crossing.z + 4);
    if (p.sx < -margin || p.sy < -margin || p.sx > cam.width + margin || p.sy > cam.height + margin) {
      continue;
    }

    // The roadway runs across the track at whatever angle the scene gave it.
    const cross = crossing.heading + (crossing.angle * Math.PI) / 180;
    const rx = Math.cos(cross);
    const ry = Math.sin(cross);
    // Along the track, which is the direction the deck has to cover.
    const tx = Math.cos(crossing.heading);
    const ty = Math.sin(crossing.heading);
    const half = crossing.width / 2;

    deck(painter, crossing, tx, ty, rx, ry, half, st);

    // Two masts, diagonally opposite, which is how they are actually installed:
    // each stands beside the road on the right-hand side of one approach, set
    // back from the rails. `rx,ry` runs along the road, so setting back is along
    // it; `tx,ty` runs along the track, which is across the roadway.
    const backFromRails = 8;
    const roadside = half + 1.6;
    for (const side of [1, -1] as const) {
      const mx = crossing.x + rx * backFromRails * side + tx * roadside * side;
      const my = crossing.y + ry * backFromRails * side + ty * roadside * side;
      mast(painter, crossing, mx, my, cross, side, tx, ty, time, st);
    }

    if (st.labels && crossing.flaggedBy) {
      painter.text({ x: crossing.x, y: crossing.y, z: crossing.z + 5.5 }, 'FLAGGED', {
        fill: st.flagColor,
        font: '10px ui-monospace, monospace',
        depthBias: st.depthBias + 6,
      });
    }
  }
}

/** Planking between and outside the rails, so the road reads as continuous. */
function deck(
  painter: Painter,
  crossing: Crossing,
  tx: number,
  ty: number,
  rx: number,
  ry: number,
  half: number,
  st: Required<CrossingStyle>,
): void {
  const reach = 7;
  const quad: Vec3[] = [
    { x: crossing.x + tx * reach + rx * half, y: crossing.y + ty * reach + ry * half, z: crossing.z + 0.16 },
    { x: crossing.x + tx * reach - rx * half, y: crossing.y + ty * reach - ry * half, z: crossing.z + 0.16 },
    { x: crossing.x - tx * reach - rx * half, y: crossing.y - ty * reach - ry * half, z: crossing.z + 0.16 },
    { x: crossing.x - tx * reach + rx * half, y: crossing.y - ty * reach + ry * half, z: crossing.z + 0.16 },
  ];
  painter.polygon(quad, { fill: st.deckColor, depthBias: st.depthBias + 2.2 });
}

function mast(
  painter: Painter,
  crossing: Crossing,
  x: number,
  y: number,
  cross: number,
  side: 1 | -1,
  /** Along the track, which is the direction an arm has to lie to block a road. */
  tx: number,
  ty: number,
  time: number,
  st: Required<CrossingStyle>,
): void {
  const z = crossing.z;
  const bias = st.depthBias + 4;
  // Drawn larger than life, on the same reasoning as the switch stands and the
  // people: this is a plan of a railway at the zoom where you can also see a
  // train, and a mast at true scale is one pixel wide. What has to be legible is
  // *which* protection a crossing has and what it is doing.
  paintBox(painter, x, y, z, 0.5, 0.5, 4.6, cross, st.mastColor, { ambient: 0.7, depthBias: bias });

  if (crossing.protection === 'passive') {
    // Crossbucks: two boards in an X. Drawn as two flat slabs, which at this
    // zoom is the shape you recognise rather than the lettering.
    for (const tilt of [1, -1]) {
      paintBox(painter, x, y, z + 3.9, 2.6, 0.2, 0.42, cross + tilt * 0.7, st.crossbuckColor, {
        ambient: 0.95,
        depthBias: bias + 0.2,
      });
    }
    return;
  }

  // Two lamps side by side, facing along the road. The dark one is drawn dim
  // rather than left out — the pair is what makes it a crossing signal.
  const lit = crossingLights(crossing, time);
  const lx = Math.cos(cross + Math.PI / 2);
  const ly = Math.sin(cross + Math.PI / 2);
  for (const lamp of [1, -1] as const) {
    const on = lit.on && (lamp === 1) === lit.left;
    paintBox(
      painter,
      x + lx * 0.85 * lamp,
      y + ly * 0.85 * lamp,
      z + 3.9,
      0.75,
      0.6,
      0.75,
      cross,
      on ? st.lampOnColor : st.lampOffColor,
      { ambient: on ? 1 : 0.6, depthBias: bias + 0.3 },
    );
  }

  if (crossing.protection !== 'gates') return;

  // The arm. Pivoted at the mast at about waist height and swinging down to lie
  // **across the roadway** — which is along the track, not along the road. It
  // covers about half the width, because a gate blocks the approaching lane and
  // leaves the other one open for anybody already on the crossing to get off it.
  // `gate` runs 0 (vertical, stowed) to 1 (down).
  const pivotZ = z + 1.6;
  const length = crossing.width * 0.55 + 1.6;
  const angle = (1 - crossing.gate) * (Math.PI / 2);
  const reachOut = Math.cos(angle) * length;
  const rise = Math.sin(angle) * length;
  const ax = -tx * side;
  const ay = -ty * side;
  const tipX = x + ax * reachOut;
  const tipY = y + ay * reachOut;
  const tipZ = pivotZ + rise;
  // The arm's own width runs along the road, at right angles to its length.
  const wide = 0.4;
  const wx = Math.cos(cross) * wide;
  const wy = Math.sin(cross) * wide;
  const quad: Vec3[] = [
    { x: x + wx, y: y + wy, z: pivotZ },
    { x: tipX + wx, y: tipY + wy, z: tipZ },
    { x: tipX - wx, y: tipY - wy, z: tipZ },
    { x: x - wx, y: y - wy, z: pivotZ },
  ];
  paintFace(painter, quad, crossing.gate > 0.5 ? st.gateStripe : st.gateColor, {
    ambient: 0.95,
    noCull: true,
    depthBias: bias + 0.5,
  });
}
