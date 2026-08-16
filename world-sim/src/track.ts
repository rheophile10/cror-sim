/**
 * Track: a curve in plan, draped over the terrain, then *graded*.
 *
 * Draping alone gives unusable track. Raw terrain sampled every couple of metres
 * has half-metre steps in it, which come out as ±20% grades and a train that
 * cannot move. Real track is built on earthworks — cuts and fills that smooth
 * the profile — so this does the same thing: sample the ground, low-pass the
 * profile, then relax it until no sample exceeds a stated maximum grade. What is
 * left is the railhead elevation, and the difference against the ground is the
 * cut or fill, which the renderer draws.
 *
 * A `TrackPath` is queried by **distance in metres from its start**. That is the
 * coordinate the physics integrates in, and the reason the curve is resampled to
 * uniform spacing rather than left in its natural parameterisation.
 *
 * Only single paths for now — no turnouts, no branching. Switches belong with
 * the `CROR/sim` topology model (nodes, ports, tracks), and joining the two is
 * the next piece of work, not this one.
 */
import type { TrackEndSpec } from './network.ts';
import { resampleCurve, type Point2 } from './spline.ts';
import type { TerraformOptions } from './terraform.ts';
import type { Terrain } from './terrain.ts';
import { clamp } from './units.ts';

/** A generated oval, for scenes that want a test loop without hand-placing points. */
export interface LoopSpec {
  /** Centre, in cell coordinates. */
  center: [number, number];
  /** Radii in cells. */
  radiusX: number;
  radiusY?: number;
  /** Sinusoidal wander added to the radius, in cells — makes the loop interesting. */
  wobble?: number;
  wobbleCycles?: number;
  /** Control points generated around the oval. */
  points?: number;
  rotation?: number;
}

export interface TrackSpec {
  id?: string;
  label?: string;
  /** Control points in **cell coordinates**, as terrain features are. */
  points?: [number, number][];
  /** Alternative to `points`: generate an oval. */
  loop?: LoopSpec;
  closed?: boolean;
  /** Distance between path samples, metres. */
  spacing?: number;
  /**
   * Earthwork smoothing passes over the elevation profile. 0 rides the raw
   * ground; the default builds something a train can run on.
   */
  smoothing?: number;
  /** Ruling grade, percent. The profile is relaxed until nothing exceeds it. */
  maxGrade?: number;
  /** Railhead height above the ground line, metres. */
  ballastHeight?: number;
  /** Track gauge in metres; 1.435 is standard. Rendering only, so far. */
  gauge?: number;
  /**
   * Which node the low-mileage end attaches to. A track with neither `from` nor
   * `to` stands alone, which is what every single-track scene is.
   */
  from?: TrackEndSpec;
  /** Which node the high-mileage end attaches to. */
  to?: TrackEndSpec;
  /**
   * Cut and fill the terrain to carry this track. `false` leaves the ground
   * alone, which shows the bare grade line floating over it — occasionally what
   * you want when checking what the grading step did, rarely what you want to
   * look at. See `terraform.ts` for the options.
   */
  terraform?: false | TerraformOptions;
}

export interface TrackPoint {
  /** Distance from the start of the path, metres. */
  s: number;
  x: number;
  y: number;
  /** Railhead elevation, metres. */
  z: number;
  /**
   * Ground elevation under the track as it now stands. Equal to the formation
   * once `terraform` has cut the earthworks, so the difference against `z` is
   * just the ballast section.
   */
  ground: number;
  /**
   * Ground elevation before any earthwork — below `z` where the line is on
   * fill, above it where it is in cut. The depth of the works is
   * `z - naturalGround`, and it is the number worth reporting when asking how
   * expensive a route is.
   */
  naturalGround: number;
  /** Plan bearing, radians, atan2(dy, dx). */
  heading: number;
  /** Signed 1/radius, metres⁻¹. Positive turns left. */
  curvature: number;
  /** Signed rise/run; positive ascends with increasing `s`. */
  grade: number;
}

const TAU = Math.PI * 2;

/** Shortest signed difference between two angles. */
function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

