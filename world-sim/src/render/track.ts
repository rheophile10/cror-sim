/**
 * Track as ballast, ties, and two rails — plus the earthworks under it.
 *
 * The embankment is not decoration. Track elevation is the *smoothed* ground
 * profile, so wherever the railhead sits well above or below the terrain the
 * scene is telling you a fill or a cut is there, and drawing it is the only way
 * that reads. It is also the honest picture of what the grading step in
 * `track.ts` did.
 *
 * Geometry is emitted per sample span (a couple of metres), which keeps each
 * face small enough that a single depth value per face sorts correctly against
 * the terrain and the train.
 */
import type { TrackPath } from '../track.ts';
import type { Painter, Vec3 } from './painter.ts';

export interface TrackStyle {
  ballastColor?: string;
  ballastWidth?: number;
  railColor?: string;
  tieColor?: string;
  /** Draw one tie every N samples. */
  tieEvery?: number;
  /** Draw cut/fill slopes where the railhead departs from the ground. */
  embankments?: boolean;
  embankmentColor?: string;
  /** Below this height difference no earthwork is drawn, metres. */
  embankmentThreshold?: number;
  /** Rail line width in pixels, before zoom scaling. */
  railWidth?: number;
  /**
   * How far toward the camera to bias the whole track, in metres of depth.
   *
   * This is not cosmetic. A terrain cell is sorted on the average depth of a
   * quad tens of metres across, while a track segment is sorted on the depth of
   * two metres of ballast lying on it — so a segment sitting in the far corner
   * of its cell sorts *behind* the ground it rests on and disappears. Biasing by
   * about one cell fixes it, and stays far smaller than the relief, so a hill
   * still hides the line behind it.
   *
   * `Renderer` sets this from the terrain's cell size unless a scene overrides it.
   */
  depthBias?: number;
}

export const DEFAULT_TRACK_STYLE: Required<TrackStyle> = {
  ballastColor: '#6d6259',
  ballastWidth: 4.6,
  railColor: '#c9ccd1',
  tieColor: '#4a3f36',
  tieEvery: 1,
  embankments: true,
  embankmentColor: '#5d5248',
  embankmentThreshold: 0.35,
  railWidth: 1.4,
  depthBias: 0,
};

/** Left/right offsets perpendicular to the path at a sample. */
function offset(pt: { x: number; y: number; heading: number }, half: number): [Vec3, Vec3] {
  const nx = Math.sin(pt.heading) * half;
  const ny = -Math.cos(pt.heading) * half;
  return [
    { x: pt.x + nx, y: pt.y + ny, z: 0 },
    { x: pt.x - nx, y: pt.y - ny, z: 0 },
  ];
}

export function drawTrack(painter: Painter, path: TrackPath, style: TrackStyle = {}): void {
  const st = { ...DEFAULT_TRACK_STYLE, ...style };
  const cam = painter.camera;
  const half = st.ballastWidth / 2;
  const railHalf = path.gauge / 2;
  const n = path.samples.length;
  const spans = path.closed ? n : n - 1;
  const margin = 120;

  for (let i = 0; i < spans; i++) {
    const a = path.samples[i]!;
    const b = path.samples[(i + 1) % n]!;

    const mid = cam.project((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    if (
      mid.sx < -margin ||
      mid.sy < -margin ||
      mid.sx > cam.width + margin ||
      mid.sy > cam.height + margin
    ) {
      continue;
    }

    const [al, ar] = offset(a, half);
    const [bl, br] = offset(b, half);
    al.z = ar.z = a.z;
    bl.z = br.z = b.z;

    // Ballast top.
    painter.polygon([al, bl, br, ar], { fill: st.ballastColor, depthBias: st.depthBias + 0.3 });

    // Cut or fill: a wall from each ballast edge down (or up) to the ground.
    if (st.embankments) {
      const da = a.z - a.ground;
      const db = b.z - b.ground;
      if (Math.abs(da) > st.embankmentThreshold || Math.abs(db) > st.embankmentThreshold) {
        for (const [pa, pb, ga, gb] of [
          [al, bl, a.ground, b.ground],
          [ar, br, a.ground, b.ground],
        ] as [Vec3, Vec3, number, number][]) {
          painter.polygon(
            [
              { x: pa.x, y: pa.y, z: pa.z },
              { x: pb.x, y: pb.y, z: pb.z },
              { x: pb.x, y: pb.y, z: gb },
              { x: pa.x, y: pa.y, z: ga },
            ],
            { fill: st.embankmentColor, depthBias: st.depthBias + 0.2 },
          );
        }
      }
    }

    // Ties, as short cross members on the ballast.
    if (i % st.tieEvery === 0) {
      const [tl, tr] = offset(a, railHalf * 1.5);
      tl.z = tr.z = a.z + 0.02;
      painter.line([tl, tr], { stroke: st.tieColor, width: 2.2, depthBias: st.depthBias + 0.6 });
    }

    // Rails.
    for (const s of [railHalf, -railHalf]) {
      const [a1] = offset(a, s);
      const [b1] = offset(b, s);
      a1.z = a.z + 0.16;
      b1.z = b.z + 0.16;
      painter.line([a1, b1], { stroke: st.railColor, width: st.railWidth, depthBias: st.depthBias + 0.9 });
    }
  }
}
