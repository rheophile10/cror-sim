/**
 * Trains: a consist of cars strung along one path.
 *
 * Each car carries its own position and velocity, and neighbours are joined by
 * couplers with slack. That is deliberately not a rigid body: the interesting
 * behaviour on a landscape — run-in on a crest, stretching on a descent, a
 * heavy tail shoving the head around a curve — only exists if the cars can move
 * relative to one another. The cost is that the integrator has to be stable
 * against a stiff spring, which is why `physics.ts` substeps.
 *
 * Cars are ordered **lead first**. `direction` says which way the consist faces
 * along the path, and the lead car is at the leading end in that direction, so
 * reversing a train is a sign flip and not a re-ordering of the array.
 *
 * What a car *is* — its weight, shape and capacity — lives in `equipment.ts`. A
 * spec here names a type and how heavily it is loaded; everything else follows.
 */
import {
  buildAir,
  chargeToSteadyState,
  dumpBrakePipe,
  type AirSpec,
  type CarAir,
} from './airbrake.ts';
import {
  acknowledgeAlerter,
  buildAlerter,
  buildPcs,
  DEFAULT_CAB,
  type Alerter,
  type Pcs,
} from './cab.ts';
import type { FreeBody } from './derailment.ts';
import { buildAutoDriver, type AutoDriver, type AutoSpec } from './dispatch.ts';
import { buildLights, type Lights, type LightsSpec } from './lights.ts';
import type { Route } from './route.ts';
import {
  CONTAINER_HEIGHT,
  CONTAINER_WIDTH,
  CONTAINERS,
  type BodyPart,
  type CarKind,
  type CarPrototype,
  type ContainerLength,
  resolvePrototype,
  sectionFor,
  underframe,
} from './equipment.ts';
import { clamp, tonnesToKg } from './units.ts';

export type { CarKind } from './equipment.ts';

/**
 * Reverser positions. `neutral` is centred, and centred means the traction
 * motors cannot be energised at all — see `Train.reverser`.
 */
export type Reverser = 'forward' | 'neutral' | 'reverse';

export interface ContainerSpec {
  /** Nominal length in feet. */
  length?: ContainerLength;
  /** 0 (empty box) to 1 (loaded to capacity). */
  load?: number;
  color?: string;
}

export interface CarSpec {
  id?: string;
  /**
   * Catalogue key: `tank`, `autorack`, `well`, `covered-hopper`, `open-hopper`,
   * `gondola`, `boxcar`, `flat`, `caboose`, `locomotive`. Anything unrecognised
   * falls back to a boxcar and is kept as the label.
   */
  type?: string;
  /** Display name. Defaults to the prototype's. */
  label?: string;
  kind?: CarKind;
  /**
   * How heavily loaded, 0 to 1, mixing the prototype's tare and capacity. The
   * single most consequential number on a car: an empty and a loaded hopper are
   * the same vehicle with a 4:1 difference in weight.
   */
  load?: number;
  /** Total mass in tonnes, overriding tare, capacity and load outright. */
  mass?: number;
  /** Containers on a well car: a count, or one entry per box, bottom tier first. */
  containers?: number | ContainerSpec[];
  /** Length over pulling faces, metres. Defaults to the prototype's. */
  length?: number;
  width?: number;
  height?: number;
  /** Tractive effort at full throttle, kN. */
  tractiveEffort?: number;
  /** Dynamic brake at full handle, kN. Defaults to a fraction of the above. */
  dynamicBrakeForce?: number;
  /** Brake force at a full application, kN. */
  brakeForce?: number;
  /** Handbrake force, kN. Defaults to a fraction of the air brake. */
  handbrakeForce?: number;
  /** 112: this car stands with its handbrake applied. */
  handbrake?: boolean;
  /** Hoses, angle cocks, retainer, leakage. See `airbrake.ts`. */
  air?: AirSpec;
  color?: string;
}

export type ConsistTemplate =
  | 'balanced'
  | 'heavyRear'
  | 'heavyFront'
  | 'unitGrain'
  | 'intermodal'
  | 'mixedFreight'
  | 'unitTank'
  | 'autoTrain';

