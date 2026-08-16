/**
 * Switches and obstructions.
 *
 * A turnout is invisible in plan — the diverging route is just more track — so
 * the thing worth drawing is not the switch but **which way it is lined**. That
 * is a switch stand: a post beside the track with a target on top, coloured and
 * turned to show the position. It is the only part of a turnout a crew reads
 * from a distance, and it is the only part drawn here.
 *
 * Obstructions get a plain box in a warning colour, dulled once something has
 * hit it, because a wreck should look different from a hazard.
 */
import type { Obstruction } from '../collision.ts';
import type { Network, NetworkNode } from '../network.ts';
import type { TrackPath } from '../track.ts';
import { IsoCamera } from './camera.ts';
import { parseHex, shade, toHex } from './color.ts';
import type { Painter, Vec3 } from './painter.ts';

export interface NetworkStyle {
  /** Colour of a switch lined for the straight route. */
  normalColor?: string;
  /** Colour of one lined for the diverging route. */
  reverseColor?: string;
  postColor?: string;
  /** Height of the switch stand above the railhead, metres. */
  standHeight?: number;
  /** Offset of the stand from the centre line, metres. */
  standOffset?: number;
  /** Draw switch labels. */
  labels?: boolean;
  depthBias?: number;
}

export const DEFAULT_NETWORK_STYLE: Required<NetworkStyle> = {
  normalColor: '#3fa564',
  reverseColor: '#e0a13c',
  postColor: '#3a3f45',
  standHeight: 2.6,
  standOffset: 3.4,
  labels: false,
  depthBias: 0,
};

/**
 * Which way the stand faces, taken from the track meeting the node's trunk. A
 * stand square to the rails reads as part of the railway; one at an arbitrary
 * angle reads as debris.
 */
function headingAt(network: Network, node: NetworkNode): number {
  for (const port of ['trunk', 'normal', 'reverse'] as const) {
    const conn = node.ports.get(port);
    if (!conn) continue;
    const track = network.tracks.get(conn.track);
    if (!track) continue;
    const pt = conn.end === 'from' ? track.samples[0] : track.samples[track.samples.length - 1];
    if (pt) return pt.heading;
  }
  return 0;
}

export function drawNetwork(painter: Painter, network: Network, style: NetworkStyle = {}): void {
  const st = { ...DEFAULT_NETWORK_STYLE, ...style };

  // Derails first: they sit on the rail, and a switch stand near one should be
  // painted over it rather than behind it.
  for (const node of network.nodes.values()) {
    if (node.kind !== 'derail') continue;
    const heading = headingAt(network, node);
    const across = 2.2;
    const along = 1.4;
    const cx = Math.cos(heading);
    const sy = Math.sin(heading);
    const lift = node.derailing ? 0.55 : 0.12;
    // A block on the rail when it is on, lying flat beside it when it is off.
    const offset = node.derailing ? 0 : 2.6;
    const ox = Math.sin(heading) * offset;
    const oy = -Math.cos(heading) * offset;
    const corner = (a: number, b: number): Vec3 => ({
      x: node.x + ox + cx * a + Math.sin(heading) * b,
      y: node.y + oy + sy * a - Math.cos(heading) * b,
      z: node.z + lift,
    });
    painter.polygon(
      [corner(-along, -across), corner(along, -across), corner(along, across), corner(-along, across)],
      {
        fill: node.derailing ? '#d8b23a' : '#6b6f74',
        stroke: '#241f16',
        width: 0.6,
        depthBias: st.depthBias + 2.4,
      },
    );
    if (st.labels) {
      painter.text({ x: node.x + ox, y: node.y + oy, z: node.z + 2.4 }, node.label ?? 'derail', {
        fill: '#e0c98a',
        font: '10px ui-monospace, monospace',
        depthBias: st.depthBias + 4,
      });
    }
  }

  for (const node of network.switches) {
    const heading = headingAt(network, node);
    // Beside the track, on the right looking along it.
    const nx = Math.sin(heading) * st.standOffset;
    const ny = -Math.cos(heading) * st.standOffset;
    const base: Vec3 = { x: node.x + nx, y: node.y + ny, z: node.z };
    const top: Vec3 = { x: base.x, y: base.y, z: base.z + st.standHeight };

    painter.line([base, top], {
      stroke: st.postColor,
      width: 2.4,
      depthBias: st.depthBias + 2,
    });

    // The target: a plate that faces along the track when lined normal and
    // across it when lined reverse, which is how a real one reads.
    const lined = node.position === 'normal';
    const color = lined ? st.normalColor : st.reverseColor;
    const face = lined ? heading : heading + Math.PI / 2;
    const hw = 1.1;
    const dx = Math.cos(face) * hw;
    const dy = Math.sin(face) * hw;
    const h = 0.85;
    painter.polygon(
      [
        { x: top.x - dx, y: top.y - dy, z: top.z - h / 2 },
        { x: top.x + dx, y: top.y + dy, z: top.z - h / 2 },
        { x: top.x + dx, y: top.y + dy, z: top.z + h / 2 },
        { x: top.x - dx, y: top.y - dy, z: top.z + h / 2 },
      ],
      { fill: color, depthBias: st.depthBias + 3 },
    );

    if (st.labels && node.label) {
      // The kind is worth saying: a spring switch and a hand switch look the
      // same from here and behave completely differently when trailed.
      const kind = node.operation === 'hand' ? '' : ` ${node.operation}`;
      painter.text({ x: top.x, y: top.y, z: top.z + 1.6 }, node.label + kind, {
        fill: '#d8dde3',
        font: '10px ui-monospace, monospace',
        depthBias: st.depthBias + 4,
      });
    }
  }
}

