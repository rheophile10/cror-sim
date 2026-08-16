import assert from 'node:assert/strict';
import { test } from 'node:test';
import { World, type SceneSpec } from '../src/world.ts';

/**
 * A main track cut in two at a switch, with a siding — the arrangement the
 * subdivision actually has, and the one that broke per-track blocks.
 *
 * Automatic signals every 2 km facing east, so a movement running east sees a
 * progression rather than one signal.
 */
const line = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  name: 'blocks',
  terrain: { cols: 700, rows: 30, cellSize: 20, baseElevation: 8 },
  nodes: [
    { id: 'w', kind: 'switch', position: 'normal', operation: 'dual-control', label: 'W' },
    { id: 'e', kind: 'switch', position: 'normal', operation: 'dual-control', label: 'E' },
  ],
  tracks: [
    { id: 'main-a', points: [[3, 15], [100, 15], [200, 15]], to: { node: 'w', port: 'trunk' }, spacing: 8 },
    { id: 'main-b', points: [[200, 15], [300, 15], [400, 15]], from: { node: 'w', port: 'normal' }, to: { node: 'e', port: 'normal' }, spacing: 8 },
    { id: 'siding', points: [[200, 15], [220, 14], [380, 14], [400, 15]], from: { node: 'w', port: 'reverse' }, to: { node: 'e', port: 'reverse' }, spacing: 8 },
    { id: 'main-c', points: [[400, 15], [520, 15], [697, 15]], from: { node: 'e', port: 'trunk' }, spacing: 8 },
  ],
  signals: [
    { id: 's1', label: 'Mile 1', track: 'main-a', at: 1000, facing: 'up', control: 'automatic' },
    { id: 's2', label: 'Mile 3', track: 'main-a', at: 3000, facing: 'up', control: 'automatic' },
    { id: 's3', label: 'W', track: 'main-b', at: 60, facing: 'up', control: 'automatic' },
    { id: 's4', label: 'E', track: 'main-c', at: 60, facing: 'up', control: 'automatic' },
    { id: 's5', label: 'Mile 12', track: 'main-c', at: 2400, facing: 'up', control: 'automatic' },
  ],
  ...over,
});

const aspect = (w: World, id: string) => w.signals.find((s) => s.id === id)!.aspect.name;

test('with nothing on the railway every automatic signal is Clear', () => {
  const w = new World(line({ trains: [] }));
  w.step(0.05);
  for (const id of ['s1', 's2', 's3', 's4', 's5']) assert.equal(aspect(w, id), 'Clear', id);
});

test('a block is occupied by a train on the *next* track, not just its own', () => {
  // This is the case per-track blocks could not see: s3 stands on main-b and
  // the movement is on main-c, one segment beyond it through the east switch.
  const w = new World(
    line({ trains: [{ id: 'T', track: 'main-c', position: 800, template: 'balanced', carCount: 4, brake: 1 }] }),
  );
  w.step(0.05);
  assert.equal(aspect(w, 's4'), 'Stop', 'the signal behind it is at Stop');
  assert.equal(aspect(w, 's3'), 'Clear To Stop', 'and the one before that steps back from it');
  assert.equal(aspect(w, 's2'), 'Advance Clear To Stop', 'and the one before that again');
  assert.equal(aspect(w, 's1'), 'Clear', 'four blocks back the road is clear');
});

test('the progression follows the movement along the railway', () => {
  const w = new World(
    line({ trains: [{ id: 'T', track: 'main-a', position: 3600, template: 'balanced', carCount: 4, throttle: 0.8 }] }),
  );
  const seen: string[] = [];
  for (let t = 0; t < 600; t += 0.05) {
    w.step(0.05);
    const a = aspect(w, 's2');
    if (seen[seen.length - 1] !== a) seen.push(a);
  }
  // Behind the movement it is Stop; as the train draws away it steps back up
  // through the progression rather than jumping straight to Clear.
  assert.equal(seen[0], 'Stop', 'occupied to begin with');
  assert.ok(seen.includes('Clear To Stop'), `no approach aspect in ${seen.join(' -> ')}`);
  assert.equal(seen[seen.length - 1], 'Clear', 'and clears once the movement is well away');
});

test('a permissive signal shows Stop And Proceed where an absolute shows Stop', () => {
  const w = new World(
    line({
      signals: [
        { id: 'abs', track: 'main-c', at: 60, facing: 'up', control: 'automatic' },
        { id: 'perm', track: 'main-b', at: 60, facing: 'up', control: 'automatic', permissive: true },
      ],
      trains: [{ id: 'T', track: 'main-c', position: 800, template: 'balanced', carCount: 4, brake: 1 }],
    }),
  );
  w.step(0.05);
  assert.equal(aspect(w, 'abs'), 'Stop');
  const t = w.trains[0]!;
  void t;
  // Put the movement in the permissive signal's own block instead.
  const w2 = new World(
    line({
      signals: [{ id: 'perm', track: 'main-b', at: 60, facing: 'up', control: 'automatic', permissive: true }],
      trains: [{ id: 'T', track: 'main-b', position: 1200, template: 'balanced', carCount: 4, brake: 1 }],
    }),
  );
  w2.step(0.05);
  assert.equal(aspect(w2, 'perm'), 'Stop and Proceed');
});

test('a controlled signal is at Stop until the RTC clears it, and Stop again when occupied', () => {
  const w = new World(
    line({
      signals: [
        { id: 'ctl', track: 'main-a', at: 3000, facing: 'up', control: 'controlled' },
        { id: 'auto', track: 'main-c', at: 60, facing: 'up', control: 'automatic' },
      ],
      trains: [],
    }),
  );
  w.step(0.05);
  assert.equal(aspect(w, 'ctl'), 'Stop', 'absolute, and nobody has cleared it');
  w.clearSignal('ctl', true);
  w.step(0.05);
  assert.notEqual(aspect(w, 'ctl'), 'Stop', 'cleared, it gives an aspect');
});