export interface TrainSpec {
  id?: string;
  label?: string;
  /** Which track this train stands on. Defaults to the first in the scene. */
  track?: string;
  /** Distance of the **lead coupler** along the path, metres. */
  position?: number;
  /** Which way the consist faces along increasing `s`. */
  direction?: 1 | -1;
  /** Initial speed, m/s, positive in the direction of travel. */
  speed?: number;
  /** −1 (full reverse) to 1 (full forward). */
  throttle?: number;
  /** 0 to 1 on the dynamic brake handle. Exclusive with the throttle. */
  dynamic?: number;
  /** 0 to 1, automatic brake, applied to the whole train. */
  brake?: number;
  /** 0 to 1, independent brake — the locomotive's own, and nothing else's. */
  independent?: number;
  /** Forward, neutral or reverse. Centred, the throttle cannot move the engine. */
  reverser?: Reverser;
  /** Sanders working. */
  sand?: boolean;
  /** The alerter. Set `{ enabled: false }` for a scene that is not about it. */
  alerter?: { enabled?: boolean };
  /** Headlights, ditch lights and the bell. */
  lights?: LightsSpec;
  /** Drive this movement automatically. See `dispatch.ts`. */
  auto?: AutoSpec;
  cars?: CarSpec[];
  /** Generate a consist instead of listing it. */
  template?: ConsistTemplate;
  /** Cars to generate for `template`. */
  carCount?: number;
}

/** A container as loaded: its box class, its lading, and where it sits. */
export interface LoadedContainer {
  /** Nominal length in feet, kept so the car round-trips through JSON. */
  nominal: ContainerLength;
  /** Length in metres. */
  length: number;
  /** 0 (empty box) to 1 (loaded to capacity). */
  load: number;
  /** Mass in kilograms, tare plus lading. */
  mass: number;
  color: string;
  /** 0 sits in the well, 1 rides on top of it. */
  tier: 0 | 1;
}

/** Runtime state of one car. Positions are metres along the path. */
export interface Car {
  id: string;
  /** Catalogue key. */
  type: string;
  label: string;
  kind: CarKind;
  proto: CarPrototype;
  /** Mass in kilograms, including lading and any containers. */
  mass: number;
  /** Empty weight in kilograms — what is left after a derailment spills it. */
  tare: number;
  /** Load fraction, 0 to 1. */
  load: number;
  /** Length over pulling faces, metres. */
  length: number;
  height: number;
  width: number;
  containers: LoadedContainer[];
  /** Tractive effort at full throttle, newtons. */
  maxTractiveEffort: number;
  /**
   * Dynamic brake force at full handle and full effect, newtons.
   *
   * Zero on anything that is not a locomotive. Rather less than the tractive
   * effort, and what is actually delivered depends on speed — see
   * `dynamicBrakeFactor` in `cab.ts`.
   */
  maxDynamicForce: number;
  /** Brake force at a full application, newtons. */
  maxBrakeForce: number;
  /**
   * Handbrake force when applied, newtons.
   *
   * Much less than the air brake — a handbrake works one truck through a chain,
   * not the whole car through a cylinder — which is why 112 asks for a *number*
   * of handbrakes and then asks you to test that they held.
   */
  handbrakeForce: number;
  color: string;
  /** Extruded pieces, in draw order. Rebuilt only when the car changes. */
  parts: BodyPart[];

  /** Position of the car's **centre** along the path, metres. */
  s: number;
  /** Velocity along increasing `s`, m/s. Signed, not a speed. */
  v: number;
  /** Force in the coupler toward the car ahead. Positive is tension (draft). */
  couplerAhead: number;
  /** Lateral-over-vertical ratio at the wheel, the derailment number. */
  lv: number;
  /** 112: the handbrake is applied on this car. */
  handbrake: boolean;
  /** This car's brake pipe, reservoir, cylinder and the fittings on it. */
  air: CarAir;
  /** Off the rails. Once true, `body` drives the car instead of `s`. */
  derailed: boolean;
  /** Free-body state, present only once the car has left the track. */
  body: FreeBody | null;
  /**
   * Which track the car was on when it derailed, and where.
   *
   * A wreck goes on blocking the railway only while it is still lying across
   * it, so this is the anchor the fouling check measures against — one that
   * slid down the embankment stops being an obstruction.
   */
  foulTrack?: string;
  foulAt?: number;
}