export function drawObstructions(
  painter: Painter,
  obstructions: readonly Obstruction[],
  tracks: ReadonlyMap<string, TrackPath>,
  style: NetworkStyle = {},
): void {
  const st = { ...DEFAULT_NETWORK_STYLE, ...style };
  const view = painter.camera.viewDirection();
  const light = IsoCamera.LIGHT;

  for (const ob of obstructions) {
    const track = ob.trackId ? tracks.get(ob.trackId) : undefined;
    if (!track) continue;
    const pt = track.at(ob.displaced);
    const ch = Math.cos(pt.heading);
    const sh = Math.sin(pt.heading);
    const hl = ob.length / 2;
    const hw = ob.width / 2;
    // A struck obstruction is wreckage: darker, and sitting lower.
    const rgb = parseHex(ob.color);
    const dull = ob.struck ? 0.55 : 1;
    const top = ob.struck ? ob.height * 0.45 : ob.height;
    const lift = 0.4;

    // Something knocked clear sits beside the track, on the ground rather than
    // at railhead level.
    const ox = sh * ob.offset;
    const oy = -ch * ob.offset;
    const baseZ = ob.cleared ? pt.ground : pt.z;
    const at = (a: number, b: number, c: number): Vec3 => ({
      x: pt.x + ox + ch * a + sh * b,
      y: pt.y + oy + sh * a - ch * b,
      z: baseZ + c,
    });

    const faces: { pts: Vec3[]; n: Vec3 }[] = [
      { pts: [at(-hl, -hw, top), at(hl, -hw, top), at(hl, hw, top), at(-hl, hw, top)], n: { x: 0, y: 0, z: 1 } },
      { pts: [at(hl, -hw, lift), at(hl, hw, lift), at(hl, hw, top), at(hl, -hw, top)], n: { x: ch, y: sh, z: 0 } },
      { pts: [at(-hl, -hw, lift), at(-hl, -hw, top), at(-hl, hw, top), at(-hl, hw, lift)], n: { x: -ch, y: -sh, z: 0 } },
      { pts: [at(-hl, hw, lift), at(-hl, hw, top), at(hl, hw, top), at(hl, hw, lift)], n: { x: -sh, y: ch, z: 0 } },
      { pts: [at(-hl, -hw, lift), at(hl, -hw, lift), at(hl, -hw, top), at(-hl, -hw, top)], n: { x: sh, y: -ch, z: 0 } },
    ];

    for (const face of faces) {
      if (face.n.x * view.x + face.n.y * view.y + face.n.z * view.z >= 0) continue;
      const lambert = face.n.x * light.x + face.n.y * light.y + face.n.z * light.z;
      const level = 0.5 + 0.5 * Math.max(0, lambert);
      painter.polygon(face.pts, { fill: toHex(shade(rgb, level * dull)), depthBias: st.depthBias + 1.5 });
    }
  }
}
