/**
 * People on the railway.
 *
 * Everything else in this package has a position *along a track* — `Car.s`,
 * signals at a mileage, obstructions at an `at`. A person is the first thing
 * that is legitimately **off** the track: standing beside a switch stand, walking
 * the ballast, crossing between two tracks, in the ditch. So a person's position
 * is `(track, at, offset)` — the track they are working along, how far along it,
 * and how far to one side. World coordinates are derived from that, never stored.
 *
 * That choice is not a compromise, it is the point. `CROR/sim`'s
 * `checks/104-hand-operated-switches.ts` defers 104(j) — where employees may
 * stand relative to a switch stand — with the reason "people are placed on
 * tracks, not offset from them". The offset *is* the feature. Storing a free
 * `(x, y, z)` instead would have made "which track is he working on" a query
 * against the whole network, and every rule that matters asks that question.
 *
 * ── Tasks take time ──
 *
 * A handbrake takes half a minute and walking a hundred-car train takes twenty.
 * If both were one function call the simulation would have thrown away the thing
 * it exists to model: 112 and 115 are about what somebody can get to in time. So
 * a person has a queue of tasks, each with a duration in **simulated seconds**,
 * and `step` advances the one at the front. Nothing happens instantly except
 * being told to do something.
 *
 * Durations are stated where they are set, with where the number came from. They
 * are honest estimates from the work, not measurements, and a scene can override
 * every one of them.
 *
 * ── Being in the wrong place ──
 *
 * A task fails if the person is not near enough to the thing. It fails *loudly*:
 * the task carries the reason and an event is emitted. That is the whole design
 * goal — a control scheme that makes it easy to line a switch correctly is worth
 * less than one that makes it possible to line it wrongly and see what happened.
 */
import type { RetainerPosition } from './airbrake.ts';
import type { EventLog } from './events.ts';
import type { Network } from './network.ts';
import type { Terrain } from './terrain.ts';
import type { TrackPath } from './track.ts';
import type { Car, Train } from './train.ts';
import { clamp } from './units.ts';

/**
 * The roles `CROR/sim`'s `entities/person.ts` names. Carried whole because
 * almost every duty that matters is a duty *between* two roles — 104(d)'s verbal
 * confirmation, 115(a)'s employee observing the route, 26's workmen.
 */
export type PersonRole =
  | 'conductor'
  | 'assistant-conductor'
  | 'locomotive-engineer'
  | 'pilot'
  | 'foreman'
  | 'snow-plow-foreman'
  | 'rtc'
  | 'switchtender'
  | 'signalman'
  | 'employee'
  | 'workman'
  /**
   * Not railway staff at all.
   *
   * Somebody on the right of way who has no business being there. Modelled as a
   * `Person` rather than as scenery on purpose: everything that can happen to a
   * conductor on the ground can happen to them, and the whole reason a
   * trespasser is worth having in a rules simulation is that they are subject to
   * exactly the same physics and none of the same training.
   */
  | 'trespasser';

/** Where a body is, in the sense that matters to the rules. */
export type Posture = 'on-ground' | 'riding' | 'in-cab';

export type Injury = 'none' | 'struck' | 'crushed' | 'road' | 'drowned' | 'mauled' | 'trampled';

/** What a casualty is labelled, in the order the label reads best. */
export const INJURY_LABEL: Record<Injury, string> = {
  none: '',
  struck: 'struck',
  crushed: 'crushed',
  road: 'run down',
  drowned: 'drowned',
  mauled: 'mauled',
  trampled: 'trampled',
};

export interface PersonSpec {
  id?: string;
  name?: string;
  role?: PersonRole;
  /** On the ground: which track they are working along. */
  track?: string;
  /** How far along it, metres. */
  at?: number;
  /** How far to one side of the centre line, metres. Positive is to the right. */
  offset?: number;
  /** Or riding: the movement, and optionally which car and side. */
  ridingOn?: string;
  ridingCar?: string;
  ridingSide?: 'left' | 'right';
  /**
   * Which end of the car. 113(b) is written about which end a person rides, and
   * riding the leading end of the leading car of a shove is a different act from
   * riding anywhere else.
   */
  ridingEnd?: 'leading' | 'trailing';
  /** Or in the cab of a movement, at the controls. */
  inCabOf?: string;
  /** In the cab but not driving. Defaults to driving, which is what scenes meant. */
  atControls?: boolean;
  /**
   * Wander about on their own.
   *
   * What makes a trespasser a trespasser: nobody sends them anywhere and they
   * go where they like, including across the track. `World` picks the
   * destinations; the walking is the same walking everybody else does, so they
   * are run over by exactly the same rule.
   */
  roam?: boolean;
  /** Walking pace on the ballast, m/s. */
  walkSpeed?: number;
  /** How far they can see and be useful, metres. See `canTakeEffectiveActionOn`. */
  reach?: number;
  /** One of the crew the player is working, as opposed to somebody else's. */
  crew?: boolean;
}

export type TaskKind =
  | 'walk'
  | 'line-switch'
  | 'point-and-call'
  | 'set-derail'
  | 'apply-handbrake'
  | 'release-handbrake'
  | 'board'
  | 'dismount'
  | 'ride-cab'
  | 'take-controls'
  | 'leave-controls'
  | 'display-blue-signal'
  | 'remove-blue-signal'
  | 'uncouple'
  | 'couple'
  | 'connect-hose'
  | 'disconnect-hose'
  | 'open-angle-cock'
  | 'close-angle-cock'
  | 'set-retainer'
  | 'bleed'
  | 'protect-crossing'
  | 'release-crossing'
  | 'cut-out-brake'
  | 'cut-in-brake'
  | 'align-drawbars'
  | 'set-and-centre'
  | 'bail-off'
  | 'inspect'
  | 'wait';

