/**
 * Terrain: a height field built from a *sparse* description.
 *
 * The JSON never lists every height. It gives a grid size, a base elevation and
 * a short list of features — hills, ridges, ramps, basins, noise — each of which
 * contributes an additive height over a bounded footprint. That is what makes a
 * 200×200 landscape a twenty-line file, and it is the property worth preserving
 * as this grows: a scene should stay hand-editable.
 *
 * Heights live at **lattice nodes**, not cell centres. A grid of `cols × rows`
 * cells therefore stores `(cols+1) × (rows+1)` heights, and a cell is the quad
 * joining its four corner nodes. Storing corners is what lets a cell be drawn as
 * a genuinely tilted plane instead of a flat plate at one height, which is the
 * whole point of having elevation at all.
 *
 * Two coordinate systems, and mixing them is the bug to watch for:
 *   - **cell coordinates** — what the JSON is authored in, node (0,0) to
 *     (cols, rows), fractional values allowed.
 *   - **world coordinates** — metres, `cell * cellSize`. Everything outside this
 *     file works in metres.
 */
import { clamp, lerp, smoothstep } from './units.ts';

export type FeatureProfile =
  /** Cosine bell: flat at the summit, flat where it meets grade. */
  | 'smooth'
  /** Straight cone or wedge — a constant side slope. */
  | 'linear'
  /** Full height out to the edge of the footprint, then a short blend. */
  | 'plateau'
  /** Full height inside the footprint, a cliff at its edge. */
  | 'step';

interface FeatureBase {
  /** Additive height in metres. Negative digs a basin or a cut. */
  height?: number;
  /** Alias for `height`, kept because the first scenes were written this way. */
  z?: number;
  profile?: FeatureProfile;
}

/** A radially symmetric bump or hollow. The default feature kind. */
export interface HillFeature extends FeatureBase {
  kind?: 'hill';
  /** Centre, in cell coordinates. */
  x: number;
  y: number;
  /** Footprint radius, in cells. */
  radius: number;
  /** Squash along one axis to make an oval; 1 is circular. */
  aspect?: number;
  /** Rotate the oval, degrees counter-clockwise. */
  rotation?: number;
}

/** A hill extruded along a line: an esker, a valley wall, a spoil bank. */
export interface RidgeFeature extends FeatureBase {
  kind: 'ridge';
  from: [number, number];
  to: [number, number];
  /** Half-width of the footprint, in cells. */
  width: number;
}

/**
 * A linear grade: height ramps from 0 at `from` to `height` at `to`, measured
 * along the axis, and holds either side of it. This is the feature that makes
 * a scene that trains can actually climb, as opposed to bumps to go around.
 */
export interface RampFeature extends FeatureBase {
  kind: 'ramp';
  from: [number, number];
  to: [number, number];
  /** If given, the ramp fades out beyond this half-width, in cells. */
  width?: number;
}

/** Value noise, for texture. Deterministic in `seed`. */
export interface NoiseFeature {
  kind: 'noise';
  /** Peak-to-trough amplitude in metres. */
  amplitude: number;
  /** Feature size, in cells. */
  scale?: number;
  seed?: number;
  /** Summed octaves; each halves amplitude and scale. */
  octaves?: number;
}

export type TerrainFeature =
  | HillFeature
  | RidgeFeature
  | RampFeature
  | NoiseFeature;

export interface TerrainSpec {
  cols: number;
  rows: number;
  /** Metres per cell. */
  cellSize?: number;
  /** Height everywhere before features, metres. */
  baseElevation?: number;
  features?: TerrainFeature[];
  /**
   * Explicit node overrides, `[col, row, height]`, applied last. The escape
   * hatch for the one node a feature cannot express — a level yard throat, a
   * bridge abutment.
   */
  nodes?: [number, number, number][];
}

export interface TerrainSample {
  /** Height in metres. */
  z: number;
  /** Unit surface normal. */
  nx: number;
  ny: number;
  nz: number;
  /** Steepest ascent, as rise/run. */
  slope: number;
}

