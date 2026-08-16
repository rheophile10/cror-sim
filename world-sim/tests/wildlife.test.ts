import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SPECIES } from '../src/wildlife.ts';
import { World, type SceneSpec } from '../src/world.ts';

/** Open country with one straight track, a river, and a road across it. */
const country = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  name: 'wildlife',
  terrain: {
    cols: 200,
    rows: 60,
    cellSize: 14,
    baseElevation: 30,
    // A trench for the river to sit in, well away from where people stand.
    features: [{ kind: 'ridge', from: [150, 0], to: [150, 60], width: 6, height: -26 }],
  },
  embodied: true,
  tracks: [{ id: 'main', points: [[3, 30], [100, 30], [197, 30]], spacing: 6, maxGrade: 1 }],
  trains: [{ id: 'M1', track: 'main', position: 400, template: 'balanced', carCount: 4, brake: 1 }],
  people: [{ id: 'cond', name: 'Conductor', role: 'conductor', track: 'main', at: 400, offset: 4 }],
  ...over,
});

function run(world: World, seconds: number, dt = 0.05): void {
  for (let t = 0; t < seconds; t += dt) world.step(dt);
}

// ── Salting ───────────────────────────────────────────────────────────────

test('animals are scattered clear of the railway, and the same way every time', () => {
  const spec = country({ wildlife: { seed: 7, moose: 12, bears: 4, wolfPacks: 2, packSize: 5 } });
  const a = new World(spec);
  const b = new World(spec);
  assert.equal(a.animals.length, 12 + 4 + 10);
  assert.deepEqual(
    a.animals.map((x) => [x.species, Math.round(x.x), Math.round(x.y)]),
    b.animals.map((x) => [x.species, Math.round(x.x), Math.round(x.y)]),
    'the same seed must give the same country',
  );
  for (const animal of a.animals) {
    assert.ok(a.distanceToTrack(animal.x, animal.y) >= 40, 'nothing starts fouling the line');
  }
});

test('a pack has one leader and the rest keep station on it', () => {
  const world = new World(country({ wildlife: { seed: 3, wolfPacks: 1, packSize: 6 } }));
  const pack = world.animals.filter((a) => a.species === 'wolf');
  assert.equal(pack.length, 6);
  assert.equal(pack.filter((a) => a.leader).length, 1);
  run(world, 400);
  const alive = pack.filter((a) => a.state !== 'dead');
  const leader = alive.find((a) => a.leader)!;
  for (const wolf of alive) {
    assert.ok(
      Math.hypot(wolf.x - leader.x, wolf.y - leader.y) < 60,
      'a pack that walks apart is not a pack',
    );
  }
});

// ── What kills people ─────────────────────────────────────────────────────

test('a bear put beside somebody kills them', () => {
  const world = new World(
    country({ wildlife: { animals: [{ id: 'bear-x', species: 'bear', at: [30, 30] }] } }),
  );
  const person = world.person('cond')!;
  const bear = world.animals[0]!;
  bear.x = person.x + 30;
  bear.y = person.y;
  bear.homeX = bear.x;
  bear.homeY = bear.y;
  run(world, 60);
  assert.equal(person.injury, 'mauled');
  const hurt = world.events.all().find((e) => e.kind === 'injured');
  assert.match(String(hurt?.detail?.how), /bear/);
  // The body is left where it fell, as every other casualty is.
  assert.ok(world.person('cond')!.restingAt);
});

test('a moose tramples rather than eats, and does not stand over the body', () => {
  const world = new World(
    country({ wildlife: { animals: [{ species: 'moose', at: [30, 30] }] } }),
  );
  const person = world.person('cond')!;
  const moose = world.animals[0]!;
  moose.x = person.x + 12;
  moose.y = person.y;
  moose.homeX = moose.x;
  moose.homeY = moose.y;
  run(world, 60);
  assert.equal(person.injury, 'trampled');
  assert.notEqual(moose.state, 'attacking');
});

test('a moose only goes for somebody who gets close; a wolf comes from a long way off', () => {
  assert.ok(SPECIES.moose.provoked < 60, 'a moose is not hunting anybody');
  assert.ok(SPECIES.wolf.notices > 200, 'a wolf is');
});

test('walking into the water drowns you', () => {
  const world = new World(
    country({
      scenery: [
        { kind: 'river', id: 'r', points: [[150, 20], [150, 30], [150, 40]], width: 70, level: 12 },
      ],
    }),
  );
  const person = world.person('cond')!;
  const river = world.scenery.rivers[0]!;
  const mid = river.left[1]!;
  // Put them in the middle of the channel.
  person.x = (mid.x + river.right[1]!.x) / 2;
  person.y = (mid.y + river.right[1]!.y) / 2;
  run(world, 1);
  assert.equal(person.injury, 'drowned');
  assert.ok(world.events.all().some((e) => String(e.detail?.how) === 'drowned'));
});

