import assert from 'node:assert/strict';
import { test } from 'node:test';
import { throwCar } from '../src/derailment.ts';
import { ASPECTS, aspectByName, aspectByRule, SPEED_LIMITS } from '../src/signals.ts';
import { World, type SceneSpec } from '../src/world.ts';

const line = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  terrain: { cols: 220, rows: 20, cellSize: 12, baseElevation: 3 },
  tracks: [{ id: 'main', points: [[2, 10], [110, 10], [218, 10]], spacing: 3 }],
  ...over,
});

const showing = (world: World) =>
  Object.fromEntries(world.signals.map((s) => [s.id, s.aspect.name]));

test('the catalogue is the CROR signal table', () => {
  assert.ok(ASPECTS.length >= 35, `only ${ASPECTS.length} aspects`);
  // The ones the block logic leans on must exist under their own rule numbers.
  for (const [rule, name] of [
    ['405', 'Clear'],
    ['411', 'Clear To Stop'],
    ['415', 'Advance Clear To Stop'],
    ['436', 'Restricting'],
    ['437', 'Stop and Proceed'],
    ['439', 'Stop'],
  ] as const) {
    const aspect = aspectByRule(rule);
    assert.ok(aspect, `rule ${rule} is missing`);
    assert.equal(aspect!.name, name);
    assert.ok(aspect!.indication.length > 0);
    assert.ok(aspect!.lamps.length > 0);
  }
  assert.equal(aspectByName('clear to medium')!.rule, '407');
  assert.equal(aspectByName('Nonsense'), undefined);
});

test('every aspect says what it permits and what to be ready for', () => {
  for (const aspect of ASPECTS) {
    assert.ok(aspect.passing in SPEED_LIMITS, `${aspect.name} has no passing speed`);
    assert.ok(aspect.next in SPEED_LIMITS, `${aspect.name} has no next speed`);
  }
  // The grammar of speed signalling: the name says both halves.
  const cm = aspectByName('Clear To Medium')!;
  assert.equal(cm.passing, 'normal');
  assert.equal(cm.next, 'medium');
  const ms = aspectByName('Medium To Stop')!;
  assert.equal(ms.passing, 'medium');
  assert.equal(ms.next, 'stop');
  assert.equal(aspectByName('Stop')!.passing, 'stop');
  assert.equal(aspectByName('Restricting')!.passing, 'restricted');
  assert.equal(aspectByName('Advance Clear To Stop')!.advance, true);
});

test('an occupied block puts its signal to Stop and steps back from there', () => {
  const world = new World(
    line({
      signals: [
        { id: 'S1', track: 'main', at: 400 },
        { id: 'S2', track: 'main', at: 1000 },
        { id: 'S3', track: 'main', at: 1600 },
        { id: 'S4', track: 'main', at: 2200 },
      ],
      trains: [{ id: 'T', track: 'main', position: 2300, brake: 1, template: 'balanced', carCount: 2 }],
    }),
  );
  world.step(0.02);
  assert.deepEqual(showing(world), {
    S1: 'Clear',
    S2: 'Advance Clear To Stop',
    S3: 'Clear To Stop',
    S4: 'Stop',
  });
});

test('the block clears behind a movement as it goes', () => {
  const world = new World(
    line({
      signals: [
        { id: 'S1', track: 'main', at: 400 },
        { id: 'S2', track: 'main', at: 1200 },
        { id: 'S3', track: 'main', at: 2000 },
      ],
      trains: [{ id: 'T', track: 'main', position: 700, brake: 1, template: 'balanced', carCount: 2 }],
    }),
  );
  world.step(0.02);
  assert.equal(showing(world).S1, 'Stop', 'the block it stands in is occupied');

  world.trains[0]!.place(1600);
  world.step(0.02);
  assert.equal(showing(world).S1, 'Clear To Stop', 'that block is clear now');
  assert.equal(showing(world).S2, 'Stop', 'and the one it moved into is not');
});

test('a permissive signal shows Stop and Proceed where an absolute shows Stop', () => {
  const build = (permissive: boolean) =>
    new World(
      line({
        signals: [{ id: 'S1', track: 'main', at: 400, permissive }],
        trains: [{ id: 'T', track: 'main', position: 900, brake: 1, template: 'balanced', carCount: 2 }],
      }),
    );
  const absolute = build(false);
  absolute.step(0.02);
  assert.equal(absolute.signals[0]!.aspect.name, 'Stop');

  const permissive = build(true);
  permissive.step(0.02);
  assert.equal(permissive.signals[0]!.aspect.name, 'Stop and Proceed');
  assert.equal(permissive.signals[0]!.aspect.passing, 'restricted');
});

test('a pinned aspect is left alone', () => {
  const world = new World(
    line({
      signals: [{ id: 'S1', track: 'main', at: 400, aspect: 'Restricting' }],
      trains: [{ id: 'T', track: 'main', position: 900, brake: 1, template: 'balanced', carCount: 2 }],
    }),
  );
  world.step(0.02);
  assert.equal(world.signals[0]!.aspect.name, 'Restricting', 'occupancy does not override it');
});

