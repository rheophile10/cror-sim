import assert from 'node:assert/strict';
import { test } from 'node:test';
import { World, type SceneSpec } from '../src/world.ts';

/**
 * A main track with a siding: a switch at each end, four track segments. This is
 * the smallest arrangement that exercises everything a turnout can do — facing
 * moves, trailing moves, and a trailing move against a switch lined the other
 * way.
 */
const sidingScene = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  terrain: { cols: 80, rows: 40, cellSize: 12, baseElevation: 3 },
  nodes: [
    { id: 'sw-w', kind: 'switch', position: 'normal' },
    { id: 'sw-e', kind: 'switch', position: 'normal' },
  ],
  tracks: [
    { id: 'main-w', points: [[2, 20], [16, 20], [28, 20]], to: { node: 'sw-w', port: 'trunk' }, spacing: 2 },
    {
      id: 'main-mid',
      points: [[28, 20], [40, 20], [52, 20]],
      from: { node: 'sw-w', port: 'normal' },
      to: { node: 'sw-e', port: 'normal' },
      spacing: 2,
    },
    {
      id: 'siding',
      // A realistic turnout: about 14 m of separation taken up over 100 m, which
      // is a 137 m radius. Diverging any harder than this makes a siding no
      // train can enter above walking pace — the L/V limit sees to that.
      points: [[28, 20], [32, 19.6], [36, 18.8], [44, 18.8], [48, 19.6], [52, 20]],
      from: { node: 'sw-w', port: 'reverse' },
      to: { node: 'sw-e', port: 'reverse' },
      spacing: 2,
    },
    { id: 'main-e', points: [[52, 20], [66, 20], [78, 20]], from: { node: 'sw-e', port: 'trunk' }, spacing: 2 },
  ],
  trains: [{ id: 'T', track: 'main-w', position: 120, throttle: 0.6, template: 'balanced', carCount: 4 }],
  ...over,
});

function run(world: World, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.02) world.step(0.02);
}

const legIds = (world: World): string[] => world.trains[0]!.route!.legs.map((l) => l.track.id);

test('a facing move follows whichever way the switch is lined', () => {
  const normal = new World(sidingScene());
  assert.deepEqual(legIds(normal), ['main-w', 'main-mid', 'main-e']);

  const reverse = new World(sidingScene());
  reverse.throwSwitch('sw-w', 'reverse');
  reverse.throwSwitch('sw-e', 'reverse');
  assert.deepEqual(legIds(reverse), ['main-w', 'siding', 'main-e']);
});

test('a train actually runs over the track its route claims', () => {
  const world = new World(sidingScene());
  world.throwSwitch('sw-w', 'reverse');
  world.throwSwitch('sw-e', 'reverse');
  const seen = new Set<string>();
  for (let t = 0; t < 90; t += 0.02) {
    world.step(0.02);
    seen.add(world.trackFor(world.trains[0]!)!.id);
  }
  assert.ok(seen.has('siding'), 'it took the siding');
  assert.ok(seen.has('main-e'), 'and came out the far end');
  assert.equal(world.trains[0]!.derailedCount, 0);
});

test('running through a switch lined against the movement derails it', () => {
  // West reversed, east still normal: the train takes the siding and meets the
  // east switch from the wrong leg.
  const world = new World(sidingScene());
  world.throwSwitch('sw-w', 'reverse');
  const train = world.trains[0]!;
  assert.deepEqual(legIds(world), ['main-w', 'siding'], 'the route cannot get past the east switch');
  assert.equal(train.route!.stop.reason, 'runThrough');

  run(world, 90);
  assert.equal(train.derailed, true);
  assert.match(train.derailmentReason, /ran through the switch/);
});

test('throwing a switch under a moving train re-routes it without disturbing it', () => {
  const world = new World(sidingScene());
  world.throwSwitch('sw-e', 'reverse');
  const train = world.trains[0]!;
  run(world, 12);
  const speedBefore = train.speed;
  const spreadBefore = Math.max(...train.cars.map((c) => c.v)) - Math.min(...train.cars.map((c) => c.v));

  world.throwSwitch('sw-w', 'reverse');
  assert.deepEqual(legIds(world), ['main-w', 'siding', 'main-e']);
  // Rebuilding the route moves the origin of route distance; if the shift is
  // wrong the train teleports, and the couplers report it instantly.
  assert.ok(Math.abs(train.speed - speedBefore) < 1e-6, 'speed unchanged');
  const spreadAfter = Math.max(...train.cars.map((c) => c.v)) - Math.min(...train.cars.map((c) => c.v));
  assert.ok(Math.abs(spreadAfter - spreadBefore) < 1e-6, 'the consist was not stretched by the rebuild');

  run(world, 4);
  assert.equal(train.derailedCount, 0);
});

test('a consist straddling a switch has cars on two different tracks', () => {
  const world = new World(sidingScene());
  world.throwSwitch('sw-w', 'reverse');
  world.throwSwitch('sw-e', 'reverse');
  const train = world.trains[0]!;
  const route = train.route!;

  let straddled = false;
  for (let t = 0; t < 90; t += 0.02) {
    world.step(0.02);
    const tracks = new Set(train.cars.map((c) => route.locate(c.s).track.id));
    if (tracks.size > 1) straddled = true;
  }
  assert.ok(straddled, 'at some point it was on both sides of the points at once');
});