export interface Task {
  kind: TaskKind;
  /** Human-readable, for a UI and for the task list. */
  label: string;
  /** Work time once in position, simulated seconds. Walking sets this from distance. */
  duration: number;
  /** How much of it has been done. */
  elapsed: number;
  /** The node, car, train or signal it is done to. */
  target?: string;
  /** For a walk: where to. */
  to?: { track?: string; at: number; offset?: number };
  /** For lining a switch. */
  position?: 'normal' | 'reverse';
  /** For a derail, a blue signal, a cock or a hose: on/open or off/closed. */
  on?: boolean;
  /** Which end of a car a fitting is on. */
  end?: 'ahead' | 'behind';
  /** For the retainer. */
  retainer?: RetainerPosition;
  /** Set when the task could not be done, and why. */
  blocked?: string;
}

/**
 * How near a person must be to work on something, metres.
 *
 * This is "at it", not "touching it", and the difference is measured off the
 * railway rather than guessed: a switch stand sits about 3.4 m from the centre
 * line (`render/network.ts`, `standOffset`) while the node itself is on it, so
 * anything tighter than that reports somebody standing at the stand as being
 * too far from the switch. Five metres covers a stand and its points and a step
 * either way.
 *
 * It is still deliberately small. The entire value of a physical conductor is
 * that being in the wrong place has consequences, and a generous radius quietly
 * gives that back.
 */
/**
 * How close you have to be to work on something, metres.
 *
 * Twelve rather than five. Five is roughly true — you can touch a switch stand
 * from five metres — but it makes an invisible target a few pixels across on a
 * plan of a railway, and walking somebody onto it is fiddly in a way the job is
 * not. Twelve is a zone you can aim at, and the rings drawn round the things
 * you can work make it something you walk *into* rather than something you
 * discover you have missed.
 */
export const WORKING_DISTANCE = 12;

/**
 * Default task durations in simulated seconds.
 *
 * Where these came from: a hand switch is unlock, throw, examine the points,
 * relock — twenty seconds is brisk and honest. The point and call is four
 * deliberate steps. A handbrake is the half-minute the brief names. Boarding is
 * a grab-iron and a step up. None of them are measurements; all of them are
 * overridable per scene, and the ratios between them matter more than the
 * absolute values.
 */
export const TASK_SECONDS: Record<TaskKind, number> = {
  walk: 0,
  'line-switch': 20,
  'point-and-call': 8,
  'set-derail': 15,
  'apply-handbrake': 30,
  'release-handbrake': 20,
  board: 8,
  dismount: 8,
  'ride-cab': 10,
  'take-controls': 10,
  'leave-controls': 6,
  // Reach under the car and hold the release rod until the exhaust stops. Not
  // instant, and on a long cut it is done one car at a time on foot.
  bleed: 14,
  // Walk out into the road, face the traffic and stop it. The time is getting
  // yourself somewhere a driver can see you and be sure they have seen you.
  'protect-crossing': 12,
  'release-crossing': 5,
  'display-blue-signal': 25,
  'remove-blue-signal': 15,
  // Pull the pin and stretch to see it part. In real life this is also the air
  // hoses and the angle cocks, which this package does not model, so the number
  // is for the mechanical half only.
  uncouple: 25,
  couple: 20,
  // Bucking up a pair of hoses is a lift and a twist on the gladhands. The cocks
  // are a quarter turn each. Retainers are a lever, but there is one on every
  // car and that is the whole cost of using them.
  'connect-hose': 12,
  'disconnect-hose': 8,
  'open-angle-cock': 5,
  'close-angle-cock': 5,
  'set-retainer': 10,
  'cut-out-brake': 8,
  'cut-in-brake': 8,
  'align-drawbars': 20,
  // Two handles and a moment to look at what you have done.
  'set-and-centre': 12,
  'bail-off': 3,
  inspect: 0,
  wait: 0,
};

/** Walking pace on ballast, m/s — 1.5 km in twenty minutes. */
export const WALK_SPEED = 1.25;

export interface Person {
  id: string;
  name: string;
  role: PersonRole;
  posture: Posture;
  /**
   * At the controls, as opposed to merely in the cab.
   *
   * Two different things, and conflating them was wrong: a conductor rides in
   * the cab for most of a trip and is not driving. Only one person on a
   * movement can have this, and it is what `World.cabOccupant` looks for — so
   * the throttle, the horn and the alerter all follow the seat rather than the
   * doorway.
   */
  atControls: boolean;
  /** Wanders on their own. See `PersonSpec.roam`. */
  roam: boolean;

  /** Track they are working along, when on the ground. */
  trackId: string | undefined;
  /** Distance along it, metres. */
  at: number;
  /** Lateral offset from the centre line, metres. Positive is to the right. */
  offset: number;

  /** The movement they are riding or driving. */
  trainId: string | undefined;
  carId: string | undefined;
  ridingSide: 'left' | 'right';
  /** Which end of the car they are riding. */
  ridingEnd: 'leading' | 'trailing';

  /**
   * Where they came to rest, if they were hurt.
   *
   * An injured person stops being carried by anything and stops being placed by
   * their track coordinates. They are left exactly where it happened, because
   * that is where they are, and because the position of the casualty is part of
   * what an investigation is about.
   */
  restingAt: { x: number; y: number; z: number } | null;