test('a signal governs movements coming toward it and no others', () => {
  const world = new World(
    line({
      signals: [
        { id: 'facing-up', track: 'main', at: 1200, facing: 'up' },
        { id: 'facing-down', track: 'main', at: 1400, facing: 'down' },
      ],
      trains: [{ id: 'T', track: 'main', position: 400, brake: 1, template: 'balanced', carCount: 2 }],
    }),
  );
  world.step(0.02);
  const sighting = world.signalAhead(world.trains[0]!);
  assert.ok(sighting);
  assert.equal(sighting!.signal.id, 'facing-up', 'the one facing the other way is its back');
  assert.ok(Math.abs(sighting!.distance - 800) < 40, `distance was ${sighting!.distance.toFixed(0)} m`);
});

test('a wreck holds the block just as a train does', () => {
  const world = new World(
    line({
      signals: [{ id: 'S1', track: 'main', at: 400 }],
      trains: [{ id: 'T', track: 'main', position: 900, speed: 34, template: 'balanced', carCount: 4 }],
    }),
  );
  const train = world.trains[0]!;
  throwCar(train, train.cars[0]!, train.route!.at(train.cars[0]!.s), 1, 0.5, world.physics.derailment);
  for (let t = 0; t < 30; t += 0.02) world.step(0.02);

  assert.ok(train.derailedCount > 0);
  assert.equal(world.signals[0]!.aspect.name, 'Stop', 'equipment on the ground has not vacated the block');
});

test('flags stand where they are put and are found by a movement', () => {
  const world = new World(
    line({
      flags: [
        { id: 'red-41', track: 'main', at: 1400, colours: ['red'], rule: '41', displayedBy: 'foreman' },
        { id: 'adv-42', track: 'main', at: 1000, colours: ['yellow', 'red'], rule: '42' },
        { id: 'yellow-43', track: 'main', at: 800, colours: ['yellow'], rule: '43' },
        { id: 'blue-26', track: 'main', at: 2000, colours: ['blue'], rule: '26', placement: 'on-equipment' },
      ],
      trains: [{ id: 'T', track: 'main', position: 400, brake: 1, template: 'balanced', carCount: 2 }],
    }),
  );
  const ahead = world.flagsAhead(world.trains[0]!);
  assert.deepEqual(ahead.map((f) => f.flag.id), ['yellow-43', 'adv-42', 'red-41', 'blue-26']);

  const advance = world.flags.find((f) => f.id === 'adv-42')!;
  assert.deepEqual(advance.colours, ['yellow', 'red'], 'one staff, two colours, top first');
  // Rule 41 protection goes between the rails; that is the default for a red.
  assert.equal(world.flags.find((f) => f.id === 'red-41')!.placement, 'between-rails');
  assert.equal(world.flags.find((f) => f.id === 'yellow-43')!.placement, 'beside');
});

test('signals and flags survive a round trip through JSON', () => {
  const spec = line({
    signals: [{ id: 'S1', track: 'main', at: 400, mast: 'dwarf', plates: ['R'], permissive: true }],
    flags: [{ id: 'F1', track: 'main', at: 900, colours: ['yellow', 'red'], rule: '42' }],
  });
  const world = new World(spec);
  const again = new World(JSON.parse(JSON.stringify(world.toJSON())) as SceneSpec);
  assert.equal(again.signals.length, 1);
  assert.equal(again.signals[0]!.mast, 'dwarf');
  assert.equal(again.signals[0]!.permissive, true);
  assert.deepEqual(again.flags[0]!.colours, ['yellow', 'red']);
});

test("nothing enforces a signal — that is the rules layer's job", () => {
  const world = new World(
    line({
      signals: [{ id: 'S1', track: 'main', at: 600 }],
      trains: [
        { id: 'T', track: 'main', position: 200, throttle: 1, template: 'balanced', carCount: 3 },
        { id: 'X', track: 'main', position: 1400, brake: 1, template: 'balanced', carCount: 2 },
      ],
    }),
  );
  world.step(0.02);
  assert.equal(world.signals[0]!.aspect.name, 'Stop');
  const before = world.trains[0]!.headPosition;
  for (let t = 0; t < 20; t += 0.02) world.step(0.02);
  assert.ok(world.trains[0]!.headPosition > before + 20, 'the movement ran straight past it');
});


// ─────────────────────────────────── controlled signals, and what the engineer did

/** A main track with a siding, so a controlled signal has a route to line over. */
const junction = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  terrain: { cols: 180, rows: 30, cellSize: 12, baseElevation: 3 },
  nodes: [{ id: 'sw', kind: 'switch', position: 'normal', operation: 'power' }],
  tracks: [
    { id: 'main-w', points: [[2, 15], [50, 15], [96, 15]], to: { node: 'sw', port: 'trunk' }, spacing: 3 },
    { id: 'main-e', points: [[96, 15], [130, 15], [178, 15]], from: { node: 'sw', port: 'normal' }, spacing: 3 },
    {
      id: 'siding',
      points: [[96, 15], [102, 14.4], [110, 13.4], [140, 13.4], [178, 13.4]],
      from: { node: 'sw', port: 'reverse' },
      spacing: 3,
    },
  ],
  signals: [
    { id: 'A2', track: 'main-w', at: 300, control: 'automatic', permissive: true },
    { id: 'A4', track: 'main-w', at: 700, control: 'automatic', permissive: true },
    { id: 'C6', track: 'main-w', at: 1050, control: 'controlled', divergingClass: 'medium' },
  ],
  trains: [{ id: 'T', track: 'main-w', position: 120, throttle: 0.5, template: 'balanced', carCount: 4 }],
  ...over,
});

