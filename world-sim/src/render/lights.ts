/**
 * Drawing a locomotive's lights, without lighting anything.
 *
 * The honest statement is in `lights.ts` and it is worth repeating here because
 * this file is where somebody would be tempted to fix it: the painter is
 * depth-sorted per face with no z-buffer and no lighting pass, so there is no
 * way to make a headlight *illuminate*. What is drawn instead is what you can
 * see of a lit locomotive from a kilometre away in daylight — **bright lamp
 * faces** on the end of the hood, and a **translucent beam decal on the ground**
 * in front of them.
 *
 * The beam is a flat polygon lying on the terrain, sampled at intervals so it
 * follows the ground rather than cutting into a rise. It is drawn with a low
 * alpha and no shading. It is a decal and it behaves like one: it does not
 * brighten what stands in it, it is not occluded, and it stops at a fixed
 * distance rather than at the first obstruction. At the zoom this simulation is
 * for, that reads as "the headlight is on and pointing that way", which is the
 * only thing anybody needs from it.
 */
import { ditchPhase, hornSounding, lampLevel, beamReach, type Lights } from '../lights.ts';
import type { Guideway } from '../route.ts';
import type { Terrain } from '../terrain.ts';
import type { Train } from '../train.ts';
import { paintBox } from './solid.ts';
import type { Painter, Vec3 } from './painter.ts';

export interface LightStyle {
  /** Draw the beam decal on the ground. Off leaves just the lamp faces. */
  beams?: boolean;
  headlightColor?: string;
  ditchColor?: string;
  /** Peak opacity of the beam where it leaves the lamp. */
  beamAlpha?: number;
  /** Half-width of the beam where it ends, metres. */
  beamSpread?: number;
  /** Mark the bell and horn, since neither can be heard. */
  labels?: boolean;
  depthBias?: number;
}

export const DEFAULT_LIGHT_STYLE: Required<LightStyle> = {
  beams: true,
  headlightColor: '#fff6d8',
  ditchColor: '#ffe9b0',
  beamAlpha: 0.35,
  beamSpread: 11,
  labels: true,
  depthBias: 0,
};

export function drawLights(
  painter: Painter,
  train: Train,
  path: Guideway,
  terrain: Terrain,
  time: number,
  style: LightStyle = {},
): void {
  const st = { ...DEFAULT_LIGHT_STYLE, ...style };
  const lights = train.lights;

  // Both ends of the movement, because a locomotive has a headlight at each and
  // which one is displayed how is the substance of the rule. The lead end is the
  // leading car in the direction the consist faces; the rear end is the last car
  // whichever way it happens to be pointing.
  const railed = train.cars.filter((c) => !c.derailed);
  const lead = railed[0];
  const tail = railed[railed.length - 1];
  if (lead?.kind === 'locomotive') {
    lamps(painter, train, path, terrain, lead.s, lead.length, train.direction, lights.front, time, st);
  }
  if (tail && tail !== lead && tail.kind === 'locomotive') {
    lamps(painter, train, path, terrain, tail.s, tail.length, -train.direction as 1 | -1, lights.rear, time, st);
  }
}

function lamps(
  painter: Painter,
  train: Train,
  path: Guideway,
  terrain: Terrain,
  s: number,
  length: number,
  facing: 1 | -1,
  setting: Lights['front'],
  time: number,
  st: Required<LightStyle>,
): void {
  const level = lampLevel(setting);
  if (level <= 0) return;

  const nose = s + (facing * length) / 2;
  const pt = path.at(nose);
  // Forward along the track in the direction this end faces, and right across it.
  const fx = Math.cos(pt.heading) * facing;
  const fy = Math.sin(pt.heading) * facing;
  const rx = -fy;
  const ry = fx;

  const headlight = shadeLamp(st.headlightColor, level);
  // The headlight itself, high on the short hood.
  paintBox(painter, pt.x, pt.y, pt.z + 3.5, 0.7, 0.5, 0.45, pt.heading, headlight, {
    ambient: 1,
    depthBias: st.depthBias + 4,
  });

  // Ditch lights, low and wide, alternating while the horn is sounding.
  const ditch = ditchPhase(train.lights, time);
  if (ditch.on) {
    for (const side of [1, -1] as const) {
      // With the horn quiet they burn steady; sounding, they alternate.
      const lit = train.lights.horn ? (side === 1) === ditch.left : true;
      if (!lit) continue;
      paintBox(
        painter,
        pt.x + rx * 1.2 * side,
        pt.y + ry * 1.2 * side,
        pt.z + 0.9,
        0.45,
        0.35,
        0.35,
        pt.heading,
        shadeLamp(st.ditchColor, level),
        { ambient: 1, depthBias: st.depthBias + 4 },
      );
    }
  }

  if (st.beams) beam(painter, terrain, pt.x, pt.y, fx, fy, rx, ry, level, st);

  if (st.labels) {
    // Neither the bell nor the horn can be heard, so they are written down.
    const sounding = hornSounding(train.lights);
    const note = sounding
      ? train.lights.horn!.signal.name
      : train.lights.bell
        ? 'bell'
        : null;
    if (note) {
      painter.text({ x: pt.x, y: pt.y, z: pt.z + 6.2 }, note, {
        fill: sounding ? '#ffd98a' : '#b9c3cc',
        font: '10px ui-monospace, monospace',
        depthBias: st.depthBias + 6,
      });
    }
  }
}

/** A translucent wedge lying on the ground, sampled so it follows the terrain. */
function beam(
  painter: Painter,
  terrain: Terrain,
  x: number,
  y: number,
  fx: number,
  fy: number,
  rx: number,
  ry: number,
  level: number,
  st: Required<LightStyle>,
): void {
  const reach = beamReach(level === 1 ? 'bright' : 'dim');
  const steps = 6;
  // Drawn as a stack of quads rather than one long polygon: a single flat
  // polygon over rolling ground either sinks into a rise or floats over a dip,
  // and it is the same reason track is drawn in short pieces.
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const quad: Vec3[] = [];
    for (const [t, side] of [
      [t0, -1],
      [t0, 1],
      [t1, 1],
      [t1, -1],
    ] as const) {
      const d = t * reach;
      // A cone, not a stripe: 0.9 m at the lamp opening out to the full spread.
      const half = 0.9 + t * st.beamSpread;
      const px = x + fx * d + rx * half * side;
      const py = y + fy * d + ry * half * side;
      quad.push({ x: px, y: py, z: terrain.heightAt(px, py) + 0.12 });
    }
    // Fading with distance, because a beam that ended in a hard edge would read
    // as a painted shape rather than as light.
    const fade = 1 - (t0 + t1) / 2;
    painter.polygon(quad, {
      fill: st.headlightColor,
      alpha: st.beamAlpha * fade * level,
      depthBias: st.depthBias + 1.5,
    });
  }
}

/** A lamp face is drawn at its own brightness rather than the scene's. */
function shadeLamp(color: string, level: number): string {
  return level >= 1 ? color : mix(color, '#6b6650', level);
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const out = [16, 8, 0].map((shift) => {
    const ca = (pa >> shift) & 255;
    const cb = (pb >> shift) & 255;
    return Math.round(cb + (ca - cb) * t);
  });
  return `#${out.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