test('a route reports where it stops and why', () => {
  const world = new World(sidingScene());
  const route = world.trains[0]!.route!;
  assert.equal(route.stop.reason, 'end');
  assert.ok(route.length > 900, `route is only ${route.length.toFixed(0)} m`);
  // Track coordinates and route coordinates agree at the start.
  assert.equal(route.distanceOf('main-w', 0), 0);
  const mid = route.distanceOf('main-mid', 10);
  assert.ok(mid !== null && mid > 300);
});

test('travelling a leg backwards flips its heading, grade and curvature', () => {
  const world = new World({
    terrain: {
      cols: 60,
      rows: 30,
      cellSize: 12,
      features: [{ kind: 'ramp', from: [2, 15], to: [58, 15], height: 30 }],
    },
    tracks: [
      { id: 'a', points: [[3, 15], [20, 15], [30, 15]], to: { node: 'j' }, spacing: 2, maxGrade: 3 },
      // Attached by its `to` end, so a movement coming from `a` runs over it
      // against its own direction.
      { id: 'b', points: [[57, 12], [40, 13], [30, 15]], to: { node: 'j' }, spacing: 2, maxGrade: 3 },
    ],
    trains: [{ id: 'T', track: 'a', position: 100 }],
  });
  const route = world.trains[0]!.route!;
  assert.deepEqual(route.legs.map((l) => l.track.id), ['a', 'b']);
  const backwards = route.legs[1]!;
  assert.equal(backwards.dir, -1);

  const d = backwards.start + 40;
  const direct = backwards.track.at(backwards.from + backwards.dir * 40);
  const viaRoute = route.at(d);
  assert.ok(Math.abs(viaRoute.x - direct.x) < 1e-6, 'same point in the world');
  assert.ok(Math.abs(viaRoute.grade + direct.grade) < 1e-9, 'grade is negated');
  assert.ok(Math.abs(viaRoute.curvature + direct.curvature) < 1e-9, 'curvature is negated');
  const flipped = Math.abs(Math.abs(viaRoute.heading - direct.heading) - Math.PI);
  assert.ok(flipped < 1e-6, 'heading is reversed');
});

test('a loop with no nodes is still just a loop', () => {
  const world = new World({
    terrain: { cols: 60, rows: 60, cellSize: 12, baseElevation: 2 },
    tracks: [{ id: 'loop', loop: { center: [30, 30], radiusX: 20 }, spacing: 3 }],
    trains: [{ id: 'T', position: 0, speed: 6 }],
  });
  const route = world.trains[0]!.route!;
  assert.equal(route.closed, true);
  assert.equal(route.legs.length, 1);
  run(world, 30);
  assert.equal(world.trains[0]!.derailedCount, 0, 'and it goes round without falling off the end');
});

/**
 * The elevation bug: every track is graded on its own, so the height each one
 * happens to end at has nothing to do with what it must join up to. Left alone,
 * a route through a few turnouts climbs a staircase that exists nowhere in the
 * terrain — a metre or more at every switch.
 */
test('tracks meeting at a node agree about how high the railway is', () => {
  const world = new World(
    sidingScene({
      terrain: {
        cols: 80,
        rows: 40,
        cellSize: 12,
        baseElevation: 3,
        features: [
          { kind: 'ramp', from: [2, 20], to: [78, 20], height: 40 },
          { kind: 'noise', amplitude: 6, scale: 5, seed: 9, octaves: 3 },
        ],
      },
    }),
  );

  for (const node of world.network.nodes.values()) {
    const heights: number[] = [];
    for (const conn of node.ports.values()) {
      const track = world.network.tracks.get(conn.track)!;
      const pt = conn.end === 'from' ? track.samples[0]! : track.samples[track.samples.length - 1]!;
      heights.push(pt.z);
    }
    if (heights.length < 2) continue;
    const spread = Math.max(...heights) - Math.min(...heights);
    assert.ok(spread < 0.05, `node ${node.id} has a ${spread.toFixed(2)} m step in it`);
  }

  // And the route a train follows has no step in it either.
  const route = world.trains[0]!.route!;
  let worst = 0;
  for (let d = 1; d < route.length; d += 1) {
    worst = Math.max(worst, Math.abs(route.at(d).z - route.at(d - 1).z));
  }
  assert.ok(worst < 0.1, `largest one-metre step in the profile is ${worst.toFixed(2)} m`);
});

test('levelling the junctions does not wreck the ruling grade', () => {
  const world = new World(
    sidingScene({
      terrain: {
        cols: 80,
        rows: 40,
        cellSize: 12,
        baseElevation: 3,
        features: [{ kind: 'ramp', from: [2, 20], to: [78, 20], height: 40 }],
      },
    }),
  );
  const worst = Math.max(
    ...world.tracks.flatMap((t) => t.samples.map((s) => Math.abs(s.grade))),
  );
  // The pins get the last word, so a little over the 2.2% default is expected
  // and a lot over is a bug.
  assert.ok(worst < 0.03, `worst grade is ${(worst * 100).toFixed(2)}%`);
});