/**
 * 2D value noise. Not simplex, not Perlin — hash the lattice, smoothstep
 * between. It is a handful of lines, it has no gradient artefacts worth caring
 * about at this scale, and it is exactly reproducible from a seed, which
 * matters because a scene has to round-trip through JSON unchanged.
 */
function hash2(ix: number, iy: number, seed: number): number {
  let h = ix * 374761393 + iy * 668265263 + seed * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967295;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smoothstep(x - ix);
  const fy = smoothstep(y - iy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy) * 2 - 1;
}

/** Falloff applied to a normalised distance from a feature's spine or centre. */
function falloff(t: number, profile: FeatureProfile): number {
  if (t >= 1) return 0;
  switch (profile) {
    case 'linear':
      return 1 - t;
    case 'plateau':
      // Flat out to 70% of the footprint, then down.
      return t < 0.7 ? 1 : smoothstep((1 - t) / 0.3);
    case 'step':
      return 1;
    case 'smooth':
    default:
      return (Math.cos(t * Math.PI) + 1) / 2;
  }
}

function heightOf(f: FeatureBase): number {
  return f.height ?? f.z ?? 0;
}

/** Distance from point to segment, and the fraction along the segment. */
function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { dist: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1);
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return { dist: Math.hypot(px - cx, py - cy), t };
}

export class Terrain {
  readonly cols: number;
  readonly rows: number;
  /** Metres per cell. */
  readonly cellSize: number;
  readonly baseElevation: number;
  readonly features: readonly TerrainFeature[];
  /**
   * Node heights, row-major, `(cols+1) * (rows+1)` of them.
   *
   * Mutable, because `terraform` cuts and fills it after the tracks are laid
   * out. Anything that writes here owes a call to `refreshExtent`.
   */
  readonly heights: Float64Array;
  minHeight: number;
  maxHeight: number;
  /**
   * How far the formation under the track sits below the railhead, metres — the
   * depth of the ballast section. Terraforming needs it so the ground does not
   * come up through the ties.
   */
  readonly formationDrop = 0.6;

  private readonly spec: TerrainSpec;

  constructor(spec: TerrainSpec) {
    this.spec = spec;
    this.cols = Math.max(1, Math.floor(spec.cols));
    this.rows = Math.max(1, Math.floor(spec.rows));
    this.cellSize = spec.cellSize ?? 10;
    this.baseElevation = spec.baseElevation ?? 0;
    this.features = spec.features ?? [];

    const nx = this.cols + 1;
    const ny = this.rows + 1;
    this.heights = new Float64Array(nx * ny);
    this.heights.fill(this.baseElevation);
    // Each feature is applied over its own footprint rather than every feature
    // being asked about every node. With a handful of features the difference
    // did not matter; with the eight hundred a located corridor produces it is
    // the difference between a scene that loads in a second and one that takes
    // thirty-seven, because the old way is features × nodes and this is the sum
    // of the footprints.
    for (const f of this.features) {
      const box = footprint(f, this.cols, this.rows);
      for (let r = box.r0; r <= box.r1; r++) {
        const row = r * nx;
        for (let c = box.c0; c <= box.c1; c++) {
          this.heights[row + c]! += this.contribution(f, c, r);
        }
      }
    }
    for (const [c, r, z] of spec.nodes ?? []) {
      if (c >= 0 && c < nx && r >= 0 && r < ny) this.heights[r * nx + c] = z;
    }

    this.minHeight = 0;
    this.maxHeight = 0;
    this.refreshExtent();
  }

  /** Recompute the height range. Call after writing into `heights`. */
  refreshExtent(): void {
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of this.heights) {
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    this.minHeight = lo;
    this.maxHeight = hi;
  }

  /** Extent in metres. */
  get width(): number {
    return this.cols * this.cellSize;
  }
  get depth(): number {
    return this.rows * this.cellSize;
  }

