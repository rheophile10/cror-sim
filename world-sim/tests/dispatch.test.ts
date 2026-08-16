import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAutoDriver, DEFAULT_DISPATCH, permittedSpeed } from '../src/dispatch.ts';
import { aspectByName } from '../src/signals.ts';
import { World, type SceneSpec } from '../src/world.ts';

/** Twelve kilometres of single track with a controlled signal at 6 km. */
const line = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  name: 'dispatch',
  terrain: { cols: 700, rows: 30, cellSize: 20, baseElevation: 6 },
  tracks: [{ id: 'main', points: [[3, 15], [350, 15], [697, 15]], spacing: 8, maxGrade: 0.8 }],
  signals: [
    { id: 'sig', label: 'Mile 6', track: 'main', at: 6000, facing: 'up', control: 'controlled' },
  ],
  trains: [
    {
      id: 'A',
      track: 'main',
      position: 600,
      template: 'balanced',
      carCount: 8,
      auto: { drive: true, cruise: 18 },
    },
  ],
  ...over,
});

function run(world: World, seconds: number, dt = 0.05): void {
  for (let t = 0; t < seconds; t += dt) world.step(dt);
}

const mileage = (world: World, id: string): number => {
  const train = world.trains.find((t) => t.id === id)!;
  return train.route!.locate(train.cars[0]!.s).at;
};

// ── What speed is permitted ───────────────────────────────────────────────

test('a Stop is a place to be stopped short of, not a speed', () => {
  const driver = buildAutoDriver({ drive: true, cruise: 20 });
  const sighting = (distance: number) => ({
    signal: { id: 's', label: 'Mile 6', aspect: aspectByName('Stop')! } as never,
    distance,
  });
  const far = permittedSpeed(driver, sighting(3000), 20);
  const near = permittedSpeed(driver, sighting(300), 20);
  const close = permittedSpeed(driver, sighting(40), 20);
  assert.equal(far.target, 20, 'three kilometres off it makes no difference yet');
  assert.ok(near.target < 20 && near.target > 5, `${near.target.toFixed(1)} m/s at 300 m`);
  assert.ok(close.target < 3, `${close.target.toFixed(1)} m/s at 40 m`);
  assert.match(near.reason, /Stop in/);
});

test('a Clear is still only track speed, however fast the movement wants to go', () => {
  // 45 mph is 20.1 m/s, so a driver asking for 25 gets the railway's answer.
  const driver = buildAutoDriver({ drive: true, cruise: 25, trackSpeedMph: 45 });
  const clear = {
    signal: { id: 's', label: 'X', aspect: aspectByName('Clear')! } as never,
    distance: 800,
  };
  assert.ok(Math.abs(permittedSpeed(driver, clear, 20).target - 20.1168) < 0.01);
});

test('an aspect that asks for a speed at the *next* signal bites before this one', () => {
  const driver = buildAutoDriver({ drive: true, cruise: 25, trackSpeedMph: 60 });
  const clearToStop = {
    signal: { id: 's', label: 'X', aspect: aspectByName('Clear To Stop')! } as never,
    distance: 800,
  };
  const clear = {
    signal: { id: 's', label: 'X', aspect: aspectByName('Clear')! } as never,
    distance: 800,
  };
  const running = permittedSpeed(driver, clear, 25).target;
  const reducing = permittedSpeed(driver, clearToStop, 25);
  assert.ok(reducing.target < running, `did not begin reducing: ${reducing.target.toFixed(1)}`);
});

test('a movement told not to obey signals is not slowed by any of them', () => {
  const driver = buildAutoDriver({ drive: true, cruise: 20, obeySignals: false });
  const at = permittedSpeed(
    driver,
    { signal: { id: 's', aspect: aspectByName('Stop')! } as never, distance: 30 },
    20,
  );
  assert.equal(at.target, 20);
  assert.match(at.reason, /not obeying/);
});

// ── Through the world ─────────────────────────────────────────────────────

test('an automatic movement gets itself up to speed and holds it', () => {
  const world = new World(line({ signals: [] }));
  const train = world.trains[0]!;
  run(world, 300);
  assert.ok(Math.abs(train.speed - 18) < 3, `settled at ${train.speed.toFixed(1)} m/s, wanted 18`);
  assert.equal(train.derailed, false);
});

