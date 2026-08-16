import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Terrain } from '../src/terrain.ts';

test('base elevation is the floor when there are no features', () => {
  const t = new Terrain({ cols: 4, rows: 4, cellSize: 10, baseElevation: 7 });
  assert.equal(t.minHeight, 7);
  assert.equal(t.maxHeight, 7);
  assert.equal(t.heightAt(25, 25), 7);
});

test('a smooth hill peaks at its centre and dies at its radius', () => {
  const t = new Terrain({
    cols: 20,
    rows: 20,
    cellSize: 10,
    baseElevation: 0,
    features: [{ x: 10, y: 10, radius: 5, height: 30, profile: 'smooth' }],
  });
  assert.equal(t.nodeHeight(10, 10), 30);
  assert.ok(Math.abs(t.nodeHeight(15, 10)) < 1e-9, 'zero at the edge of the footprint');
  assert.equal(t.nodeHeight(0, 0), 0, 'nothing outside the footprint');
  // Monotone down the flank.
  assert.ok(t.nodeHeight(11, 10) > t.nodeHeight(12, 10));
  assert.ok(t.nodeHeight(12, 10) > t.nodeHeight(13, 10));
});

test('features add, so a basin can be cut into a hill', () => {
  const t = new Terrain({
    cols: 20,
    rows: 20,
    features: [
      { x: 10, y: 10, radius: 8, height: 40 },
      { x: 10, y: 10, radius: 3, height: -15 },
    ],
  });
  assert.equal(t.nodeHeight(10, 10), 25);
});

test('a ramp climbs linearly along its axis and holds past the end', () => {
  const t = new Terrain({
    cols: 20,
    rows: 20,
    cellSize: 10,
    features: [{ kind: 'ramp', from: [0, 10], to: [10, 10], height: 50 }],
  });
  assert.equal(t.nodeHeight(0, 10), 0);
  assert.ok(Math.abs(t.nodeHeight(5, 10) - 25) < 1e-9);
  assert.equal(t.nodeHeight(10, 10), 50);
  assert.equal(t.nodeHeight(18, 10), 50, 'holds its summit past `to`');
});

test('explicit node overrides win over features', () => {
  const t = new Terrain({
    cols: 4,
    rows: 4,
    baseElevation: 0,
    features: [{ x: 2, y: 2, radius: 3, height: 20 }],
    nodes: [[2, 2, -5]],
  });
  assert.equal(t.nodeHeight(2, 2), -5);
});

test('sampling is bilinear between nodes, and clamps outside the grid', () => {
  const t = new Terrain({ cols: 2, rows: 2, cellSize: 10, nodes: [[1, 1, 10]] });
  // Node (1,1) is 10, its four neighbours 0: the centre of a cell touching it
  // is a quarter of the way there.
  assert.ok(Math.abs(t.heightAt(5, 5) - 2.5) < 1e-9);
  assert.equal(t.heightAt(-100, -100), t.heightAt(0, 0));
  assert.equal(t.contains(-1, 5), false);
});

test('noise is reproducible from its seed', () => {
  const spec = {
    cols: 16,
    rows: 16,
    features: [{ kind: 'noise' as const, amplitude: 10, scale: 4, seed: 42 }],
  };
  const a = new Terrain(spec);
  const b = new Terrain(spec);
  assert.deepEqual(Array.from(a.heights), Array.from(b.heights));
  const c = new Terrain({ ...spec, features: [{ kind: 'noise', amplitude: 10, scale: 4, seed: 43 }] });
  assert.notDeepEqual(Array.from(a.heights), Array.from(c.heights));
});

test('the surface normal points uphill-negative on a slope', () => {
  const t = new Terrain({
    cols: 20,
    rows: 20,
    cellSize: 10,
    features: [{ kind: 'ramp', from: [0, 10], to: [20, 10], height: 100 }],
  });
  const s = t.sampleAt(100, 100);
  // Rising toward +x, so the normal leans toward −x, and the slope is 100 m of
  // rise over 200 m of run.
  assert.ok(s.nx < 0);
  assert.ok(Math.abs(s.slope - 0.5) < 0.02);
});