  /** The sparse spec this was built from, for round-tripping to JSON. */
  toJSON(): TerrainSpec {
    return this.spec;
  }

  /**
   * Height at one node, summed over every feature.
   *
   * Not used to bake the grid — that goes feature by feature over each one's
   * footprint — but kept because it is the definition, and because a caller
   * that wants one height without a grid should have it.
   */
  evaluate(c: number, r: number): number {
    let z = this.baseElevation;
    for (const f of this.features) {
      z += this.contribution(f, c, r);
    }
    return z;
  }

  private contribution(f: TerrainFeature, c: number, r: number): number {
    switch (f.kind) {
      case 'noise': {
        const scale = f.scale ?? 8;
        const seed = f.seed ?? 1;
        const octaves = Math.max(1, f.octaves ?? 1);
        let amp = f.amplitude;
        let freq = 1 / Math.max(1e-6, scale);
        let sum = 0;
        for (let o = 0; o < octaves; o++) {
          sum += valueNoise(c * freq, r * freq, seed + o * 101) * amp;
          amp *= 0.5;
          freq *= 2;
        }
        return sum;
      }
      case 'ridge': {
        const [ax, ay] = f.from;
        const [bx, by] = f.to;
        const { dist } = segmentDistance(c, r, ax, ay, bx, by);
        return heightOf(f) * falloff(dist / Math.max(1e-6, f.width), f.profile ?? 'smooth');
      }
      case 'ramp': {
        const [ax, ay] = f.from;
        const [bx, by] = f.to;
        const dx = bx - ax;
        const dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return 0;
        // Unclamped along-axis fraction, clamped to the ends: the ramp holds its
        // top height past `to` so track can run out onto the summit.
        const t = clamp(((c - ax) * dx + (r - ay) * dy) / lenSq, 0, 1);
        let v = heightOf(f) * t;
        if (f.width !== undefined) {
          const { dist } = segmentDistance(c, r, ax, ay, bx, by);
          v *= falloff(dist / Math.max(1e-6, f.width), f.profile ?? 'smooth');
        }
        return v;
      }
      case 'hill':
      case undefined: {
        const hill = f as HillFeature;
        let dx = c - hill.x;
        let dy = r - hill.y;
        if (hill.rotation) {
          const a = (hill.rotation * Math.PI) / 180;
          const cs = Math.cos(a);
          const sn = Math.sin(a);
          const rx = dx * cs + dy * sn;
          const ry = -dx * sn + dy * cs;
          dx = rx;
          dy = ry;
        }
        if (hill.aspect && hill.aspect !== 1) dy /= hill.aspect;
        const dist = Math.hypot(dx, dy);
        return heightOf(hill) * falloff(dist / Math.max(1e-6, hill.radius), hill.profile ?? 'smooth');
      }
      default:
        return 0;
    }
  }

  /** Height at a lattice node, clamped to the edge of the grid. */
  nodeHeight(c: number, r: number): number {
    const nx = this.cols + 1;
    const cc = clamp(Math.round(c), 0, this.cols);
    const rr = clamp(Math.round(r), 0, this.rows);
    return this.heights[rr * nx + cc]!;
  }