const CONTAINER_COLORS = ['#b4553f', '#3f6fb4', '#4f8f5c', '#b49a3f', '#8a4f9c', '#3f8f9c'];

function buildContainers(spec: CarSpec, proto: CarPrototype): LoadedContainer[] {
  if (!proto.carriesContainers || spec.containers === undefined) return [];
  const nominal = proto.containerLength ?? 40;
  const list: ContainerSpec[] =
    typeof spec.containers === 'number'
      ? Array.from({ length: clamp(Math.round(spec.containers), 0, 2) }, () => ({}))
      : spec.containers.slice(0, 2);

  return list.map((c, i) => {
    const size = c.length ?? nominal;
    const cls = CONTAINERS[size];
    const load = clamp(c.load ?? 0.7, 0, 1);
    return {
      nominal: size,
      length: cls.length,
      load,
      mass: tonnesToKg(cls.tare + cls.capacity * load),
      color: c.color ?? CONTAINER_COLORS[i % CONTAINER_COLORS.length]!,
      tier: (i === 0 ? 0 : 1) as 0 | 1,
    };
  });
}

/** Every extruded piece of a car, body first, containers last. */
function buildParts(proto: CarPrototype, width: number, color: string, containers: LoadedContainer[]): BodyPart[] {
  const parts: BodyPart[] = [underframe(proto)];
  parts.push({ section: sectionFor(proto.shape, width), span: 0.94, offset: 0, color });
  for (const extra of proto.extras ?? []) {
    parts.push({
      section: sectionFor(extra.shape, width),
      span: extra.span,
      offset: extra.offset,
      color: extra.color === proto.color ? color : extra.color,
    });
  }

  // Containers ride in the well and stack; the floor is the top of the U's
  // bottom web, which is why the well's own section is read rather than guessed.
  const floor = proto.shape.kind === 'open' ? proto.shape.bottom + proto.shape.wall : 1.2;
  for (const c of containers) {
    const bottom = floor + c.tier * CONTAINER_HEIGHT;
    parts.push({
      section: sectionFor(
        { kind: 'box', bottom, top: bottom + CONTAINER_HEIGHT, widthFactor: CONTAINER_WIDTH / width },
        width,
      ),
      span: c.length / proto.length,
      offset: 0,
      color: c.color,
      bias: 0.1,
    });
  }
  return parts;
}

function buildCar(spec: CarSpec, index: number): Car {
  // No type on the first car means a locomotive: the overwhelmingly common case,
  // and it keeps `{ cars: [{}, {}, {}] }` a usable shorthand for a short train.
  const resolved = resolvePrototype(spec.type ?? (index === 0 ? 'locomotive' : 'boxcar'));
  const proto = resolved.proto;
  const kind = spec.kind ?? proto.kind;
  const width = spec.width ?? proto.width;
  const color = spec.color ?? proto.color;
  const load = clamp(spec.load ?? proto.defaultLoad, 0, 1);
  const containers = buildContainers(spec, proto);
  const containerMass = containers.reduce((sum, c) => sum + c.mass, 0);

  const mass =
    spec.mass !== undefined
      ? tonnesToKg(spec.mass)
      : tonnesToKg(proto.tare + proto.capacity * load) + containerMass;

  // A stack of boxes stands well above the car it rides on, and the camera and
  // the derailment both need to know how tall the whole thing is.
  const stack = containers.length > 0 ? 1.9 + containers.length * CONTAINER_HEIGHT : 0;

  return {
    id: spec.id ?? String(index),
    type: resolved.key,
    // An unrecognised type is free text from an older scene; keep it as the name.
    label: spec.label ?? (resolved.known ? proto.label : (spec.type ?? proto.label)),
    kind,
    proto,
    mass,
    tare: tonnesToKg(proto.tare),
    load,
    length: spec.length ?? proto.length,
    height: spec.height ?? Math.max(proto.height, stack),
    width,
    containers,
    maxTractiveEffort: (spec.tractiveEffort ?? proto.tractiveEffort ?? 0) * 1000,
    maxDynamicForce:
      kind === 'locomotive'
        ? (spec.dynamicBrakeForce ??
            (spec.tractiveEffort ?? proto.tractiveEffort ?? 0) * DEFAULT_CAB.dynamicFraction) * 1000
        : 0,
    maxBrakeForce: (spec.brakeForce ?? proto.brakeForce) * 1000,
    handbrakeForce: (spec.handbrakeForce ?? (spec.brakeForce ?? proto.brakeForce) * 0.22) * 1000,
    color,
    parts: buildParts(proto, width, color, containers),
    s: 0,
    v: 0,
    couplerAhead: 0,
    lv: 0,
    handbrake: spec.handbrake ?? false,
    air: buildAir(spec.air),
    derailed: false,
    body: null,
  };
}

