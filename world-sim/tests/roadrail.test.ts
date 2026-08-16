import assert from 'node:assert/strict';
import { test } from 'node:test';
import { task } from '../src/person.ts';
import { World, type SceneSpec } from '../src/world.ts';

/**
 * A straight line with a road across it, and traffic on the road.
 *
 * The crossing is **passive** on purpose. These are the cases where the
 * protection is not what keeps the two apart — no lights, nothing to tell the
 * traffic anything — because that is where a truck used to drive through a
 * train.
 */
const scene = (over: Partial<SceneSpec> = {}): SceneSpec => ({
  name: 'road and rail',
  terrain: { cols: 200, rows: 40, cellSize: 14, baseElevation: 4 },
  embodied: true,
  tracks: [{ id: 'main', points: [[3, 20], [100, 20], [197, 20]], spacing: 5 }],
  // Track 'main' starts at cell x=3, so world x = 42 + at; 1200 m along is cell
  // x = 88.71.
  scenery: [
    { kind: 'road', id: 'hwy', points: [[88.71, 0], [88.71, 40]], width: 8 },
    { kind: 'vehicle', road: 'hwy', along: 40, speed: 14, type: 'truck' },
  ],
  crossings: [
    { id: 'x1', label: 'Mill Road', track: 'main', at: 1200, road: 'hwy', protection: 'passive' },
  ],
  trains: [
    { id: 'M1', track: 'main', position: 1200, template: 'balanced', carCount: 6, brake: 1 },
  ],
  people: [{ id: 'cond', name: 'Conductor', role: 'conductor', track: 'main', at: 1150, offset: 3 }],
  ...over,
});

function run(world: World, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.05) world.step(0.05);
}

/** How near the vehicle is to the nearest piece of equipment, in plan. */
function gapToEquipment(world: World): number {
  const v = world.scenery.vehicles[0]!;
  let best = Infinity;
  for (const train of world.trains) {
    const route = train.route;
    if (!route) continue;
    for (const car of train.cars) {
      const p = route.at(car.s);
      const h = car.length / 2;
      const ax = p.x - Math.cos(p.heading) * h;
      const ay = p.y - Math.sin(p.heading) * h;
      const bx = p.x + Math.cos(p.heading) * h;
      const by = p.y + Math.sin(p.heading) * h;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((v.x - ax) * dx + (v.y - ay) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      best = Math.min(best, Math.hypot(v.x - (ax + dx * t), v.y - (ay + dy * t)));
    }
  }
  return best;
}

test('a train standing across a passive crossing is not something you drive through', () => {
  const world = new World(scene());
  const truck = world.scenery.vehicles[0]!;

  // The protection here tells the road nothing — there is none. What stops the
  // truck is the train itself being in the way.
  run(world, 90);
  assert.ok(Math.abs(truck.speed) < 0.5, `still doing ${truck.speed.toFixed(1)} m/s`);
  assert.equal(truck.wrecked, false, 'it stopped rather than hit anything');
  const gap = gapToEquipment(world);
  assert.ok(gap > 3 && gap < 30, `stopped ${gap.toFixed(1)} m from the equipment`);

  // And it stays stopped for as long as the train is there.
  const waited = truck.along;
  run(world, 40);
  assert.ok(Math.abs(truck.along - waited) < 1, 'it holds');
});

test('the road runs again once the equipment is out of the way', () => {
  const world = new World(scene());
  const truck = world.scenery.vehicles[0]!;
  run(world, 90);
  const waited = truck.along;

  const train = world.trains[0]!;
  train.place(train.cars[0]!.s + 900);
  run(world, 40);
  assert.ok(truck.along > waited + 20, 'traffic moved off again');
  assert.equal(truck.blockedAhead, null);
});

test('a vehicle caught on the crossing is destroyed, and it is reported', () => {
  // Nothing protecting it and a movement bearing down: the vehicle loses.
  const world = new World(
    scene({
      trains: [
        { id: 'M1', track: 'main', position: 900, template: 'balanced', carCount: 6, throttle: 1 },
      ],
      scenery: [
        { kind: 'road', id: 'hwy', points: [[88.71, 0], [88.71, 40]], width: 8 },
        // Stalled on the rails: cruise zero, so it is not going anywhere.
        { kind: 'vehicle', road: 'hwy', along: 280, speed: 0, type: 'car' },
      ],
    }),
  );
  const car = world.scenery.vehicles[0]!;
  // Put it exactly on the crossing and leave it there.
  car.along = world.crossings[0]!.roadAt;
  car.cruise = 0;
  world.step(0.05);
  assert.ok(gapToEquipment(world) > 5, 'it starts clear of the movement');

  for (let t = 0; t < 300 && !car.wrecked; t += 0.05) world.step(0.05);
  assert.equal(car.wrecked, true, 'the train ran over it');

  const struck = world.events.recent.filter((e) => e.kind === 'vehicle-wrecked');
  assert.equal(struck.length, 1);
  assert.equal(struck[0]!.detail?.by, 'M1');
  assert.ok(Number(struck[0]!.detail?.closing) > 1.6, 'and how hard it was hit is recorded');

  // The train does not care, which is the honest outcome: a car under a train is
  // a delay and a report, not a derailment.
  assert.ok(world.trains[0]!.cars.every((c) => !c.derailed));
});

test('traffic stops for somebody flagging, and runs over somebody who is not', () => {
  const held = new World(
    scene({
      // No train anywhere near: the only thing stopping the road is the person.
      trains: [
        { id: 'M1', track: 'main', position: 200, template: 'balanced', carCount: 4, brake: 1 },
      ],
      people: [
        { id: 'cond', name: 'Conductor', role: 'conductor', track: 'main', at: 1200, offset: 0 },
      ],
    }),
  );
  const crossing = held.crossings[0]!;
  held.assign('cond', task('protect-crossing', { target: crossing.id }));
  run(held, 60);
  assert.equal(crossing.flaggedBy, 'cond', 'he is out there flagging');
  const truck = held.scenery.vehicles[0]!;
  assert.ok(Math.abs(truck.speed) < 0.5, 'and the traffic stopped for him');
  assert.equal(held.person('cond')!.injury, 'none');

  // The same person in the same place, not flagging: the road does not know he
  // is there, and neither does the driver.
  const runover = new World(
    scene({
      trains: [
        { id: 'M1', track: 'main', position: 200, template: 'balanced', carCount: 4, brake: 1 },
      ],
      people: [
        { id: 'cond', name: 'Conductor', role: 'conductor', track: 'main', at: 1200, offset: 0 },
      ],
    }),
  );
  run(runover, 120);
  assert.ok(!runover.crossings[0]!.flaggedBy, 'nobody is flagging it');
  // `road`, not `struck`: run down by a vehicle is a different thing from being
  // run over by equipment, and the model keeps them apart.
  assert.equal(runover.person('cond')!.injury, 'road', 'he was run down on the crossing');
});