test('a road vehicle runs down whoever is standing in front of it', () => {
  const world = new World(
    country({
      scenery: [
        { kind: 'road', id: 'hwy', points: [[60, 10], [60, 50]], width: 8 },
        { kind: 'vehicle', road: 'hwy', along: 100, speed: 16, type: 'car' },
      ],
    }),
  );
  // Standing on the crossing itself. A person's world position is derived from
  // their track coordinates every step, so moving one means moving those.
  const person = world.person('cond')!;
  person.at = 798;
  person.offset = 0;
  run(world, 20);
  assert.equal(person.injury, 'road');
  assert.ok(world.events.all().some((e) => String(e.detail?.how).includes('run down')));
});

// ── What kills animals ────────────────────────────────────────────────────

test('a movement takes whatever is fouling the line', () => {
  const world = new World(
    country({
      wildlife: { animals: [{ id: 'moose-x', species: 'moose', at: [60, 30] }] },
      trains: [{ id: 'M1', track: 'main', position: 200, template: 'balanced', carCount: 4, throttle: 1 }],
      people: [],
    }),
  );
  // Standing on the rail and staying there: `hold` is what stops it choosing
  // somewhere else to be, and a wandering moose would make this a coin toss.
  const moose = world.animals[0]!;
  const pt = world.tracks[0]!.at(600);
  moose.x = pt.x;
  moose.y = pt.y;
  moose.goalX = pt.x;
  moose.goalY = pt.y;
  moose.hold = 1e6;
  run(world, 120);
  assert.equal(moose.state, 'dead');
  assert.match(String(moose.killedBy), /struck by M1/);
  const struck = world.events.all().find((e) => e.kind === 'animal-struck');
  assert.equal(struck?.detail?.species, 'moose');
});

test('a car that hits a moose is written off; one that hits a wolf is not', () => {
  const build = (species: 'moose' | 'wolf') => {
    const world = new World(
      country({
        wildlife: { animals: [{ species, at: [60, 30] }] },
        scenery: [
          { kind: 'road', id: 'hwy', points: [[60, 10], [60, 50]], width: 8 },
          { kind: 'vehicle', road: 'hwy', along: 100, speed: 18, type: 'car' },
        ],
        people: [],
      }),
    );
    const car = world.scenery.vehicles[0]!;
    const animal = world.animals[0]!;
    animal.x = car.x;
    animal.y = car.y + 40;
    animal.homeX = animal.x;
    animal.homeY = animal.y;
    run(world, 12);
    return { world, car, animal };
  };
  const hitMoose = build('moose');
  assert.equal(hitMoose.animal.state, 'dead');
  assert.equal(hitMoose.car.wrecked, true, 'half a tonne at windscreen height');
  assert.equal(hitMoose.car.speed, 0, 'and it stops where it is');
  assert.ok(hitMoose.world.events.all().some((e) => e.kind === 'vehicle-wrecked'));

  const hitWolf = build('wolf');
  assert.equal(hitWolf.animal.state, 'dead');
  assert.equal(hitWolf.car.wrecked, false, 'a wolf does not write off a car');
});

// ── The horn ──────────────────────────────────────────────────────────────

test('the horn clears the right of way, and calls a bear off somebody', () => {
  const world = new World(
    country({
      wildlife: { animals: [{ id: 'bear-x', species: 'bear', at: [30, 30] }] },
      people: [
        { id: 'cond', name: 'Conductor', role: 'conductor', track: 'main', at: 400, offset: 4 },
        { id: 'eng', name: 'Engineer', role: 'locomotive-engineer', inCabOf: 'M1' },
      ],
    }),
  );
  const person = world.person('cond')!;
  const bear = world.animals[0]!;
  bear.x = person.x + 40;
  bear.y = person.y;
  bear.homeX = bear.x;
  bear.homeY = bear.y;
  run(world, 2);
  assert.equal(bear.state, 'stalking', 'it has come for them');

  const before = Math.hypot(bear.x - person.x, bear.y - person.y);
  assert.ok(world.sound(world.trains[0]!, 'alarm'), 'a succession of short sounds');
  run(world, 6);
  assert.equal(bear.target, null, 'it let them go');
  assert.ok(
    Math.hypot(bear.x - person.x, bear.y - person.y) > before,
    'and put distance between them',
  );
  assert.equal(person.injury, 'none');
});
