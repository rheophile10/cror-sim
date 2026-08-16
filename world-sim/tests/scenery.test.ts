import assert from 'node:assert/strict';
import { test } from 'node:test';
import { World, type SceneSpec } from '../src/world.ts';

const base = (scenery: SceneSpec['scenery']): SceneSpec => ({
  terrain: { cols: 60, rows: 40, cellSize: 12, baseElevation: 4 },
  tracks: [{ id: 'main', points: [[2, 20], [30, 20], [58, 20]], spacing: 2 }],
  scenery,
});

test('a forest expands to trees standing on the ground', () => {
  const world = new World(
    base([{ kind: 'forest', from: [2, 28], to: [58, 38], count: 80, seed: 5, clearance: 0 }]),
  );
  assert.equal(world.scenery.trees.length, 80);
  for (const tree of world.scenery.trees) {
    assert.ok(Math.abs(tree.z - world.terrain.heightAt(tree.x, tree.y)) < 1e-9, 'planted on the surface');
    assert.ok(tree.height > 0 && tree.radius > 0);
    assert.ok(world.terrain.contains(tree.x, tree.y));
  }
});

test('the same seed plants the same forest twice', () => {
  const spec = base([{ kind: 'forest', from: [2, 28], to: [58, 38], count: 40, seed: 5, clearance: 0 }]);
  const a = new World(spec).scenery.trees.map((t) => [t.x, t.y, t.height]);
  const b = new World(spec).scenery.trees.map((t) => [t.x, t.y, t.height]);
  assert.deepEqual(a, b);

  const other = new World(
    base([{ kind: 'forest', from: [2, 28], to: [58, 38], count: 40, seed: 6, clearance: 0 }]),
  ).scenery.trees.map((t) => [t.x, t.y, t.height]);
  assert.notDeepEqual(a, other);
});

test('nothing grows on the right-of-way', () => {
  // A planting area straddling the track, with a clearance that must be honoured.
  const clearance = 20;
  const world = new World(
    base([{ kind: 'forest', from: [2, 10], to: [58, 30], count: 400, seed: 3, clearance }]),
  );
  const track = world.tracks[0]!;
  assert.ok(world.scenery.trees.length > 50, 'it still planted a forest');

  for (const tree of world.scenery.trees) {
    let nearest = Infinity;
    for (const s of track.samples) {
      nearest = Math.min(nearest, Math.hypot(s.x - tree.x, s.y - tree.y));
    }
    assert.ok(nearest >= clearance * 0.75, `a tree stands ${nearest.toFixed(1)} m from the track`);
  }
});

test('a treeline keeps trees off the summits', () => {
  const world = new World({
    terrain: {
      cols: 60,
      rows: 60,
      cellSize: 12,
      baseElevation: 2,
      features: [{ x: 30, y: 30, radius: 20, height: 120 }],
    },
    scenery: [
      { kind: 'forest', from: [2, 2], to: [58, 58], count: 300, seed: 8, clearance: 0, maxElevation: 60 },
    ],
  });
  assert.ok(world.scenery.trees.length > 20);
  for (const tree of world.scenery.trees) assert.ok(tree.z <= 60);
});

test('roads are draped on the ground and know their length', () => {
  const world = new World(
    base([{ kind: 'road', id: 'hwy', points: [[2, 30], [30, 32], [58, 30]], width: 8 }]),
  );
  const road = world.scenery.roads[0]!;
  assert.equal(road.id, 'hwy');
  assert.ok(road.length > 600);
  for (const s of road.samples) {
    assert.ok(Math.abs(s.z - world.terrain.heightAt(s.x, s.y)) < 1e-9, 'follows the ground');
  }
});

test('traffic drives its road and wraps round', () => {
  const world = new World(
    base([
      { kind: 'road', id: 'hwy', points: [[2, 30], [30, 32], [58, 30]], width: 8 },
      { kind: 'vehicle', road: 'hwy', along: 10, speed: 20, type: 'car' },
    ]),
  );
  const car = world.scenery.vehicles[0]!;
  const start = { x: car.x, y: car.y };
  for (let t = 0; t < 5; t += 0.02) world.step(0.02);
  assert.ok(Math.hypot(car.x - start.x, car.y - start.y) > 50, 'it moved');

  const road = world.scenery.roads[0]!;
  for (let t = 0; t < 200; t += 0.02) world.step(0.02);
  assert.ok(car.along > road.length, 'it went past the end');
  assert.ok(world.terrain.contains(car.x, car.y), 'and is still somewhere on the map');
});

test('a parked vehicle stays parked', () => {
  const world = new World(base([{ kind: 'vehicle', at: [20, 25], rotation: 45, type: 'truck' }]));
  const truck = world.scenery.vehicles[0]!;
  const before = { x: truck.x, y: truck.y };
  for (let t = 0; t < 20; t += 0.02) world.step(0.02);
  assert.deepEqual({ x: truck.x, y: truck.y }, before);
  assert.ok(Math.abs(truck.z - world.terrain.heightAt(truck.x, truck.y)) < 1e-9);
});

test('buildings sit on the ground with the size they were given', () => {
  const world = new World(
    base([
      { kind: 'building', at: [30, 26], width: 20, depth: 10, height: 7, rotation: 30, label: 'Depot' },
    ]),
  );
  const b = world.scenery.buildings[0]!;
  assert.equal(b.width, 20);
  assert.equal(b.height, 7);
  assert.equal(b.label, 'Depot');
  assert.ok(Math.abs(b.heading - Math.PI / 6) < 1e-9);
  assert.ok(Math.abs(b.z - world.terrain.heightAt(b.x, b.y)) < 1e-9);
});

test('scenery survives a round trip through JSON', () => {
  const spec = base([
    { kind: 'forest', from: [2, 28], to: [58, 38], count: 30, seed: 5, clearance: 0 },
    { kind: 'road', id: 'hwy', points: [[2, 30], [58, 31]] },
    { kind: 'vehicle', road: 'hwy', along: 40, speed: 10 },
    { kind: 'building', at: [30, 26] },
  ]);
  const world = new World(spec);
  const again = new World(JSON.parse(JSON.stringify(world.toJSON())) as SceneSpec);
  assert.equal(again.scenery.trees.length, world.scenery.trees.length);
  assert.equal(again.scenery.roads.length, 1);
  assert.equal(again.scenery.vehicles.length, 1);
  assert.equal(again.scenery.buildings.length, 1);
});

test('scenery is decoration: a train runs straight through it', () => {
  const world = new World({
    terrain: { cols: 60, rows: 40, cellSize: 12, baseElevation: 4 },
    tracks: [{ id: 'main', points: [[2, 20], [30, 20], [58, 20]], spacing: 2 }],
    // Deliberately planted and built right on the track.
    scenery: [
      { kind: 'forest', from: [10, 19], to: [50, 21], count: 60, seed: 2, clearance: 0 },
      { kind: 'building', at: [40, 20], width: 20, depth: 12, height: 8 },
    ],
    trains: [{ id: 'T', track: 'main', position: 100, throttle: 0.8, template: 'balanced', carCount: 4 }],
  });
  const train = world.trains[0]!;
  for (let t = 0; t < 60; t += 0.02) world.step(0.02);
  assert.equal(train.derailedCount, 0, 'trees and buildings cannot be hit');
  assert.equal(world.collisions.length, 0);
  assert.ok(train.headPosition > 300, 'and it kept going');
});
