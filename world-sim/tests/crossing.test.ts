import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCrossing,
  crossingLights,
  DEFAULT_CROSSING,
  stepCrossings,
  trafficStops,
} from '../src/crossing.ts';
import { task } from '../src/person.ts';
import { World, type SceneSpec } from '../src/world.ts';

/** A straight line with a road across it at 1200 m, and a car coming up to it. */
const scene = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  name: 'crossing',
  terrain: { cols: 200, rows: 40, cellSize: 14, baseElevation: 4 },
  embodied: true,
  tracks: [{ id: 'main', points: [[3, 20], [100, 20], [197, 20]], spacing: 5 }],
  // The road has to genuinely cross the track where the crossing says it does.
  // Track 'main' starts at cell x=3, so world x = 42 + at; 1200 m along is cell
  // x = 88.71.
  scenery: [{ kind: 'road', id: 'hwy', points: [[88.71, 0], [88.71, 40]], width: 8 }],
  crossings: [
    { id: 'x1', label: 'Mill Road', track: 'main', at: 1200, road: 'hwy', protection: 'gates' },
  ],
  trains: [{ id: 'M1', track: 'main', position: 400, template: 'balanced', carCount: 5 }],
  people: [{ id: 'cond', name: 'Conductor', role: 'conductor', track: 'main', at: 400, offset: 3 }],
  ...over,
});

function run(world: World, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.05) world.step(0.05);
}

/**
 * Where the head end is *on its track*.
 *
 * `Train.headPosition` is a distance along the route, and a route carries a
 * kilometre of railway behind the movement — so it is not a mileage and cannot
 * be compared against one.
 */
function mileage(world: World, id = 'M1'): number {
  const train = world.trains.find((t) => t.id === id)!;
  const lead = train.cars[0]!;
  return train.route!.locate(lead.s).at;
}

test('a crossing sits where its track and its road actually meet', () => {
  const world = new World(scene());
  const crossing = world.crossings[0]!;
  const pt = world.tracks[0]!.at(1200);
  assert.ok(Math.hypot(crossing.x - pt.x, crossing.y - pt.y) < 0.01, 'placed off the track');
  assert.ok(crossing.roadAt > 0, 'and it found its place on the road');
});

test('nothing coming, nothing happens', () => {
  const world = new World(scene());
  run(world, 5);
  const crossing = world.crossings[0]!;
  assert.equal(crossing.state, 'clear');
  assert.equal(crossing.gate, 0);
  assert.equal(crossingLights(crossing, 0).on, false);
  assert.equal(trafficStops(crossing), false);
});

test('an approaching movement starts the lights, then the gates come down', () => {
  const world = new World(scene());
  const crossing = world.crossings[0]!;
  const train = world.trains[0]!;
  train.throttle = 1;

  // Far off, nothing.
  run(world, 10);
  assert.equal(crossing.state, 'clear', 'it does not start on a train 700 m away');

  for (let t = 0; t < 300 && crossing.state === 'clear'; t += 0.05) world.step(0.05);
  assert.equal(crossing.state, 'warning');
  assert.equal(crossingLights(crossing, 0).on, true);
  assert.equal(trafficStops(crossing), true);
  assert.equal(crossing.gate, 0, 'the arms wait a few seconds behind the lights');

  run(world, 15);
  assert.ok(crossing.gate > 0.8, `the arms came down: ${crossing.gate.toFixed(2)}`);
});

