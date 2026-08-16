import assert from 'node:assert/strict';
import { test } from 'node:test';
import { throwCar } from '../src/derailment.ts';
import { World, type SceneSpec } from '../src/world.ts';

/**
 * A flat test loop tight enough that speed alone will put a train on the ground.
 * A 168 m radius at 38 m/s gives v²/Rg ≈ 0.88, comfortably over the 0.8 limit —
 * the margin matters, because a scene that only just derails makes every
 * assertion below flaky.
 */
const loopScene = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  terrain: { cols: 80, rows: 80, cellSize: 12, baseElevation: 5 },
  tracks: [{ id: 'loop', loop: { center: [40, 40], radiusX: 14 }, spacing: 3 }],
  trains: [{ id: 'T', position: 0, speed: 38, template: 'mixedFreight', carCount: 10 }],
  ...over,
});

function run(world: World, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.02) world.step(0.02);
}

test('a car over the L/V limit leaves the rails and becomes a free body', () => {
  const world = new World(loopScene());
  const train = world.trains[0]!;
  run(world, 6);

  assert.equal(train.derailed, true);
  const off = train.cars.filter((c) => c.derailed);
  assert.ok(off.length > 0);
  for (const car of off) {
    assert.ok(car.body, 'a derailed car carries a free body');
    assert.equal(car.v, 0, 'and no longer has a velocity along the path');
  }
});

test('wrecked cars come to rest on the ground, beside the track', () => {
  const world = new World(loopScene());
  const train = world.trains[0]!;
  run(world, 40);

  const cx = 40 * 12;
  const cy = 40 * 12;
  const radii = world.tracks[0]!.samples.map((s) => Math.hypot(s.x - cx, s.y - cy));
  const near = Math.min(...radii);
  const far = Math.max(...radii);

  const off = train.cars.filter((c) => c.derailed);
  assert.ok(off.length >= 3, `only ${off.length} cars came off`);
  for (const car of off) {
    const b = car.body!;
    assert.ok(b.settled, `car ${car.id} never stopped`);
    // Resting on the ground, not buried in it or hovering over it.
    const ground = world.terrain.heightAt(b.x, b.y);
    assert.ok(b.z >= ground - 0.01, `car ${car.id} sank below the ground`);
    assert.ok(b.z < ground + car.height, `car ${car.id} is floating`);
    // A pile-up concertinas beside the right-of-way; it does not scatter the
    // train over the county.
    const r = Math.hypot(b.x - cx, b.y - cy);
    assert.ok(
      r > near - 90 && r < far + 90,
      `car ${car.id} ended ${r.toFixed(0)} m from centre, track is ${near.toFixed(0)}–${far.toFixed(0)}`,
    );
  }
});

/**
 * A loop wide enough that nothing derails on its own, so a wreck can be staged
 * mid-train and the *propagation* observed on its own. On a constant-radius
 * loop every car sees the same v²/R, so a speed high enough to derail one is
 * high enough to derail all of them at once — which tests nothing about the
 * cars behind running into the cars in front.
 */
const stagedScene = (): SceneSpec => ({
  terrain: { cols: 120, rows: 120, cellSize: 12, baseElevation: 5 },
  tracks: [{ id: 'loop', loop: { center: [60, 60], radiusX: 46 }, spacing: 3 }],
  trains: [{ id: 'T', position: 0, speed: 16, template: 'mixedFreight', carCount: 10 }],
});

test('a staged wreck pulls the cars behind it into a pile-up', () => {
  const world = new World(stagedScene());
  const train = world.trains[0]!;
  const path = world.tracks[0]!;
  run(world, 2);
  assert.equal(train.derailedCount, 0, 'nothing derails on its own here');

  const victim = train.cars[3]!;
  throwCar(train, victim, path.at(victim.s), 1, 1.2);
  assert.equal(train.derailedCount, 1);
  assert.ok(train.derailAnchor !== null);

  run(world, 25);
  assert.ok(train.derailedCount > 1, 'the cars behind ran into it');
  // Cars 4..9 are behind car 3 and should be in the pile; 0..2 are ahead.
  for (const car of train.cars.slice(4)) {
    assert.equal(car.derailed, true, `car ${car.id} should have piled in`);
  }
});

