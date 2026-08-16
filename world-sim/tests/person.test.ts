import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brakingEffort, buildAir, DEFAULT_AIR } from '../src/airbrake.ts';
import { throwCar } from '../src/derailment.ts';
import { task, WORKING_DISTANCE } from '../src/person.ts';
import { World, type SceneSpec } from '../src/world.ts';

/**
 * A main track with a siding and a hand switch at the west end, and a conductor
 * standing beside the head end. Everything below is done from this.
 */
const yard = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  terrain: { cols: 120, rows: 30, cellSize: 12, baseElevation: 4 },
  embodied: true,
  nodes: [{ id: 'sw', kind: 'switch', position: 'normal', operation: 'hand', label: 'W' }],
  tracks: [
    { id: 'main', points: [[2, 15], [40, 15], [70, 15]], to: { node: 'sw', port: 'trunk' }, spacing: 3 },
    { id: 'main-e', points: [[70, 15], [95, 15], [118, 15]], from: { node: 'sw', port: 'normal' }, spacing: 3 },
    {
      id: 'siding',
      points: [[70, 15], [76, 14.4], [84, 13.6], [118, 13.6]],
      from: { node: 'sw', port: 'reverse' },
      spacing: 3,
    },
  ],
  trains: [{ id: 'M1', track: 'main', position: 700, brake: 1, template: 'mixedFreight', carCount: 5 }],
  people: [{ id: 'cond', name: 'Conductor', role: 'conductor', track: 'main', at: 700, offset: 3 }],
  ...over,
});

/** Run for `seconds` of simulated time, collecting the acts. */
function run(world: World, seconds: number): { kind: string; by?: string; subject?: string }[] {
  const log: { kind: string; by?: string; subject?: string }[] = [];
  for (let t = 0; t < seconds; t += 0.02) {
    world.step(0.02);
    for (const e of world.events.recent) log.push({ kind: e.kind, by: e.by, subject: e.subject });
  }
  return log;
}

test('a person stands where their track coordinates say, offset and all', () => {
  const world = new World(yard());
  const person = world.person('cond')!;
  const track = world.tracks.find((t) => t.id === 'main')!;
  const pt = track.at(700);

  assert.equal(person.posture, 'on-ground');
  // Three metres to one side of the centre line, not on it.
  assert.ok(Math.abs(Math.hypot(person.x - pt.x, person.y - pt.y) - 3) < 0.01);
  assert.ok(person.z >= world.terrain.heightAt(person.x, person.y) - 0.3);
});

test('walking takes the time walking takes', () => {
  const world = new World(yard());
  const person = world.person('cond')!;
  world.send('cond', { track: 'main', at: 200, offset: 3 });

  // 500 m at 1.25 m/s is four hundred seconds, and the point of the feature is
  // that the simulation makes you spend them.
  run(world, 60);
  assert.ok(person.at > 200 && person.at < 700, 'still walking a minute in');
  const log = run(world, 400);
  assert.ok(log.some((e) => e.kind === 'arrived'));
  assert.ok(Math.abs(person.at - 200) < 1);
});

test('a task nobody is near enough for is refused, out loud', () => {
  const world = new World(yard());
  world.assign('cond', task('line-switch', { target: 'sw', position: 'reverse' }));
  const log = run(world, 5);

  const refusal = log.find((e) => e.kind === 'refused');
  assert.ok(refusal, 'it did not silently fail');
  assert.equal(world.network.nodes.get('sw')!.position, 'normal', 'and the switch did not move');
  assert.match(world.person('cond')!.lastRefusal ?? '', /too far away/);
});

test('sending somebody to a switch lines it, and the acts are recorded in order', () => {
  const world = new World(yard());
  world.sendToSwitch('cond', 'sw', 'reverse');
  const log = run(world, 600);

  const kinds = log.filter((e) => e.by === 'cond').map((e) => e.kind);
  assert.deepEqual(kinds, ['arrived', 'turned', 'examined']);
  assert.equal(world.network.nodes.get('sw')!.position, 'reverse');

  const turned = world.events.about('sw').find((e) => e.kind === 'turned')!;
  assert.equal(turned.detail?.from, 'normal');
  assert.equal(turned.detail?.to, 'reverse');
  assert.ok(turned.where, 'and it says where he was standing when he did it');
});

test('a switch a person throws re-routes the movements, as the control machine would', () => {
  const world = new World(yard());
  const legs = () => world.trains[0]!.route!.legs.map((l) => l.track.id);
  assert.deepEqual(legs(), ['main', 'main-e']);

  world.sendToSwitch('cond', 'sw', 'reverse');
  run(world, 600);
  assert.deepEqual(legs(), ['main', 'siding']);
});

test('with embodiment on, a hand switch cannot be thrown from nowhere', () => {
  const world = new World(yard());
  const check = world.canThrowSwitch('sw');
  assert.equal(check.ok, false);
  assert.match(check.reason ?? '', /somebody has to be at it/);
  assert.equal(world.throwSwitch('sw', 'reverse'), false);

  // Walk him to it and the same call succeeds — the switch did not change, the
  // world did.
  world.sendToSwitch('cond', 'sw');
  run(world, 600);
  assert.equal(world.canThrowSwitch('sw').ok, true);
});

test('a power switch needs nobody, embodiment or not', () => {
  const world = new World(
    yard({ nodes: [{ id: 'sw', kind: 'switch', position: 'normal', operation: 'power' }] }),
  );
  assert.equal(world.canThrowSwitch('sw').ok, true, 'it is worked from a control machine');
  assert.equal(world.throwSwitch('sw', 'reverse'), true);
});

test('embodiment is off by default, so older scenes still run', () => {
  const world = new World(yard({ embodied: undefined, people: [] }));
  assert.equal(world.embodied, false);
  assert.equal(world.throwSwitch('sw', 'reverse'), true);
});