test('constant warning time: a fast movement starts it further out than a slow one', () => {
  // Driven straight, with a made-up movement closing at a fixed rate. Doing
  // this through the physics would be measuring the coast-down of an unpowered
  // train instead of the property under test.
  const reach = (speed: number): number => {
    const crossing = buildCrossing({ track: 'main', at: 1000 }, 0);
    for (let gap = 1200; gap > 0; gap -= speed * 0.05) {
      stepCrossings(crossing ? [crossing] : [], [{ trackId: 'main', at: 1000 - gap, speed }], 0.05);
      if (crossing.state !== 'clear') return gap;
    }
    return 0;
  };
  const slow = reach(4);
  const fast = reach(20);
  // Twenty-two seconds of warning either way, so the distance scales with speed
  // — which is the whole idea, and why a slow movement can sit on the approach
  // with the lights going for a very long time.
  assert.ok(Math.abs(slow - 88) < 10, `slow started at ${slow.toFixed(0)} m, expected ~88`);
  assert.ok(Math.abs(fast - 440) < 20, `fast started at ${fast.toFixed(0)} m, expected ~440`);
  assert.ok(fast > slow * 4);
});

test('the warning never starts closer in than the floor, however slow the movement', () => {
  const crossing = buildCrossing({ track: 'main', at: 1000 }, 0);
  // A movement crawling at half a metre a second would otherwise get a warning
  // distance of eleven metres, which is no warning at all.
  stepCrossings([crossing], [{ trackId: 'main', at: 1000 - DEFAULT_CROSSING.minApproach + 1, speed: 0.5 }], 0.05);
  assert.equal(crossing.state, 'warning');
});

test('a movement standing across a road holds it, which is the case that matters', () => {
  const world = new World(scene({
    trains: [{ id: 'M1', track: 'main', position: 1200, template: 'balanced', carCount: 5, brake: 1 }],
  }));
  // Shift it so the head end is genuinely over the road, in track coordinates.
  const train = world.trains[0]!;
  train.place(train.cars[0]!.s + (1200 - mileage(world)) + train.cars[0]!.length / 2);
  run(world, 5);
  const crossing = world.crossings[0]!;
  assert.equal(crossing.state, 'occupied');
  assert.equal(trafficStops(crossing), true);
  assert.ok(crossing.gate > 0.4, 'and the arms are down');
});

test('a passive crossing warns nobody, and traffic only stops for what it can see', () => {
  const world = new World(scene({
    crossings: [{ id: 'x1', track: 'main', at: 1200, road: 'hwy', protection: 'passive' }],
  }));
  const crossing = world.crossings[0]!;
  world.trains[0]!.throttle = 1;
  for (let t = 0; t < 300 && crossing.state === 'clear'; t += 0.05) world.step(0.05);
  assert.equal(crossing.state, 'warning', 'the railway knows a train is coming');
  assert.equal(crossingLights(crossing, 0).on, false, 'but nothing tells the road');
  assert.equal(trafficStops(crossing), false);

  for (let t = 0; t < 400 && !trafficStops(crossing); t += 0.05) world.step(0.05);
  assert.equal(crossing.state, 'occupied');
  assert.equal(trafficStops(crossing), true, 'a driver stops for a train they can see on it');
});

test('a failed warning system leaves the road running, and a flag is the only remedy', () => {
  const world = new World(scene({
    crossings: [
      { id: 'x1', label: 'Mill Road', track: 'main', at: 1200, road: 'hwy', protection: 'gates', outOfOrder: true },
    ],
  }));
  const crossing = world.crossings[0]!;
  world.trains[0]!.throttle = 1;
  for (let t = 0; t < 300 && crossing.state === 'clear'; t += 0.05) world.step(0.05);
  assert.equal(crossing.state, 'warning');
  assert.equal(trafficStops(crossing), false, 'nothing is stopping the traffic');
  assert.equal(crossing.gate, 0, 'and the arms stay up');

  // Flagging it from where the conductor happens to be is refused; being there
  // is the whole of the act.
  assert.equal(world.flagCrossing('x1', 'cond'), false);
  assert.ok(world.events.all().some((e) => e.kind === 'refused'));

  world.send('cond', { track: 'main', at: 1200, offset: 4 }, task('protect-crossing', { target: 'x1' }));
  for (let t = 0; t < 1200 && !crossing.flaggedBy; t += 0.05) world.step(0.05);
  assert.equal(crossing.flaggedBy, 'cond');
  assert.equal(trafficStops(crossing), true, 'a person can stop a road the equipment cannot');
  assert.ok(world.events.all().some((e) => e.kind === 'crossing-protected'));

  world.assign('cond', task('release-crossing', { target: 'x1' }));
  run(world, 8);
  assert.equal(crossing.flaggedBy, null);
  assert.ok(world.events.all().some((e) => e.kind === 'crossing-released'));
});

