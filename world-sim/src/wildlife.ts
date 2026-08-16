/**
 * Animals, and the several ways the country kills people.
 *
 * The railway is not the only hazard on a right of way, and a simulation that
 * models a conductor being run over but not being drowned, run down, mauled or
 * trampled has drawn an arbitrary line. What is here is the rest of it.
 *
 * ── What an animal is ──
 *
 * A position, a heading, a species, and a state. Animals live in **world
 * coordinates**, not track coordinates — unlike people, whose whole design turns
 * on being on a track. A moose does not know where the right of way is, and that
 * is the point of it being on the railway.
 *
 * Behaviour is three rules and no more:
 *
 *   - **Wander.** Pick somewhere within a home range, walk there, pause, repeat.
 *   - **Notice.** A predator that sees a person goes after them; a moose that is
 *     approached too closely charges rather than fleeing, which is what a moose
 *     actually does and is why they kill people.
 *   - **Reach.** Close enough for long enough and the person is dead.
 *
 * Wolves move as a pack: one animal picks the destinations and the rest keep
 * station on it. That is the whole of pack behaviour here, and it is enough —
 * what matters is that they arrive together.
 *
 * ── What kills what ──
 *
 *   train  → animal, person          (already, for people, in `person.ts`)
 *   road   → animal, person; and a moose wrecks the vehicle that hits it
 *   water  → person
 *   wolf, bear → person
 *   moose  → person
 *
 * Animals do not drown: a moose swims better than most boats, and wolves and
 * bears keep out of the water because nothing here makes them go in.
 *
 * ── Determinism ──
 *
 * Every random choice comes from a seeded generator carried on the animal
 * itself, so a scene runs the same way twice. `Math.random` would make the
 * hazards untestable, and a hazard you cannot write a test for is a hazard you
 * do not really have.
 */
import { fell, type Person } from './person.ts';
import type { Scenery } from './scenery.ts';
import type { Terrain } from './terrain.ts';
import type { Train } from './train.ts';
import type { Route } from './route.ts';
import { DEFAULT_DERAILMENT, throwCar } from './derailment.ts';
import type { EventLog } from './events.ts';
import { hornSounding } from './lights.ts';
import { clamp } from './units.ts';

/**
 * `dinosaur` is a joke and is labelled as one.
 *
 * It is here because the author asked for it, and it costs nothing: it is a
 * species row and one extra branch, because the machinery for "something large
 * comes over and kills whoever is standing there" already existed. What it adds
 * that the others do not is that it will also eat *equipment*, which is the
 * only reason `maul` knows about cars at all.
 *
 * Nothing in the rules layer should ever be written against it.
 */
export type Species = 'moose' | 'wolf' | 'bear' | 'dinosaur';

export type AnimalState =
  /** Feeding or standing about. The default, and where they spend most of it. */
  | 'grazing'
  /** Walking to somewhere within the home range. */
  | 'moving'
  /** Going after a person. */
  | 'stalking'
  /** In contact. A second or two from a killing. */
  | 'attacking'
  /** Running from something. */
  | 'fleeing'
  | 'dead';

export interface SpeciesTraits {
  /** Body dimensions, metres: nose to tail, across, and to the shoulder. */
  length: number;
  width: number;
  height: number;
  /** Mass in kilograms, which is what decides whether a car survives it. */
  mass: number;
  /** Walking and running speeds, m/s. */
  pace: number;
  charge: number;
  /** How far off it notices a person. */
  notices: number;
  /**
   * How close a person has to be before it does anything about them.
   *
   * A predator closes from a long way off. A moose does not hunt — it stands
   * there until something gets too near, and then it goes through them.
   */
  provoked: number;
  /** Seconds in contact before the person is dead. */
  killSeconds: number;
  /** How far it will stray from where it was salted, metres. */
  range: number;
  /** Wolves run in packs; the rest do not. */
  packs: boolean;
  color: string;
}