  /**
   * Whether they have been hurt, and how.
   *
   * `struck` is equipment running over somebody standing foul of the track;
   * `crushed` is being caught between two pieces of equipment coming together.
   * Both stop the person working, permanently. This is in the model because the
   * rules it exists to study are written in response to these two events, and a
   * simulation in which standing in front of a moving car costs nothing teaches
   * the opposite of what it is for.
   */
  /**
   * How this person came to grief, if they did.
   *
   * `struck` and `crushed` are railway hazards. The rest are what the world does
   * to anybody standing in it: `road` is a highway vehicle, `drowned` is water,
   * `mauled` is a bear or a wolf pack, `trampled` is a moose. All of them end
   * the same way — a body left where it fell.
   */
  injury: Injury;

  walkSpeed: number;
  reach: number;

  /** Derived each step from the above. Never stored in a scene. */
  x: number;
  y: number;
  z: number;
  heading: number;

  task: Task | null;
  queue: Task[];
  /** Set the moment a task is refused, and cleared when the next one starts. */
  lastRefusal: string | null;

  /** Where a walk began, so it can be interpolated. Internal. */
  walkFrom: { trackId: string | undefined; at: number; offset: number; x: number; y: number } | null;
  walkDistance: number;
  /** Distance walked in total, metres. Drives the stride in the renderer. */
  stride: number;
}

export function buildPerson(spec: PersonSpec, index: number): Person {
  const posture: Posture = spec.inCabOf ? 'in-cab' : spec.ridingOn ? 'riding' : 'on-ground';
  // A scene that puts somebody in a cab means them to be driving unless it says
  // otherwise: `inCabOf` predates the distinction and every scene using it means
  // the engineer.
  const atControls = spec.inCabOf !== undefined && (spec.atControls ?? true);
  return {
    id: spec.id ?? `person-${index}`,
    name: spec.name ?? spec.id ?? `Person ${index + 1}`,
    role: spec.role ?? 'conductor',
    posture,
    trackId: spec.track,
    at: spec.at ?? 0,
    offset: spec.offset ?? 0,
    atControls,
    roam: spec.roam ?? spec.role === 'trespasser',
    trainId: spec.inCabOf ?? spec.ridingOn,
    carId: spec.ridingCar,
    ridingSide: spec.ridingSide ?? 'right',
    ridingEnd: spec.ridingEnd ?? 'trailing',
    injury: 'none',
    restingAt: null,
    walkSpeed: spec.walkSpeed ?? WALK_SPEED,
    reach: spec.reach ?? WORKING_DISTANCE,
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
    task: null,
    queue: [],
    lastRefusal: null,
    walkFrom: null,
    walkDistance: 0,
    stride: 0,
  };
}

/** Build a task with its default duration, which a caller may override. */
export function task(kind: TaskKind, fields: Partial<Task> = {}): Task {
  return {
    kind,
    label: fields.label ?? kind.replace(/-/g, ' '),
    duration: fields.duration ?? TASK_SECONDS[kind],
    elapsed: 0,
    ...fields,
  } as Task;
}

/** Everything a person needs from the world to know where they are and act. */
export interface PersonContext {
  tracks: Map<string, TrackPath>;
  network: Network;
  terrain: Terrain;
  trains: Train[];
  /**
   * Everybody, because a few acts are about more than one person: taking the
   * controls is somebody else giving them up.
   */
  people: Person[];
  events: EventLog;
  time: number;
  /**
   * Cutting and joining rewrite whole consists and re-route them, which is
   * `World`'s business and not a person's. A task that needs it calls back out
   * rather than reaching into the movement itself.
   */
  uncouple?: (carId: string, by: string) => boolean;
  couple?: (trainId: string, otherId: string, by: string) => boolean;
  protectCrossing?: (crossingId: string, by: string) => boolean;
  releaseCrossing?: (crossingId: string, by: string) => boolean;
}

/**
 * Put a person's world coordinates where their state says they are.
 *
 * Three cases, and the riding one is the interesting one: a person riding is
 * *slaved* to a car, so when that car derails and `Car.body` takes over from
 * `Car.s`, they go with it. Somebody riding the side of a car that rolls over is
 * somewhere very specific, and the model should not pretend otherwise.
 */
export function locate(person: Person, ctx: PersonContext): void {
  // Somebody who has been hurt lies where they fell and is not moved by anything
  // again — not by the car they were riding, not by their own coordinates.
  if (person.restingAt) {
    person.x = person.restingAt.x;
    person.y = person.restingAt.y;
    person.z = person.restingAt.z;
    return;
  }

  if (person.posture !== 'on-ground' && person.trainId) {
    const train = ctx.trains.find((t) => t.id === person.trainId);
    const car =
      train && person.carId ? train.cars.find((c) => c.id === person.carId) : train?.cars[0];
    if (train && car) {
      if (car.derailed && car.body) {
        person.x = car.body.x;
        person.y = car.body.y;
        person.z = car.body.z + 1;
        person.heading = car.body.yaw;
        return;
      }
      const route = train.route;
      if (route) {
        // Riding a specific end of a specific side of a specific car — which is
        // the level of detail 113(b) and 115 are written at.
        const along =
          person.posture === 'in-cab'
            ? 0
            : (person.ridingEnd === 'leading' ? 1 : -1) * train.direction * (car.length / 2 - 1.2);
        const pt = route.at(car.s + along);
        const side = person.posture === 'in-cab' ? 0 : person.ridingSide === 'left' ? -1 : 1;
        const lateral = side * (car.width / 2 + 0.35);
        person.x = pt.x + Math.sin(pt.heading) * lateral;
        person.y = pt.y - Math.cos(pt.heading) * lateral;
        person.z = pt.z + (person.posture === 'in-cab' ? 2.2 : 0.9);
        person.heading = pt.heading;
        return;
      }
    }
  }

  const track = person.trackId ? ctx.tracks.get(person.trackId) : undefined;
  if (!track) {
    person.z = ctx.terrain.heightAt(person.x, person.y);
    return;
  }
  const pt = track.at(person.at);
  person.x = pt.x + Math.sin(pt.heading) * person.offset;
  person.y = pt.y - Math.cos(pt.heading) * person.offset;
  // Standing on the ground beside the track, not floating at railhead level.
  person.z = Math.max(ctx.terrain.heightAt(person.x, person.y), pt.ground - 0.2);
  person.heading = pt.heading;
}

