/**
 * Drawing bridges: a deck, and what holds it up.
 *
 * A trestle is a row of bents — four battered piles and a cap — at close
 * centres, and the thing that makes it read as a trestle rather than as a fence
 * is the **batter**: the outer piles lean outward as they go down, so the frame
 * is wider at the ground than at the deck. Two faces per pile is enough for
 * that at this zoom.
 *
 * The deck itself is drawn as a solid beam under the railhead. The track is
 * drawn separately, by `render/track.ts`, and sits on top of it — which is why
 * the deck's depth is subtracted from the railhead rather than added to it. Get
 * that backwards and the rails disappear inside the bridge.
 */
import type { Bridge } from '../bridge.ts';
import { paintBox, paintFace } from './solid.ts';
import type { Painter, Vec3 } from './painter.ts';

export interface BridgeStyle {
  ambient?: number;
  deckColor?: string;
  pileColor?: string;
  /** Depth of the deck beam below the railhead, metres. */
  deckDepth?: number;
  /** How far the outer piles lean out per metre of height. */
  batter?: number;
  labels?: boolean;
  depthBias?: number;
}

export const DEFAULT_BRIDGE_STYLE: Required<BridgeStyle> = {
  ambient: 0.5,
  deckColor: '#5b4a38',
  pileColor: '#4a3d2f',
  deckDepth: 1.1,
  batter: 0.12,
  labels: true,
  depthBias: 0,
};

export function drawBridges(
  painter: Painter,
  bridges: readonly Bridge[],
  style: BridgeStyle = {},
): void {
  const st = { ...DEFAULT_BRIDGE_STYLE, ...style };
  const cam = painter.camera;
  const margin = 160;

  for (const bridge of bridges) {
    if (bridge.deck.length < 2) continue;
    const mid = bridge.deck[Math.floor(bridge.deck.length / 2)]!;
    const p = cam.project(mid.x, mid.y, mid.z);
    if (p.sx < -margin || p.sy < -margin || p.sx > cam.width + margin || p.sy > cam.height + margin) {
      continue;
    }

    const half = bridge.width / 2;
    const bias = st.depthBias + 1.6;

    // The bents first, so the deck sorts in front of the piles it stands on.
    for (const bent of bridge.bents) {
      const height = bent.deck - st.deckDepth - bent.ground;
      if (height <= 0.2) continue;
      const nx = -Math.sin(bent.heading);
      const ny = Math.cos(bent.heading);
      // Four piles: two inner and two outer, the outer pair battered.
      for (const [offset, lean] of [
        [half * 0.35, 0],
        [-half * 0.35, 0],
        [half * 0.9, st.batter],
        [-half * 0.9, -st.batter],
      ] as const) {
        const topX = bent.x + nx * offset;
        const topY = bent.y + ny * offset;
        const footX = topX + nx * lean * height;
        const footY = topY + ny * lean * height;
        pile(painter, footX, footY, bent.ground, topX, topY, bent.deck - st.deckDepth, 0.28, {
          ambient: st.ambient,
          depthBias: bias,
        });
      }
      // The cap the stringers sit on.
      paintBox(
        painter,
        bent.x,
        bent.y,
        bent.deck - st.deckDepth,
        0.4,
        bridge.width * 1.05,
        0.4,
        bent.heading,
        st.pileColor,
        { ambient: st.ambient, depthBias: bias + 0.1 },
      );
    }

    // The deck, as a run of short beams so it follows the curve and the grade.
    for (let i = 0; i < bridge.deck.length - 1; i++) {
      const a = bridge.deck[i]!;
      const b = bridge.deck[i + 1]!;
      const an = { x: -Math.sin(a.heading), y: Math.cos(a.heading) };
      const bn = { x: -Math.sin(b.heading), y: Math.cos(b.heading) };
      const top: Vec3[] = [
        { x: a.x + an.x * half, y: a.y + an.y * half, z: a.z - 0.25 },
        { x: b.x + bn.x * half, y: b.y + bn.y * half, z: b.z - 0.25 },
        { x: b.x - bn.x * half, y: b.y - bn.y * half, z: b.z - 0.25 },
        { x: a.x - an.x * half, y: a.y - an.y * half, z: a.z - 0.25 },
      ];
      paintFace(painter, top, bridge.color, {
        ambient: st.ambient + 0.2,
        noCull: true,
        normal: { x: 0, y: 0, z: 1 },
        depthBias: bias + 0.3,
      });
      // Two sides, so the deck has thickness seen from anywhere but overhead.
      for (const side of [1, -1] as const) {
        const face: Vec3[] = [
          { x: a.x + an.x * half * side, y: a.y + an.y * half * side, z: a.z - 0.25 },
          { x: b.x + bn.x * half * side, y: b.y + bn.y * half * side, z: b.z - 0.25 },
          { x: b.x + bn.x * half * side, y: b.y + bn.y * half * side, z: b.z - st.deckDepth },
          { x: a.x + an.x * half * side, y: a.y + an.y * half * side, z: a.z - st.deckDepth },
        ];
        paintFace(painter, face, st.pileColor, {
          ambient: st.ambient,
          noCull: true,
          depthBias: bias + 0.25,
        });
      }
    }

    if (st.labels && bridge.maxHeight > 4) {
      painter.text({ x: mid.x, y: mid.y, z: mid.z + 5 }, bridge.label, {
        fill: '#c9b79a',
        font: '10px ui-monospace, monospace',
        depthBias: st.depthBias + 5,
      });
    }
  }
}

/** A leaning post: four faces between a foot and a head. */
function pile(
  painter: Painter,
  fx: number,
  fy: number,
  fz: number,
  tx: number,
  ty: number,
  tz: number,
  r: number,
  opts: { ambient: number; depthBias: number },
): void {
  const corners: [number, number][] = [
    [r, r],
    [r, -r],
    [-r, -r],
    [-r, r],
  ];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i]!;
    const [bx, by] = corners[(i + 1) % 4]!;
    paintFace(
      painter,
      [
        { x: fx + ax, y: fy + ay, z: fz },
        { x: fx + bx, y: fy + by, z: fz },
        { x: tx + bx, y: ty + by, z: tz },
        { x: tx + ax, y: ty + ay, z: tz },
      ],
      '#4a3d2f',
      opts,
    );
  }
}
