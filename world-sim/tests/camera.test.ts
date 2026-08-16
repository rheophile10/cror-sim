import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IsoCamera } from '../src/render/camera.ts';

const cam = (over: Partial<{ yaw: number; pitch: number; zoom: number }> = {}) => {
  const c = new IsoCamera({ yaw: 45, pitch: 30, zoom: 4, focus: { x: 100, y: 100, z: 0 }, ...over });
  c.width = 800;
  c.height = 600;
  return c;
};

test('the focus point lands in the middle of the viewport', () => {
  const c = cam();
  const p = c.project(100, 100, 0);
  assert.ok(Math.abs(p.sx - 400) < 1e-9);
  assert.ok(Math.abs(p.sy - 300) < 1e-9);
});

test('unproject inverts project on the focus plane', () => {
  const c = cam({ yaw: 37, pitch: 41 });
  for (const [x, y] of [[0, 0], [250, 80], [-40, 900]] as [number, number][]) {
    const p = c.project(x, y, 0);
    const back = c.unproject(p.sx, p.sy, 0);
    assert.ok(Math.hypot(back.x - x, back.y - y) < 1e-6, `${x},${y} round-tripped to ${back.x},${back.y}`);
  }
});

test('height moves a point up the screen and toward the camera', () => {
  const c = cam();
  const ground = c.project(100, 140, 0);
  const raised = c.project(100, 140, 20);
  assert.ok(raised.sy < ground.sy, 'higher is further up the screen');
  assert.ok(raised.depth < ground.depth, 'and nearer the camera, so it paints over');
  assert.ok(Math.abs(raised.sx - ground.sx) < 1e-9, 'and does not slide sideways');
});

test('a plan view flattens height out of the picture', () => {
  const c = cam({ pitch: 89.5 });
  const a = c.project(100, 140, 0);
  const b = c.project(100, 140, 50);
  assert.ok(Math.abs(a.sy - b.sy) < 2, 'height barely registers looking straight down');
});

test('faces pointing away from the camera are culled', () => {
  const c = cam({ yaw: 0 });
  const view = c.viewDirection();
  // Yaw 0 looks toward +y and downward: a face whose normal is −y is toward us.
  const towards = { x: 0, y: -1, z: 0 };
  const away = { x: 0, y: 1, z: 0 };
  const dot = (n: { x: number; y: number; z: number }) => n.x * view.x + n.y * view.y + n.z * view.z;
  assert.ok(dot(towards) < 0);
  assert.ok(dot(away) > 0);
  assert.ok(dot({ x: 0, y: 0, z: 1 }) < 0, 'and up-facing surfaces are always visible');
});

test('framing a box fits it on screen', () => {
  const c = cam();
  c.frame({ minX: 0, minY: 0, maxX: 1000, maxY: 1000, minZ: 0, maxZ: 100 });
  for (const [x, y, z] of [[0, 0, 0], [1000, 0, 0], [1000, 1000, 100], [0, 1000, 0]] as [number, number, number][]) {
    const p = c.project(x, y, z);
    assert.ok(p.sx >= -1 && p.sx <= 801, `x ${p.sx} off screen`);
    assert.ok(p.sy >= -1 && p.sy <= 601, `y ${p.sy} off screen`);
  }
});

test('zooming about a screen point keeps that point under the cursor', () => {
  const c = cam();
  const before = c.unproject(600, 200, 0);
  c.zoomBy(1.5, 600, 200);
  const after = c.unproject(600, 200, 0);
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1e-6);
});