/**
 * Decompose a world point into a position along a track and an offset from it.
 *
 * The nearest sample, then the signed perpendicular distance from it. Used to
 * keep a person's track coordinates honest while they are walking *between*
 * tracks: without it their `(track, at, offset)` stays at wherever the walk
 * began, and anything that reads it — `locate` at the top of the next step, a
 * cancelled walk, a saved scene — puts them back at the start. That was a real
 * bug, and it looked exactly like a person snapping home mid-stride.
 */
export function projectOntoTrack(track: TrackPath, x: number, y: number): { at: number; offset: number } {
  let best = track.samples[0]!;
  let bestDistance = Infinity;
  for (const sample of track.samples) {
    const d = Math.hypot(sample.x - x, sample.y - y);
    if (d < bestDistance) {
      bestDistance = d;
      best = sample;
    }
  }
  return {
    at: best.s,
    offset: (x - best.x) * Math.sin(best.heading) - (y - best.y) * Math.cos(best.heading),
  };
}

/** Straight-line distance from a person to a point, metres. */
export function distanceTo(person: Person, x: number, y: number): number {
  return Math.hypot(person.x - x, person.y - y);
}

/**
 * Whether a person is near enough to work on something.
 *
 * `CROR/sim`'s `Person.canTakeEffectiveActionOn` is a *stated judgement* — its
 * own comment says the model stores the judgement "rather than inventing a
 * threshold in feet". A physical person is the thing that can finally derive it,
 * and this is that derivation: near enough to put a hand on it. A scene author
 * who wants to say "he could not have reached it" still can, by putting him
 * somewhere else.
 */
export function canWork(person: Person, x: number, y: number): boolean {
  return person.posture === 'on-ground' && distanceTo(person, x, y) <= person.reach;
}

/** Where a node is, so a task can find out whether the person is at it. */
function nodePosition(ctx: PersonContext, id: string): { x: number; y: number } | null {
  const node = ctx.network.nodes.get(id);
  return node ? { x: node.x, y: node.y } : null;
}

/**
 * Where the coupling behind a car is.
 *
 * Not the same place as the car, and the difference matters: a car is eighteen
 * metres long, so its couplers are nine metres from where you stand if you walk
 * to the middle of it. Somebody cutting off has to be at the joint.
 */
function couplingPosition(ctx: PersonContext, carId: string): { x: number; y: number } | null {
  for (const train of ctx.trains) {
    const index = train.cars.findIndex((c) => c.id === carId);
    if (index < 0 || index === train.cars.length - 1) continue;
    const car = train.cars[index]!;
    const next = train.cars[index + 1]!;
    const route = train.route;
    if (!route) continue;
    const pt = route.at((car.s + next.s) / 2);
    return { x: pt.x, y: pt.y };
  }
  return null;
}

/** The car with this id, and the movement it is on. */
function findCar(ctx: PersonContext, carId?: string): { car: Car; train: Train } | null {
  if (!carId) return null;
  for (const train of ctx.trains) {
    const car = train.cars.find((c) => c.id === carId);
    if (car) return { car, train };
  }
  return null;
}

/**
 * Where a given end of a car is, in the world.
 *
 * The angle cock at the *front* of a car and the one at the *back* are at
 * opposite ends of eighteen metres of steel, so which one you are being asked to
 * work decides where you have to be standing. Getting this wrong sends somebody
 * to the right car and the wrong end of it, and the refusal is baffling.
 */
function endPosition(
  ctx: PersonContext,
  carId: string | undefined,
  end: 'ahead' | 'behind',
): { x: number; y: number } | null {
  const found = findCar(ctx, carId);
  if (!found || !found.train.route) return null;
  const { car, train } = found;
  const route = train.route;
  if (!route) return null;
  const along = (end === 'ahead' ? 1 : -1) * train.direction * (car.length / 2);
  const pt = route.at(car.s + along);
  return { x: pt.x, y: pt.y };
}

/** The two cars either side of the coupling behind `carId`. */
function couplingPair(ctx: PersonContext, carId?: string): { ahead: Car; behind: Car } | null {
  if (!carId) return null;
  for (const train of ctx.trains) {
    const i = train.cars.findIndex((c) => c.id === carId);
    if (i < 0 || i === train.cars.length - 1) continue;
    return { ahead: train.cars[i]!, behind: train.cars[i + 1]! };
  }
  return null;
}

function carPosition(ctx: PersonContext, carId: string): { x: number; y: number } | null {
  for (const train of ctx.trains) {
    const car = train.cars.find((c) => c.id === carId);
    if (!car) continue;
    if (car.derailed && car.body) return { x: car.body.x, y: car.body.y };
    const route = train.route;
    if (!route) continue;
    const pt = route.at(car.s);
    return { x: pt.x, y: pt.y };
  }
  return null;
}