export const SPECIES: Record<Species, SpeciesTraits> = {
  moose: {
    length: 2.9,
    width: 1.2,
    height: 2.1,
    mass: 550,
    pace: 1.3,
    charge: 9,
    notices: 60,
    // A moose is not hunting anybody. It is standing in the willows until you
    // are thirty metres away, and then it is a different animal entirely.
    provoked: 30,
    killSeconds: 1.5,
    range: 320,
    packs: false,
    color: '#4a3a2c',
  },
  wolf: {
    length: 1.6,
    width: 0.55,
    height: 0.85,
    mass: 45,
    pace: 1.9,
    charge: 13,
    notices: 260,
    provoked: 260,
    killSeconds: 3,
    range: 900,
    packs: true,
    color: '#6b6b66',
  },
  bear: {
    length: 2.1,
    width: 0.95,
    height: 1.1,
    mass: 280,
    pace: 1.4,
    charge: 10,
    notices: 130,
    provoked: 130,
    killSeconds: 2.5,
    range: 420,
    packs: false,
    color: '#3d2b1f',
  },
  dinosaur: {
    length: 12,
    width: 2.6,
    height: 5.6,
    // Heavy enough to wreck anything on a road, and it is not on a road.
    mass: 8000,
    pace: 2.2,
    // Faster than a person can run and faster than a train gets away from a
    // stand, which is the entire joke.
    charge: 17,
    notices: 600,
    provoked: 600,
    killSeconds: 2,
    range: 700,
    packs: false,
    color: '#3f5136',
  },
};

export interface AnimalSpec {
  id?: string;
  species: Species;
  /** Where it starts, in cell coordinates. */
  at: [number, number];
  /** Pack it belongs to. Wolves salted together share one. */
  pack?: string;
}

export interface WildlifeSpec {
  seed?: number;
  /** How many of each to scatter. Wolves are counted in packs, not animals. */
  moose?: number;
  wolfPacks?: number;
  /** Animals in a pack. */
  packSize?: number;
  bears?: number;
  /** Keep this far clear of the track when salting, metres. */
  clearance?: number;
  /** Individually placed animals, on top of whatever is scattered. */
  animals?: AnimalSpec[];
}

export interface Animal {
  id: string;
  species: Species;
  traits: SpeciesTraits;
  pack: string | null;
  /** True for the animal the rest of its pack keeps station on. */
  leader: boolean;
  x: number;
  y: number;
  z: number;
  heading: number;
  state: AnimalState;
  /** Where it was salted. It wanders about this and comes back to it. */
  homeX: number;
  homeY: number;
  /** Where it is walking to. */
  goalX: number;
  goalY: number;
  /** Seconds left of whatever it is doing. */
  hold: number;
  /** Person it is going after, and how long it has been in contact. */
  target: string | null;
  /** Car it is going after, for the one species that eats rolling stock. */
  targetCar: string | null;
  contact: number;
  /** How it died, once it has. */
  killedBy: string | null;
  seed: number;
}

export interface WildlifeOptions {
  /** Half-width of the strip a movement sweeps clear of animals, metres. */
  foulingHalfWidth: number;
  /** Mass above which a road vehicle is wrecked rather than the animal shoved. */
  wreckingMass: number;
  /** How near a vehicle has to pass to hit something, metres. */
  vehicleReach: number;
  /** How far a horn clears the right of way, metres. */
  hornCarries: number;
}

export const DEFAULT_WILDLIFE: WildlifeOptions = {
  foulingHalfWidth: 2.6,
  // A moose is half a tonne of animal with its body at windscreen height, which
  // is why hitting one is not like hitting a deer. A bear is heavy too but low.
  wreckingMass: 260,
  vehicleReach: 2.4,
  hornCarries: 500,
};

/** Mulberry32, as everywhere else in this package. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildWildlife(
  spec: WildlifeSpec,
  terrain: Terrain,
  clearOf: (x: number, y: number) => number,
): Animal[] {
  const pick = rng(spec.seed ?? 20_260);
  const out: Animal[] = [];
  const cs = terrain.cellSize;
  const w = terrain.cols * cs;
  const h = terrain.rows * cs;
  const clearance = spec.clearance ?? 45;

  /** Somewhere on the map that is not on the railway. */
  const spot = (): { x: number; y: number } => {
    for (let tries = 0; tries < 40; tries++) {
      const x = pick() * w;
      const y = pick() * h;
      if (clearOf(x, y) >= clearance) return { x, y };
    }
    return { x: pick() * w, y: pick() * h };
  };

  const place = (species: Species, x: number, y: number, pack: string | null, leader: boolean) => {
    const traits = SPECIES[species];
    out.push({
      id: `${species}-${out.length}`,
      species,
      traits,
      pack,
      leader,
      x,
      y,
      z: terrain.heightAt(x, y),
      heading: pick() * Math.PI * 2,
      state: 'grazing',
      homeX: x,
      homeY: y,
      goalX: x,
      goalY: y,
      hold: pick() * 20,
      target: null,
      targetCar: null,
      contact: 0,
      killedBy: null,
      seed: Math.floor(pick() * 2 ** 31),
    });
  };

  for (let i = 0; i < (spec.moose ?? 0); i++) {
    const p = spot();
    place('moose', p.x, p.y, null, false);
  }
  for (let i = 0; i < (spec.bears ?? 0); i++) {
    const p = spot();
    place('bear', p.x, p.y, null, false);
  }
  for (let i = 0; i < (spec.wolfPacks ?? 0); i++) {
    const p = spot();
    const pack = `pack-${i}`;
    const size = spec.packSize ?? 5;
    for (let j = 0; j < size; j++) {
      // Spread about the leader, so a pack arrives as a group rather than a file.
      const a = pick() * Math.PI * 2;
      const r = 6 + pick() * 22;
      place('wolf', p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, pack, j === 0);
    }
  }
  for (const animal of spec.animals ?? []) {
    const traits = SPECIES[animal.species];
    void traits;
    place(animal.species, animal.at[0] * cs, animal.at[1] * cs, animal.pack ?? null, false);
    const last = out[out.length - 1]!;
    if (animal.id) last.id = animal.id;
  }
  return out;
}