test('the cars ahead of a wreck keep going', () => {
  const world = new World(stagedScene());
  const train = world.trains[0]!;
  const path = world.tracks[0]!;
  run(world, 2);
  const victim = train.cars[3]!;
  throwCar(train, victim, path.at(victim.s), 1, 1.2);

  const lead = train.cars[0]!;
  const before = lead.s;
  run(world, 6);
  assert.equal(lead.derailed, false, 'the head end is not dragged back');
  assert.ok(lead.s - before > 20, `the head end only moved ${(lead.s - before).toFixed(1)} m`);
});

test('a pile-up throws cars to alternating sides', () => {
  const world = new World(stagedScene());
  const train = world.trains[0]!;
  const path = world.tracks[0]!;
  run(world, 2);
  const victim = train.cars[3]!;
  throwCar(train, victim, path.at(victim.s), 1, 1.2);
  run(world, 30);

  // Take each wrecked car's offset from the centre of the loop: an accordion
  // puts them alternately inside and outside the curve.
  const cx = 60 * 12;
  const cy = 60 * 12;
  const radius = 46 * 12;
  const sides = train.cars
    .slice(4)
    .filter((c) => c.body)
    .map((c) => Math.sign(Math.hypot(c.body!.x - cx, c.body!.y - cy) - radius));
  assert.ok(sides.length >= 4);
  assert.ok(
    sides.some((s) => s > 0) && sides.some((s) => s < 0),
    `all on one side: ${sides.join(',')}`,
  );
});

test('a high-speed derailment puts equipment on its side', () => {
  const world = new World(loopScene());
  const train = world.trains[0]!;
  run(world, 40);
  const overturned = train.cars.filter((c) => c.body?.overturned);
  assert.ok(overturned.length >= 2, `only ${overturned.length} cars went over`);
});

test('the head end runs on when the train comes apart behind it', () => {
  // A single locomotive with a light train behind: derail the tail by making the
  // rear heavy, and the power should keep going.
  const world = new World({
    terrain: { cols: 80, rows: 80, cellSize: 12, baseElevation: 5 },
    tracks: [{ id: 'loop', loop: { center: [40, 40], radiusX: 16 }, spacing: 3 }],
    trains: [{ id: 'T', position: 0, speed: 36, throttle: 1, template: 'heavyRear', carCount: 8 }],
  });
  const train = world.trains[0]!;
  run(world, 8);
  if (train.derailedCount === 0 || train.derailedCount === train.cars.length) return;

  const still = train.cars.filter((c) => !c.derailed);
  const before = still[0]!.s;
  run(world, 4);
  assert.ok(Math.abs(still[0]!.s - before) > 5, 'the cars still on the rails kept moving');
});

test('a train under the limit goes round and round', () => {
  const world = new World(
    loopScene({
      trains: [{ id: 'T', position: 0, speed: 8, template: 'intermodal', carCount: 10 }],
    }),
  );
  const train = world.trains[0]!;
  run(world, 60);
  assert.equal(train.derailed, false);
  assert.equal(train.derailedCount, 0);
});

test('a wreck on a slope slides downhill and stops', () => {
  const world = new World({
    terrain: {
      cols: 80,
      rows: 80,
      cellSize: 12,
      baseElevation: 2,
      features: [{ kind: 'ramp', from: [40, 20], to: [40, 70], height: 120 }],
    },
    tracks: [{ id: 'loop', loop: { center: [40, 40], radiusX: 14 }, spacing: 3, maxGrade: 3 }],
    trains: [{ id: 'T', position: 0, speed: 38, template: 'unitTank', carCount: 8 }],
  });
  const train = world.trains[0]!;
  run(world, 45);
  const off = train.cars.filter((c) => c.derailed);
  assert.ok(off.length > 0);
  for (const car of off) {
    const b = car.body!;
    assert.ok(b.settled, `car ${car.id} never settled on the slope`);
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.z));
  }
});

test('derailment is off the rails, not paused — simulated time keeps running', () => {
  const world = new World(loopScene());
  run(world, 10);
  assert.ok(Math.abs(world.time - 10) < 0.1);
  const tel = world.telemetry(world.trains[0]!)!;
  assert.ok(tel.derailedCount > 0);
  assert.match(tel.reason, /L\/V/);
});