test('a controlled signal shows Stop until somebody clears it', () => {
  const world = new World(junction());
  world.step(0.02);
  assert.equal(showing(world).C6, 'Stop', 'clear track, and still red');
  assert.deepEqual(
    [showing(world).A4, showing(world).A2],
    ['Clear To Stop', 'Advance Clear To Stop'],
    'and the automatics behind it step back from it',
  );

  assert.equal(world.clearSignal('C6'), true);
  world.step(0.02);
  assert.equal(showing(world).C6, 'Clear');
});

test('an automatic signal has nobody to clear it', () => {
  const world = new World(junction());
  assert.equal(world.clearSignal('A2'), false, 'that is the whole distinction');
});

test('a controlled signal lined over the turnout shows a turnout aspect', () => {
  const world = new World(junction());
  world.clearSignal('C6');
  world.throwSwitch('sw', 'reverse');
  world.step(0.02);

  assert.equal(showing(world).C6, 'Medium To Clear');
  // And the approach falls out of the grammar rather than being written down.
  assert.equal(showing(world).A4, 'Clear To Medium');
  assert.equal(showing(world).A2, 'Advance Clear To Medium');
});

test('the diverging class picks which family of turnout aspect is shown', () => {
  for (const [cls, expected] of [
    ['medium', 'Medium To Clear'],
    ['diverging', 'Diverging To Clear'],
    ['slow', 'Slow To Clear'],
    ['limited', 'Limited To Clear'],
  ] as const) {
    const world = new World(
      junction({
        signals: [{ id: 'C6', track: 'main-w', at: 1050, control: 'controlled', divergingClass: cls }],
      }),
    );
    world.clearSignal('C6');
    world.throwSwitch('sw', 'reverse');
    world.step(0.02);
    assert.equal(world.signals[0]!.aspect.name, expected, `${cls} should show ${expected}`);
  }
});

test('a reversed switch somewhere else does not divert a signal', () => {
  // The switch is lined for the siding, but this signal faces away from it.
  const world = new World(
    junction({
      signals: [{ id: 'CX', track: 'main-e', at: 300, facing: 'down', control: 'controlled' }],
    }),
  );
  world.clearSignal('CX');
  world.throwSwitch('sw', 'reverse');
  world.step(0.02);
  assert.equal(world.signals[0]!.divergingRoute, false);
  assert.equal(world.signals[0]!.aspect.name, 'Clear');
});

test('passing a signal is recorded with the aspect the movement was given', () => {
  const world = new World(junction());
  const seen: { id: string; given: string; atPassing: string; fault: boolean }[] = [];
  for (let t = 0; t < 80; t += 0.02) {
    world.step(0.02);
    for (const p of world.signalsPassed) {
      seen.push({
        id: p.signal.id,
        given: p.aspect.name,
        atPassing: p.displayedAtPassing.name,
        fault: p.passedAtStop,
      });
    }
  }

  assert.deepEqual(seen.map((s) => s.id), ['A2', 'A4', 'C6']);
  // A signal knocks down as the movement takes its block. What counts is the
  // aspect it was showing on approach, not the red it drops to underneath you.
  assert.equal(seen[0]!.given, 'Advance Clear To Stop');
  assert.equal(seen[0]!.atPassing, 'Stop and Proceed');
  assert.equal(seen[0]!.fault, false, 'obeying an advance aspect is not a fault');

  const atStop = seen.find((s) => s.id === 'C6')!;
  assert.equal(atStop.given, 'Stop');
  assert.equal(atStop.fault, true, 'and running the red is');
});

test('a movement that stops short of the red is not recorded as passing it', () => {
  const world = new World(junction({
    trains: [{ id: 'T', track: 'main-w', position: 900, brake: 1, template: 'balanced', carCount: 3 }],
  }));
  let passings = 0;
  for (let t = 0; t < 40; t += 0.02) {
    world.step(0.02);
    passings += world.signalsPassed.length;
  }
  assert.equal(passings, 0);
});

test('the signal ahead reports what it permits and what to be ready for', () => {
  const world = new World(junction());
  world.clearSignal('C6');
  world.throwSwitch('sw', 'reverse');
  world.step(0.02);

  const sighting = world.signalAhead(world.trains[0]!, 5000)!;
  assert.equal(sighting.signal.id, 'A2');
  assert.equal(sighting.signal.aspect.name, 'Advance Clear To Medium');
  assert.equal(sighting.signal.aspect.passing, 'normal', 'nothing required here');
  assert.equal(sighting.signal.aspect.next, 'medium');
  assert.equal(sighting.signal.aspect.advance, true, 'and it applies two signals on');
});