test('a handbrake takes half a minute and then actually holds the car', () => {
  const world = new World(
    yard({
      terrain: {
        cols: 120,
        rows: 30,
        cellSize: 12,
        baseElevation: 4,
        features: [{ kind: 'ramp', from: [2, 15], to: [118, 15], height: 40 }],
      },
      trains: [{ id: 'M1', track: 'main', position: 700, template: 'mixedFreight', carCount: 3 }],
    }),
  );
  const train = world.trains[0]!;
  const car = train.cars[0]!;

  // Left to itself on a grade it rolls away.
  const loose = new World(JSON.parse(JSON.stringify(world.toJSON())) as SceneSpec);
  const before = loose.trains[0]!.headPosition;
  for (let t = 0; t < 40; t += 0.02) loose.step(0.02);
  assert.ok(Math.abs(loose.trains[0]!.headPosition - before) > 5, 'it ran away');

  // Tie every handbrake and it stands.
  for (const c of train.cars) c.handbrake = true;
  const held = train.headPosition;
  for (let t = 0; t < 40; t += 0.02) world.step(0.02);
  assert.ok(Math.abs(train.headPosition - held) < 1, 'handbrakes held it');
  assert.equal(car.handbrake, true);
});

test('what a person can do depends entirely on where they are standing', () => {
  // Standing well clear of everything: the working radius is twelve metres, and
  // the conductor starts beside the train.
  const world = new World(yard({
    people: [{ id: 'cond', name: 'Conductor', role: 'conductor', track: 'main', at: 300, offset: 3 }],
  }));
  assert.deepEqual(world.actionsAt('cond').map((a) => a.kind).sort(), [], 'nothing within reach');

  world.sendToSwitch('cond', 'sw');
  run(world, 600);
  const kinds = new Set(world.actionsAt('cond').map((a) => a.kind));
  assert.ok(kinds.has('line-switch'));
  assert.ok(kinds.has('point-and-call'));
});

test('getting on, riding, and getting down again', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const person = world.person('cond')!;
  const car = train.cars[1]!;

  // Walk to the car, board it, and be carried by it.
  const loc = train.route!.locate(car.s);
  world.send('cond', { track: loc.track.id, at: loc.at, offset: 3 }, task('board', { target: car.id }));
  run(world, 600);
  assert.equal(person.posture, 'riding');
  assert.equal(person.carId, car.id);

  train.brake = 0;
  train.throttle = 0.6;
  const started = { x: person.x, y: person.y };
  run(world, 30);
  assert.ok(Math.hypot(person.x - started.x, person.y - started.y) > 20, 'he went with it');

  world.assign('cond', task('dismount'));
  run(world, 20);
  assert.equal(person.posture, 'on-ground');
  assert.ok(person.trackId, 'and he is beside the track the movement was on');
});

test('somebody riding a car that derails goes with it', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const person = world.person('cond')!;
  const car = train.cars[1]!;
  person.posture = 'riding';
  person.trainId = train.id;
  person.carId = car.id;

  throwCar(train, car, train.route!.at(car.s), 1, 1.2, world.physics.derailment);
  run(world, 10);

  assert.ok(car.body, 'the car is a free body now');
  assert.ok(
    Math.hypot(person.x - car.body!.x, person.y - car.body!.y) < 2,
    'and he is wherever it ended up',
  );
});

test('the working distance covers a switch stand and not much more', () => {
  const world = new World(yard());
  const node = world.network.nodes.get('sw')!;
  const person = world.person('cond')!;

  // Standing at the stand, 3.4 m off the centre line, counts as being at it.
  person.trackId = 'main';
  person.at = world.tracks.find((t) => t.id === 'main')!.length;
  person.offset = 3.4;
  world.step(0.02);
  assert.ok(world.somebodyAt(node.x, node.y), 'at the stand is at the switch');

  // Three car lengths away is not.
  person.at -= 60;
  world.step(0.02);
  assert.equal(world.somebodyAt(node.x, node.y), null);
  // Wide enough to be a place you can walk into and see yourself entering,
  // narrow enough that "at the switch" still means at the switch rather than
  // anywhere on the lead.
  assert.ok(WORKING_DISTANCE >= 8 && WORKING_DISTANCE <= 20, 'the radius still means something');
});

test('the work zones are the same places the actions are', () => {
  const world = new World(yard());
  world.sendToSwitch('cond', 'sw');
  run(world, 600);

  const zones = world.workZones('cond');
  const stand = zones.find((z) => z.kind === 'switch' && z.id === 'sw');
  assert.ok(stand, 'the switch is ringed');
  assert.equal(stand!.radius, WORKING_DISTANCE);
  // Standing at it, the ring says so and the action is offered. The two must
  // never disagree: the circle is a promise about what the panel will show.
  assert.equal(stand!.inReach, true);
  const offered = world.actionsAt('cond').filter((a) => a.target === 'sw');
  assert.ok(offered.length > 0);
  // Every act names the circle it came out of, and names it the same way the
  // circle does: that string is all the panel has to head the box with.
  assert.ok(offered.every((a) => a.zone === stand!.id && a.zoneLabel === stand!.label));
  assert.ok(zones.every((z) => z.label.length > 0), 'every circle is named');
  // Nothing is ever offered from a circle that was not drawn.
  const drawn = new Set(zones.filter((z) => z.inReach).map((z) => z.id));
  assert.ok(world.actionsAt('cond').every((a) => drawn.has(a.zone)));

  // Nothing is ringed for somebody who is not on their feet — from a car there
  // is nothing to walk into.
  const person = world.person('cond')!;
  person.posture = 'riding';
  assert.deepEqual(world.workZones('cond'), []);
});