/** Refuse the current task, say why, and record it. */
function refuse(person: Person, ctx: PersonContext, why: string): void {
  const current = person.task;
  person.lastRefusal = why;
  if (current) current.blocked = why;
  ctx.events.emit({
    kind: 'refused',
    at: ctx.time,
    by: person.id,
    subject: current?.target,
    detail: { task: current?.kind ?? 'unknown', why },
  });
  person.task = null;
}

/**
 * Advance one person by `dt` seconds.
 *
 * Position is settled first, then the task at the front of the queue is worked
 * on. A task only *completes* when its duration has been spent, and only then
 * does anything change on the railway — which is why a conductor who is told to
 * line a switch and then walks away has not lined it.
 */
export function stepPerson(person: Person, ctx: PersonContext, dt: number): void {
  const wasX = person.x;
  const wasY = person.y;
  locate(person, ctx);
  // Somebody who has been hurt is not doing any more work.
  if (person.injury !== 'none') {
    person.task = null;
    person.queue = [];
    return;
  }

  if (!person.task) {
    const next = person.queue.shift();
    if (!next) return;
    person.task = next;
    person.lastRefusal = null;
    if (next.kind === 'walk') beginWalk(person, ctx, next);
  }

  const current = person.task;
  if (!current) return;

  if (current.kind === 'walk') {
    stepWalk(person, ctx, current, dt);
    person.stride += Math.hypot(person.x - wasX, person.y - wasY);
    return;
  }

  // Everything else is done standing still, and only if the person is there.
  const where = targetPosition(ctx, current, person);
  if (where === 'missing') {
    refuse(person, ctx, `there is no ${current.target ?? 'target'} here`);
    return;
  }
  if (where && !canWork(person, where.x, where.y)) {
    const gap = distanceTo(person, where.x, where.y);
    refuse(
      person,
      ctx,
      person.posture === 'on-ground'
        ? `too far away — ${gap.toFixed(0)} m from ${current.target ?? 'it'}`
        : `not on the ground`,
    );
    return;
  }

  current.elapsed += dt;
  if (current.elapsed < current.duration) return;

  complete(person, ctx, current);
  person.task = null;
}

/** Where the thing a task acts on is, `null` if it needs no position. */
function targetPosition(
  ctx: PersonContext,
  t: Task,
  person?: Person,
): { x: number; y: number } | null | 'missing' {
  switch (t.kind) {
    case 'line-switch':
    case 'point-and-call':
    case 'set-derail':
      return t.target ? (nodePosition(ctx, t.target) ?? 'missing') : 'missing';
    case 'apply-handbrake':
    case 'release-handbrake':
    case 'board':
    case 'set-retainer':
    case 'bleed':
    case 'cut-out-brake':
    case 'cut-in-brake':
      return t.target ? (carPosition(ctx, t.target) ?? 'missing') : 'missing';
    // The hoses and cocks are at the end of the car, which is where the
    // coupling is — the same place you stand to pull a pin.
    case 'open-angle-cock':
    case 'close-angle-cock':
      return endPosition(ctx, t.target, t.end ?? 'behind') ?? 'missing';
    case 'connect-hose':
    case 'disconnect-hose':
    case 'align-drawbars':
      return t.target
        ? (couplingPosition(ctx, t.target) ?? carPosition(ctx, t.target) ?? 'missing')
        : 'missing';
    case 'uncouple':
      return t.target ? (couplingPosition(ctx, t.target) ?? 'missing') : 'missing';
    case 'couple':
      // Checked by `World.couple` itself, which knows where the two ends are.
      return null;
    case 'ride-cab':
    case 'take-controls': {
      const train = ctx.trains.find((x) => x.id === t.target);
      const lead = train?.cars.find((c) => c.kind === 'locomotive');
      if (!train || !lead) return 'missing';
      // From the ground you must be at the engine. From aboard the same
      // movement you are already on it and can make your way to the cab —
      // which the comment here has always said and the code did not do, so
      // climbing into a cab left you unable to then take the controls.
      if (person && person.posture !== 'on-ground' && person.trainId === train.id) return null;
      return carPosition(ctx, lead.id) ?? 'missing';
    }
    default:
      // Dismounting, leaving the controls, waiting and inspecting need no
      // particular spot; they are done wherever the person already is.
      return null;
  }
}

function beginWalk(person: Person, ctx: PersonContext, t: Task): void {
  if (person.posture !== 'on-ground') {
    // Walking begins on the ground. Getting off is its own task, on purpose:
    // stepping down from a moving car is a decision, not a detail.
    t.blocked = 'not on the ground';
    return;
  }
  const to = t.to;
  if (!to) {
    t.blocked = 'nowhere to walk to';
    return;
  }
  const targetTrack = to.track ?? person.trackId;
  const track = targetTrack ? ctx.tracks.get(targetTrack) : undefined;
  if (!track) {
    t.blocked = 'no such track';
    return;
  }

  const pt = track.at(to.at);
  const offset = to.offset ?? 0;
  const tx = pt.x + Math.sin(pt.heading) * offset;
  const ty = pt.y - Math.cos(pt.heading) * offset;

  person.walkFrom = {
    trackId: person.trackId,
    at: person.at,
    offset: person.offset,
    x: person.x,
    y: person.y,
  };
  person.walkDistance = Math.hypot(tx - person.x, ty - person.y);
  t.duration = person.walkDistance / Math.max(0.1, person.walkSpeed);
}

