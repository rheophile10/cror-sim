/**
 * Terrain as isometric quads.
 *
 * One quad per grid cell, using the four corner heights, so a sloping cell is
 * drawn as a sloping plane and the silhouette of a hill is genuinely its
 * profile. Shading is flat Lambert against a fixed sun: no smoothing across
 * cells, because the facet edges are what let you read the shape of the ground
 * without contour lines.
 *
 * ── Culling, and why it is done twice ──
 *
 * A cell is skipped when its projected centre falls well outside the viewport.
 * That is a coarse cull — a tall spire just off screen can pop — but the margin
 * is generous enough that it does not show at normal zooms.
 *
 * That test alone is not enough once a world gets long. Rejecting a cell still
 * costs a projection, and a subdivision big enough to run a train over for an
 * hour is half a million cells: forty milliseconds a frame spent deciding not to
 * draw anything. So the loop is **bounded first** by unprojecting the four
 * corners of the viewport onto the terrain's lowest and highest planes and
 * taking the cell range that covers. The per-cell test then trims what is left.
 *
 * The bound is conservative in two ways and both are deliberate: the visible
 * region is a rotated rectangle and this takes its axis-aligned box, and it is
 * evaluated at the extremes of the height field rather than per column. Being
 * generous costs a few thousand cells; being wrong cuts a hole in the landscape.
 */
import type { Terrain } from '../terrain.ts';
import { clamp } from '../units.ts';
import { IsoCamera } from './camera.ts';
import { DEFAULT_RAMP, parseHex, type RampStop, sampleRamp, shade, toHex } from './color.ts';
import type { Painter } from './painter.ts';

export interface TerrainStyle {
  ramp?: RampStop[];
  /** Ambient light floor, 0–1; below this, a face in shadow goes flat black. */
  ambient?: number;
  /** Hairline between cells. Null draws none. */
  grid?: string | null;
  /** Draw vertical walls around the edge of the grid, so it reads as a solid. */
  skirt?: boolean;
  skirtColor?: string;
  /** Flood everything below this elevation, metres. */
  waterLevel?: number | null;
  waterColor?: string;
  /**
   * Minimum relief the colour ramp is stretched over, metres.
   *
   * Without a floor the ramp is normalised to whatever range the terrain
   * happens to have, so a prairie with a 15 m knoll on it gets a snowcapped
   * summit. With one, colour means roughly the same thing from scene to scene.
   */
  reliefFloor?: number;
  /** Contour interval in metres; null draws none. */
  contourInterval?: number | null;
  contourColor?: string;
}

export const DEFAULT_TERRAIN_STYLE: Required<TerrainStyle> = {
  ramp: DEFAULT_RAMP,
  ambient: 0.45,
  grid: null,
  reliefFloor: 60,
  skirt: true,
  skirtColor: '#2b2620',
  waterLevel: null,
  waterColor: '#2f6b8f',
  contourInterval: null,
  contourColor: 'rgba(255,255,255,0.16)',
};

export function drawTerrain(painter: Painter, terrain: Terrain, style: TerrainStyle = {}): void {
  const st = { ...DEFAULT_TERRAIN_STYLE, ...style };
  const cam = painter.camera;
  const cs = terrain.cellSize;
  const span = Math.max(1e-6, terrain.maxHeight - terrain.minHeight, st.reliefFloor);
  const light = IsoCamera.LIGHT;
  const margin = 80;
  const win = visibleCells(painter, terrain, margin);

  for (let r = win.r0; r < win.r1; r++) {
    for (let c = win.c0; c < win.c1; c++) {
      const x0 = c * cs;
      const y0 = r * cs;
      const x1 = x0 + cs;
      const y1 = y0 + cs;
      const h00 = terrain.nodeHeight(c, r);
      const h10 = terrain.nodeHeight(c + 1, r);
      const h11 = terrain.nodeHeight(c + 1, r + 1);
      const h01 = terrain.nodeHeight(c, r + 1);
      const avg = (h00 + h10 + h11 + h01) / 4;

      const centre = cam.project(x0 + cs / 2, y0 + cs / 2, avg);
      if (
        centre.sx < -margin ||
        centre.sy < -margin ||
        centre.sx > cam.width + margin ||
        centre.sy > cam.height + margin
      ) {
        continue;
      }

      // Flat normal from the cell diagonals.
      const nx = ((h00 - h10) + (h01 - h11)) * 0.5 * cs;
      const ny = ((h00 - h01) + (h10 - h11)) * 0.5 * cs;
      const nz = cs * cs;
      const nlen = Math.hypot(nx, ny, nz);
      const lambert = (nx * light.x + ny * light.y + nz * light.z) / nlen;
      const level = st.ambient + (1 - st.ambient) * clamp(lambert, 0, 1);

      const base = sampleRamp(st.ramp, (avg - terrain.minHeight) / span);
      const fill = toHex(shade(base, level));
      painter.polygon(
        [
          { x: x0, y: y0, z: h00 },
          { x: x1, y: y0, z: h10 },
          { x: x1, y: y1, z: h11 },
          { x: x0, y: y1, z: h01 },
        ],
        // Stroked in its own fill colour when no grid is asked for: canvas
        // antialiases each quad's edge against what is already there, and
        // abutting quads leave a hairline of background between them that reads
        // as a wireframe over the whole landscape.
        { fill, stroke: st.grid ?? fill, width: st.grid ? 0.5 : 1 },
      );

      if (st.waterLevel !== null && avg < st.waterLevel) {
        const w = st.waterLevel;
        painter.polygon(
          [
            { x: x0, y: y0, z: w },
            { x: x1, y: y0, z: w },
            { x: x1, y: y1, z: w },
            { x: x0, y: y1, z: w },
          ],
          { fill: st.waterColor, alpha: 0.72 },
        );
      }

      if (st.contourInterval) {
        drawCellContours(painter, x0, y0, cs, [h00, h10, h11, h01], st.contourInterval, st.contourColor);
      }
    }
  }

  if (st.skirt) drawSkirt(painter, terrain, st.skirtColor);
}