/** Everything the wildlife needs to see of the world. */
export interface WildlifeContext {
  terrain: Terrain;
  /** Every animal, so a pack member can find the one it keeps station on. */
  animals: Animal[];
  people: Person[];
  trains: Train[];
  scenery: Scenery;
  events: EventLog;
  time: number;
  /** Whether a point is in water deep enough to drown in. */
  inWater: (x: number, y: number) => boolean;
}

/**
 * Advance the animals, and settle everything the country did to anybody.
 *
 * One pass, in a fixed order: animals move, then what they have reached is
 * resolved, then the machines — trains and road vehicles — take whatever is in
 * front of them, then the water takes whoever walked into it. Order matters
 * only in that a person killed by one thing is not killed again by the next.
 */
export function stepWildlife(
  animals: Animal[],
  ctx: WildlifeContext,
  dt: number,
  opt: WildlifeOptions = DEFAULT_WILDLIFE,
): void {
  const horns = soundingHorns(ctx);
  for (const animal of animals) {
    if (animal.state === 'dead') continue;
    // A horn clears the right of way, which is a large part of why it is sounded
    // at all. Everything with any sense goes the other way; the one species with
    // none of it is unmoved, and that is the joke.
    if (horns.length > 0 && animal.species !== 'dinosaur') scare(animal, horns, opt);
    think(animal, ctx, dt);
    move(animal, ctx, dt);
    maul(animal, ctx, dt);
  }
  struckByTrain(animals, ctx, opt);
  struckOnTheRoad(animals, ctx, opt);
  drowned(ctx);
}

/** Where a horn is sounding right now, and how far it carries. */
function soundingHorns(ctx: WildlifeContext): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const train of ctx.trains) {
    const route = train.route;
    const lead = train.cars.find((c) => !c.derailed);
    if (!route || !lead || !hornSounding(train.lights)) continue;
    const pt = route.at(lead.s);
    out.push({ x: pt.x, y: pt.y });
  }
  return out;
}

/**
 * Put an animal to flight, away from the nearest horn.
 *
 * It runs for its home range rather than in a straight line for ever, so a
 * scared animal ends up somewhere sensible instead of pinned against the edge
 * of the map. It also drops whatever it was going after — which is the useful
 * part: sounding the horn calls a bear off somebody.
 */
function scare(animal: Animal, horns: { x: number; y: number }[], opt: WildlifeOptions): void {
  let nearest = Infinity;
  let from = horns[0]!;
  for (const horn of horns) {
    const d = Math.hypot(horn.x - animal.x, horn.y - animal.y);
    if (d < nearest) {
      nearest = d;
      from = horn;
    }
  }
  if (nearest > opt.hornCarries) return;
  const a = Math.atan2(animal.y - from.y, animal.x - from.x);
  const run = opt.hornCarries * 0.8;
  animal.target = null;
  animal.targetCar = null;
  animal.contact = 0;
  animal.state = 'fleeing';
  animal.goalX = animal.x + Math.cos(a) * run;
  animal.goalY = animal.y + Math.sin(a) * run;
  animal.hold = 12;
}