/**
 * Canned consists.
 *
 * `heavyRear` and `heavyFront` are badly marshalled on purpose: tonnage at the
 * wrong end of a train is what turns a curve on a grade into a string-lining,
 * and the whole reason for modelling per-car mass is to be able to show that.
 */
export function templateCars(template: ConsistTemplate, count = 12): CarSpec[] {
  const n = Math.max(1, count);
  const cars: CarSpec[] = [{ type: 'locomotive' }];
  const empty = { type: 'boxcar', load: 0, label: 'Empty Box Car' };

  for (let i = 1; i < n; i++) {
    switch (template) {
      case 'heavyRear':
        cars.push(i >= n - 3 ? { type: 'tank', load: 1 } : empty);
        break;
      case 'heavyFront':
        cars.push(i <= 3 ? { type: 'open-hopper', load: 1 } : empty);
        break;
      case 'unitGrain':
        cars.push({ type: 'covered-hopper', load: 0.95 });
        break;
      case 'unitTank':
        cars.push({ type: 'tank', load: 0.92 });
        break;
      case 'autoTrain':
        cars.push({ type: 'autorack', load: 0.8 });
        break;
      case 'intermodal':
        // A real intermodal train is not uniformly loaded: some wells run empty,
        // some single-stacked, most double.
        cars.push({
          type: 'well',
          containers: i % 5 === 0 ? 0 : i % 3 === 0 ? 1 : 2,
        });
        break;
      case 'mixedFreight': {
        const kinds = ['boxcar', 'tank', 'covered-hopper', 'autorack', 'gondola', 'flat'];
        cars.push({ type: kinds[i % kinds.length]!, load: i % 4 === 0 ? 0.1 : 0.9 });
        break;
      }
      case 'balanced':
      default:
        cars.push({ type: 'boxcar', load: 0.4 + (i % 2) * 0.4 });
        break;
    }
  }
  if (template === 'mixedFreight') cars.push({ type: 'caboose' });
  return cars;
}