/**
 * Marching-squares contours inside one cell. Drawn per cell rather than as
 * traced polylines: the segments never need to be joined up because they are
 * painted, not exported, and per-cell segments sort correctly against the
 * terrain they sit on.
 */
function drawCellContours(
  painter: Painter,
  x0: number,
  y0: number,
  cs: number,
  h: [number, number, number, number],
  interval: number,
  color: string,
): void {
  const [h00, h10, h11, h01] = h;
  const lo = Math.min(h00, h10, h11, h01);
  const hi = Math.max(h00, h10, h11, h01);
  const first = Math.ceil(lo / interval) * interval;
  for (let level = first; level <= hi; level += interval) {
    // Corners in order, walking the cell boundary.
    const corners = [
      { x: x0, y: y0, z: h00 },
      { x: x0 + cs, y: y0, z: h10 },
      { x: x0 + cs, y: y0 + cs, z: h11 },
      { x: x0, y: y0 + cs, z: h01 },
    ];
    const hits: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 4]!;
      if ((a.z - level) * (b.z - level) < 0) {
        const t = (level - a.z) / (b.z - a.z);
        hits.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: level });
      }
    }
    if (hits.length >= 2) {
      painter.line([hits[0]!, hits[1]!], { stroke: color, width: 1, depthBias: 0.4 });
    }
  }
}

/** Vertical walls around the edge of the grid, down to below the lowest point. */
function drawSkirt(painter: Painter, terrain: Terrain, color: string): void {
  const cs = terrain.cellSize;
  const floor = terrain.minHeight - Math.max(4, (terrain.maxHeight - terrain.minHeight) * 0.15);
  const rgb = parseHex(color);
  const wall = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    az: number,
    bz: number,
    dim: number,
  ) => {
    painter.polygon(
      [
        { x: ax, y: ay, z: az },
        { x: bx, y: by, z: bz },
        { x: bx, y: by, z: floor },
        { x: ax, y: ay, z: floor },
      ],
      { fill: toHex(shade(rgb, dim)) },
    );
  };
  // The skirt was the last thing in here drawn unconditionally, and on a long
  // subdivision it was most of the frame: ten thousand wall quads along an edge
  // nowhere near the camera. It gets the same window as the ground does.
  const win = visibleCells(painter, terrain, 120);
  for (let c = win.c0; c < win.c1; c++) {
    wall(c * cs, 0, (c + 1) * cs, 0, terrain.nodeHeight(c, 0), terrain.nodeHeight(c + 1, 0), 1.15);
    const y = terrain.rows * cs;
    wall(
      c * cs,
      y,
      (c + 1) * cs,
      y,
      terrain.nodeHeight(c, terrain.rows),
      terrain.nodeHeight(c + 1, terrain.rows),
      0.8,
    );
  }
  for (let r = win.r0; r < win.r1; r++) {
    wall(0, r * cs, 0, (r + 1) * cs, terrain.nodeHeight(0, r), terrain.nodeHeight(0, r + 1), 0.95);
    const x = terrain.cols * cs;
    wall(
      x,
      r * cs,
      x,
      (r + 1) * cs,
      terrain.nodeHeight(terrain.cols, r),
      terrain.nodeHeight(terrain.cols, r + 1),
      1.05,
    );
  }
}

/**
 * The range of cells the viewport can possibly touch.
 *
 * Unprojects the four screen corners onto horizontal planes at the terrain's
 * lowest and highest points and takes the bounding box of the eight results. A
 * cell outside that box cannot project inside the viewport whatever its height,
 * so the loop never has to look at it.
 *
 * `unproject` divides by sin(pitch), so at an edge-on camera the inverse is
 * degenerate and the answer is the whole grid — correct, and slow only in a view
 * nobody uses.
 */
export function visibleCells(
  painter: Painter,
  terrain: Terrain,
  margin: number,
): { c0: number; c1: number; r0: number; r1: number } {
  const cam = painter.camera;
  const all = { c0: 0, c1: terrain.cols, r0: 0, r1: terrain.rows };
  if (Math.abs(Math.sin((cam.pitch * Math.PI) / 180)) < 0.02) return all;

  const cs = terrain.cellSize;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const corners = [
    [-margin, -margin],
    [cam.width + margin, -margin],
    [cam.width + margin, cam.height + margin],
    [-margin, cam.height + margin],
  ] as const;
  for (const z of [terrain.minHeight, terrain.maxHeight]) {
    for (const [sx, sy] of corners) {
      const p = cam.unproject(sx, sy, z);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return all;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  // One cell of slack all round: a cell is drawn from its corner heights, which
  // can carry its silhouette past the centre this box was computed against.
  return {
    c0: clamp(Math.floor(minX / cs) - 1, 0, terrain.cols),
    c1: clamp(Math.ceil(maxX / cs) + 1, 0, terrain.cols),
    r0: clamp(Math.floor(minY / cs) - 1, 0, terrain.rows),
    r1: clamp(Math.ceil(maxY / cs) + 1, 0, terrain.rows),
  };
}