test('the head end stays findable after the route is rebuilt', () => {
  // The camera follows the head end of the movement somebody is on. It used to
  // find it by sampling the *track* under the lead car at that car's `s` — but
  // `s` runs along the **route**, and a route is only ever a window: cut from a
  // kilometre behind the movement, and re-cut whenever a switch is thrown. On a
  // yard lead the two measures happen to agree, which is why this went unseen;
  // on a subdivision they are kilometres apart, and the camera stopped following
  // the train and pointed at another part of the railway.
  //
  // So the scene here is long on purpose. Somebody riding the lead car is the
  // independent witness — a person's position is worked out from the car they
  // are on, not from the code under test.
  const world = new World({
    terrain: { cols: 900, rows: 30, cellSize: 12, baseElevation: 4 },
    embodied: true,
    nodes: [{ id: 'sw', kind: 'switch', position: 'normal', operation: 'hand', label: 'W' }],
    tracks: [
      { id: 'main', points: [[2, 15], [200, 15], [300, 15]], to: { node: 'sw', port: 'trunk' }, spacing: 4 },
      { id: 'main-e', points: [[300, 15], [890, 15]], from: { node: 'sw', port: 'normal' }, spacing: 4 },
      {
        id: 'siding',
        points: [[300, 15], [310, 14.4], [330, 13.6], [500, 13.6]],
        from: { node: 'sw', port: 'reverse' },
        spacing: 4,
      },
    ],
    trains: [{ id: 'M1', track: 'main', position: 2600, brake: 1, template: 'mixedFreight', carCount: 5 }],
    people: [
      { id: 'cond', name: 'Conductor', role: 'conductor', track: 'main', at: 2600, offset: 3 },
      { id: 'eng', name: 'Engineer', role: 'locomotive-engineer', track: 'main', at: 2600, offset: 3 },
    ],
  });
  const train = world.trains[0]!;
  const rider = world.person('eng')!;

  world.assign('eng', task('board', { target: train.cars[0]!.id }));
  run(world, 60);
  assert.equal(rider.posture, 'riding');

  const at = () => {
    const head = world.headEnd(train)!;
    return Math.hypot(head.x - rider.x, head.y - rider.y);
  };
  // Somebody riding stands beside the car rather than on its centre line, so
  // what is asserted is that the gap does not *change*. A jump is the symptom.
  const offset = at();
  assert.ok(offset < 15, 'the head end starts within a car length of the rider');

  // Out of the first track and well along the second, and **stopped short of
  // the end** — running to the buffer stop hid this once, because a wrong answer
  // that clamps to the end of the railway is right when the train is there.
  train.brake = 0;
  train.throttle = 0.9;
  run(world, 180);
  train.throttle = 0;
  train.brake = 1;
  run(world, 300);
  assert.equal(world.trackFor(train)!.id, 'main-e', 'it is out on the main');

  // Getting down and lining the switch is what re-cuts every route.
  world.sendToSwitch('cond', 'sw');
  run(world, 1800);
  assert.equal(world.network.nodes.get('sw')!.position, 'reverse');

  assert.ok(
    Math.abs(at() - offset) < 1,
    `the head end is still at the lead car (was ${offset.toFixed(1)} m away, now ${at().toFixed(1)})`,
  );
});

test('people and switch state survive a round trip through JSON', () => {
  const world = new World(yard());
  world.sendToSwitch('cond', 'sw', 'reverse');
  run(world, 600);
  const node = world.network.nodes.get('sw')!;
  node.locked = true;
  node.spiked = true;

  const again = new World(JSON.parse(JSON.stringify(world.toJSON())) as SceneSpec);
  const there = again.network.nodes.get('sw')!;
  // The bug this feature had to fix first: a conductor who locks a switch and
  // exports the scene must not lose the lock.
  assert.equal(there.locked, true);
  assert.equal(there.spiked, true);
  assert.equal(there.position, 'reverse');

  const person = again.person('cond')!;
  assert.equal(person.role, 'conductor');
  assert.equal(person.trackId, 'main');
  assert.ok(Math.abs(person.at - world.person('cond')!.at) < 0.01, 'and he reloads where he walked to');
});

test('the terrain answers what it can see', () => {
  const world = new World({
    terrain: {
      cols: 80,
      rows: 40,
      cellSize: 12,
      baseElevation: 2,
      features: [{ x: 40, y: 20, radius: 8, height: 60 }],
    },
    tracks: [{ id: 'main', points: [[2, 20], [40, 20], [78, 20]], spacing: 3 }],
  });
  const t = world.terrain;
  // Straight through the hill: no.
  assert.equal(t.hasLineOfSight(60, 240, 5, 900, 240, 5), false);
  // Along the flat beside it: yes.
  assert.equal(t.hasLineOfSight(60, 60, 5, 900, 60, 5), true);
});

test('a walk can be sent to any point beside any track, offset and all', () => {
  const world = new World(yard());
  const person = world.person('cond')!;

  // Somewhere out in the field beside the siding, not on it.
  const siding = world.tracks.find((t) => t.id === 'siding')!;
  const pt = siding.at(200);
  const near = world.nearestPointOnTrack(pt.x + 8, pt.y + 8);
  assert.ok(near);
  assert.equal(near!.track, 'siding');

  world.send('cond', { track: near!.track, at: near!.at, offset: 9 });
  run(world, 1200);
  assert.equal(person.trackId, 'siding');
  assert.ok(Math.abs(person.offset - 9) < 0.01, 'he stands nine metres off the centre line');
  // And nine metres off a track is not at anything.
  assert.deepEqual(world.actionsAt('cond'), []);
});

test('a walk in progress can be called off', () => {
  const world = new World(yard());
  const person = world.person('cond')!;
  world.send('cond', { track: 'main', at: 100, offset: 3 });
  run(world, 30);
  const partway = person.at;
  assert.ok(partway < 700 && partway > 100, 'he set off');

  world.cancel('cond');
  run(world, 60);
  assert.equal(person.task, null);
  assert.ok(Math.abs(person.at - partway) < 1, 'and stopped where he was');
});