/** Decide what to do. Called every step; most of the time the answer is nothing. */
function think(animal: Animal, ctx: WildlifeContext, dt: number): void {
  const traits = animal.traits;
  const random = rng(animal.seed + Math.floor(ctx.time * 3));

  // A person close enough to matter. Predators look a long way; a moose only
  // notices what is nearly on top of it, and then it does not run away.
  let nearest: Person | null = null;
  let nearestD = Infinity;
  for (const person of ctx.people) {
    if (person.injury !== 'none' || person.posture !== 'on-ground') continue;
    const d = Math.hypot(person.x - animal.x, person.y - animal.y);
    if (d < nearestD) {
      nearestD = d;
      nearest = person;
    }
  }

  // A fleeing animal is not available for anything else until it has run.
  if (animal.state === 'fleeing') {
    animal.hold -= dt;
    if (animal.hold > 0) return;
    animal.state = 'grazing';
    animal.hold = 10 + random() * 20;
    return;
  }

  if (nearest && nearestD <= traits.provoked) {
    animal.target = nearest.id;
    animal.targetCar = null;
    animal.state = nearestD <= reach(animal) ? 'attacking' : 'stalking';
    animal.goalX = nearest.x;
    animal.goalY = nearest.y;
    return;
  }

  // Nobody on foot. The one species that eats equipment goes for the train
  // instead, which is why anybody who stays aboard is safe for exactly as long
  // as the car they are on lasts.
  if (animal.species === 'dinosaur') {
    const car = nearestCar(animal, ctx, traits.notices);
    if (car) {
      animal.target = null;
      animal.targetCar = car.id;
      animal.goalX = car.x;
      animal.goalY = car.y;
      animal.state = Math.hypot(car.x - animal.x, car.y - animal.y) <= reach(animal)
        ? 'attacking'
        : 'stalking';
      return;
    }
  }

  // Lost them, or nobody about.
  if (animal.target || animal.targetCar) {
    animal.target = null;
    animal.targetCar = null;
    animal.contact = 0;
    animal.state = 'grazing';
    animal.hold = 2 + random() * 6;
  }

  // Pack animals that are not the leader keep station instead of choosing —
  // and take the leader's state, so they walk when it walks and run when it
  // runs. Left grazing they dawdle at a quarter pace and the pack strings out
  // over half a kilometre, which is a queue, not a pack.
  if (animal.pack && !animal.leader) {
    const leader = packLeader(ctx, animal.pack);
    if (leader) animal.state = leader.state === 'dead' ? 'grazing' : leader.state;
    return;
  }

  animal.hold -= dt;
  if (animal.hold > 0) return;
  if (animal.state === 'moving') {
    animal.state = 'grazing';
    animal.hold = 8 + random() * 40;
    return;
  }
  const a = random() * Math.PI * 2;
  const r = random() * traits.range;
  animal.goalX = animal.homeX + Math.cos(a) * r;
  animal.goalY = animal.homeY + Math.sin(a) * r;
  animal.state = 'moving';
  animal.hold = 20 + random() * 90;
}

/** The nearest car still on the rails, and where it is. */
function nearestCar(
  animal: Animal,
  ctx: WildlifeContext,
  within: number,
): { id: string; x: number; y: number; train: Train; car: Train['cars'][number] } | null {
  let best: { id: string; x: number; y: number; train: Train; car: Train['cars'][number] } | null =
    null;
  let bestD = within;
  for (const train of ctx.trains) {
    const route = train.route;
    if (!route) continue;
    for (const car of train.cars) {
      if (car.derailed) continue;
      const pt = route.at(car.s);
      const d = Math.hypot(pt.x - animal.x, pt.y - animal.y);
      if (d >= bestD) continue;
      bestD = d;
      best = { id: car.id, x: pt.x, y: pt.y, train, car };
    }
  }
  return best;
}

/** How close counts as being on top of somebody. */
function reach(animal: Animal): number {
  return animal.traits.length * 0.6 + 1.2;
}

function move(animal: Animal, ctx: WildlifeContext, dt: number): void {
  let gx = animal.goalX;
  let gy = animal.goalY;

  // A pack member's goal is its leader, held at an offset so five wolves are a
  // group rather than a stack.
  if (animal.pack && !animal.leader) {
    const leader = packLeader(ctx, animal.pack);
    if (leader) {
      const spread = 4 + (animal.seed % 9);
      const a = ((animal.seed % 360) * Math.PI) / 180;
      gx = leader.x + Math.cos(a) * spread;
      gy = leader.y + Math.sin(a) * spread;
    }
  }

  const dx = gx - animal.x;
  const dy = gy - animal.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.4) return;

  const speed =
    animal.state === 'stalking' || animal.state === 'attacking' || animal.state === 'fleeing'
      ? animal.traits.charge
      : animal.state === 'moving'
        ? animal.traits.pace
        : animal.traits.pace * 0.25;
  // A follower that has fallen behind closes the gap rather than ambling.
  const catchUp = animal.pack && !animal.leader && d > 25 ? animal.traits.charge * 0.7 : 0;
  const step = Math.min(d, Math.max(speed, catchUp) * dt);
  animal.x += (dx / d) * step;
  animal.y += (dy / d) * step;
  animal.heading = Math.atan2(dy, dx);
  animal.z = ctx.terrain.heightAt(animal.x, animal.y);
}