export class Train {
  readonly id: string;
  readonly label: string | undefined;
  readonly trackId: string | undefined;
  /**
   * The consist, lead first.
   *
   * Not readonly: a conductor cuts cars off and couples them back on, and both
   * operations rewrite this array in place rather than rebuilding the movement.
   * `World.uncouple` and `World.couple` are the only things that should.
   */
  cars: Car[];
  /** Which way the consist faces along increasing `s`. */
  direction: 1 | -1;
  /** −1 to 1. */
  throttle: number;
  /**
   * The dynamic brake handle, 0 to 1.
   *
   * Exclusive with the throttle — the same motors cannot be pulling and
   * generating at once — and it is the physics that enforces that rather than
   * this setter, so a scene can describe an impossible handle position and see
   * it refused rather than silently corrected.
   */
  dynamic: number;
  /** Sanders working, which buys adhesion for both power and dynamic braking. */
  sand = false;
  /**
   * Somebody is at the controls of this movement.
   *
   * Set by `World` each step from who is actually in the cab. It gates the
   * alerter, and only the alerter — a train with nobody in it still rolls, still
   * brakes and still derails, which is the entire point of half the scenes in
   * this package.
   */
  attended = false;
  /** The vigilance timer, and what it has done about being ignored. */
  alerter: Alerter;
  /** The pneumatic control switch. Open means no power and no dynamic brake. */
  pcs: Pcs;
  /** The air flow indicator, CFM. Written by the air brake each step. */
  airFlowCfm = 0;
  /** Headlights, ditch lights, bell and horn. See `lights.ts`. */
  lights: Lights;
  /**
   * The machine driving this movement, if one is.
   *
   * Present on every train and inert unless `drive` is set, so the app can show
   * what an automatic movement is reacting to without asking whether it has a
   * driver at all.
   */
  auto: AutoDriver;
  /** The automatic brake handle: 0 released, 1 a full service reduction. */
  brake: number;
  /**
   * In emergency. Set by the pipe going to atmosphere — a parted hose, an open
   * angle cock — and cleared only by a full release and a recharge, which on a
   * long train is minutes rather than seconds.
   */
  emergency = false;
  /**
   * The independent brake, 0 to 1.
   *
   * Straight air to the locomotive's own brake cylinders, and to nothing else.
   * It is not the train brake and it does not go down the pipe: it applies and
   * releases immediately, it holds the engine and nothing behind it, and it is
   * half of what "set and centre" means.
   */
  independent: number;
  /**
   * The reverser, and the other half.
   *
   * Centred, the traction motors cannot be energised and the throttle does
   * nothing at all — which is the entire safety property. An engine left with
   * the reverser centred cannot move under power however the throttle is left,
   * and that is why 62 asks for it rather than for the throttle to be closed.
   *
   * Modelled as a gate rather than as the sign of the effort, because `throttle`
   * here is already signed. Centring it is the part the rules are about.
   */
  reverser: Reverser;
  /** True once any car has left the rails. The rest of the train runs on. */
  derailed = false;
  derailmentReason = '';
  /**
   * Path position of the pile-up, once there is one. Cars still on the rails
   * run into it; see `derailment.ts`.
   */
  derailAnchor: number | null = null;
  /** Which side the last car was thrown, so a pile-up jackknifes. */
  derailSide = 1;
  /**
   * The way through the network this movement is taking. Set by `World`; the
   * physics measures every position along it. Null only before the train has
   * been given one.
   */
  route: Route | null = null;

  /**
   * A movement made from cars that already exist and are already positioned.
   *
   * This is what a cut produces. The cars keep their `s`, so the new movement is
   * standing exactly where those cars were standing; `World.uncouple` then gives
   * it its own route, which is where the distances get rebased.
   */
  static of(id: string, cars: Car[], from: Train): Train {
    const train = new Train({ id, cars: [] });
    train.cars.push(...cars);
    train.direction = from.direction;
    train.route = from.route;
    return train;
  }

  constructor(spec: TrainSpec) {
    this.id = spec.id ?? 'train';
    this.label = spec.label;
    this.trackId = spec.track;
    this.direction = spec.direction ?? 1;
    this.throttle = spec.throttle ?? 0;
    this.dynamic = clamp(spec.dynamic ?? 0, 0, 1);
    this.brake = spec.brake ?? 0;
    this.independent = spec.independent ?? 0;
    this.reverser = spec.reverser ?? 'forward';
    this.sand = spec.sand ?? false;
    this.alerter = buildAlerter(spec.alerter);
    this.pcs = buildPcs();
    this.lights = buildLights(spec.lights);
    this.auto = buildAutoDriver(spec.auto);

    const specs = spec.cars ?? templateCars(spec.template ?? 'balanced', spec.carCount);
    this.cars = specs.map(buildCar);
    this.place(spec.position ?? 0);
    for (const car of this.cars) car.v = (spec.speed ?? 0) * this.direction;
    // A movement with a locomotive on it is assumed to have been coupled up and
    // charged before the scene starts. Without this a freshly built train has an
    // empty brake pipe and therefore *no air brakes at all* — which is correct
    // physics and a horrible trap, since nothing about it looks wrong until the
    // train fails to stop.
    this.chargeAir();
  }

  /**
   * Stand the consist on the path with its lead coupler at `headS`, couplers
   * closed. Called at construction and by any reset.
   */
  place(headS: number): void {
    let offset = 0;
    for (const car of this.cars) {
      offset += car.length / 2;
      car.s = headS - this.direction * offset;
      offset += car.length / 2;
    }
  }

  /** Settle the air to what it would be after standing charged. */
  chargeAir(): void {
    chargeToSteadyState(this);
  }

