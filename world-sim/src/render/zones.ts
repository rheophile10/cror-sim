/**
 * Drawing the places where there is work.
 *
 * A glowing circle lying on the ground round every switch, crossing, car end
 * and doorway the selected person could work, at exactly the radius they have
 * to be inside. Walk into the circle and the job appears in the actions panel.
 *
 * ── Why a circle on the ground and not a highlight on the object ──
 *
 * Because the quantity being shown is a **distance**, and a distance has to be
 * drawn where it is measured. Glowing the switch stand itself would say "this is
 * a thing you can work" without saying the one thing you need to know, which is
 * how close is close enough. The old answer — nothing drawn at all, five metres
 * of tolerance, and a refusal message once you got it wrong — made the working
 * radius something you learned by failing.
 *
 * ── How it is drawn ──
 *
 * The painter has no z-buffer and no blend modes, so the "glow" is three
 * concentric strokes of falling alpha — a wide dim one outside the boundary, the
 * boundary itself, and a soft one just inside — biased to sit above the ground
 * and below everything standing on it. That is enough: on grass a soft ring
 * reads as light, and it never occludes the switch stand in the middle of it.
 * Nothing is filled, so a zone never dims the ballast or the road under it.
 *
 * The ring is sampled at terrain height around its whole circumference rather
 * than drawn as a projected ellipse, so it lies over a ditch or up the side of
 * an embankment instead of hovering across it.
 */
import type { WorkZone } from '../world.ts';
import type { Painter } from './painter.ts';
import type { Terrain } from '../terrain.ts';

export interface ZoneStyle {
  /** A zone you are outside: something to walk into. */
  color?: string;
  /** A zone you are standing in. */
  activeColor?: string;
  /**
   * Write each circle's name on it. On by default: the name is what ties the
   * ring on the ground to the box of jobs it offers in the panel.
   */
  labels?: boolean;
  depthBias?: number;
}

export const DEFAULT_ZONE_STYLE: Required<ZoneStyle> = {
  color: '#6fd3ff',
  activeColor: '#8ff0a8',
  labels: true,
  depthBias: 0,
};

/**
 * How many points go round a ring.
 *
 * Enough that a twelve-metre circle still reads as a circle at the on-foot zoom,
 * where it fills a good part of the screen. The sixteen the person renderer uses
 * for its own reach ring is visibly a polygon at that size.
 */
const SEGMENTS = 40;

export function drawWorkZones(
  painter: Painter,
  zones: readonly WorkZone[],
  terrain: Terrain,
  style: ZoneStyle = {},
): void {
  const st = { ...DEFAULT_ZONE_STYLE, ...style };
  const cam = painter.camera;
  // Cull to the viewport, like every other renderer here: a scene can hold
  // hundreds of switches and this runs every frame.
  const margin = 120;

  for (const zone of zones) {
    const mid = cam.project(zone.x, zone.y, zone.z);
    const span = zone.radius * cam.zoom * 1.5;
    if (
      mid.sx < -margin - span ||
      mid.sx > cam.width + margin + span ||
      mid.sy < -margin - span ||
      mid.sy > cam.height + margin + span
    ) {
      continue;
    }

    const rgb = zone.inReach ? st.activeColor : st.color;
    // Three rings: a wide dim one outside the boundary, the boundary itself, and
    // a thin bright one just inside. Together they read as a lit edge rather
    // than as a drawn circle, which is the difference between "here is a line"
    // and "here is somewhere to stand".
    ring(painter, terrain, zone, zone.radius * 1.04, {
      stroke: alpha(rgb, zone.inReach ? 0.16 : 0.1),
      width: 7,
      depthBias: st.depthBias + 0.4,
    });
    const edge = ring(painter, terrain, zone, zone.radius, {
      stroke: alpha(rgb, zone.inReach ? 0.85 : 0.55),
      width: 2,
      depthBias: st.depthBias + 0.5,
    });
    ring(painter, terrain, zone, zone.radius * 0.93, {
      stroke: alpha(rgb, zone.inReach ? 0.3 : 0.16),
      width: 3,
      depthBias: st.depthBias + 0.45,
    });

    // The name goes on the **near rim**, not in the middle: the middle of a car
    // zone is under the car, and a name you cannot read is worse than none.
    // Named only once the circle is big enough on screen to be worth naming.
    // Zoomed out to the whole subdivision every siding switch would otherwise
    // write its name across the same forty pixels.
    if (st.labels && zone.radius * cam.zoom > 26) {
      painter.text({ ...edge, z: edge.z + 0.3 }, zone.label, {
        fill: zone.inReach ? st.activeColor : '#dbeaf2',
        font: '11px ui-monospace, monospace',
        // Well clear of the ballast and the rails. The ring is a ground decal
        // and sorts like one; its name is a caption and has to be readable
        // wherever the near rim happens to fall, which is often across track.
        depthBias: st.depthBias + 6,
      });
    }
  }
}

/** Draws one circle, and hands back the point on it nearest the viewer. */
function ring(
  painter: Painter,
  terrain: Terrain,
  zone: WorkZone,
  radius: number,
  opts: { stroke: string; width: number; depthBias: number },
): { x: number; y: number; z: number } {
  const pts: { x: number; y: number; z: number }[] = [];
  let near = null as { x: number; y: number; z: number } | null;
  let lowest = -Infinity;
  for (let i = 0; i <= SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    const x = zone.x + Math.cos(a) * radius;
    const y = zone.y + Math.sin(a) * radius;
    // Just clear of the ground, so it is not fighting the terrain it lies on.
    const pt = { x, y, z: terrain.heightAt(x, y) + 0.08 };
    pts.push(pt);
    // Nearest the viewer is furthest **down the screen**, whatever the camera's
    // yaw happens to be — worked out from the projection rather than assumed,
    // so it stays right when the view is orbited.
    const sy = painter.camera.project(x, y, pt.z).sy;
    if (sy > lowest) { lowest = sy; near = pt; }
  }
  painter.line(pts, { ...opts, round: true });
  return near ?? { x: zone.x, y: zone.y, z: zone.z };
}

/** `#rrggbb` plus an opacity, because the painter takes CSS colours. */
function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
}
