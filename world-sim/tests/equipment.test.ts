import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAR_TYPES, CATALOGUE, prototypeFor, sectionFor, type BodyShape } from '../src/equipment.ts';
import { Train, type Car, type CarSpec } from '../src/train.ts';
import { kgToTonnes } from '../src/units.ts';

const carOf = (spec: CarSpec): Car => new Train({ cars: [spec] }).cars[0]!;

test('load mixes tare and capacity', () => {
  const proto = CATALOGUE['covered-hopper'];
  const empty = carOf({ type: 'covered-hopper', load: 0 });
  const full = carOf({ type: 'covered-hopper', load: 1 });
  const half = carOf({ type: 'covered-hopper', load: 0.5 });

  assert.equal(kgToTonnes(empty.mass), proto.tare);
  assert.equal(kgToTonnes(full.mass), proto.tare + proto.capacity);
  assert.equal(kgToTonnes(half.mass), proto.tare + proto.capacity / 2);
  // The point of the whole exercise: the same car, four times the weight.
  assert.ok(full.mass / empty.mass > 3.5);
});

test('an explicit mass overrides the catalogue outright', () => {
  const car = carOf({ type: 'tank', mass: 42 });
  assert.equal(kgToTonnes(car.mass), 42);
});

test('an unrecognised type becomes a generic car keeping its name', () => {
  const car = carOf({ type: 'Loaded Ore Hopper', mass: 130 });
  assert.equal(car.type, 'boxcar');
  assert.equal(car.label, 'Loaded Ore Hopper', 'free text from an older scene survives as the label');
  assert.equal(kgToTonnes(car.mass), 130);
});

test('the first car defaults to a locomotive, later cars to freight', () => {
  const train = new Train({ cars: [{}, {}, {}] });
  assert.equal(train.cars[0]!.kind, 'locomotive');
  assert.ok(train.cars[0]!.maxTractiveEffort > 0);
  assert.equal(train.cars[1]!.kind, 'car');
  assert.equal(train.cars[1]!.maxTractiveEffort, 0);
});

test('containers add their own weight and stack two high', () => {
  const bare = carOf({ type: 'well' });
  const one = carOf({ type: 'well', containers: 1 });
  const two = carOf({ type: 'well', containers: 2 });

  assert.equal(bare.containers.length, 0);
  assert.equal(one.containers.length, 1);
  assert.equal(two.containers.length, 2);
  assert.deepEqual(
    two.containers.map((c) => c.tier),
    [0, 1],
    'the first rides in the well, the second on top of it',
  );
  assert.ok(one.mass > bare.mass);
  assert.ok(two.mass > one.mass);
  // A double stack stands well above the car and the camera has to know.
  assert.ok(two.height > bare.height + 5);
});

test('a container spec sets its own size and lading', () => {
  const light = carOf({ type: 'well', containers: [{ length: 20, load: 0 }] });
  const heavy = carOf({ type: 'well', containers: [{ length: 53, load: 1 }] });
  assert.equal(light.containers[0]!.nominal, 20);
  assert.equal(heavy.containers[0]!.nominal, 53);
  assert.ok(heavy.containers[0]!.length > light.containers[0]!.length);
  assert.ok(heavy.mass - light.mass > 25_000, 'a loaded 53 outweighs an empty 20 by tonnes');
});

test('more than two containers is clamped, and cars without wells take none', () => {
  assert.equal(carOf({ type: 'well', containers: 9 }).containers.length, 2);
  assert.equal(carOf({ type: 'boxcar', containers: 2 }).containers.length, 0);
});

test('the catalogue keeps its weights in a believable order', () => {
  const mass = (type: string, load: number) => carOf({ type, load }).mass;
  assert.ok(mass('locomotive', 0) > mass('boxcar', 1));
  assert.ok(mass('covered-hopper', 1) > mass('autorack', 1), 'grain outweighs cars');
  assert.ok(mass('autorack', 1) < mass('tank', 1), 'an autorack is bulky, not heavy');
  assert.ok(mass('flat', 0) < mass('open-hopper', 1));
  for (const type of CAR_TYPES) {
    const proto = prototypeFor(type);
    assert.ok(proto.length > 5 && proto.length < 35, `${type} has an odd length`);
    assert.ok(proto.height > 1 && proto.height < 7, `${type} has an odd height`);
  }
});

/**
 * The extrusion renderer takes the outward normal of a section edge to be
 * (dz, −dy), which is only outward if the section is wound counter-clockwise.
 * Get one shape backwards and that car turns inside out — its near faces get
 * culled and you see through it — so the winding is worth asserting rather than
 * eyeballing.
 */
test('every cross-section is wound counter-clockwise', () => {
  const shapes: BodyShape[] = [
    { kind: 'box', bottom: 1, top: 4 },
    { kind: 'taper', bottom: 1, top: 4, bottomFactor: 0.4 },
    { kind: 'open', bottom: 0.5, top: 2, wall: 0.2 },
    { kind: 'open', bottom: 1, top: 4, bottomFactor: 0.5, wall: 0.3 },
    { kind: 'cylinder', centre: 2.5, radius: 1.5 },
  ];
  for (const shape of shapes) {
    const pts = sectionFor(shape, 3.2);
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      area += a.y * b.z - b.y * a.z;
    }
    assert.ok(area > 0, `${shape.kind} is wound clockwise (signed area ${area / 2})`);
  }

  for (const type of CAR_TYPES) {
    const proto = prototypeFor(type);
    const pts = sectionFor(proto.shape, proto.width);
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      area += a.y * b.z - b.y * a.z;
    }
    assert.ok(area > 0, `${type} is wound clockwise`);
  }
});

test('a consist template of well cars runs mixed loadings', () => {
  const train = new Train({ template: 'intermodal', carCount: 12 });
  const counts = new Set(train.cars.slice(1).map((c) => c.containers.length));
  assert.ok(counts.has(0) && counts.has(1) && counts.has(2), 'empty, single and double stacked');
  const wells = train.cars.filter((c) => c.type === 'well');
  assert.equal(wells.length, 11);
});
