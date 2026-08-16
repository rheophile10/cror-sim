/**
 * Rolling stock catalogue: what a car *is*, as opposed to where it is.
 *
 * A car type carries three things that used to be scattered or absent:
 *
 *   - **Mass in two parts.** Tare is the car; capacity is what it can hold; a
 *     `load` between 0 and 1 mixes them. That is the whole point — an empty
 *     centre-beam and a loaded one are the same car with a 5:1 difference in
 *     weight, and every interesting thing in `physics.ts` turns on weight.
 *   - **A cross-section.** Bodies are extrusions of a polygon in the (lateral,
 *     vertical) plane, which is enough to tell a tank car from an autorack from
 *     a well car without modelling any of them properly. One extrusion routine
 *     draws them all.
 *   - **What it can carry.** Well cars take containers, which have their own
 *     tare and lading and stack two high.
 *
 * Dimensions are metres above the railhead, masses are tonnes. Figures are
 * representative North American practice, rounded — good enough that a unit
 * grain train outweighs an empty boxcar train by the right factor, not good
 * enough to quote at anyone.
 */

/** A point on a car's cross-section: lateral offset, height above railhead. */
export interface Section2D {
  y: number;
  z: number;
}

/**
 * Cross-section shapes. Everything is an extrusion of one of these along the
 * car's length; `open` produces a U, which covers gondolas, open hoppers and
 * intermodal wells alike.
 */
export type BodyShape =
  | { kind: 'box'; bottom: number; top: number; widthFactor?: number }
  /** Wide at the top, narrower at the bottom: a hopper's slope sheets. */
  | { kind: 'taper'; bottom: number; top: number; bottomFactor: number }
  /** A U: outer wall, cavity, outer wall. */
  | { kind: 'open'; bottom: number; top: number; bottomFactor?: number; wall: number }
  | { kind: 'cylinder'; centre: number; radius: number; sides?: number };

/** One extruded piece of a car. A car is a handful of these. */
export interface BodyPart {
  section: Section2D[];
  /** Fraction of the car's length this part spans. */
  span: number;
  /** Offset of the part's centre along the car, metres. Positive is forward. */
  offset: number;
  color: string;
  /** Parts drawn nearer the camera than the body: containers on a well car. */
  bias?: number;
}

export type CarKind = 'locomotive' | 'car';

export interface CarPrototype {
  /** Human label, used when a scene does not give one. */
  label: string;
  kind: CarKind;
  /** Empty weight, tonnes. */
  tare: number;
  /** Lading the car can carry, tonnes. */
  capacity: number;
  /** Load fraction when a scene does not say. */
  defaultLoad: number;
  /** Length over pulling faces, metres. */
  length: number;
  width: number;
  /** Overall height above railhead, metres. */
  height: number;
  /** Brake force at a full application, kN. */
  brakeForce: number;
  /** Tractive effort at full throttle, kN. Locomotives only. */
  tractiveEffort?: number;
  color: string;
  shape: BodyShape;
  /** Extra pieces: a locomotive cab, a tank car's frame. */
  extras?: { shape: BodyShape; span: number; offset: number; color: string }[];
  /** Well cars take containers; nothing else does. */
  carriesContainers?: boolean;
  /** Containers this car takes when a scene just says how many. */
  containerLength?: ContainerLength;
}

export type ContainerLength = 20 | 40 | 45 | 53;

export interface ContainerClass {
  /** Length in metres. */
  length: number;
  tare: number;
  capacity: number;
}

/** ISO container classes, by nominal length in feet. */
export const CONTAINERS: Record<ContainerLength, ContainerClass> = {
  20: { length: 6.06, tare: 2.2, capacity: 28 },
  40: { length: 12.19, tare: 3.8, capacity: 26 },
  45: { length: 13.72, tare: 4.3, capacity: 26 },
  53: { length: 16.15, tare: 4.8, capacity: 30 },
};

export const CONTAINER_WIDTH = 2.44;
/** High-cube height, 9 ft 6 in. */
export const CONTAINER_HEIGHT = 2.9;