test('a cross-track walk keeps honest track coordinates the whole way', () => {
  const world = new World({
    terrain: { cols: 120, rows: 40, cellSize: 12, baseElevation: 4 },
    tracks: [
      { id: 'a', points: [[2, 20], [60, 20], [118, 20]], spacing: 3 },
      { id: 'b', points: [[2, 26], [60, 26], [118, 26]], spacing: 3 },
    ],
    people: [{ id: 'p', name: 'Tender', track: 'a', at: 300, offset: 3 }],
  });
  const person = world.person('p')!;
  world.send('p', { track: 'b', at: 900, offset: 3 });
  run(world, 60);

  // Mid-walk between two tracks, the world position is the truth and the track
  // coordinates are re-derived from it — so nothing that reads them puts him
  // back where he set off.
  const track = world.tracks.find((t) => t.id === person.trackId)!;
  const pt = track.at(person.at);
  const rebuilt = {
    x: pt.x + Math.sin(pt.heading) * person.offset,
    y: pt.y - Math.cos(pt.heading) * person.offset,
  };
  assert.ok(
    Math.hypot(rebuilt.x - person.x, rebuilt.y - person.y) < 1.5,
    'the decomposition reconstructs where he actually is',
  );
});

test('re-ordering somebody mid-walk does not send them back to the start', () => {
  const world = new World({
    terrain: { cols: 120, rows: 40, cellSize: 12, baseElevation: 4 },
    tracks: [
      { id: 'a', points: [[2, 20], [60, 20], [118, 20]], spacing: 3 },
      { id: 'b', points: [[2, 26], [60, 26], [118, 26]], spacing: 3 },
    ],
    people: [{ id: 'p', name: 'Tender', track: 'a', at: 300, offset: 3 }],
  });
  const person = world.person('p')!;
  world.send('p', { track: 'b', at: 900, offset: 3 });
  run(world, 60);
  const where = { x: person.x, y: person.y };

  world.cancel('p');
  world.send('p', { track: 'a', at: 200, offset: 3 });
  run(world, 0.1);
  assert.ok(
    Math.hypot(person.x - where.x, person.y - where.y) < 2,
    'he carries on from where he was standing, not from where he set off',
  );
});

test('walking accumulates a stride, standing still does not', () => {
  const world = new World(yard());
  const person = world.person('cond')!;
  assert.equal(person.stride, 0);
  world.send('cond', { track: 'main', at: 600, offset: 3 });
  run(world, 40);
  const walked = person.stride;
  assert.ok(walked > 40, `only ${walked.toFixed(0)} m of stride in 40 s`);

  world.cancel('cond');
  run(world, 20);
  assert.equal(person.stride, walked, 'a stopped person does not walk on the spot');
});

test('a conductor at an engine can climb into the cab, and only then is anybody driving', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const engine = train.cars[0]!;
  assert.equal(world.cabOccupant(train.id), null, 'nobody is driving to begin with');

  const loc = train.route!.locate(engine.s);
  world.send('cond', { track: loc.track.id, at: loc.at, offset: 3 });
  run(world, 600);

  const offered = world.actionsAt('cond');
  assert.match(offered.find((a) => a.kind === 'ride-cab')!.label, /climb into the cab/);
  assert.equal(
    offered.find((a) => a.kind === 'take-controls'),
    undefined,
    'the seat is not on offer from the ballast — you have to be in the cab',
  );

  // Climbing in is not taking the controls. A conductor rides in the cab for
  // most of a trip and is not driving, and the two acts are separate.
  world.assign('cond', task('ride-cab', { target: train.id }));
  run(world, 20);
  assert.equal(world.person('cond')!.posture, 'in-cab');
  assert.equal(world.person('cond')!.atControls, false);
  assert.equal(world.cabOccupant(train.id), null, 'in the cab is not at the controls');
  assert.ok(
    world.actionsAt('cond').some((a) => a.kind === 'take-controls'),
    'and now the seat is offered',
  );

  world.assign('cond', task('take-controls', { target: train.id }));
  run(world, 20);
  assert.equal(world.cabOccupant(train.id)?.id, 'cond');

  // Out of the seat, still in the cab.
  world.assign('cond', task('leave-controls', { target: train.id }));
  run(world, 12);
  assert.equal(world.person('cond')!.posture, 'in-cab');
  assert.equal(world.cabOccupant(train.id), null);
  world.assign('cond', task('take-controls', { target: train.id }));
  run(world, 20);

  // Getting down again leaves the throttle wherever it was: an unmanned engine
  // with the throttle open is a state the simulation must be able to be in.
  train.throttle = 0.5;
  world.assign('cond', task('leave-controls'), task('dismount'));
  run(world, 30);
  assert.equal(world.cabOccupant(train.id), null);
  assert.equal(train.throttle, 0.5, 'the throttle did not tidy itself up');
});

test('a conductor at a car can cut off everything behind it', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const cutBehind = train.cars[2]!;
  // Counts are derived, not written down: `mixedFreight` puts a van on the rear,
  // so a consist asked for five cars is six.
  const total = train.cars.length;
  const behind = total - 3;
  assert.equal(world.trains.length, 1);

  const joint = world.couplingBehind(cutBehind.id)!;
  world.send(
    'cond',
    { track: joint.track, at: joint.at, offset: 3 },
    task('uncouple', { target: cutBehind.id }),
  );
  run(world, 700);

  assert.equal(world.trains.length, 2, 'there are two movements now');
  assert.equal(train.cars.length, 3, 'the head end kept three');
  const cut = world.trains.find((t) => t !== train)!;
  assert.equal(cut.cars.length, behind);
  // The cut is standing exactly where those cars were standing — not teleported
  // to the origin of its new route, which is the arithmetic that goes wrong.
  const pt = cut.route!.at(cut.cars[0]!.s);
  assert.ok(world.terrain.contains(pt.x, pt.y));
  assert.ok(Math.abs(cut.speed) < 0.1, 'and it is not moving');

  const event = world.events.about(cutBehind.id).find((e) => e.kind === 'uncoupled');
  assert.ok(event, 'the act was recorded');
  assert.equal(event!.by, 'cond');
  assert.equal(event!.detail?.cars, behind);
});