function packLeader(ctx: WildlifeContext, pack: string): Animal | null {
  return ctx.animals.find((a) => a.pack === pack && a.leader && a.state !== 'dead') ?? null;
}

/** Kill whoever this animal has been standing on top of for long enough. */
function maul(animal: Animal, ctx: WildlifeContext, dt: number): void {
  if (animal.state !== 'attacking') return;

  if (animal.targetCar) {
    const found = nearestCar(animal, ctx, reach(animal) * 1.6);
    if (!found || found.id !== animal.targetCar) {
      animal.contact = 0;
      return;
    }
    animal.contact += dt;
    if (animal.contact < animal.traits.killSeconds) return;
    // Taken off the rails and thrown clear, which is the closest thing this
    // model has to being eaten.
    throwCar(
      found.train,
      found.car,
      found.train.route!.at(found.car.s),
      animal.y > found.y ? -1 : 1,
      1.4,
      DEFAULT_DERAILMENT,
      DEFAULT_DERAILMENT.kick,
      `Car ${found.car.id} was eaten by a ${animal.species} at end of steel.`,
    );
    ctx.events.emit({
      kind: 'animal-struck',
      at: ctx.time,
      subject: animal.id,
      detail: { species: animal.species, how: `ate ${found.car.id}`, speedKmh: 0 },
    });
    animal.contact = 0;
    animal.targetCar = null;
    return;
  }

  if (!animal.target) return;
  const person = ctx.people.find((p) => p.id === animal.target);
  if (!person || person.injury !== 'none') {
    animal.contact = 0;
    return;
  }
  if (Math.hypot(person.x - animal.x, person.y - animal.y) > reach(animal) * 1.4) {
    animal.contact = 0;
    return;
  }

  animal.contact += dt;
  if (animal.contact < animal.traits.killSeconds) return;

  // A moose does not eat anybody. It goes through them and carries on, which is
  // why it is trampling and not mauling — and why the moose is not left standing
  // over the body afterwards.
  const how = animal.species === 'moose' ? 'trampled' : 'mauled';
  fell(person, how);
  ctx.events.emit({
    kind: 'injured',
    at: ctx.time,
    by: person.id,
    subject: animal.id,
    where: person.trackId ? { track: person.trackId, at: person.at } : undefined,
    detail: { how: `${how} by a ${animal.species}`, animal: animal.id },
  });
  animal.contact = 0;
  animal.target = null;
  animal.state = animal.species === 'moose' ? 'fleeing' : 'grazing';
  animal.hold = 20;
}

/** Anything on the rails when a movement comes through. */
function struckByTrain(animals: Animal[], ctx: WildlifeContext, opt: WildlifeOptions): void {
  for (const train of ctx.trains) {
    const route: Route | null = train.route;
    if (!route) continue;
    for (const car of train.cars) {
      if (car.derailed || Math.abs(car.v) < 0.5) continue;
      const pt = route.at(car.s);
      for (const animal of animals) {
        if (animal.state === 'dead') continue;
        const dx = animal.x - pt.x;
        const dy = animal.y - pt.y;
        const along = dx * Math.cos(pt.heading) + dy * Math.sin(pt.heading);
        const across = dx * Math.sin(pt.heading) - dy * Math.cos(pt.heading);
        if (Math.abs(along) > car.length / 2 || Math.abs(across) > opt.foulingHalfWidth) continue;
        kill(animal, ctx, `struck by ${train.id}`, Math.abs(car.v));
      }
    }
  }
}

/**
 * The highway, which kills far more of everything than the railway does.
 *
 * A vehicle takes whatever is in front of it — animal or person. What happens to
 * the *vehicle* depends on what it hit: half a tonne of moose with its body at
 * windscreen height wrecks the car, and a wrecked car stops where it is and
 * becomes part of the scenery, which is exactly what one does.
 */
