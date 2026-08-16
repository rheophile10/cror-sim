import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Terrain } from '../src/terrain.ts';
import { TrackPath } from '../src/track.ts';
import { curvatureToDegrees } from '../src/units.ts';

const flat = (): Terrain => new Terrain({ cols: 100, rows: 100, cellSize: 10, baseElevation: 0 });

test('a straight line on flat ground has no grade and no curvature', () => {
  const path = new TrackPath(
    { points: [[10, 50], [50, 50], [90, 50]], spacing: 5 },
    flat(),
  );
  assert.ok(Math.abs(path.length - 800) < 1);
  for (const p of path.samples) {
    assert.ok(Math.abs(p.grade) < 1e-9);
    assert.ok(Math.abs(p.curvature) < 1e-6);
  }
});

test('a generated loop closes, and its curvature matches its radius', () => {
  const terrain = flat();
  const r = 30 * terrain.cellSize; // 300 m
  const path = new TrackPath(
    { loop: { center: [50, 50], radiusX: 30, points: 24 }, spacing: 4 },
    terrain,
  );
  assert.equal(path.closed, true);
  assert.ok(Math.abs(path.length - 2 * Math.PI * r) / (2 * Math.PI * r) < 0.02);

  const mid = path.samples[Math.floor(path.samples.length / 2)]!;
  assert.ok(Math.abs(Math.abs(mid.curvature) - 1 / r) / (1 / r) < 0.05);
  // ~5.8 degrees of curve for a 300 m radius.
  assert.ok(Math.abs(curvatureToDegrees(mid.curvature) - 5.8) < 0.5);

  // Wrapping is seamless: one lap past a point returns the same point.
  const a = path.at(123);
  const b = path.at(123 + path.length);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-6);
});

test('grading holds the ruling grade over ground that does not', () => {
  const terrain = new Terrain({
    cols: 100,
    rows: 100,
    cellSize: 10,
    features: [
      { x: 50, y: 50, radius: 20, height: 120, profile: 'linear' },
      { kind: 'noise', amplitude: 6, scale: 3, seed: 5 },
    ],
  });
  const raw = new TrackPath(
    { points: [[10, 50], [50, 50], [90, 50]], spacing: 4, smoothing: 0, maxGrade: 0 },
    terrain,
  );
  const graded = new TrackPath(
    { points: [[10, 50], [50, 50], [90, 50]], spacing: 4, maxGrade: 2 },
    terrain,
  );

  const worst = (p: TrackPath) => Math.max(...p.samples.map((s) => Math.abs(s.grade)));
  assert.ok(worst(raw) > 0.05, 'raw ground is far too steep to run on');
  assert.ok(worst(graded) <= 0.0225, `graded profile holds 2%, got ${worst(graded)}`);
});

test('the railhead sits above the ground on fill and below it in cut', () => {
  const terrain = new Terrain({
    cols: 100,
    rows: 100,
    cellSize: 10,
    features: [{ x: 50, y: 50, radius: 12, height: 60, profile: 'smooth' }],
  });
  const path = new TrackPath(
    { points: [[10, 50], [50, 50], [90, 50]], spacing: 4, maxGrade: 2, ballastHeight: 0 },
    terrain,
  );
  const cuts = path.samples.filter((s) => s.z < s.ground - 1);
  const fills = path.samples.filter((s) => s.z > s.ground + 1);
  assert.ok(cuts.length > 0, 'the summit is cut through');
  assert.ok(fills.length > 0, 'the approaches are filled');
});

test('an open path clamps at its ends rather than wrapping', () => {
  const path = new TrackPath({ points: [[10, 10], [10, 50], [10, 90]], spacing: 5 }, flat());
  assert.equal(path.closed, false);
  assert.equal(path.isOffEnd(-5), true);
  assert.equal(path.isOffEnd(path.length + 5), true);
  assert.equal(path.at(-100).s, 0);
  assert.equal(path.at(path.length + 100).s, path.length);
});