test('a cut is held by its air at first, and rolls away once that leaks off', () => {
  const world = new World(
    yard({
      terrain: {
        cols: 120,
        rows: 30,
        cellSize: 12,
        baseElevation: 4,
        features: [{ kind: 'ramp', from: [2, 15], to: [118, 15], height: 50 }],
      },
      trains: [{ id: 'M1', track: 'main', position: 600, brake: 1, template: 'mixedFreight', carCount: 5 }],
      people: [{ id: 'cond', name: 'Conductor', role: 'conductor', track: 'main', at: 600, offset: 3 }],
    }),
  );
  const train = world.trains[0]!;
  const car = train.cars[1]!;
  const joint = world.couplingBehind(car.id)!;
  world.send('cond', { track: joint.track, at: joint.at, offset: 3 }, task('uncouple', { target: car.id }));

  // Measured from the moment it comes off, not later: a cut left to itself runs
  // to the end of steel and stops there, and waiting around would time the wrong
  // thing entirely.
  let cut: (typeof world.trains)[number] | undefined;
  for (let t = 0; t < 900 && !cut; t += 0.02) {
    world.step(0.02);
    cut = world.trains.find((x) => x !== train);
  }
  assert.ok(cut, 'the cut was made');

  // Cut off with the air applied, it stands — for a while. This is exactly the
  // trap 112 is written about: the cars look secured and are not.
  const before = cut!.cars[0]!.s;
  run(world, 120);
  assert.ok(
    Math.abs(cut!.cars[0]!.s - before) < 2,
    'the air was still holding it two minutes later',
  );
  assert.ok(cut!.cars[0]!.air.cylinderPsi > 5, 'because there is still pressure in the cylinder');
  assert.ok(!cut!.hasAir, 'and nothing on the cut can put any more in');

  // Left long enough — hours, not minutes — the cylinders leak down and then the
  // reservoirs, and there is nothing left to hold it with. Emptied here rather
  // than waited out, since the test should not sit through an afternoon.
  for (const car of cut!.cars) {
    car.air.cylinderPsi = 0;
    car.air.reservoirPsi = 0;
    car.air.referencePsi = 0;
    car.air.brakePipePsi = 0;
  }
  run(world, 60);
  assert.ok(
    Math.abs(cut!.cars[0]!.s - before) > 5,
    'once the air is off, nothing is holding it at all',
  );
});

test('two movements standing together can be coupled back up', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const total = train.cars.length;
  const car = train.cars[2]!;
  const joint = world.couplingBehind(car.id)!;
  world.send('cond', { track: joint.track, at: joint.at, offset: 3 }, task('uncouple', { target: car.id }));
  run(world, 700);
  assert.equal(world.trains.length, 2);
  const cut = world.trains.find((t) => t !== train)!;

  // They are still touching, so the joint is within reach and coupling is offered.
  const offered = world.actionsAt('cond');
  const couple = offered.find((a) => a.kind === 'couple');
  assert.ok(couple, `coupling was not offered; got ${offered.map((o) => o.kind).join(', ')}`);

  world.assign('cond', task('couple', { target: couple!.target }));
  run(world, 40);
  assert.equal(world.trains.length, 1, 'one movement again');
  assert.equal(world.trains[0]!.cars.length, total);
  assert.ok(world.events.all().some((e) => e.kind === 'coupled'));

  // And the order is the order they stand in on the ground.
  const joined = world.trains[0]!;
  const order = joined.cars.map((c) => c.s);
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i]! < order[i - 1]!, 'cars are still in order from the head end back');
  }
  assert.equal(cut.cars.length >= 0, true);
});

test('coupling is refused to a movement that is rolling', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const car = train.cars[2]!;
  const joint = world.couplingBehind(car.id)!;
  world.send('cond', { track: joint.track, at: joint.at, offset: 3 }, task('uncouple', { target: car.id }));
  run(world, 700);

  const rolling = world.trains.find((t) => t !== train)!;
  // Pulling the pin dumped the air, which opened the PCS, and no amount of
  // throttle does anything until that resets. The pipe cannot come back up with
  // a hose hanging open at the rear either, so close the cock — which is what
  // somebody would have walked back and done — then release and wait.
  train.cars[train.cars.length - 1]!.air.cockBehind = false;
  train.brake = 0;
  run(world, 90);
  assert.equal(train.pcs.open, false, 'the PCS reset once the pipe was back');
  train.throttle = 1;
  run(world, 15);
  assert.ok(Math.abs(train.speed) > 0.5, 'the movement really is rolling');
  assert.equal(world.couple(train.id, rolling.id), false, 'coupling is done at a stand');
});

// ───────────────────────────────────────────────────────────────── the air

test('cutting a train with the angle cocks open dumps the air on both portions', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const car = train.cars[2]!;
  // The scene stands with the brakes applied; release them so the emergency the
  // parting causes is unmistakably the parting's doing.
  train.brake = 0;
  run(world, 40);
  assert.ok(train.cars[0]!.air.cylinderPsi < 5, 'the brakes are off to begin with');

  world.uncouple(car.id, 'cond');
  const cut = world.trains.find((t) => t !== train)!;
  assert.equal(train.emergency, true);
  assert.equal(cut.emergency, true);
  assert.ok(world.events.all().some((e) => e.kind === 'emergency-brake'));

  // Both portions have the brakes hard on, from the hoses parting alone.
  run(world, 15);
  assert.ok(train.cars[0]!.air.cylinderPsi > 40, 'the head end went into emergency');
  assert.ok(cut.cars[0]!.air.cylinderPsi > 40, 'and so did the cut');
});

