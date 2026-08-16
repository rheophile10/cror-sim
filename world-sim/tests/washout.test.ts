import assert from 'node:assert/strict';
import { test } from 'node:test';
import { World, type SceneSpec } from '../src/world.ts';

/**
 * Ten kilometres of line running down into a broad basin and out again.
 *
 * The basin has to be *gentle* — a hollow the rail cannot descend into at its
 * ruling grade is one the rail simply bridges over, and the profile stays flat.
 * Forty-five metres over four kilometres is 0.9%, which the track will follow.
 */
const coast = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  name: 'washout',
  terrain: {
    cols: 400,
    rows: 40,
    cellSize: 25,
    baseElevation: 70,
    features: [{ x: 200, y: 20, radius: 160, height: -48, profile: 'smooth' }],
  },
  tracks: [{ id: 'main', points: [[3, 20], [200, 20], [397, 20]], spacing: 10, maxGrade: 1.2 }],
  ...over,
});

test('with no sea level nothing is washed out', () => {
  const w = new World(coast());
  assert.equal(w.seaLevel, null);
  assert.equal(w.trackWashedOut, false);
  assert.deepEqual(w.washouts, []);
});

test('raising the sea takes the low stretches, and lowering it gives them back', () => {
  const w = new World(coast());
  assert.equal(w.trackWashedOut, false);

  w.seaLevel = 5;
  assert.equal(w.trackWashedOut, false, 'still well below the formation');

  w.seaLevel = 35;
  assert.equal(w.trackWashedOut, true);
  assert.ok(w.washouts.length >= 1, 'at least one stretch is out');
  const total = w.washouts.reduce((m, x) => m + (x.to - x.from), 0);
  assert.ok(total > 100, `only ${total.toFixed(0)} m washed out`);
  assert.ok(w.washouts.every((x) => x.depth > 0));

  w.seaLevel = null;
  assert.equal(w.trackWashedOut, false, 'the sea went away and so did the washouts');
});

test('the higher the water the more of the railway is gone', () => {
  const w = new World(coast());
  const at = (level: number) => {
    w.seaLevel = level;
    return w.washouts.reduce((m, x) => m + (x.to - x.from), 0);
  };
  const low = at(30);
  const high = at(55);
  assert.ok(low > 0, 'the bottom of the basin goes first');
  assert.ok(high > low * 1.5, `${high.toFixed(0)} m at 55 vs ${low.toFixed(0)} m at 30`);
});

test('a bridge is not a washout — the structure is there to avoid an embankment', () => {
  const bare = new World(coast());
  bare.seaLevel = 35;
  const spanned = new World(
    coast({ bridges: [{ id: 'br', track: 'main', from: 4600, to: 5400 }] }),
  );
  spanned.seaLevel = 35;
  const inSpan = (w: World) => w.washouts.some((x) => x.from < 5400 && x.to > 4600);
  assert.equal(inSpan(bare), true, 'without a bridge that dip goes under');
  assert.equal(inSpan(spanned), false, 'with one it does not count as washed out');
});

test('a movement that runs into a washout goes into the water', () => {
  const w = new World(
    coast({
      trains: [{ id: 'T', track: 'main', position: 500, template: 'balanced', carCount: 5, throttle: 0.7 }],
    }),
  );
  w.seaLevel = 35;
  assert.equal(w.trackWashedOut, true);
  const train = w.trains[0]!;
  for (let t = 0; t < 300 && !train.derailed; t += 0.05) w.step(0.05);
  assert.equal(train.derailed, true, 'it should have found the hole');
  assert.match(train.derailmentReason, /washout/);
  assert.ok(w.events.all().some((e) => e.kind === 'washout' && e.detail?.struck === true));
});

test('a washout is announced when it appears and when it goes', () => {
  const w = new World(coast());
  w.seaLevel = 40;
  const made = w.events.all().filter((e) => e.kind === 'washout');
  assert.ok(made.length >= 1);
  assert.ok(Number(made[0]!.detail?.metres) > 0, 'and says how much railway is out');
  w.seaLevel = 0;
  assert.ok(w.events.all().some((e) => e.kind === 'washout-cleared'));
});

test('the sea level survives a round trip through the scene JSON', () => {
  const w = new World(coast({ seaLevel: 32 }));
  assert.equal(w.seaLevel, 32);
  const again = new World(w.toJSON());
  assert.equal(again.seaLevel, 32);
  assert.equal(again.trackWashedOut, w.trackWashedOut);
});
