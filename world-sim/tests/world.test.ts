import assert from 'node:assert/strict';
import { test } from 'node:test';
import { World, type SceneSpec } from '../src/world.ts';

const scene: SceneSpec = {
  name: 'test scene',
  terrain: {
    cols: 60,
    rows: 60,
    cellSize: 10,
    baseElevation: 4,
    features: [{ x: 30, y: 30, radius: 14, height: 45 }],
  },
  tracks: [{ id: 'main', loop: { center: [30, 30], radiusX: 22 }, maxGrade: 2 }],
  trains: [{ id: 'M301', track: 'main', position: 120, template: 'unitGrain', carCount: 6 }],
};

test('a scene builds terrain, track and trains from one document', () => {
  const world = new World(scene);
  assert.equal(world.terrain.cols, 60);
  assert.equal(world.tracks.length, 1);
  assert.equal(world.tracks[0]!.id, 'main');
  assert.equal(world.trains[0]!.cars.length, 6);
  assert.equal(world.trackFor(world.trains[0]!)!.id, 'main');
});

test('a train with no track named falls back to the first one', () => {
  const world = new World({ ...scene, trains: [{ id: 'x' }] });
  assert.equal(world.trackFor(world.trains[0]!)!.id, 'main');
});

test('stepping advances simulated time and moves a train under power', () => {
  const world = new World(scene);
  const train = world.trains[0]!;
  train.throttle = 1;
  const start = train.headPosition;
  for (let i = 0; i < 500; i++) world.step(0.02);
  assert.ok(Math.abs(world.time - 10) < 1e-6);
  assert.ok(train.headPosition > start, 'the train moved');
  assert.ok(world.telemetry(train)!.speed > 0);
});

test('the scene round-trips through JSON, sparse description intact', () => {
  const world = new World(scene);
  const json = JSON.parse(JSON.stringify(world.toJSON())) as SceneSpec;
  // The terrain comes back as its feature list, not as a baked grid.
  assert.deepEqual(json.terrain.features, scene.terrain.features);
  assert.equal(json.tracks![0]!.loop!.radiusX, 22);

  const again = new World(json);
  assert.deepEqual(Array.from(again.terrain.heights), Array.from(world.terrain.heights));
  assert.equal(again.trains[0]!.cars.length, 6);
});

test('saving with state resumes where the simulation left off', () => {
  const world = new World(scene);
  world.trains[0]!.throttle = 0.8;
  for (let i = 0; i < 400; i++) world.step(0.02);
  const moved = world.trains[0]!.headPosition;

  const resumed = new World(world.toJSON({ state: true }));
  assert.ok(Math.abs(resumed.trains[0]!.headPosition - moved) < 0.5);
  assert.ok(Math.abs(resumed.trains[0]!.speed - world.trains[0]!.speed) < 0.1);
});

test('a consist stopped by the end of an open path stays coupled', () => {
  const world = new World({
    terrain: { cols: 60, rows: 20, cellSize: 10 },
    tracks: [{ id: 'stub', points: [[2, 10], [30, 10], [58, 10]] }],
    trains: [{ position: 400, template: 'balanced', carCount: 8, throttle: 1 }],
  });
  const train = world.trains[0]!;
  const length = train.length;
  for (let i = 0; i < 4000; i++) world.step(0.02);

  const path = world.tracks[0]!;
  assert.ok(train.headPosition <= path.length + 1e-6, 'stops at the end of steel');
  assert.ok(Math.abs(train.speed) < 1e-6, 'and stays stopped');
  const spread = train.cars[0]!.s - train.cars[train.cars.length - 1]!.s;
  assert.ok(
    Math.abs(spread - (length - train.cars[0]!.length / 2 - train.cars[7]!.length / 2)) < 1,
    'and the consist keeps its length instead of telescoping',
  );
});