function stepWalk(person: Person, ctx: PersonContext, t: Task, dt: number): void {
  if (t.blocked) {
    refuse(person, ctx, t.blocked);
    return;
  }
  const from = person.walkFrom;
  const to = t.to;
  if (!from || !to) {
    refuse(person, ctx, 'nowhere to walk to');
    return;
  }

  t.elapsed += dt;
  const progress = t.duration <= 0 ? 1 : clamp(t.elapsed / t.duration, 0, 1);
  const targetTrack = to.track ?? from.trackId;

  if (targetTrack === from.trackId) {
    // Walking the length of a track: interpolate in track coordinates, so the
    // person follows the curve rather than cutting the corner off it.
    person.trackId = targetTrack;
    person.at = from.at + (to.at - from.at) * progress;
    person.offset = from.offset + ((to.offset ?? 0) - from.offset) * progress;
  } else if (progress >= 1) {
    person.trackId = targetTrack;
    person.at = to.at;
    person.offset = to.offset ?? 0;
  } else {
    // Crossing between tracks: a straight line over the ground. The world point
    // is the truth here, so the track coordinates are re-derived from it every
    // step against the track being walked to — which keeps them a faithful
    // decomposition rather than a stale memory of where the walk began.
    const track = targetTrack ? ctx.tracks.get(targetTrack) : undefined;
    if (track) {
      const pt = track.at(to.at);
      const off = to.offset ?? 0;
      const x = from.x + (pt.x + Math.sin(pt.heading) * off - from.x) * progress;
      const y = from.y + (pt.y - Math.cos(pt.heading) * off - from.y) * progress;
      const decomposed = projectOntoTrack(track, x, y);
      person.trackId = targetTrack;
      person.at = decomposed.at;
      person.offset = decomposed.offset;
      person.x = x;
      person.y = y;
      person.z = ctx.terrain.heightAt(x, y);
    }
  }

  if (progress >= 1) {
    locate(person, ctx);
    ctx.events.emit({
      kind: 'arrived',
      at: ctx.time,
      by: person.id,
      where: person.trackId ? { track: person.trackId, at: person.at } : undefined,
      detail: {
        metres: Math.round(person.walkDistance),
        seconds: Math.round(t.duration),
      },
    });
    person.walkFrom = null;
    person.task = null;
  }
}

/**
 * Finish a task: change the railway, and say so.
 *
 * Every branch here either emits an event or refuses. A task that completes
 * silently is one the rules layer can never see, which would defeat the purpose
 * of having a body do it at all.
 */