test('traffic brakes to the stop line and goes again afterwards', () => {
  // A movement standing on the crossing, so the road is held for as long as the
  // test needs rather than for as long as a train happens to take to pass.
  const world = new World(scene({
    trains: [{ id: 'M1', track: 'main', position: 1200, template: 'balanced', carCount: 5, brake: 1 }],
    scenery: [
      { kind: 'road', id: 'hwy', points: [[88.71, 0], [88.71, 40]], width: 8 },
      { kind: 'vehicle', road: 'hwy', along: 40, speed: 14, type: 'car' },
    ],
  }));
  const train = world.trains[0]!;
  train.place(train.cars[0]!.s + (1200 - mileage(world)) + train.cars[0]!.length / 2);
  const crossing = world.crossings[0]!;
  const car = world.scenery.vehicles[0]!;
  const road = world.scenery.roads[0]!;

  run(world, 2);
  assert.equal(trafficStops(crossing), true, 'the road is held');
  for (let t = 0; t < 120 && Math.abs(car.speed) > 0.4; t += 0.05) world.step(0.05);
  assert.ok(Math.abs(car.speed) < 0.4, `the car did not stop: ${car.speed.toFixed(1)} m/s`);

  const lap = ((car.along % road.length) + road.length) % road.length;
  const short = crossing.roadAt - lap;
  assert.ok(short > 2 && short < 22, `stopped ${short.toFixed(1)} m from the rails`);

  const waited = car.along;
  run(world, 20);
  assert.ok(Math.abs(car.along - waited) < 1, 'and it holds there');

  // Pull the movement clear and the road runs again.
  train.place(train.cars[0]!.s + 600);
  run(world, 30);
  assert.equal(trafficStops(crossing), false);
  assert.ok(car.along > waited + 20, 'traffic moved off again');
});

test('a car stopped on the crossing gets hit, and the strike is reported', () => {
  const world = new World(scene({
    crossings: [
      { id: 'x1', track: 'main', at: 1200, road: 'hwy', protection: 'passive', stalled: true },
    ],
  }));
  const stalled = world.obstructions.find((o) => o.id === 'x1-stalled');
  assert.ok(stalled, 'a stalled vehicle is a real obstruction on the track');

  const train = world.trains[0]!;
  train.throttle = 1;
  let hit: { what: string; closing: number } | null = null;
  for (let t = 0; t < 600 && !hit; t += 0.05) {
    world.step(0.05);
    const first = world.collisions[0];
    if (first) hit = { what: first.what, closing: first.closing };
  }
  assert.ok(hit, 'the train struck it');
  assert.match(hit!.what, /crossing/i);
  assert.equal(stalled!.struck, true);
  // A car is not heavy enough to put a train on the ground; it is shoved.
  assert.equal(train.derailed, false);
  assert.ok(stalled!.displaced > 1200, 'and it was carried down the track');
});

test('crossings survive a round trip through the scene JSON', () => {
  const world = new World(scene({
    crossings: [
      { id: 'x1', label: 'Mill Road', track: 'main', at: 1200, road: 'hwy', protection: 'gates', outOfOrder: true, stalled: true, stalledType: 'truck' },
    ],
  }));
  const again = new World(world.toJSON());
  const crossing = again.crossings[0]!;
  assert.equal(crossing.label, 'Mill Road');
  assert.equal(crossing.protection, 'gates');
  assert.equal(crossing.outOfOrder, true);
  assert.equal(again.obstructions.filter((o) => o.id === 'x1-stalled').length, 1, 'not duplicated');
});
