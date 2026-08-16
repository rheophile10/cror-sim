import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PHYSICS, stepTrain, telemetry } from '../src/physics.ts';
import { Terrain } from '../src/terrain.ts';
import { TrackPath } from '../src/track.ts';
import { Train } from '../src/train.ts';
import { G, mpsToMph } from '../src/units.ts';

const level = () => new Terrain({ cols: 200, rows: 20, cellSize: 10, baseElevation: 0 });

const straight = (terrain: Terrain) =>
  new TrackPath({ points: [[2, 10], [100, 10], [198, 10]], spacing: 5 }, terrain);

/** Run `seconds` of simulated time in 20 ms slices, the way a frame loop would. */
function run(train: Train, path: TrackPath, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.02) stepTrain(train, path, 0.02, DEFAULT_PHYSICS);
}

test('a train at rest with no throttle stays at rest', () => {
  const path = straight(level());
  const train = new Train({ position: 200, template: 'balanced', carCount: 6 });
  run(train, path, 5);
  assert.ok(Math.abs(train.speed) < 1e-6, `drifted to ${train.speed} m/s`);
});

test('throttle accelerates, and the whole consist comes with it', () => {
  const path = straight(level());
  const train = new Train({ position: 200, template: 'balanced', carCount: 6, throttle: 1 });
  run(train, path, 30);
  assert.ok(train.speed > 2, `only reached ${train.speed} m/s`);
  const spread = Math.max(...train.cars.map((c) => c.v)) - Math.min(...train.cars.map((c) => c.v));
  assert.ok(spread < 0.5, `consist came apart: ${spread} m/s spread`);
  // Couplers are in draft, pulling the train along behind the locomotive.
  assert.ok(telemetry(train, path).maxDraft > 0);
});

test('acceleration is bounded by adhesion, not by the horsepower on the drawbar', () => {
  const path = straight(level());
  const train = new Train({
    position: 200,
    cars: [{ kind: 'locomotive', mass: 190, tractiveEffort: 100_000 }],
    throttle: 1,
  });
  run(train, path, 4);
  // μ·g is the ceiling; with μ = 0.3 that is 2.94 m/s², so 4 s cannot exceed ~12 m/s.
  const ceiling = DEFAULT_PHYSICS.adhesion * G * 4;
  assert.ok(train.speed <= ceiling, `${train.speed} m/s exceeds the adhesion limit ${ceiling}`);
  assert.ok(train.speed > 5, 'but it should still get moving smartly');
});

test('brakes bring a train to a stand and hold it there', () => {
  const path = straight(level());
  const train = new Train({ position: 400, template: 'balanced', carCount: 8, speed: 15 });
  train.brake = 1;
  run(train, path, 60);
  assert.ok(Math.abs(train.speed) < 0.05, `still rolling at ${train.speed} m/s`);
  run(train, path, 10);
  assert.ok(Math.abs(train.speed) < 0.05, 'and does not creep back');
});

test('gravity moves an unbraked train down a grade, and holds it on the level', () => {
  const terrain = new Terrain({
    cols: 200,
    rows: 20,
    cellSize: 10,
    features: [{ kind: 'ramp', from: [180, 10], to: [20, 10], height: 60 }],
  });
  const path = new TrackPath(
    { points: [[20, 10], [100, 10], [180, 10]], spacing: 5, maxGrade: 2.5, smoothing: 4 },
    terrain,
  );
  const start = path.length / 2;
  const train = new Train({ position: start, template: 'unitGrain', carCount: 10 });
  run(train, path, 60);
  // The ramp descends toward increasing mileage, so the train runs away forward.
  assert.ok(train.headPosition > start + 20, `only ran ${train.headPosition - start} m`);
  assert.ok(train.speed > 1, `never got rolling: ${train.speed} m/s`);
  assert.ok(mpsToMph(train.speed) < 90, 'and not to an absurd speed');
});

test('a stopped train on a grade is held by its brakes, once they have set', () => {
  const terrain = new Terrain({
    cols: 200,
    rows: 20,
    cellSize: 10,
    features: [{ kind: 'ramp', from: [180, 10], to: [20, 10], height: 60 }],
  });
  const path = new TrackPath(
    { points: [[20, 10], [100, 10], [180, 10]], spacing: 5, maxGrade: 2.5, smoothing: 4 },
    terrain,
  );
  const train = new Train({ position: path.length / 2, template: 'unitGrain', carCount: 10 });
  train.brake = 1;
  // An application is not instantaneous: the pipe has to be reduced and every
  // car's cylinder has to fill from its own reservoir. A train standing on a
  // grade creeps a few metres before the brakes take hold, and that creep is the
  // model being right rather than the test being wrong.
  run(train, path, 15);
  const settled = train.headPosition;
  run(train, path, 30);
  assert.ok(
    Math.abs(train.headPosition - settled) < 1,
    `rolled ${(train.headPosition - settled).toFixed(1)} m after the brakes set`,
  );
});

test('too much speed through a curve derails the train', () => {
  const terrain = new Terrain({ cols: 120, rows: 120, cellSize: 10, baseElevation: 0 });
  // A 100 m radius curve: v²/(R·g) reaches the 0.8 L/V limit around 28 m/s.
  const path = new TrackPath({ loop: { center: [60, 60], radiusX: 10 }, spacing: 3 }, terrain);
  const slow = new Train({ position: 0, template: 'balanced', carCount: 4, speed: 5 });
  run(slow, path, 10);
  assert.equal(slow.derailed, false, 'a slow train goes round');

  const fast = new Train({ position: 0, template: 'balanced', carCount: 4, speed: 34 });
  run(fast, path, 5);
  assert.equal(fast.derailed, true, 'a fast one does not');
  assert.match(fast.derailmentReason, /L\/V/);
});

test('telemetry reports the grade and curve the lead car is standing on', () => {
  const terrain = new Terrain({ cols: 120, rows: 120, cellSize: 10, baseElevation: 0 });
  const path = new TrackPath({ loop: { center: [60, 60], radiusX: 20 }, spacing: 3 }, terrain);
  const train = new Train({ position: 50, template: 'balanced', carCount: 4 });
  const t = telemetry(train, path);
  assert.ok(Math.abs(t.grade) < 1e-6);
  assert.ok(t.curveDegrees > 5 && t.curveDegrees < 12, `${t.curveDegrees}° for a 200 m radius`);
  assert.ok(t.mass > 0);
  assert.equal(t.derailed, false);
});