  /**
   * Big hole: the brake valve to emergency.
   *
   * Dumps the pipe rather than merely raising the flag, because the flag alone
   * clears itself against a pipe that is still full. Recovery is a full release
   * and a recharge, which on a long train is minutes.
   */
  emergencyBrake(): void {
    dumpBrakePipe(this);
    this.throttle = 0;
    this.dynamic = 0;
  }

  /** Length over the pulling faces of the whole consist, metres. */
  get length(): number {
    return this.cars.reduce((sum, c) => sum + c.length, 0);
  }

  get mass(): number {
    return this.cars.reduce((sum, c) => sum + c.mass, 0);
  }

  /**
   * Whether anything on this movement can charge the brake pipe.
   *
   * A cut of cars has no air supply: whatever was in the pipe when it was cut
   * off is all it will ever have, and it leaks from there. That is the whole
   * distinction between a movement and a standing cut, and 112 is written about
   * the difference.
   */
  get hasAir(): boolean {
    return this.cars.some((c) => c.kind === 'locomotive' && !c.derailed);
  }

  /**
   * Set and centre: full independent brake, reverser centred.
   *
   * The two acts are done together because either alone leaves the engine able
   * to move — brakes on but the motors live, or the motors dead but nothing
   * holding it on a grade.
   */
  setAndCentre(): void {
    this.independent = 1;
    this.reverser = 'neutral';
    this.throttle = 0;
    this.dynamic = 0;
  }

  /**
   * The alerter reset button, and everything else that counts as one.
   *
   * A penalty already made is not undone by this — recovering from one means
   * the automatic brake handle in suppression and waiting out the PCS.
   */
  acknowledge(): void {
    acknowledgeAlerter(this);
  }

  /**
   * Whether the throttle and the dynamic brake can do anything at all.
   *
   * False with the reverser centred or the PCS open, and the two failures look
   * identical from the seat: the handle moves and nothing happens.
   */
  get loadAvailable(): boolean {
    return this.reverser !== 'neutral' && !this.pcs.open;
  }

  /**
   * Bail off: release the locomotive's brakes during an automatic application.
   *
   * The engine's cylinders are dumped while the train's stay applied, which is
   * what keeps a train stretched instead of letting the head end brake harder
   * than the cars behind it and bunch the slack into the cab.
   */
  bailOff(): void {
    for (const car of this.cars) {
      if (car.kind === 'locomotive') car.air.cylinderPsi = 0;
    }
  }

  /**
   * How much of the train has its brakes off, 0 to 1.
   *
   * Not a pressure — a *count of cars*. What an engineer waits for after
   * releasing is not a number on a gauge but the far end of the train letting
   * go, and on a long train that takes a minute or more while the head end
   * reads full pressure the whole time. This is that wait, made visible.
   */
  get released(): number {
    const railed = this.cars.filter((c) => !c.derailed);
    if (railed.length === 0) return 1;
    const off = railed.filter((c) => c.air.cylinderPsi < 3).length;
    return off / railed.length;
  }

  /** How much of the train's brake pipe is up to running pressure, 0 to 1. */
  get charged(): number {
    const railed = this.cars.filter((c) => !c.derailed);
    if (railed.length === 0) return 1;
    const head = railed[0]!.air.brakePipePsi;
    if (head <= 1) return 0;
    const up = railed.filter((c) => c.air.brakePipePsi >= head * 0.95).length;
    return up / railed.length;
  }

  /** Cars still on the rails, in consist order. */
  get railed(): Car[] {
    return this.cars.filter((c) => !c.derailed);
  }

  get derailedCount(): number {
    return this.cars.reduce((n, c) => n + (c.derailed ? 1 : 0), 0);
  }

  /**
   * Position of the lead coupler along the path. Falls back to the leading car
   * still on the rails once the head end has been thrown off.
   */
  get headPosition(): number {
    const lead = this.cars.find((c) => !c.derailed) ?? this.cars[0];
    return lead ? lead.s + (this.direction * lead.length) / 2 : 0;
  }

  /** Speed in the direction of travel; negative means the train is backing. */
  get speed(): number {
    const lead = this.cars.find((c) => !c.derailed) ?? this.cars[0];
    return lead ? lead.v * this.direction : 0;
  }

  derail(reason: string): void {
    this.derailed = true;
    this.derailmentReason = reason;
  }
}