  /**
   * Height at an arbitrary world point, bilinear over the cell it falls in.
   * Bilinear rather than nearest because track and wheels ride this surface and
   * a staircase would show up as a train that hops.
   */
  heightAt(wx: number, wy: number): number {
    const cx = clamp(wx / this.cellSize, 0, this.cols);
    const cy = clamp(wy / this.cellSize, 0, this.rows);
    const c0 = Math.min(Math.floor(cx), this.cols - 1);
    const r0 = Math.min(Math.floor(cy), this.rows - 1);
    const fx = cx - c0;
    const fy = cy - r0;
    const nx = this.cols + 1;
    const h00 = this.heights[r0 * nx + c0]!;
    const h10 = this.heights[r0 * nx + c0 + 1]!;
    const h01 = this.heights[(r0 + 1) * nx + c0]!;
    const h11 = this.heights[(r0 + 1) * nx + c0 + 1]!;
    return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fy);
  }

  /** Height and surface normal at a world point. */
  sampleAt(wx: number, wy: number): TerrainSample {
    const h = this.cellSize * 0.5;
    const dzdx = (this.heightAt(wx + h, wy) - this.heightAt(wx - h, wy)) / (2 * h);
    const dzdy = (this.heightAt(wx, wy + h) - this.heightAt(wx, wy - h)) / (2 * h);
    const len = Math.hypot(dzdx, dzdy, 1);
    return {
      z: this.heightAt(wx, wy),
      nx: -dzdx / len,
      ny: -dzdy / len,
      nz: 1 / len,
      slope: Math.hypot(dzdx, dzdy),
    };
  }

  /**
   * Whether one point can see another over the ground between them.
   *
   * A straight march along the line, checking that the ground never rises above
   * it. Cheap — the height field is right there — and it is what `Person.sightFt`
   * in `CROR/sim` has had to be *asserted* for, because nothing could work it
   * out. 115(a) and 105(c) both turn on it.
   *
   * What it does not know about: trains, buildings, trees, or a cut of cars
   * standing in the way. It answers "does the land get in the way", which is the
   * question the terrain can answer honestly.
   */
  hasLineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const span = Math.hypot(bx - ax, by - ay);
    if (span < 1e-6) return true;
    // Half a cell: finer than the terrain's own resolution, so nothing is
    // missed, and coarse enough that a kilometre is a few hundred samples.
    const steps = Math.max(2, Math.ceil((span / this.cellSize) * 2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      if (this.heightAt(x, y) > az + (bz - az) * t) return false;
    }
    return true;
  }

  /** True where the point lies inside the grid footprint. */
  contains(wx: number, wy: number): boolean {
    return wx >= 0 && wy >= 0 && wx <= this.width && wy <= this.depth;
  }
}

/**
 * The block of nodes a feature can possibly affect.
 *
 * Radial features reach their radius; a ridge reaches its width either side of
 * its segment; a ramp is bounded by its own endpoints. Noise is unbounded and
 * gets the whole grid, which is correct and is why a scene should have one noise
 * feature rather than twenty.
 *
 * Generous by a cell all round: the falloff functions reach zero *at* the
 * boundary, and clipping a node early would leave a visible seam.
 */
function footprint(
  f: TerrainFeature,
  cols: number,
  rows: number,
): { c0: number; c1: number; r0: number; r1: number } {
  const all = { c0: 0, c1: cols, r0: 0, r1: rows };
  const clip = (x0: number, x1: number, y0: number, y1: number) => ({
    c0: Math.max(0, Math.floor(x0) - 1),
    c1: Math.min(cols, Math.ceil(x1) + 1),
    r0: Math.max(0, Math.floor(y0) - 1),
    r1: Math.min(rows, Math.ceil(y1) + 1),
  });
  switch (f.kind) {
    case 'noise':
      return all;
    case 'ridge': {
      const w = f.width;
      return clip(
        Math.min(f.from[0], f.to[0]) - w,
        Math.max(f.from[0], f.to[0]) + w,
        Math.min(f.from[1], f.to[1]) - w,
        Math.max(f.from[1], f.to[1]) + w,
      );
    }
    case 'ramp':
      // Not bounded by its endpoints: a ramp **holds its top height past `to`**
      // so that track can run out onto the summit, and it has no lateral limit
      // at all unless it was given a width. Clipping it to the segment cut the
      // plateau off, which the ramp test caught immediately.
      return all;
    default: {
      // A hill, possibly squashed into an oval and rotated: the safe bound is
      // its longest radius in every direction.
      const reach = f.radius * Math.max(1, 1 / Math.max(1e-6, f.aspect ?? 1));
      return clip(f.x - reach, f.x + reach, f.y - reach, f.y + reach);
    }
  }
}