function complete(person: Person, ctx: PersonContext, t: Task): void {
  const where = person.trackId ? { track: person.trackId, at: person.at } : undefined;
  const emit = (kind: Parameters<EventLog['emit']>[0]['kind'], detail?: Record<string, string | number | boolean>) =>
    ctx.events.emit({ kind, at: ctx.time, by: person.id, subject: t.target, where, detail });

  switch (t.kind) {
    case 'line-switch': {
      const node = t.target ? ctx.network.nodes.get(t.target) : undefined;
      if (!node || node.kind !== 'switch') return void refuse(person, ctx, 'not a switch');
      if (node.operation === 'spring') {
        return void refuse(person, ctx, 'spring switch — the points are held by the spring');
      }
      const before = node.position;
      node.position = t.position ?? (node.position === 'normal' ? 'reverse' : 'normal');
      // Turning it is also examining it: 104(b) requires the points be examined
      // and the target observed, and a person who turned it did stand there.
      emit('turned', { from: before, to: node.position, byHand: true });
      emit('examined', { target: node.target });
      return;
    }

    case 'point-and-call':
      emit('point-and-call');
      return;

    case 'set-derail': {
      const node = t.target ? ctx.network.nodes.get(t.target) : undefined;
      if (!node || node.kind !== 'derail') return void refuse(person, ctx, 'not a derail');
      node.derailing = t.on ?? !node.derailing;
      emit(node.derailing ? 'derail-set' : 'derail-removed', { type: node.derailType });
      return;
    }

    case 'apply-handbrake':
    case 'release-handbrake': {
      const applied = t.kind === 'apply-handbrake';
      for (const train of ctx.trains) {
        const car = train.cars.find((c) => c.id === t.target);
        if (!car) continue;
        car.handbrake = applied;
        emit(applied ? 'handbrake-applied' : 'handbrake-released', { car: car.id, type: car.type });
        return;
      }
      refuse(person, ctx, 'no such car');
      return;
    }

    case 'board': {
      const train = ctx.trains.find((x) => x.cars.some((c) => c.id === t.target));
      if (!train) return void refuse(person, ctx, 'no such car');
      person.posture = 'riding';
      person.trainId = train.id;
      person.carId = t.target;
      emit('boarded', { train: train.id, side: person.ridingSide });
      return;
    }

    case 'dismount': {
      if (person.posture === 'on-ground') return void refuse(person, ctx, 'already on the ground');
      const train = ctx.trains.find((x) => x.id === person.trainId);
      // Getting down puts them beside the track the movement is on, which is
      // where they actually are — not at the origin of some other track.
      if (train?.route) {
        const car = train.cars.find((c) => c.id === person.carId) ?? train.cars[0];
        if (car) {
          const loc = train.route.locate(car.s);
          person.trackId = loc.track.id;
          person.at = loc.at;
          person.offset = (person.ridingSide === 'left' ? -1 : 1) * 3;
        }
      }
      person.posture = 'on-ground';
      person.trainId = undefined;
      person.carId = undefined;
      emit('dismounted', train ? { train: train.id } : undefined);
      return;
    }

    case 'ride-cab': {
      const train = ctx.trains.find((x) => x.id === t.target);
      if (!train) return void refuse(person, ctx, 'no such movement');
      person.posture = 'in-cab';
      person.atControls = false;
      person.trainId = train.id;
      person.carId = train.cars.find((c) => c.kind === 'locomotive')?.id;
      emit('boarded', { train: train.id, where: 'cab' });
      return;
    }

    case 'take-controls': {
      const train = ctx.trains.find((x) => x.id === t.target);
      if (!train) return void refuse(person, ctx, 'no such movement');
      // You have to be in the cab. Climbing in is its own act and its own eight
      // seconds; this is sitting down at the stand once you are.
      if (person.posture !== 'in-cab') {
        return void refuse(person, ctx, 'not in the cab — climb in first');
      }
      // One pair of hands on the controls. Somebody else taking them is
      // somebody else giving them up, and the log says so.
      for (const other of ctx.people) {
        if (other !== person && other.atControls && other.trainId === train.id) {
          other.atControls = false;
        }
      }
      person.posture = 'in-cab';
      person.atControls = true;
      person.trainId = train.id;
      person.carId = train.cars.find((c) => c.kind === 'locomotive')?.id;
      emit('took-controls', { train: train.id });
      return;
    }

    case 'leave-controls': {
      if (!person.atControls) return void refuse(person, ctx, 'not at the controls');
      const train = ctx.trains.find((x) => x.id === person.trainId);
      // Out of the seat, still in the cab. Getting down is a separate act and
      // takes its own eight seconds.
      person.atControls = false;
      emit('left-controls', train ? { train: train.id } : undefined);
      return;
    }

    case 'display-blue-signal':
    case 'remove-blue-signal':
      emit(t.kind === 'display-blue-signal' ? 'blue-signal-displayed' : 'blue-signal-removed');
      return;

    case 'uncouple': {
      if (!t.target || !ctx.uncouple?.(t.target, person.id)) {
        return void refuse(person, ctx, 'nothing to cut off there');
      }
      return;
    }

    case 'couple': {
      const [a, b] = (t.target ?? '').split('|');
      if (!a || !b || !ctx.couple?.(a, b, person.id)) {
        return void refuse(person, ctx, 'they are not together, or not standing still');
      }
      return;
    }

    case 'connect-hose':
    case 'disconnect-hose': {
      const pair = couplingPair(ctx, t.target);
      if (!pair) return void refuse(person, ctx, 'no coupling there');
      const on = t.kind === 'connect-hose';
      pair.ahead.air.hoseBehind = on;
      pair.behind.air.hoseAhead = on;
      emit(on ? 'hose-connected' : 'hose-disconnected', { with: pair.behind.id });
      return;
    }

    case 'open-angle-cock':
    case 'close-angle-cock': {
      const found = findCar(ctx, t.target);
      if (!found) return void refuse(person, ctx, 'no such car');
      const on = t.kind === 'open-angle-cock';
      const end = t.end ?? 'behind';
      if (end === 'ahead') found.car.air.cockAhead = on;
      else found.car.air.cockBehind = on;
      emit(on ? 'angle-cock-opened' : 'angle-cock-closed', { end });
      return;
    }

    case 'set-retainer': {
      const found = findCar(ctx, t.target);
      if (!found) return void refuse(person, ctx, 'no such car');
      found.car.air.retainer = t.retainer ?? 'EX';
      emit('retainer-set', { position: found.car.air.retainer });
      return;
    }

    case 'cut-out-brake':
    case 'cut-in-brake': {
      const found = findCar(ctx, t.target);
      if (!found) return void refuse(person, ctx, 'no such car');
      found.car.air.cutOut = t.kind === 'cut-out-brake';
      emit(found.car.air.cutOut ? 'brake-cut-out' : 'brake-cut-in');
      return;
    }

    case 'protect-crossing':
    case 'release-crossing': {
      const ok =
        t.kind === 'protect-crossing'
          ? ctx.protectCrossing?.(t.target ?? '', person.id)
          : ctx.releaseCrossing?.(t.target ?? '', person.id);
      // `World` owns the crossings and does its own reach check, and it emits
      // the act or the refusal — so there is nothing to say here either way.
      if (!ok) person.task = null;
      return;
    }

    case 'bleed': {
      const found = findCar(ctx, t.target);
      if (!found) return void refuse(person, ctx, 'no such car');
      // The release rod under the car: it dumps the reservoir and the cylinder
      // to atmosphere, and after it the car has no air brake at all until
      // somebody recharges it from a locomotive.
      //
      // This is the act the model was missing, and its absence read as a bug.
      // Cut a portion off and the parted hoses put it in emergency: the brakes
      // go hard on and stay on for the best part of an hour while the cylinder
      // leaks down. Bleeding is how a cut is actually made free to move, and it
      // is exactly why 112 asks for handbrakes rather than for the air — a bled
      // car on a grade will go, and nothing about it looks any different.
      found.car.air.reservoirPsi = 0;
      found.car.air.cylinderPsi = 0;
      found.car.air.brakePipePsi = 0;
      found.car.air.referencePsi = 0;
      found.car.air.pistonTravelIn = 0;
      emit('bled', { car: found.car.id, handbrake: found.car.handbrake });
      return;
    }

    case 'align-drawbars':
      emit('drawbars-aligned', { car: t.target ?? '' });
      return;

    case 'set-and-centre': {
      const train = ctx.trains.find((x) => x.id === (t.target ?? person.trainId));
      if (!train) return void refuse(person, ctx, 'no movement here');
      if (person.posture !== 'in-cab') return void refuse(person, ctx, 'not at the controls');
      train.setAndCentre();
      emit('set-and-centred', { train: train.id });
      return;
    }

    case 'bail-off': {
      const train = ctx.trains.find((x) => x.id === (t.target ?? person.trainId));
      if (!train) return void refuse(person, ctx, 'no movement here');
      if (person.posture !== 'in-cab') return void refuse(person, ctx, 'not at the controls');
      train.bailOff();
      emit('bailed-off', { train: train.id });
      return;
    }

    case 'inspect':
      emit('examined', { what: t.target ?? 'equipment' });
      return;

    case 'wait':
    case 'walk':
      return;
  }
}