test('closing the angle cocks first keeps the air in both portions', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const car = train.cars[2]!;
  const behind = train.cars[3]!;

  train.brake = 0;
  run(world, 40);
  // What a conductor actually does: close both cocks, part the hoses, pull the pin.
  car.air.cockBehind = false;
  behind.air.cockAhead = false;
  world.uncouple(car.id, 'cond');

  assert.equal(train.emergency, false, 'nothing went to atmosphere');
  const cut = world.trains.find((t) => t !== train)!;
  assert.equal(cut.emergency, false);
  run(world, 15);
  assert.ok(train.cars[0]!.air.cylinderPsi < 10, 'the head end still has its brakes off');
});

test('a car cut out does not brake, and nothing about the pipe says so', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const cutOut = train.cars[2]!;
  cutOut.air.cutOut = true;
  train.brake = 1;
  run(world, 25);

  assert.ok(train.cars[1]!.air.cylinderPsi > 40, 'its neighbours are applied');
  assert.equal(cutOut.air.cylinderPsi < 5, true, 'and it is not');
  assert.ok(
    Math.abs(cutOut.air.brakePipePsi - train.cars[1]!.air.brakePipePsi) < 3,
    'while its brake pipe reads exactly the same as theirs',
  );
});

test('a retainer holds cylinder pressure back through a release', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const held = train.cars[2]!;
  const plain = train.cars[3]!;
  held.air.retainer = 'HP';

  train.brake = 1;
  run(world, 25);
  train.brake = 0;
  run(world, 30);

  assert.ok(plain.air.cylinderPsi < 3, 'the car with its retainer in exhaust let go');
  assert.ok(held.air.cylinderPsi > 12, 'the one set to high pressure kept some brake on');
});

test('piston travel out of limits costs braking force', () => {
  const good = buildAir({ nominalTravelIn: 7.5 });
  const bad = buildAir({ nominalTravelIn: 7.5 });
  good.cylinderPsi = 50;
  bad.cylinderPsi = 50;
  good.pistonTravelIn = 8;
  bad.pistonTravelIn = 14;
  assert.ok(brakingEffort(good, DEFAULT_AIR) > brakingEffort(bad, DEFAULT_AIR) * 1.4);
});

test('the conductor can work the air with their hands', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const car = train.cars[2]!;
  const behind = train.cars[3]!;
  const joint = world.couplingBehind(car.id)!;

  world.send(
    'cond',
    { track: joint.track, at: joint.at, offset: 3 },
    task('close-angle-cock', { target: car.id, end: 'behind' }),
  );
  world.assign(
    'cond',
    task('close-angle-cock', { target: behind.id, end: 'ahead' }),
    task('disconnect-hose', { target: car.id }),
  );
  run(world, 800);

  assert.equal(car.air.cockBehind, false);
  assert.equal(behind.air.cockAhead, false);
  assert.equal(car.air.hoseBehind, false);
  const kinds = world.events.by('cond').map((e) => e.kind);
  assert.deepEqual(kinds.slice(-3), ['angle-cock-closed', 'angle-cock-closed', 'hose-disconnected']);
});

// ─────────────────────────────────────────────────────── being in the way

test('somebody standing foul of the track is run over by moving equipment', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const person = world.person('cond')!;

  // Standing on the track ahead of the movement, not beside it.
  const ahead = train.route!.locate(train.headPosition + 120);
  person.trackId = ahead.track.id;
  person.at = ahead.at;
  person.offset = 0;
  world.step(0.02);
  assert.equal(person.injury, 'none', 'a standing train runs nobody over');

  train.brake = 0;
  train.throttle = 1;
  run(world, 90);

  assert.equal(person.injury, 'struck');
  const event = world.events.by('cond').find((e) => e.kind === 'injured');
  assert.ok(event);
  assert.equal(event!.detail?.how, 'struck by moving equipment');
  assert.ok(event!.where, 'and it says where it happened');
});

test('standing clear of the track is standing clear', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const person = world.person('cond')!;
  const ahead = train.route!.locate(train.headPosition + 120);
  person.trackId = ahead.track.id;
  person.at = ahead.at;
  person.offset = 4;

  train.brake = 0;
  train.throttle = 1;
  run(world, 90);
  assert.equal(person.injury, 'none');
});

test('somebody in the gap between two movements coming together is crushed', () => {
  // Two movements a little apart, and somebody standing in the gap — which is
  // exactly where you stand to buck up hoses or pull a pin.
  const world = new World({
    terrain: { cols: 160, rows: 30, cellSize: 12, baseElevation: 4 },
    embodied: true,
    tracks: [{ id: 'main', points: [[2, 15], [60, 15], [158, 15]], spacing: 3 }],
    trains: [
      { id: 'A', track: 'main', position: 600, brake: 1, template: 'unitGrain', carCount: 3 },
      // Close enough that the gap is a place to stand, not a stretch of railway:
      // three cars is about 58 m, so this leaves six or seven metres between them.
      { id: 'B', track: 'main', position: 665, brake: 1, template: 'unitGrain', carCount: 3 },
    ],
    people: [{ id: 'cond', name: 'Conductor', track: 'main', at: 600, offset: 3 }],
  });
  const [a, b] = world.trains as [(typeof world.trains)[number], (typeof world.trains)[number]];
  const gap = world.couplingGap(a, b)!;
  const near = world.nearestPointOnTrack(gap.x, gap.y)!;
  const person = world.person('cond')!;
  person.trackId = near.track;
  person.at = near.at;
  person.offset = 0;
  world.step(0.02);
  assert.equal(person.injury, 'none', 'nothing is moving yet');

  // Shove A up against B with him still standing in between.
  a.brake = 0;
  a.throttle = 0.6;
  run(world, 90);

  assert.equal(person.injury, 'crushed');
  assert.ok(world.couplingGap(a, b)!.distance < 2, 'they came together');
  assert.match(
    String(world.events.by('cond').find((e) => e.kind === 'injured')?.detail?.how),
    /between/,
  );
});