test('it stops short of a signal displaying Stop, and goes when it is cleared', () => {
  const world = new World(line());
  const train = world.trains[0]!;
  run(world, 900);
  const stoppedAt = mileage(world, 'A');
  assert.ok(Math.abs(train.speed) < 0.5, `still moving at ${train.speed.toFixed(2)} m/s`);
  assert.ok(stoppedAt < 6000, `ran past the signal to ${stoppedAt.toFixed(0)} m`);
  assert.ok(stoppedAt > 5400, `stopped ${(6000 - stoppedAt).toFixed(0)} m short — nowhere near it`);

  world.clearSignal('sig', true);
  run(world, 300);
  assert.ok(mileage(world, 'A') > 6100, 'it went when the signal was cleared');
});

test('a movement that does not obey signals runs straight past a Stop', () => {
  const world = new World(
    line({
      trains: [
        {
          id: 'A',
          track: 'main',
          position: 600,
          template: 'balanced',
          carCount: 8,
          auto: { drive: true, cruise: 18, obeySignals: false },
        },
      ],
    }),
  );
  run(world, 900);
  assert.ok(mileage(world, 'A') > 6200, 'it should have gone straight by');
});

test('two movements approach on one track and the signals keep them apart', () => {
  // One signal each way, and neither is cleared. Nobody decides this and no
  // dispatcher is involved: each movement stops at what is in front of it, and
  // the two of them end up a kilometre apart with the block between them empty.
  const world = new World(
    line({
      signals: [
        { id: 'sig', label: 'Mile 6', track: 'main', at: 6000, facing: 'up', control: 'controlled' },
        { id: 'sig-w', label: 'Mile 7', track: 'main', at: 7000, facing: 'down', control: 'controlled' },
      ],
      trains: [
        {
          id: 'A',
          track: 'main',
          position: 600,
          template: 'balanced',
          carCount: 8,
          auto: { drive: true, cruise: 18 },
        },
        {
          id: 'B',
          track: 'main',
          position: 11_500,
          direction: -1,
          template: 'unitGrain',
          carCount: 10,
          auto: { drive: true, cruise: 16 },
        },
      ],
    }),
  );
  run(world, 1500);
  const a = mileage(world, 'A');
  const b = mileage(world, 'B');
  assert.ok(a < 6000, `A ran past its Stop to ${a.toFixed(0)} m`);
  assert.ok(b > 7000, `B ran past its Stop to ${b.toFixed(0)} m`);
  assert.ok(b - a > 900, `they closed to ${(b - a).toFixed(0)} m of each other`);
  assert.equal(world.trains[0]!.derailed, false);
  assert.equal(world.trains[1]!.derailed, false);
  assert.equal(world.collisions.length, 0, 'and nothing hit anything');
});

test('ignore the signal and they collide, which is what the signal is for', () => {
  const world = new World(
    line({
      trains: [
        {
          id: 'A',
          track: 'main',
          position: 600,
          template: 'balanced',
          carCount: 8,
          auto: { drive: true, cruise: 18, obeySignals: false },
        },
        {
          id: 'B',
          track: 'main',
          position: 11_500,
          direction: -1,
          template: 'unitGrain',
          carCount: 10,
          auto: { drive: true, cruise: 16, obeySignals: false },
        },
      ],
    }),
  );
  let hit = false;
  for (let t = 0; t < 1200 && !hit; t += 0.05) {
    world.step(0.05);
    if (world.collisions.length > 0) hit = true;
  }
  assert.ok(hit, 'two movements on one track, neither reading the signal, did not meet');
  const impact = world.collisions[0]!;
  assert.ok(Math.abs(impact.closing) > 5, `closed at only ${impact.closing.toFixed(1)} m/s`);
});

test('an automatic driver survives a round trip through the scene JSON', () => {
  const world = new World(line());
  const again = new World(world.toJSON());
  assert.equal(again.trains[0]!.auto.drive, true);
  assert.equal(again.trains[0]!.auto.cruise, 18);
  assert.equal(again.trains[0]!.auto.obeySignals, true);
});

test('believing you can stop harder than you can is how a signal gets overrun', () => {
  // The default rate is deliberately gentle because a loaded freight is. Tell
  // the driver it can stop at 3 m/s² — which nothing on rails can — and it runs
  // straight past the Stop it was braking for. That is not a bug in the
  // controller; it is the reason the default is what it is.
  const optimistic = new World(line({ dispatch: { brakingRate: 3 } }));
  const honest = new World(line({ dispatch: DEFAULT_DISPATCH }));
  for (const w of [optimistic, honest]) run(w, 900);

  assert.ok(mileage(honest, 'A') < 6000, 'the honest one stopped short of it');
  assert.ok(
    mileage(optimistic, 'A') > mileage(honest, 'A'),
    'the optimistic one ran closer to the signal',
  );
  assert.ok(mileage(optimistic, 'A') > 6000, 'and in fact went straight past it');
});
