/**
 * Centripetal Catmull-Rom, and arc-length resampling.
 *
 * A track is authored as a handful of control points; the physics needs a curve
 * parameterised by *distance*, because a car's position is a distance and its
 * curve resistance depends on the radius at that distance. Catmull-Rom passes
 * through its control points, which is what you want when someone drops a point
 * on a summit and expects the track to cross there.
 *
 * Centripetal (alpha = 0.5) rather than uniform: uniform Catmull-Rom cusps and
 * self-intersects when control points are unevenly spaced, and unevenly spaced
 * is the normal case for hand-placed track.
 */
export interface Point2 {
  x: number;
  y: number;
}

const ALPHA = 0.5;

function tj(ti: number, a: Point2, b: Point2): number {
  return ti + Math.pow(Math.hypot(b.x - a.x, b.y - a.y), ALPHA);
}

/** One Catmull-Rom segment, evaluated at u in [0,1] over p1..p2. */
function segment(p0: Point2, p1: Point2, p2: Point2, p3: Point2, u: number): Point2 {
  const t0 = 0;
  const t1 = tj(t0, p0, p1);
  const t2 = tj(t1, p1, p2);
  const t3 = tj(t2, p2, p3);
  // Degenerate spacing (duplicate control points) collapses the knot vector;
  // fall back to the straight chord rather than dividing by zero.
  if (!(t1 > t0) || !(t2 > t1) || !(t3 > t2)) {
    return { x: p1.x + (p2.x - p1.x) * u, y: p1.y + (p2.y - p1.y) * u };
  }
  const t = t1 + (t2 - t1) * u;
  const a1x = ((t1 - t) / (t1 - t0)) * p0.x + ((t - t0) / (t1 - t0)) * p1.x;
  const a1y = ((t1 - t) / (t1 - t0)) * p0.y + ((t - t0) / (t1 - t0)) * p1.y;
  const a2x = ((t2 - t) / (t2 - t1)) * p1.x + ((t - t1) / (t2 - t1)) * p2.x;
  const a2y = ((t2 - t) / (t2 - t1)) * p1.y + ((t - t1) / (t2 - t1)) * p2.y;
  const a3x = ((t3 - t) / (t3 - t2)) * p2.x + ((t - t2) / (t3 - t2)) * p3.x;
  const a3y = ((t3 - t) / (t3 - t2)) * p2.y + ((t - t2) / (t3 - t2)) * p3.y;
  const b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x;
  const b1y = ((t2 - t) / (t2 - t0)) * a1y + ((t - t0) / (t2 - t0)) * a2y;
  const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x;
  const b2y = ((t3 - t) / (t3 - t1)) * a2y + ((t - t1) / (t3 - t1)) * a3y;
  return {
    x: ((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x,
    y: ((t2 - t) / (t2 - t1)) * b1y + ((t - t1) / (t2 - t1)) * b2y,
  };
}

/**
 * Densely sample a Catmull-Rom curve through `points`, then resample the result
 * at uniform `spacing` so index arithmetic is distance arithmetic downstream.
 *
 * Two passes rather than one because Catmull-Rom is not arc-length
 * parameterised: stepping u uniformly bunches samples in the curves, which is
 * precisely where curvature needs resolution.
 */
export function resampleCurve(
  points: readonly Point2[],
  closed: boolean,
  spacing: number,
): { samples: Point2[]; length: number } {
  if (points.length === 0) return { samples: [], length: 0 };
  if (points.length === 1) return { samples: [{ ...points[0]! }], length: 0 };
  if (points.length === 2 && !closed) {
    const [a, b] = points as [Point2, Point2];
    return resamplePolyline([a, b], false, spacing);
  }

  const n = points.length;
  const at = (i: number): Point2 => {
    if (closed) return points[((i % n) + n) % n]!;
    // Open curve: reflect the end points so the curve reaches its ends.
    if (i < 0) {
      const p0 = points[0]!;
      const p1 = points[1]!;
      return { x: 2 * p0.x - p1.x, y: 2 * p0.y - p1.y };
    }
    if (i >= n) {
      const pl = points[n - 1]!;
      const pp = points[n - 2]!;
      return { x: 2 * pl.x - pp.x, y: 2 * pl.y - pp.y };
    }
    return points[i]!;
  };

  const dense: Point2[] = [];
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    // Subdivision proportional to chord length, so a long straight leg is not
    // sampled at the same density as a tight curve.
    const steps = Math.max(8, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / spacing) * 4);
    for (let s = 0; s < steps; s++) {
      dense.push(segment(p0, p1, p2, p3, s / steps));
    }
  }
  if (!closed) dense.push({ ...points[n - 1]! });

  return resamplePolyline(dense, closed, spacing);
}

/** Resample a polyline at uniform arc-length `spacing`. */
export function resamplePolyline(
  dense: readonly Point2[],
  closed: boolean,
  spacing: number,
): { samples: Point2[]; length: number } {
  if (dense.length < 2) return { samples: dense.map((p) => ({ ...p })), length: 0 };

  const pts = closed ? [...dense, { ...dense[0]! }] : dense;
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    cum.push(cum[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = cum[cum.length - 1]!;
  if (total === 0) return { samples: [{ ...pts[0]! }], length: 0 };

  // A closed curve must come out to a whole number of samples or the seam gets a
  // short segment that reads as a kink in curvature.
  const count = Math.max(2, Math.round(total / spacing));
  const step = total / count;
  const emit = closed ? count : count + 1;

  const samples: Point2[] = [];
  let seg = 1;
  for (let i = 0; i < emit; i++) {
    const target = Math.min(i * step, total);
    while (seg < cum.length - 1 && cum[seg]! < target) seg++;
    const s0 = cum[seg - 1]!;
    const s1 = cum[seg]!;
    const u = s1 > s0 ? (target - s0) / (s1 - s0) : 0;
    const a = pts[seg - 1]!;
    const b = pts[seg]!;
    samples.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
  }
  return { samples, length: total };
}