function struckOnTheRoad(animals: Animal[], ctx: WildlifeContext, opt: WildlifeOptions): void {
  for (const vehicle of ctx.scenery.vehicles) {
    if (vehicle.wrecked || Math.abs(vehicle.speed) < 1.5) continue;
    const half = vehicle.length / 2;
    const hit = (x: number, y: number): boolean => {
      const dx = x - vehicle.x;
      const dy = y - vehicle.y;
      const along = dx * Math.cos(vehicle.heading) + dy * Math.sin(vehicle.heading);
      const across = dx * Math.sin(vehicle.heading) - dy * Math.cos(vehicle.heading);
      return Math.abs(along) <= half && Math.abs(across) <= opt.vehicleReach;
    };

    for (const animal of animals) {
      if (animal.state === 'dead' || !hit(animal.x, animal.y)) continue;
      kill(animal, ctx, 'struck on the road', Math.abs(vehicle.speed));
      if (animal.traits.mass >= opt.wreckingMass) {
        vehicle.wrecked = true;
        vehicle.speed = 0;
        vehicle.cruise = 0;
        ctx.events.emit({
          kind: 'vehicle-wrecked',
          at: ctx.time,
          subject: animal.id,
          detail: { what: animal.species, speedKmh: Math.round(Math.abs(vehicle.speed) * 3.6) },
        });
      }
    }

    for (const person of ctx.people) {
      if (person.injury !== 'none' || person.posture !== 'on-ground') continue;
      if (!hit(person.x, person.y)) continue;
      fell(person, 'road');
      ctx.events.emit({
        kind: 'injured',
        at: ctx.time,
        by: person.id,
        where: person.trackId ? { track: person.trackId, at: person.at } : undefined,
        detail: {
          how: 'run down on a road crossing',
          speedKmh: Math.round(Math.abs(vehicle.speed) * 3.6),
        },
      });
    }
  }
}

/** Anybody standing in the water. */
function drowned(ctx: WildlifeContext): void {
  for (const person of ctx.people) {
    if (person.injury !== 'none' || person.posture !== 'on-ground') continue;
    if (!ctx.inWater(person.x, person.y)) continue;
    fell(person, 'drowned');
    ctx.events.emit({
      kind: 'injured',
      at: ctx.time,
      by: person.id,
      where: person.trackId ? { track: person.trackId, at: person.at } : undefined,
      detail: { how: 'drowned' },
    });
  }
}

function kill(animal: Animal, ctx: WildlifeContext, how: string, speed: number): void {
  animal.state = 'dead';
  animal.killedBy = how;
  animal.target = null;
  ctx.events.emit({
    kind: 'animal-struck',
    at: ctx.time,
    subject: animal.id,
    detail: { species: animal.species, how, speedKmh: Math.round(speed * 3.6) },
  });
}

/** Whether a point is inside any reach of water. Used for drowning. */
export function inWater(scenery: Scenery, x: number, y: number): boolean {
  for (const river of scenery.rivers) {
    for (let i = 0; i < river.left.length - 1; i++) {
      const a = river.left[i]!;
      const b = river.left[i + 1]!;
      const c = river.right[i + 1]!;
      const d = river.right[i]!;
      if (Math.hypot(a.x - d.x, a.y - d.y) < 0.5 && Math.hypot(b.x - c.x, b.y - c.y) < 0.5) continue;
      if (inQuad(x, y, a, b, c, d)) return true;
    }
  }
  return false;
}

function inQuad(
  x: number,
  y: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number },
): boolean {
  return inTriangle(x, y, a, b, c) || inTriangle(x, y, a, c, d);
}

function inTriangle(
  x: number,
  y: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): boolean {
  const s = (b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y);
  const t = (c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y);
  const area = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (Math.abs(area) < 1e-9) return false;
  const u = s / area;
  const v = t / area;
  return u >= 0 && v >= 0 && u + v <= 1;
}

/** Somewhere for a roaming person to go next. Seeded, so a scene repeats. */
export function roamTo(
  person: Person,
  terrain: Terrain,
  time: number,
): { x: number; y: number } {
  const random = rng(hash(person.id) + Math.floor(time));
  const a = random() * Math.PI * 2;
  const r = 40 + random() * 260;
  return {
    x: clamp(person.x + Math.cos(a) * r, 5, terrain.cols * terrain.cellSize - 5),
    y: clamp(person.y + Math.sin(a) * r, 5, terrain.rows * terrain.cellSize - 5),
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
