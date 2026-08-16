import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildLights,
  ditchPhase,
  HORN_GAP,
  HORN_LONG,
  HORN_SHORT,
  HORN_SIGNALS,
  hornDuration,
  hornSounding,
  soundHorn,
  stepLights,
} from '../src/lights.ts';
import { World } from '../src/world.ts';

const scene = () => ({
  name: 'lights',
  terrain: { cols: 120, rows: 24, cellSize: 12, baseElevation: 4 },
  tracks: [{ id: 'main', points: [[3, 12], [60, 12], [117, 12]], spacing: 5 } as never],
  embodied: true,
  trains: [{ id: 'M1', track: 'main', position: 400, template: 'balanced' as const, carCount: 4 }],
  people: [
    { id: 'eng', name: 'Engineer', role: 'locomotive-engineer' as const, inCabOf: 'M1' },
    { id: 'cond', name: 'Conductor', role: 'conductor' as const, ridingOn: 'M1' },
  ],
});

test('the crossing signal is two long, a short and a long, and it takes as long as it takes', () => {
  const crossing = HORN_SIGNALS.find((s) => s.id === 'crossing')!;
  assert.deepEqual(crossing.pattern, ['long', 'long', 'short', 'long']);
  // The last long is held until the crossing is occupied, so the sounding runs
  // well past the sum of its nominal elements.
  const nominal = HORN_LONG * 3 + HORN_SHORT + HORN_GAP * 3;
  assert.ok(hornDuration(crossing) > nominal, 'the final long is prolonged');
});

test('a sounding is a pattern over time, not a boolean', () => {
  const lights = buildLights();
  assert.equal(hornSounding(lights), false);
  assert.ok(soundHorn(lights, 'crossing'));

  // Sample the whole sounding and check it is broken by silences — which is the
  // only thing that distinguishes one Rule 14 signal from another.
  const heard: boolean[] = [];
  const total = hornDuration(lights.horn!.signal);
  for (let t = 0; t < total; t += 0.1) {
    heard.push(hornSounding(lights));
    stepLights(lights, 0.1);
  }
  assert.ok(heard.some((h) => h), 'it made a noise');
  assert.ok(heard.some((h) => !h), 'and it stopped between elements');
  assert.equal(lights.horn, null, 'and it finished on its own');
});

test('a sounding cannot be interrupted by another', () => {
  const lights = buildLights();
  assert.ok(soundHorn(lights, 'crossing'));
  assert.equal(soundHorn(lights, 'stop'), null, 'half a signal is a different signal');
  assert.equal(lights.horn!.signal.id, 'crossing');
});

test('ditch lights burn steady, and alternate while the horn is sounding', () => {
  const lights = buildLights();
  assert.equal(ditchPhase(lights, 0).on, true);
  assert.equal(ditchPhase(lights, 0).left, ditchPhase(lights, 5).left, 'steady when quiet');

  soundHorn(lights, 'crossing');
  const sides = new Set<boolean>();
  for (let t = 0; t < 4; t += 0.2) sides.add(ditchPhase(lights, t).left);
  assert.equal(sides.size, 2, 'they alternate while the horn is sounding');

  lights.front = 'off';
  assert.equal(ditchPhase(lights, 0).on, false, 'and go out with the headlight');
});

test('a headlight turned off draws no beam and no lamp', () => {
  const lights = buildLights({ front: 'off' });
  assert.equal(lights.front, 'off');
  assert.equal(lights.rear, 'dim', 'the other end is its own switch');
});

// ── Through the world, where the acts are recorded ─────────────────────────

test('sounding the horn is recorded as an act, with which signal it was', () => {
  const world = new World(scene());
  const train = world.trains[0]!;
  assert.ok(world.sound(train, 'crossing'));
  const event = world.events.about(train.id).find((e) => e.kind === 'horn');
  assert.ok(event, 'the act was recorded');
  assert.equal(event!.by, 'eng');
  assert.equal(event!.detail?.signal, 'crossing');
  assert.equal(event!.detail?.pattern, 'long long short long');
});

test('nobody in the seat, nothing sounds', () => {
  const world = new World(scene());
  const train = world.trains[0]!;
  // The engineer leaves the seat. There is now no hand on the horn valve.
  const eng = world.person('eng')!;
  eng.posture = 'riding';
  eng.atControls = false;
  assert.equal(world.sound(train, 'crossing'), null);
  assert.equal(world.setBell(train, true), false);
  assert.equal(world.setHeadlight(train, 'front', 'off'), false);
});

test('the bell and the headlights are recorded, and only when they change', () => {
  const world = new World(scene());
  const train = world.trains[0]!;
  assert.equal(world.setBell(train, true), true);
  assert.equal(world.setBell(train, true), false, 'setting it where it already is is not an act');
  assert.equal(world.setHeadlight(train, 'rear', 'bright'), true);
  assert.equal(world.setDitchLights(train, false), true);

  const kinds = world.events.about(train.id).map((e) => e.kind);
  assert.ok(kinds.includes('bell-on'));
  assert.ok(kinds.includes('headlight'));
  assert.ok(kinds.includes('ditch-lights'));
  assert.equal(kinds.filter((k) => k === 'bell-on').length, 1);
});

test('a sounding runs itself out as the world steps', () => {
  const world = new World(scene());
  const train = world.trains[0]!;
  world.sound(train, 'proceed');
  assert.ok(train.lights.horn);
  for (let t = 0; t < 12; t += 0.05) world.step(0.05);
  assert.equal(train.lights.horn, null);
});

test('lights survive a round trip through the scene JSON', () => {
  const world = new World(scene());
  const train = world.trains[0]!;
  world.setHeadlight(train, 'front', 'dim');
  world.setBell(train, true);
  world.setDitchLights(train, false);

  const again = new World(world.toJSON());
  assert.equal(again.trains[0]!.lights.front, 'dim');
  assert.equal(again.trains[0]!.lights.bell, true);
  assert.equal(again.trains[0]!.lights.ditch, false);
});