function loopControlPoints(loop: LoopSpec): [number, number][] {
  const n = Math.max(6, loop.points ?? 16);
  const [cx, cy] = loop.center;
  const rx = loop.radiusX;
  const ry = loop.radiusY ?? loop.radiusX;
  const wob = loop.wobble ?? 0;
  const cycles = loop.wobbleCycles ?? 2;
  const rot = ((loop.rotation ?? 0) * Math.PI) / 180;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU;
    const k = 1 + (wob / Math.max(rx, ry)) * Math.sin(t * cycles);
    const px = Math.cos(t) * rx * k;
    const py = Math.sin(t) * ry * k;
    out.push([cx + px * Math.cos(rot) - py * Math.sin(rot), cy + px * Math.sin(rot) + py * Math.cos(rot)]);
  }
  return out;
}

export class TrackPath {
  readonly id: string;
  readonly label: string | undefined;
  readonly closed: boolean;
  readonly gauge: number;
  /** Ruling grade as a signed fraction (0.022 for 2.2%). */
  readonly maxGrade: number;
  /** Node attachment at the `s = 0` end, if any. */
  readonly startNode: TrackEndSpec | undefined;
  /** Node attachment at the `s = length` end, if any. */
  readonly endNode: TrackEndSpec | undefined;
  /** Uniformly spaced samples; `spacing` metres apart. */
  readonly samples: readonly TrackPoint[];
  readonly spacing: number;
  /** Total length, metres. For a closed path this includes the closing segment. */
  readonly length: number;

  private readonly spec: TrackSpec;
  /** The natural ground under each sample, kept so the profile can be redone. */
  private readonly groundProfile: Float64Array;
  /** Spacing actually used between samples, metres. */
  private readonly ds: number;
  private readonly ballast: number;

  constructor(spec: TrackSpec, terrain: Terrain) {
    this.spec = spec;
    this.id = spec.id ?? 'track';
    this.label = spec.label;
    // A track wired into the network is an edge, never a loop, whatever the
    // generator would otherwise have made of it.
    this.closed = (spec.closed ?? spec.loop !== undefined) && !spec.from && !spec.to;
    this.gauge = spec.gauge ?? 1.435;
    this.maxGrade = (spec.maxGrade ?? 2.2) / 100;
    this.startNode = spec.from;
    this.endNode = spec.to;
    this.spacing = Math.max(0.5, spec.spacing ?? 2);

    const control = spec.points ?? (spec.loop ? loopControlPoints(spec.loop) : []);
    if (control.length < 2) {
      throw new Error(`track "${this.id}": needs at least two control points`);
    }
    const cells: Point2[] = control.map(([c, r]) => ({
      x: c * terrain.cellSize,
      y: r * terrain.cellSize,
    }));

    const { samples: plan } = resampleCurve(cells, this.closed, this.spacing);
    const n = plan.length;
    // Uniform spacing means every span is the same length; recompute it from the
    // sample count so the closed seam is exact.
    const ds = this.measure(plan, this.closed) / (this.closed ? n : n - 1);

    const ground = new Float64Array(n);
    for (let i = 0; i < n; i++) ground[i] = terrain.heightAt(plan[i]!.x, plan[i]!.y);

    this.groundProfile = ground;
    this.ds = ds;
    this.ballast = spec.ballastHeight ?? 0.6;
    const rail = this.gradeProfile(ground, ds, spec);
    const ballast = this.ballast;

    const pts: TrackPoint[] = [];
    for (let i = 0; i < n; i++) {
      pts.push({
        s: i * ds,
        x: plan[i]!.x,
        y: plan[i]!.y,
        z: rail[i]! + ballast,
        ground: ground[i]!,
        naturalGround: ground[i]!,
        heading: 0,
        curvature: 0,
        grade: 0,
      });
    }
    this.attachDerivatives(pts, ds);
    this.samples = pts;
    this.length = this.closed ? n * ds : (n - 1) * ds;
  }

  private measure(plan: readonly Point2[], closed: boolean): number {
    let total = 0;
    for (let i = 1; i < plan.length; i++) {
      total += Math.hypot(plan[i]!.x - plan[i - 1]!.x, plan[i]!.y - plan[i - 1]!.y);
    }
    if (closed && plan.length > 1) {
      total += Math.hypot(
        plan[0]!.x - plan[plan.length - 1]!.x,
        plan[0]!.y - plan[plan.length - 1]!.y,
      );
    }
    return total;
  }

  /** Index helper honouring wrap on a closed path and clamping on an open one. */
  private idx(i: number, n: number): number {
    if (this.closed) return ((i % n) + n) % n;
    return clamp(i, 0, n - 1);
  }

