/**
 * The scenario the brief asks for, run end to end.
 *
 * "A train pulls into a siding, the conductor gets down at the west switch,
 * lines it reverse, the movement backs in, he walks the length of it, cuts off
 * four cars, ties handbrakes on them, has to walk back to the head end, and
 * restores the switch to normal."
 *
 * What is run here is that scenario **minus the cut**, because there is no cut:
 * `Train.cars` is `readonly` and this package has no split or join, which the
 * brief itself identifies as a separate feature. Everything else in the sentence
 * happens, in simulated minutes, and every act lands in the event log in order.
 *
 * The test asserts the *shape of the tour* rather than exact timings, but it
 * does assert that the whole thing takes the better part of half an hour, since
 * a version of this that ran instantly would have deleted the point of it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { task } from '../src/person.ts';
import { World, type SceneSpec } from '../src/world.ts';

const scene: SceneSpec = {
  name: 'a tour of duty',
  embodied: true,
  terrain: { cols: 160, rows: 30, cellSize: 12, baseElevation: 4 },
  nodes: [
    { id: 'sw-w', kind: 'switch', position: 'normal', operation: 'hand', label: 'W', locked: true },
    { id: 'sw-e', kind: 'switch', position: 'normal', operation: 'hand', label: 'E', locked: true },
  ],
  tracks: [
    { id: 'main-w', points: [[2, 15], [30, 15], [56, 15]], to: { node: 'sw-w', port: 'trunk' }, spacing: 3 },
    {
      id: 'main-mid',
      points: [[56, 15], [90, 15], [124, 15]],
      from: { node: 'sw-w', port: 'normal' },
      to: { node: 'sw-e', port: 'normal' },
      spacing: 3,
    },
    {
      id: 'siding',
      points: [[56, 15], [62, 14.4], [70, 13.6], [110, 13.6], [118, 14.4], [124, 15]],
      from: { node: 'sw-w', port: 'reverse' },
      to: { node: 'sw-e', port: 'reverse' },
      spacing: 3,
    },
    { id: 'main-e', points: [[124, 15], [145, 15], [158, 15]], from: { node: 'sw-e', port: 'trunk' }, spacing: 3 },
  ],
  trains: [
    { id: 'M301', label: 'M301', track: 'main-w', position: 600, brake: 1, template: 'mixedFreight', carCount: 8 },
  ],
  people: [{ id: 'cond', name: 'Conductor', role: 'conductor', ridingOn: 'M301' }],
};

test('a tour: down, line the switch, back in, tie handbrakes, walk back, restore', () => {
  const world = new World(scene);
  const train = world.trains[0]!;
  const conductor = world.person('cond')!;
  const acts: string[] = [];

  const run = (seconds: number) => {
    for (let t = 0; t < seconds; t += 0.02) {
      world.step(0.02);
      for (const e of world.events.recent) acts.push(`${e.kind}${e.subject ? `:${e.subject}` : ''}`);
    }
  };

  // ── He is riding, so nothing on the ground is his to touch yet.
  assert.equal(conductor.posture, 'riding');
  assert.equal(world.canThrowSwitch('sw-w').ok, false, 'nobody is at the switch');

  // ── Get down, walk to the west switch, line it reverse.
  world.assign('cond', task('dismount'));
  run(20);
  assert.equal(conductor.posture, 'on-ground');

  world.sendToSwitch('cond', 'sw-w', 'reverse');
  run(900);
  assert.equal(world.network.nodes.get('sw-w')!.position, 'reverse', 'the switch is lined for the siding');
  assert.deepEqual(
    train.route!.legs.map((l) => l.track.id).slice(0, 2),
    ['main-w', 'siding'],
    'and the movement is now routed into it',
  );

  // ── Take the movement into the siding. Gently, and not far: the east switch
  //    is still lined for the main, so anything that runs the length of the
  //    siding trails through it and goes on the ground. That is the simulation
  //    being right, and it is exactly the mistake the feature exists to expose.
  // Releasing takes time too — the pipe has to be recharged and every cylinder
  // exhausted — so the movement does not start the instant the handle moves.
  // These durations are short because the release now works: the brake pipe
  // propagates as a wave rather than by conservative diffusion, so a train
  // actually comes off the brakes and this ran the length of the siding and
  // trailed through the far switch when it was first re-timed.
  train.brake = 0;
  train.throttle = 0.2;
  run(60);
  train.throttle = 0;
  train.brake = 1;
  run(120);
  const standing = world.trackFor(train)!.id;
  assert.equal(standing, 'siding', `the movement is in the siding, not on ${standing}`);
  assert.equal(train.derailedCount, 0, 'and it got there without incident');

  // ── Walk the length of it and tie handbrakes on the last four cars.
  const rear = train.cars.slice(-4);
  for (const car of rear) {
    const loc = train.route!.locate(car.s);
    world.send(
      'cond',
      { track: loc.track.id, at: loc.at, offset: 3 },
      task('apply-handbrake', { target: car.id, label: `tie the handbrake on ${car.id}` }),
    );
  }
  run(1800);
  for (const car of rear) {
    assert.equal(car.handbrake, true, `car ${car.id} was not tied down`);
  }

  // ── Walk back to the head end and restore the switch to normal.
  world.sendToSwitch('cond', 'sw-w', 'normal');
  run(1200);
  assert.equal(world.network.nodes.get('sw-w')!.position, 'normal', 'the switch is restored');

  // ── The tape. Every act is there, in the order it happened.
  const turned = acts.filter((a) => a === 'turned:sw-w');
  assert.equal(turned.length, 2, 'the switch was turned twice: reversed, then restored');
  assert.equal(acts.filter((a) => a.startsWith('handbrake-applied')).length, 4);
  assert.ok(acts.indexOf('dismounted') < acts.indexOf('turned:sw-w'), 'he got down before he lined it');
  assert.ok(
    acts.lastIndexOf('handbrake-applied:' + rear[3]!.id) < acts.lastIndexOf('turned:sw-w'),
    'and tied the last handbrake before walking back to restore the switch',
  );

  // ── And it took the time it takes. Half an hour of railroading, not a
  //    function call: this is the whole justification for the feature.
  assert.ok(world.time > 20 * 60, `the tour took only ${(world.time / 60).toFixed(1)} minutes`);
  assert.ok(world.time < 90 * 60, 'but not an implausible amount of it');
});

test('the event log reads as an account of what one person did', () => {
  const world = new World(scene);
  world.assign('cond', task('dismount'));
  for (let t = 0; t < 10; t += 0.02) world.step(0.02);
  world.sendToSwitch('cond', 'sw-w', 'reverse');
  for (let t = 0; t < 900; t += 0.02) world.step(0.02);

  const his = world.events.by('cond');
  assert.deepEqual(his.map((e) => e.kind), ['dismounted', 'arrived', 'turned', 'examined']);
  // Each act carries when, and the ones on the ground carry where.
  for (const event of his) assert.ok(event.at >= 0);
  const turned = his.find((e) => e.kind === 'turned')!;
  assert.equal(turned.where?.track, 'main-w');
  assert.ok(typeof turned.where?.at === 'number');
});