/** Build the polygon for a shape, wound counter-clockwise in (y, z). */
export function sectionFor(shape: BodyShape, width: number): Section2D[] {
  const w = width / 2;
  switch (shape.kind) {
    case 'box': {
      const hw = w * (shape.widthFactor ?? 1);
      return [
        { y: -hw, z: shape.bottom },
        { y: hw, z: shape.bottom },
        { y: hw, z: shape.top },
        { y: -hw, z: shape.top },
      ];
    }
    case 'taper': {
      const bw = w * shape.bottomFactor;
      return [
        { y: -bw, z: shape.bottom },
        { y: bw, z: shape.bottom },
        { y: w, z: shape.top },
        { y: -w, z: shape.top },
      ];
    }
    case 'open': {
      // Outer boundary up one side, back down the inside, out the other side:
      // a simple non-convex polygon, which fills correctly and whose edges each
      // get an honest outward normal.
      const bw = w * (shape.bottomFactor ?? 1);
      const t = shape.wall;
      const floor = shape.bottom + t;
      return [
        { y: -bw, z: shape.bottom },
        { y: bw, z: shape.bottom },
        { y: w, z: shape.top },
        { y: w - t, z: shape.top },
        { y: bw - t, z: floor },
        { y: -bw + t, z: floor },
        { y: -w + t, z: shape.top },
        { y: -w, z: shape.top },
      ];
    }
    case 'cylinder': {
      const sides = shape.sides ?? 14;
      const out: Section2D[] = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        out.push({
          y: Math.cos(a) * Math.min(shape.radius, w),
          z: shape.centre + Math.sin(a) * shape.radius,
        });
      }
      return out;
    }
  }
}

const UNDERFRAME = '#2b2927';

/**
 * The catalogue.
 *
 * `heavyRear`-style scenarios need cars that differ by a factor of four in
 * weight while looking obviously different, so the shapes and the masses are
 * chosen together: the tall light thing (autorack) and the low heavy thing
 * (loaded hopper) should be tellable apart at a glance in the isometric view.
 */