  /**
   * Turn a ground profile into a railhead profile: a [1 2 1] low-pass for the
   * general shape of the earthworks, then grade limiting.
   *
   * Grade limiting is done as the *average of two envelopes*, not by relaxing
   * over-steep spans in place. Relaxation is diffusion, and diffusion takes
   * O(n²) sweeps to carry a correction from a summit out to where the fill has
   * to start, which in practice means it silently gives up and leaves a wall in
   * the profile.
   *
   * The envelopes converge in a couple of sweeps each:
   *   - the **lower** envelope is the highest profile at or below ground that
   *     holds the grade — cut only, a trench through every hill;
   *   - the **upper** envelope is the lowest profile at or above ground that
   *     holds it — fill only, a viaduct across every valley.
   *
   * Their average holds the grade too (grade is linear in elevation, so the
   * average of two bounded slopes is bounded by the same number) and it balances
   * cut against fill instead of committing to one, which is what a location
   * engineer is doing when they set a grade line.
   */
  private gradeProfile(
    ground: Float64Array,
    ds: number,
    spec: TrackSpec,
    pinStart?: number,
    pinEnd?: number,
  ): Float64Array {
    const n = ground.length;
    const z = Float64Array.from(ground);
    const passes = spec.smoothing ?? 24;
    const next = new Float64Array(n);
    for (let p = 0; p < passes; p++) {
      for (let i = 0; i < n; i++) {
        const a = z[this.idx(i - 1, n)]!;
        const b = z[i]!;
        const c = z[this.idx(i + 1, n)]!;
        next[i] = (a + 2 * b + c) / 4;
      }
      z.set(next);
    }

    const maxGrade = (spec.maxGrade ?? 2.2) / 100;
    const pinned = pinStart !== undefined || pinEnd !== undefined;
    if (maxGrade <= 0) {
      if (pinned) this.pin(z, pinStart, pinEnd);
      return z;
    }

    const maxRise = maxGrade * ds;
    const limit = (src: Float64Array): Float64Array => {
      const lower = this.envelope(src, maxRise, 'cut');
      const upper = this.envelope(src, maxRise, 'fill');
      const out = new Float64Array(src.length);
      for (let i = 0; i < src.length; i++) out[i] = (lower[i]! + upper[i]!) / 2;
      return out;
    };

    let out = limit(z);
    if (pinned) {
      // Correct to the pins, re-limit, correct again: two rounds is enough for
      // the ramp to become small, and the last word belongs to the pins.
      for (let pass = 0; pass < 2; pass++) {
        this.pin(out, pinStart, pinEnd);
        out = limit(out);
      }
      this.pin(out, pinStart, pinEnd);
    }
    return out;
  }

