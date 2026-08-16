import assert from 'node:assert/strict';
import { test } from 'node:test';
import { throwCar } from '../src/derailment.ts';
import { World, type SceneSpec } from '../src/world.ts';

/** A long straight, so impacts are about closing speed and nothing else. */
const straight = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  terrain: { cols: 120, rows: 30, cellSize: 12, baseElevation: 3 },
  tracks: [{ id: 'main', points: [[2, 15], [60, 15], [118, 15]], spacing: 2 }],
  ...over,
});

function run(world: World, seconds: number): { first?: { what: string; closing: number; derailed: boolean } } {
  let first;
  for (let t = 0; t < seconds; t += 0.02) {
    world.step(0.02);
    if (!first && world.collisions.length > 0) {
      const e = world.collisions[0]!;
      first = { what: e.what, closing: e.closing, derailed: e.derailed };
    }
  }
  return { first };
}

test('a train runs into a standing train instead of through it', () => {
  const world = new World(
    straight({
      trains: [
        { id: 'A', track: 'main', position: 300, speed: 14, throttle: 0.5, template: 'unitGrain', carCount: 5 },
        { id: 'B', track: 'main', position: 900, brake: 1, template: 'unitGrain', carCount: 4 },
      ],
    }),
  );
  const [A, B] = world.trains as [typeof world.trains[0], typeof world.trains[0]];
  const { first } = run(world, 100);

  assert.ok(first, 'the impact happened at all');
  assert.match(first!.what, /B/);
  assert.ok(first!.closing > 10, `closing speed was only ${first!.closing.toFixed(1)} m/s`);
  assert.equal(first!.derailed, true, 'a running impact is not a coupling');
  assert.ok(A!.derailedCount > 0 && B!.derailedCount > 0, 'both movements lost equipment');
  // And the striking train did not pass through: it is still behind the other.
  assert.ok(A!.headPosition < 950);
});

test('a slow shove couples up instead of wrecking', () => {
  const world = new World(
    straight({
      trains: [
        { id: 'A', track: 'main', position: 700, speed: 1.4, throttle: 0.06, template: 'unitGrain', carCount: 5 },
        { id: 'B', track: 'main', position: 900, template: 'unitGrain', carCount: 4 },
      ],
    }),
  );
  const [A, B] = world.trains as [typeof world.trains[0], typeof world.trains[0]];
  const startB = B!.headPosition;
  const { first } = run(world, 120);

  assert.ok(first, 'they made contact');
  assert.ok(first!.closing < 5, `closing speed ${first!.closing.toFixed(2)} m/s should be gentle`);
  assert.equal(first!.derailed, false);
  assert.equal(A!.derailedCount, 0);
  assert.equal(B!.derailedCount, 0);
  assert.ok(B!.headPosition > startB + 10, 'and the standing train got shoved along');
});

test('a light obstruction is swept aside once and forgotten', () => {
  const world = new World(
    straight({
      obstructions: [
        { id: 'auto', label: 'Stalled automobile', track: 'main', at: 700, mass: 1.6, length: 4.6 },
      ],
      trains: [{ id: 'A', track: 'main', position: 300, speed: 16, throttle: 0.6, template: 'unitGrain', carCount: 5 }],
    }),
  );
  const train = world.trains[0]!;
  let hits = 0;
  for (let t = 0; t < 80; t += 0.02) {
    world.step(0.02);
    hits += world.collisions.length;
  }
  assert.equal(hits, 1, `struck ${hits} times; a car destroyed at a crossing is hit once`);
  assert.equal(train.derailedCount, 0, 'and it does not derail a train');
  assert.equal(world.obstructions[0]!.struck, true);
  assert.equal(world.obstructions[0]!.cleared, true);
  assert.ok(Math.abs(world.obstructions[0]!.offset) > 1, 'it ends up beside the track');
});

test('a heavy obstruction at speed derails the movement', () => {
  const world = new World(
    straight({
      obstructions: [{ id: 'rock', label: 'Rock', track: 'main', at: 700, mass: 40, length: 5 }],
      trains: [{ id: 'A', track: 'main', position: 300, speed: 16, throttle: 0.6, template: 'unitGrain', carCount: 5 }],
    }),
  );
  const train = world.trains[0]!;
  const { first } = run(world, 60);
  assert.ok(first?.derailed, 'hitting something that heavy at track speed puts it on the ground');
  assert.ok(train.derailedCount > 0);
  assert.match(train.derailmentReason, /struck/);
});

test('the same heavy obstruction is merely shoved at walking pace', () => {
  const world = new World(
    straight({
      // Close by and barely under power: a train left to accelerate over a few
      // hundred metres arrives at the obstruction well above walking pace, and
      // this test is about what happens when it does not.
      obstructions: [{ id: 'rock', label: 'Rock', track: 'main', at: 480, mass: 40, length: 5 }],
      trains: [{ id: 'A', track: 'main', position: 400, speed: 1.2, throttle: 0.03, template: 'unitGrain', carCount: 5 }],
    }),
  );
  const train = world.trains[0]!;
  const { first } = run(world, 90);
  assert.ok(first, 'contact was made');
  assert.equal(first!.derailed, false);
  assert.equal(train.derailedCount, 0);
  assert.ok(world.obstructions[0]!.displaced > 480, 'and it got pushed along the rail');
});

test('a wreck fouling the track is something the next train hits', () => {
  const world = new World(
    straight({
      trains: [
        { id: 'A', track: 'main', position: 300, speed: 30, template: 'unitGrain', carCount: 4 },
        { id: 'B', track: 'main', position: 1150, speed: 0, brake: 1, template: 'unitGrain', carCount: 3 },
      ],
    }),
  );
  const [A, B] = world.trains as [typeof world.trains[0], typeof world.trains[0]];
  // Put A's train on the ground where it stands, then let B run into the wreck.
  world.trains[0]!.throttle = 0;
  const path = A!.route!;
  throwCar(A!, A!.cars[0]!, path.at(A!.cars[0]!.s), 1, 0.4, world.physics.derailment);
  run(world, 4);

  const wreck = A!.cars.find((c) => c.derailed);
  assert.ok(wreck, 'something is on the ground');
  assert.ok(wreck!.foulTrack === 'main', 'and it knows which track it is lying across');

  B!.brake = 0;
  B!.direction = -1;
  B!.throttle = 1;
  const { first } = run(world, 90);
  assert.ok(first, 'the second movement found the wreck');
  assert.match(first!.what, /wreck|A/);
});

test('trains on different tracks pass each other without touching', () => {
  const world = new World({
    terrain: { cols: 120, rows: 40, cellSize: 12, baseElevation: 3 },
    tracks: [
      { id: 'north', points: [[2, 16], [60, 16], [118, 16]], spacing: 2 },
      { id: 'south', points: [[2, 22], [60, 22], [118, 22]], spacing: 2 },
    ],
    trains: [
      { id: 'A', track: 'north', position: 200, speed: 14, throttle: 0.5, template: 'unitGrain', carCount: 4 },
      { id: 'B', track: 'south', position: 1200, speed: 14, direction: -1, throttle: 0.5, template: 'unitGrain', carCount: 4 },
    ],
  });
  const { first } = run(world, 60);
  assert.equal(first, undefined, 'a parallel track is not the same track');
  assert.equal(world.trains[0]!.derailedCount, 0);
  assert.equal(world.trains[1]!.derailedCount, 0);
});