export const CATALOGUE = {
  locomotive: {
    label: 'Locomotive',
    kind: 'locomotive',
    tare: 190,
    capacity: 0,
    defaultLoad: 0,
    length: 22.4,
    width: 3.1,
    height: 4.7,
    brakeForce: 180,
    tractiveEffort: 530,
    color: '#f2b134',
    shape: { kind: 'box', bottom: 1.35, top: 4.3, widthFactor: 0.86 },
    extras: [
      // The cab, a little taller and set at the rear of the long hood.
      { shape: { kind: 'box', bottom: 1.35, top: 4.7, widthFactor: 0.95 }, span: 0.26, offset: -6.5, color: '#f2b134' },
      { shape: { kind: 'box', bottom: 0.35, top: 1.35, widthFactor: 0.95 }, span: 0.98, offset: 0, color: UNDERFRAME },
    ],
  },
  boxcar: {
    label: 'Box Car',
    kind: 'car',
    tare: 30,
    capacity: 70,
    defaultLoad: 0.5,
    length: 18.3,
    width: 3.2,
    height: 4.6,
    brakeForce: 90,
    color: '#6f7f8c',
    shape: { kind: 'box', bottom: 1.15, top: 4.6 },
  },
  'covered-hopper': {
    label: 'Covered Hopper',
    kind: 'car',
    tare: 30,
    capacity: 100,
    defaultLoad: 0.95,
    length: 18.0,
    width: 3.2,
    height: 4.6,
    brakeForce: 95,
    color: '#c7a45c',
    shape: { kind: 'taper', bottom: 1.0, top: 4.6, bottomFactor: 0.42 },
  },
  'open-hopper': {
    label: 'Open Hopper',
    kind: 'car',
    tare: 22,
    capacity: 100,
    defaultLoad: 0.95,
    length: 16.0,
    width: 3.2,
    height: 3.9,
    brakeForce: 95,
    color: '#5c5f63',
    shape: { kind: 'open', bottom: 1.0, top: 3.9, bottomFactor: 0.5, wall: 0.28 },
  },
  gondola: {
    label: 'Gondola',
    kind: 'car',
    tare: 25,
    capacity: 100,
    defaultLoad: 0.8,
    length: 16.0,
    width: 3.2,
    height: 3.5,
    brakeForce: 95,
    color: '#7a5f4e',
    shape: { kind: 'open', bottom: 1.1, top: 3.5, wall: 0.25 },
  },
  tank: {
    label: 'Tank Car',
    kind: 'car',
    tare: 30,
    capacity: 90,
    defaultLoad: 0.9,
    length: 18.5,
    width: 3.1,
    height: 4.2,
    brakeForce: 90,
    color: '#b0b5ba',
    shape: { kind: 'cylinder', centre: 2.65, radius: 1.55 },
    extras: [{ shape: { kind: 'box', bottom: 0.9, top: 1.15, widthFactor: 0.8 }, span: 1, offset: 0, color: UNDERFRAME }],
  },
  autorack: {
    label: 'Auto Carrier',
    kind: 'car',
    tare: 45,
    capacity: 25,
    defaultLoad: 0.85,
    length: 27.4,
    width: 3.25,
    height: 5.9,
    brakeForce: 100,
    color: '#8c7f6f',
    shape: { kind: 'box', bottom: 1.05, top: 5.9 },
  },
  well: {
    label: 'Well Car',
    kind: 'car',
    tare: 28,
    capacity: 0,
    defaultLoad: 0,
    length: 20.1,
    width: 3.0,
    height: 1.9,
    brakeForce: 95,
    color: '#4a5a66',
    // The well floor sits low between the trucks — that is the whole point of
    // the car, and it is what lets two containers stack inside the loading gauge.
    shape: { kind: 'open', bottom: 0.5, top: 1.9, wall: 0.22 },
    carriesContainers: true,
    containerLength: 40,
  },
  flat: {
    label: 'Flat Car',
    kind: 'car',
    tare: 25,
    capacity: 70,
    defaultLoad: 0.6,
    length: 18.9,
    width: 3.2,
    height: 1.4,
    brakeForce: 90,
    color: '#5a5f55',
    shape: { kind: 'box', bottom: 1.05, top: 1.4 },
  },
  caboose: {
    label: 'Caboose',
    kind: 'car',
    tare: 25,
    capacity: 0,
    defaultLoad: 0,
    length: 12.2,
    width: 3.1,
    height: 4.4,
    brakeForce: 70,
    color: '#a3453c',
    shape: { kind: 'box', bottom: 1.15, top: 4.0 },
    extras: [{ shape: { kind: 'box', bottom: 4.0, top: 4.9, widthFactor: 0.6 }, span: 0.3, offset: 0, color: '#a3453c' }],
  },
} as const satisfies Record<string, CarPrototype>;

export type CarType = keyof typeof CATALOGUE;

export const CAR_TYPES = Object.keys(CATALOGUE) as CarType[];

/** Look up a type, falling back to a boxcar for anything unrecognised. */
export function prototypeFor(type: string | undefined): CarPrototype {
  return resolvePrototype(type).proto;
}

/**
 * Resolve a type name, reporting whether it was recognised.
 *
 * Unrecognised names are not an error: earlier scenes wrote free text in `type`
 * ("Loaded Ore Hopper"), and the useful thing to do with one of those is to
 * treat it as a label on a generic car rather than to refuse the scene.
 */
export function resolvePrototype(type: string | undefined): {
  key: CarType;
  proto: CarPrototype;
  known: boolean;
} {
  if (type && type in CATALOGUE) {
    return { key: type as CarType, proto: CATALOGUE[type as CarType], known: true };
  }
  return { key: 'boxcar', proto: CATALOGUE.boxcar, known: false };
}

/** The standard underframe, added to every car that does not draw its own. */
export function underframe(proto: CarPrototype): BodyPart {
  const bottom = Math.min(0.95, shapeBottom(proto.shape));
  return {
    section: sectionFor({ kind: 'box', bottom: 0.35, top: bottom, widthFactor: 0.72 }, proto.width),
    span: 0.98,
    offset: 0,
    color: UNDERFRAME,
  };
}

function shapeBottom(shape: BodyShape): number {
  return shape.kind === 'cylinder' ? shape.centre - shape.radius : shape.bottom;
}