test('an injured person stops working and stays stopped', () => {
  const world = new World(yard());
  const person = world.person('cond')!;
  person.injury = 'struck';
  world.send('cond', { track: 'main', at: 200, offset: 3 });
  const before = person.at;
  run(world, 60);
  assert.equal(person.task, null);
  assert.equal(person.queue.length, 0);
  assert.equal(person.at, before, 'and does not walk anywhere');
});

test('riding a chosen end and side of a chosen car puts you there', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const car = train.cars[2]!;
  const person = world.person('cond')!;
  person.posture = 'riding';
  person.trainId = train.id;
  person.carId = car.id;
  person.ridingSide = 'left';
  person.ridingEnd = 'leading';
  world.step(0.02);
  const leading = { x: person.x, y: person.y };

  person.ridingEnd = 'trailing';
  world.step(0.02);
  const trailing = { x: person.x, y: person.y };
  assert.ok(
    Math.hypot(leading.x - trailing.x, leading.y - trailing.y) > car.length * 0.5,
    'the two ends of a car are a car apart',
  );

  person.ridingSide = 'right';
  world.step(0.02);
  assert.ok(
    Math.hypot(person.x - trailing.x, person.y - trailing.y) > car.width * 0.8,
    'and the two sides are a car wide',
  );
});

// ────────────────────────────────────────── the independent brake, and 62

test('the independent brake holds the engine and nothing behind it', () => {
  const world = new World(
    yard({
      terrain: {
        cols: 120,
        rows: 30,
        cellSize: 12,
        baseElevation: 4,
        features: [{ kind: 'ramp', from: [2, 15], to: [118, 15], height: 50 }],
      },
      trains: [{ id: 'M1', track: 'main', position: 600, template: 'mixedFreight', carCount: 4 }],
    }),
  );
  const train = world.trains[0]!;
  train.brake = 0;
  train.independent = 1;
  run(world, 20);

  const engine = train.cars[0]!;
  const car = train.cars[2]!;
  assert.ok(engine.air.cylinderPsi < 5, 'nothing went down the pipe');
  assert.ok(car.air.cylinderPsi < 5, 'and no car behind it has any brake on');
  // Which is the point: an independent application is the engine's brakes only,
  // and on a grade a few hundred tonnes behind it will drag it along.
});

test('a centred reverser makes the throttle inert', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  train.brake = 0;
  run(world, 40);
  train.reverser = 'neutral';
  train.throttle = 1;
  const before = train.headPosition;
  run(world, 30);
  assert.ok(Math.abs(train.headPosition - before) < 1, 'it did not move under power');

  // Off centre, the same throttle moves it.
  train.reverser = 'forward';
  run(world, 20);
  assert.ok(train.headPosition - before > 5);
});

test('set and centre does both things at once', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  train.throttle = 0.8;
  train.independent = 0;
  train.reverser = 'forward';

  train.setAndCentre();
  assert.equal(train.independent, 1);
  assert.equal(train.reverser, 'neutral');
  assert.equal(train.throttle, 0);
});

test('only somebody at the controls can set and centre', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  world.assign('cond', task('set-and-centre', { target: train.id }));
  run(world, 20);
  assert.match(world.person('cond')!.lastRefusal ?? '', /not at the controls/);
  assert.equal(train.reverser, 'forward');

  // In the cab it works, and it is recorded. Climbing in comes first: the
  // controls cannot be taken from the ground.
  const engine = train.cars[0]!;
  const loc = train.route!.locate(engine.s);
  world.send(
    'cond',
    { track: loc.track.id, at: loc.at, offset: 3 },
    task('ride-cab', { target: train.id }),
    task('take-controls', { target: train.id }),
  );
  run(world, 700);
  world.assign('cond', task('set-and-centre', { target: train.id }));
  run(world, 20);
  assert.equal(train.reverser, 'neutral');
  assert.ok(world.events.by('cond').some((e) => e.kind === 'set-and-centred'));
});

test('bailing off releases the engine and leaves the train applied', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  train.brake = 1;
  run(world, 30);
  assert.ok(train.cars[0]!.air.cylinderPsi > 40, 'the engine is applied with everything else');

  train.bailOff();
  assert.ok(train.cars[0]!.air.cylinderPsi < 1, 'the engine let go');
  assert.ok(train.cars[2]!.air.cylinderPsi > 40, 'and the train did not');
});

// ─────────────────────────────────────────────── the crew, and the casualty

test('only a crew of two can be worked', () => {
  const world = new World(
    yard({
      people: [
        { id: 'a', name: 'Conductor', role: 'conductor', track: 'main', at: 700, offset: 3 },
        { id: 'b', name: 'Engineer', role: 'locomotive-engineer', track: 'main', at: 700, offset: 4 },
        { id: 'c', name: 'Switchtender', role: 'switchtender', track: 'main', at: 300, offset: 4 },
        { id: 'd', name: 'Foreman', role: 'foreman', track: 'main', at: 100, offset: 4 },
      ],
    }),
  );
  assert.equal(world.people.length, 4, 'the scene still has everybody in it');
  assert.deepEqual(world.crew.map((p) => p.id), ['a', 'b']);
});

test('a scene can say who the crew is', () => {
  const world = new World(
    yard({
      people: [
        { id: 'a', name: 'Switchtender', role: 'switchtender', track: 'main', at: 300, offset: 4 },
        { id: 'b', name: 'Conductor', role: 'conductor', crew: true, track: 'main', at: 700, offset: 3 },
        { id: 'c', name: 'Engineer', role: 'locomotive-engineer', crew: true, track: 'main', at: 700, offset: 4 },
      ],
    }),
  );
  assert.deepEqual(world.crew.map((p) => p.id), ['b', 'c']);
});

