import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onBridge } from '../src/bridge.ts';
import { World, type SceneSpec } from '../src/world.ts';

/** A line across a deep, narrow valley. Without a bridge it fills it in. */
const valley = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  name: 'valley',
  terrain: {
    cols: 120,
    rows: 40,
    cellSize: 12,
    baseElevation: 40,
    // A round basin, wider than any span declared over it — so a bent out in the
    // middle really is out over a hole, and the test is not measuring a bridge
    // buried in a hillside.
    features: [{ x: 60, y: 20, radius: 12, height: -38, profile: 'smooth' }],
  },
  tracks: [{ id: 'main', points: [[3, 20], [60, 20], [117, 20]], spacing: 5, maxGrade: 0.5 }],
  ...over,
});

/** Ground level at the middle of the gorge, where the track crosses it. */
function gorgeFloor(world: World): number {
  const pt = world.tracks[0]!.at(world.tracks[0]!.length / 2);
  return world.terrain.heightAt(pt.x, pt.y);
}

test('without a bridge, the earthworks simply fill the valley in', () => {
  const world = new World(valley());
  const pt = world.tracks[0]!.at(world.tracks[0]!.length / 2);
  // The formation has been brought up to just under the railhead.
  assert.ok(pt.z - gorgeFloor(world) < 2, 'the ground is right under the rail');
});

test('a declared span is left alone, and the rail crosses in mid-air', () => {
  const mid = 684;
  const world = new World(
    valley({ bridges: [{ id: 'br', label: 'Gorge', track: 'main', from: mid - 70, to: mid + 70 }] }),
  );
  const track = world.tracks[0]!;
  const pt = track.at(track.length / 2);
  const drop = pt.z - gorgeFloor(world);
  assert.ok(drop > 15, `the valley was filled anyway: only ${drop.toFixed(1)} m under the rail`);

  const bridge = world.bridges[0]!;
  assert.ok(bridge.maxHeight > 15, `bridge is only ${bridge.maxHeight.toFixed(1)} m high`);
  assert.ok(bridge.bents.length > 20, `${bridge.bents.length} bents for a 140 m trestle`);
  assert.ok(bridge.deck.length > 2);
  for (const bent of bridge.bents) {
    assert.ok(Number.isFinite(bent.x) && Number.isFinite(bent.y));
  }
  // The end bents sit at the abutments, where the formation has been brought up
  // to the rail and there is nothing to stand on — that is what an abutment is.
  // Everything between them is out over the gap.
  const inner = bridge.bents.slice(2, -2);
  assert.ok(
    inner.every((b) => b.deck - b.ground > 1),
    'a bent out over the gap stands on the ground and holds up the deck',
  );
});

test('the embankment runs out to nothing at the abutment rather than ending in a wall', () => {
  const mid = 684;
  const world = new World(
    valley({ bridges: [{ id: 'br', track: 'main', from: mid - 70, to: mid + 70 }] }),
  );
  const track = world.tracks[0]!;
  // Walk out from the abutment and check the ground rises to meet the rail
  // smoothly instead of jumping.
  const gaps: number[] = [];
  for (let s = mid - 110; s <= mid - 60; s += 5) {
    const pt = track.at(s);
    gaps.push(pt.z - world.terrain.heightAt(pt.x, pt.y));
  }
  for (let i = 1; i < gaps.length; i++) {
    assert.ok(
      Math.abs(gaps[i]! - gaps[i - 1]!) < 6,
      `a ${Math.abs(gaps[i]! - gaps[i - 1]!).toFixed(1)} m step in the formation at the abutment`,
    );
  }
});

test('a girder span stands on its abutments and nothing between', () => {
  const mid = 684;
  const world = new World(
    valley({
      bridges: [{ id: 'br', track: 'main', from: mid - 40, to: mid + 40, kind: 'deck-girder' }],
    }),
  );
  assert.equal(world.bridges[0]!.bents.length, 2);
});

test('a movement knows when it is out over one', () => {
  const mid = 684;
  const world = new World(
    valley({ bridges: [{ id: 'br', track: 'main', from: mid - 70, to: mid + 70 }] }),
  );
  assert.equal(onBridge(world.bridges, 'main', mid)?.id, 'br');
  assert.equal(onBridge(world.bridges, 'main', mid - 300), null);
  assert.equal(onBridge(world.bridges, 'other', mid), null);
});

test('a train runs over a bridge without noticing it, which is the point', () => {
  const mid = 684;
  const world = new World(
    valley({
      bridges: [{ id: 'br', track: 'main', from: mid - 70, to: mid + 70 }],
      trains: [{ id: 'T', track: 'main', position: 300, template: 'balanced', carCount: 6, throttle: 1 }],
    }),
  );
  const train = world.trains[0]!;
  for (let t = 0; t < 240; t += 0.05) world.step(0.05);
  assert.equal(train.derailed, false, train.derailmentReason);
  assert.ok(train.route!.locate(train.cars[0]!.s).at > mid + 100, 'it got across');
});

test('bridges survive a round trip through the scene JSON', () => {
  const world = new World(
    valley({ bridges: [{ id: 'br', label: 'Gorge', track: 'main', from: 614, to: 754, kind: 'trestle' }] }),
  );
  const again = new World(world.toJSON());
  assert.equal(again.bridges.length, 1);
  assert.equal(again.bridges[0]!.label, 'Gorge');
  // And the ground is still open under it, which is the part that would break
  // if the spans were read after the earthworks rather than before.
  assert.ok(again.bridges[0]!.maxHeight > 15);
});

test('a river is a level sheet, and its banks are where the ground meets it', () => {
  const world = new World(
    valley({
      // With a span over it, so the basin is still a basin — without the bridge
      // the earthworks fill it to the rail and there is nowhere for water to be.
      bridges: [{ id: 'br', track: 'main', from: 614, to: 754 }],
      scenery: [
        // Down the middle of the basin, where the floor is well below 12 m, and
        // out to the rim, where it is not.
        { kind: 'river', id: 'r', points: [[60, 14], [60, 20], [60, 26]], width: 200, level: 12 },
      ],
    }),
  );
  const river = world.scenery.rivers[0]!;
  assert.equal(river.level, 12);
  assert.equal(river.left.length, 3);

  const spread = (i: number) =>
    Math.hypot(river.left[i]!.x - river.right[i]!.x, river.left[i]!.y - river.right[i]!.y);
  // It is wide in the middle of the basin and narrow at the ends, because the
  // ground decides — a flat sheet 200 m wide would run visibly up the hillside.
  assert.ok(spread(1) > spread(0) + 20, `${spread(1).toFixed(0)} m vs ${spread(0).toFixed(0)} m`);
  assert.ok(spread(1) <= 200.01, 'and never wider than the scene asked for');

  // Every bank that exists is on ground at or below the surface. Where the
  // course leaves the water entirely the banks collapse onto the centre line,
  // and the renderer skips that reach rather than painting water on a hillside.
  for (let i = 0; i < river.left.length; i++) {
    if (spread(i) < 0.5) continue;
    for (const p of [river.left[i]!, river.right[i]!]) {
      assert.ok(
        world.terrain.heightAt(p.x, p.y) <= 12.01,
        `a bank at ${world.terrain.heightAt(p.x, p.y).toFixed(1)} m is above the water`,
      );
    }
  }
  assert.ok(spread(0) < 0.5 && spread(2) < 0.5, 'and the dry ends carry no water at all');
});