// ────────────────────────────────────────────────────────── being in the way

/**
 * How near the centre line is foul of it, metres.
 *
 * Half the width of a car plus the overhang on a curve, and then some. Standing
 * inside this while equipment moves over the spot is being run over; the rules
 * about where employees may stand exist because the margin is this small.
 */
export const FOULING_HALF_WIDTH = 2;

/** Closing speed above which being caught between equipment is fatal. */
const CRUSH_SPEED = 0.15;

/**
 * Work out who has been hurt.
 *
 * Two things happen to people on the ground around moving equipment, and both
 * are modelled because both are what the rulebook is written against:
 *
 *   - **Run over.** Somebody standing foul of a track that equipment then moves
 *     over. Tested against every car of every movement, using the same swept
 *     path the fouling rules use.
 *   - **Crushed.** Somebody standing in the gap between two pieces of equipment
 *     that come together — the space between a cut and the movement backing on
 *     to it, which is exactly where you stand to buck up hoses or pull a pin.
 *
 * Neither is dramatised. The event says what happened, where, and to whom, and
 * the person stops working. What it means is for the rules layer.
 */
export function checkInjuries(people: readonly Person[], ctx: PersonContext): void {
  for (const person of people) {
    if (person.injury !== 'none' || person.posture !== 'on-ground') continue;

    // Caught between two movements closing on each other. Tested first because
    // it is the more specific hazard: somebody in that gap would also register
    // as run over a moment later, and "crushed between equipment" is the thing
    // that actually happened and the thing the rules are written about.
    for (const a of ctx.trains) {
      for (const b of ctx.trains) {
        if (a === b || !a.route || !b.route) continue;
        const closing = Math.abs(a.speed) + Math.abs(b.speed);
        if (closing < CRUSH_SPEED) continue;
        const gap = couplingGapBetween(a, b);
        if (!gap || gap.distance > 6) continue;
        if (Math.hypot(person.x - gap.x, person.y - gap.y) > 2.5) continue;

        fell(person, 'crushed');
        ctx.events.emit({
          kind: 'injured',
          at: ctx.time,
          by: person.id,
          where: person.trackId ? { track: person.trackId, at: person.at } : undefined,
          detail: { how: 'caught between equipment', between: `${a.id} and ${b.id}` },
        });
        break;
      }
      if (person.injury !== 'none') break;
    }
    if (person.injury !== 'none') continue;

    // Run over by anything moving over the spot they are standing on.
    for (const train of ctx.trains) {
      const route = train.route;
      if (!route) continue;

      for (const car of train.cars) {
        if (car.derailed) continue;
        // Only moving equipment runs anybody over. A car standing still is a
        // thing you work beside all day.
        if (Math.abs(car.v) < 0.2) continue;
        const pt = route.at(car.s);
        const dx = person.x - pt.x;
        const dy = person.y - pt.y;
        const along = dx * Math.cos(pt.heading) + dy * Math.sin(pt.heading);
        const across = dx * Math.sin(pt.heading) - dy * Math.cos(pt.heading);
        if (Math.abs(along) > car.length / 2 || Math.abs(across) > FOULING_HALF_WIDTH) continue;

        fell(person, 'struck');
        ctx.events.emit({
          kind: 'injured',
          at: ctx.time,
          by: person.id,
          subject: car.id,
          where: person.trackId ? { track: person.trackId, at: person.at } : undefined,
          detail: {
            how: 'struck by moving equipment',
            train: train.id,
            speedKmh: Math.round(Math.abs(car.v) * 3.6),
          },
        });
        break;
      }
      if (person.injury !== 'none') break;
    }
  }
}

/**
 * Mark somebody as hurt and fix them where they are.
 *
 * Position is frozen at the moment of the injury rather than recomputed after
 * it: if they were riding, they come off there; if they were on the ground, they
 * stay on the ground there. Either way nothing moves them again.
 */
/**
 * A casualty, wherever it happened.
 *
 * Exported because the railway is no longer the only thing that can kill
 * somebody: water, a highway, and anything with teeth all end here.
 */
export function fell(person: Person, injury: Exclude<Injury, 'none'>): void {
  person.injury = injury;
  person.posture = 'on-ground';
  person.trainId = undefined;
  person.carId = undefined;
  person.task = null;
  person.queue = [];
  person.walkFrom = null;
  person.restingAt = { x: person.x, y: person.y, z: person.z };
}

/** Where two movements come closest, considering only their end faces. */
function couplingGapBetween(a: Train, b: Train): { x: number; y: number; distance: number } | null {
  const ends = (t: Train) => {
    const route = t.route;
    const lead = t.cars[0];
    const tail = t.cars[t.cars.length - 1];
    if (!route || !lead || !tail) return [];
    return [
      route.at(lead.s + (t.direction * lead.length) / 2),
      route.at(tail.s - (t.direction * tail.length) / 2),
    ];
  };
  let best: { x: number; y: number; distance: number } | null = null;
  for (const p of ends(a)) {
    for (const q of ends(b)) {
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (!best || d < best.distance) best = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, distance: d };
    }
  }
  return best;
}