  /** Shift a profile by a linear ramp so its ends sit at the given heights. */
  private pin(z: Float64Array, pinStart?: number, pinEnd?: number): void {
    const n = z.length;
    if (n < 2) {
      if (n === 1 && pinStart !== undefined) z[0] = pinStart;
      return;
    }
    const head = pinStart === undefined ? 0 : pinStart - z[0]!;
    const tail = pinEnd === undefined ? 0 : pinEnd - z[n - 1]!;
    if (head === 0 && tail === 0) return;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      z[i] = z[i]! + head * (1 - t) + tail * t;
    }
  }

  /**
   * Grade-limited envelope of a profile. `cut` only ever lowers elevations,
   * `fill` only ever raises them; both come out with no span steeper than
   * `maxRise`.
   *
   * A forward and a backward sweep settle an open path exactly. A closed path
   * needs the sweeps repeated until nothing moves, because a correction can
   * chase itself around the loop — and if the loop cannot hold the grade at all
   * it converges on a level circle, which is the right answer.
   */
  private envelope(src: Float64Array, maxRise: number, mode: 'cut' | 'fill'): Float64Array {
    const n = src.length;
    const z = Float64Array.from(src);
    const spans = this.closed ? n : n - 1;
    const laps = this.closed ? n : 1;
    const sign = mode === 'cut' ? 1 : -1;
    for (let lap = 0; lap < laps; lap++) {
      let changed = false;
      const limit = (from: number, to: number) => {
        const bound = z[from]! + sign * maxRise;
        if (sign * (z[to]! - bound) > 1e-12) {
          z[to] = bound;
          changed = true;
        }
      };
      for (let i = 0; i < spans; i++) limit(i, this.idx(i + 1, n));
      for (let i = spans - 1; i >= 0; i--) limit(this.idx(i + 1, n), i);
      if (!changed) break;
    }
    return z;
  }

  private attachDerivatives(pts: TrackPoint[], ds: number): void {
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[this.idx(i - 1, n)]!;
      const b = pts[this.idx(i + 1, n)]!;
      // On an open path the end samples get a one-sided difference, which the
      // clamped index produces for free (a and b collapse to a neighbour).
      const span = this.closed || (i > 0 && i < n - 1) ? 2 * ds : ds;
      pts[i]!.heading = Math.atan2(b.y - a.y, b.x - a.x);
      pts[i]!.grade = (b.z - a.z) / span;
    }
    for (let i = 0; i < n; i++) {
      const a = pts[this.idx(i - 1, n)]!;
      const b = pts[this.idx(i + 1, n)]!;
      const span = this.closed || (i > 0 && i < n - 1) ? 2 * ds : ds;
      pts[i]!.curvature = angleDelta(b.heading, a.heading) / span;
    }
  }

  /** Normalise a distance: wrapped on a closed path, clamped on an open one. */
  normalize(s: number): number {
    if (!this.closed) return clamp(s, 0, this.length);
    const l = this.length;
    return ((s % l) + l) % l;
  }

  /** True once `s` has run off the end of an open path. */
  isOffEnd(s: number): boolean {
    return !this.closed && (s < 0 || s > this.length);
  }

  /** Interpolated track state at a distance along the path. */
  at(s: number): TrackPoint {
    const n = this.samples.length;
    const ds = this.length / (this.closed ? n : n - 1);
    const sn = this.normalize(s);
    const f = sn / ds;
    const i0 = Math.floor(f);
    const u = f - i0;
    const a = this.samples[this.idx(i0, n)]!;
    const b = this.samples[this.idx(i0 + 1, n)]!;
    return {
      s: sn,
      x: a.x + (b.x - a.x) * u,
      y: a.y + (b.y - a.y) * u,
      z: a.z + (b.z - a.z) * u,
      ground: a.ground + (b.ground - a.ground) * u,
      naturalGround: a.naturalGround + (b.naturalGround - a.naturalGround) * u,
      heading: a.heading + angleDelta(b.heading, a.heading) * u,
      curvature: a.curvature + (b.curvature - a.curvature) * u,
      grade: a.grade + (b.grade - a.grade) * u,
    };
  }

  /**
   * Redo the elevation profile with its ends pinned to given heights.
   *
   * Tracks are graded one at a time, each over its own length, so the elevation
   * a track happens to end at is whatever its own smoothing and grade limiting
   * produced. Two tracks meeting at a switch have no reason to agree, and they
   * do not: the seam comes out as a step of a metre or several, and a route
   * through a few turnouts climbs a staircase that is not in the terrain at all.
   *
   * So `World` works out one elevation per node and re-grades every track to
   * meet it. The profile is recomputed as before and then corrected by a linear
   * ramp that forces the ends exactly, iterating so the grade limiting and the
   * correction settle against each other. A pinned profile can end up slightly
   * over the ruling grade — the nodes win, because a discontinuity is a worse
   * lie than a 2.1% grade on a 2% railway.
   */
  regrade(pinStart?: number, pinEnd?: number): void {
    if (this.closed) return;
    const rail = this.gradeProfile(this.groundProfile, this.ds, this.spec, pinStart, pinEnd);
    const pts = this.samples as TrackPoint[];
    for (let i = 0; i < pts.length; i++) pts[i]!.z = rail[i]! + this.ballast;
    this.attachDerivatives(pts, this.ds);
  }

  /**
   * Re-read the ground line from the terrain.
   *
   * Called after `terraform` has cut the earthworks, so that `ground` describes
   * the formation the track is now sitting on rather than the hillside that
   * used to be there. `naturalGround` is left alone — that is the record of what
   * was dug away.
   */
  refreshGround(terrain: Terrain): void {
    for (const s of this.samples as TrackPoint[]) {
      s.ground = terrain.heightAt(s.x, s.y);
    }
  }

  toJSON(): TrackSpec {
    return this.spec;
  }
}