/** A spur trailing into the switch, so a movement leaving it is a trailing move. */
const spurScene = (operation: 'hand' | 'spring' | 'power'): SceneSpec => ({
  terrain: { cols: 90, rows: 40, cellSize: 12, baseElevation: 3 },
  nodes: [{ id: 'sw', kind: 'switch', position: 'normal', operation }],
  tracks: [
    {
      id: 'spur',
      points: [[80, 18.8], [52, 18.8], [36, 18.8], [32, 19.6], [28, 20]],
      to: { node: 'sw', port: 'reverse' },
      spacing: 2,
    },
    { id: 'main-w', points: [[28, 20], [16, 20], [2, 20]], from: { node: 'sw', port: 'trunk' }, spacing: 2 },
    { id: 'main-e', points: [[28, 20], [40, 20], [60, 20], [86, 20]], from: { node: 'sw', port: 'normal' }, spacing: 2 },
  ],
  trains: [{ id: 'T', track: 'spur', position: 120, throttle: 0.6, template: 'balanced', carCount: 4 }],
});

test('a spring switch lets a trailing movement push through and closes behind it', () => {
  const world = new World(spurScene('spring'));
  const train = world.trains[0]!;
  assert.deepEqual(train.route!.legs.map((l) => l.track.id), ['spur', 'main-w']);
  run(world, 80);
  assert.equal(train.derailedCount, 0, 'nothing on the ground');
  assert.equal(world.trackFor(train)!.id, 'main-w', 'it came out onto the main');
  // The spring closes the points again: the switch is where it started.
  assert.equal(world.network.nodes.get('sw')!.position, 'normal');
});

test('a hand switch in the same place bursts its points', () => {
  const world = new World(spurScene('hand'));
  const train = world.trains[0]!;
  assert.equal(train.route!.stop.reason, 'runThrough');
  run(world, 80);
  assert.equal(train.derailed, true);
  assert.match(train.derailmentReason, /ran through the switch/);
});

test('a power switch will not move under a movement standing on it', () => {
  const world = new World(sidingScene({}));
  world.network.nodes.get('sw-w')!.operation = 'power';

  assert.equal(world.canThrowSwitch('sw-w').ok, true, 'clear to begin with');
  // Run until the train is on the points.
  let onIt = false;
  for (let t = 0; t < 120 && !onIt; t += 0.02) {
    world.step(0.02);
    onIt = !world.canThrowSwitch('sw-w').ok;
  }
  assert.ok(onIt, 'the train reached the switch');
  assert.match(world.canThrowSwitch('sw-w').reason ?? '', /standing on the points/);
  assert.equal(world.throwSwitch('sw-w', 'reverse'), false, 'and it refuses to move');
  assert.equal(world.network.nodes.get('sw-w')!.position, 'normal');
});

test('a spring switch cannot be thrown by hand at all', () => {
  const world = new World(spurScene('spring'));
  assert.equal(world.canThrowSwitch('sw').ok, false);
  assert.match(world.canThrowSwitch('sw').reason ?? '', /spring/);
});

test('a derail on the rail puts equipment on the ground', () => {
  const scene: SceneSpec = {
    terrain: { cols: 90, rows: 30, cellSize: 12, baseElevation: 3 },
    nodes: [{ id: 'd1', kind: 'derail', derailing: true }],
    tracks: [
      { id: 'lead', points: [[3, 15], [20, 15], [40, 15]], to: { node: 'd1' }, spacing: 2 },
      { id: 'beyond', points: [[40, 15], [60, 15], [86, 15]], from: { node: 'd1' }, spacing: 2 },
    ],
    trains: [{ id: 'T', track: 'lead', position: 120, throttle: 0.8, template: 'balanced', carCount: 3 }],
  };
  const derailing = new World(scene);
  assert.equal(derailing.trains[0]!.route!.stop.reason, 'derail');
  run(derailing, 90);
  assert.equal(derailing.trains[0]!.derailed, true);
  assert.match(derailing.trains[0]!.derailmentReason, /derail/);

  // Taken off the rail, the same movement runs straight past it.
  const clear = new World(scene);
  clear.setDerail('d1', false);
  assert.deepEqual(clear.trains[0]!.route!.legs.map((l) => l.track.id), ['lead', 'beyond']);
  run(clear, 90);
  assert.equal(clear.trains[0]!.derailedCount, 0);
});

test('backing into a switch lined against the movement derails it too', () => {
  const world = new World(spurScene('hand'));
  const train = world.trains[0]!;
  // Face the other way and back toward the switch: the same trap, approached
  // from the other end of the route.
  train.direction = -1;
  train.throttle = -0.6;
  world.rebuildRoute(train);
  run(world, 90);
  assert.equal(train.derailed, true);
  assert.match(train.derailmentReason, /ran through the switch|derail/);
});