test('somebody hurt is left where they fell and is no longer crew', () => {
  const world = new World(yard());
  const train = world.trains[0]!;
  const person = world.person('cond')!;

  const ahead = train.route!.locate(train.headPosition + 120);
  person.trackId = ahead.track.id;
  person.at = ahead.at;
  person.offset = 0;
  train.brake = 0;
  train.throttle = 1;
  run(world, 90);

  assert.equal(person.injury, 'struck');
  const fell = { x: person.x, y: person.y };
  assert.deepEqual(world.crew.map((p) => p.id), [], 'a casualty is not somebody you can work');

  // The train runs on over the spot and he stays exactly where he is.
  run(world, 60);
  assert.equal(person.x, fell.x);
  assert.equal(person.y, fell.y);
  assert.equal(person.posture, 'on-ground');
});

test('somebody hurt while riding comes off there and stays there', () => {
  const world = new World({
    terrain: { cols: 160, rows: 30, cellSize: 12, baseElevation: 4 },
    embodied: true,
    tracks: [{ id: 'main', points: [[2, 15], [60, 15], [158, 15]], spacing: 3 }],
    trains: [
      { id: 'A', track: 'main', position: 600, brake: 1, template: 'unitGrain', carCount: 3 },
      { id: 'B', track: 'main', position: 665, brake: 1, template: 'unitGrain', carCount: 3 },
    ],
    people: [{ id: 'cond', name: 'Conductor', track: 'main', at: 600, offset: 3 }],
  });
  const [a, b] = world.trains as [(typeof world.trains)[number], (typeof world.trains)[number]];
  const gap = world.couplingGap(a, b)!;
  const near = world.nearestPointOnTrack(gap.x, gap.y)!;
  const person = world.person('cond')!;
  person.trackId = near.track;
  person.at = near.at;
  person.offset = 0;

  a.brake = 0;
  a.throttle = 0.6;
  run(world, 90);
  assert.equal(person.injury, 'crushed');

  const fell = { x: person.x, y: person.y };
  a.throttle = 0;
  a.brake = 1;
  run(world, 60);
  assert.deepEqual({ x: person.x, y: person.y }, fell);
});

test('a cut left to itself is held by its own air, and bleeding it lets it go', () => {
  // A cut on a grade. Pulling the pin without closing the cocks puts the
  // portion in emergency, so it stands there with the brakes hard on — which is
  // the trap, because it looks secured and is not. Bleeding it off is the act
  // that makes it free to move, and after that only a handbrake will hold it.
  const world = new World(
    yard({
      terrain: {
        cols: 120,
        rows: 30,
        cellSize: 12,
        baseElevation: 4,
        features: [{ kind: 'ramp', from: [2, 15], to: [118, 15], height: 55 }],
      },
      trains: [{ id: 'M1', track: 'main', position: 600, brake: 1, template: 'mixedFreight', carCount: 5 }],
      people: [{ id: 'cond', name: 'Conductor', role: 'conductor', track: 'main', at: 600, offset: 3 }],
    }),
  );
  const train = world.trains[0]!;
  const car = train.cars[2]!;
  const joint = world.couplingBehind(car.id)!;
  world.send('cond', { track: joint.track, at: joint.at, offset: 3 }, task('uncouple', { target: car.id }));

  let cut: (typeof world.trains)[number] | undefined;
  for (let t = 0; t < 900 && !cut; t += 0.02) {
    world.step(0.02);
    cut = world.trains.find((x) => x !== train);
  }
  assert.ok(cut, 'the cut was made');
  const head = cut!.cars[0]!;
  assert.ok(head.air.cylinderPsi > 20, 'the parting applied its brakes');

  const stood = head.s;
  run(world, 120);
  assert.ok(Math.abs(head.s - stood) < 2, 'and they hold it, for now');

  // Walk back and pull the release rod on every car in the cut.
  for (const c of cut!.cars) {
    const loc = cut!.route!.locate(c.s);
    world.send('cond', { track: loc.track.id, at: loc.at, offset: 3 }, task('bleed', { target: c.id }));
  }
  for (let t = 0; t < 3000; t += 0.02) {
    world.step(0.02);
    if (cut!.cars.every((c) => c.air.cylinderPsi < 1)) break;
  }
  assert.ok(cut!.cars.every((c) => c.air.reservoirPsi < 1), 'every car is bled');
  assert.ok(world.events.all().some((e) => e.kind === 'bled'), 'and the act was recorded');

  const released = head.s;
  run(world, 90);
  assert.ok(Math.abs(head.s - released) > 10, `bled cars stood still on a grade: ${head.s - released} m`);
});

test('a handbrake is what holds a bled cut, which is the whole of 112', () => {
  const world = new World(
    yard({
      terrain: {
        cols: 120,
        rows: 30,
        cellSize: 12,
        baseElevation: 4,
        features: [{ kind: 'ramp', from: [2, 15], to: [118, 15], height: 55 }],
      },
      trains: [{ id: 'M1', track: 'main', position: 600, template: 'mixedFreight', carCount: 4 }],
      people: [{ id: 'cond', name: 'Conductor', role: 'conductor', track: 'main', at: 600, offset: 3 }],
    }),
  );
  const train = world.trains[0]!;
  for (const c of train.cars) {
    c.air.reservoirPsi = 0;
    c.air.cylinderPsi = 0;
    c.air.brakePipePsi = 0;
    c.air.referencePsi = 0;
    c.handbrake = true;
  }
  const held = train.headPosition;
  run(world, 120);
  assert.ok(Math.abs(train.headPosition - held) < 1, 'handbrakes held it with no air at all');

  for (const c of train.cars) c.handbrake = false;
  run(world, 60);
  assert.ok(Math.abs(train.headPosition - held) > 10, 'and it went as soon as they came off');
});
