/**
 * world-sim — isometric terrain, track graded onto it, and trains running over
 * it under Newtonian physics.
 *
 * The shape of a session:
 *
 * ```ts
 * const world = World.fromJSON(sceneJson);
 * const renderer = new Renderer(canvas, world);
 * attachCameraControls(canvas, renderer.camera, { onChange: () => renderer.render() });
 *
 * let last = performance.now();
 * const frame = (now: number) => {
 *   world.step(Math.min(0.05, (now - last) / 1000));
 *   last = now;
 *   renderer.render();
 *   requestAnimationFrame(frame);
 * };
 * requestAnimationFrame(frame);
 * ```
 *
 * The simulation half (`World`, `Terrain`, `TrackPath`, `Train`, `stepTrain`)
 * has no DOM dependency; only the `render/` half touches a canvas.
 */
export { Terrain } from './terrain.ts';
export type {
  FeatureProfile,
  HillFeature,
  NoiseFeature,
  RampFeature,
  RidgeFeature,
  TerrainFeature,
  TerrainSample,
  TerrainSpec,
} from './terrain.ts';

export { DEFAULT_TERRAFORM, terraform } from './terraform.ts';
export type { TerraformOptions } from './terraform.ts';

export { TrackPath } from './track.ts';
export type { LoopSpec, TrackPoint, TrackSpec } from './track.ts';

export { resampleCurve, resamplePolyline } from './spline.ts';
export type { Point2 } from './spline.ts';

export { Train, templateCars } from './train.ts';
export type {
  Car,
  CarKind,
  CarSpec,
  ConsistTemplate,
  ContainerSpec,
  LoadedContainer,
  TrainSpec,
} from './train.ts';

export { CAR_TYPES, CATALOGUE, CONTAINERS, prototypeFor, resolvePrototype, sectionFor } from './equipment.ts';
export type { BodyPart, BodyShape, CarPrototype, CarType, ContainerLength, Section2D } from './equipment.ts';

export {
  DEFAULT_DERAILMENT,
  derailCar,
  propagateDerailment,
  stepFreeBody,
  throwCar,
} from './derailment.ts';
export type { DerailmentOptions, FreeBody } from './derailment.ts';

export { DEFAULT_PHYSICS, stepTrain, telemetry } from './physics.ts';
export type { PhysicsOptions, Telemetry } from './physics.ts';

export {
  DERAIL_DEFAULT_ON,
  isHandWorked,
  isSwitch,
  isTrailable,
  Network,
  PORTS_FOR,
  restoresToNormal,
} from './network.ts';
export type {
  DerailType,
  NetworkNode,
  NodeKind,
  NodeSpec,
  Port,
  RouteStop,
  SwitchOperation,
  SwitchPosition,
  TrackEndSpec,
} from './network.ts';

export { buildRoute, Route } from './route.ts';
export type { Guideway, RouteLeg, RouteLocation } from './route.ts';

export { buildObstruction, DEFAULT_COLLISION, resolveCollisions } from './collision.ts';
export type { CollisionEvent, CollisionOptions, Obstruction, ObstructionSpec } from './collision.ts';

export { buildScenery, stepScenery } from './scenery.ts';
export type {
  Building,
  Boat,
  BoatSpec,
  Lake,
  LakeSpec,
  River,
  RiverSpec,
  Road,
  Scenery,
  ScenerySpec,
  Tree,
  TreeSpecies,
  Vehicle,
} from './scenery.ts';
export { DEFAULT_SCENERY_STYLE, drawScenery } from './render/scenery.ts';
export { DEFAULT_PERSON_STYLE, drawPeople } from './render/person.ts';
export type { PersonStyle } from './render/person.ts';
export { DEFAULT_ZONE_STYLE, drawWorkZones } from './render/zones.ts';
export type { ZoneStyle } from './render/zones.ts';
export { DEFAULT_SIGNAL_STYLE, drawFlags, drawSignals } from './render/signals.ts';
export type { SignalStyle } from './render/signals.ts';
export type { SceneryStyle } from './render/scenery.ts';
export { paintBox, paintCone, paintFace } from './render/solid.ts';

export {
  ASPECTS,
  aspectByName,
  aspectByRule,
  buildFlag,
  buildSignal,
  flagsAhead,
  resolveSignals,
  signalAhead,
  SignalWatcher,
  speedLimitMps,
  SPEED_LIMITS,
  STOP,
} from './signals.ts';
export type {
  Aspect,
  Facing,
  Flag,
  FlagColour,
  FlagSpec,
  Signal,
  SignalControl,
  SignalPassing,
  SignalSighting,
  SignalSpec,
  SpeedClass,
} from './signals.ts';

export {
  brakingEffort,
  buildAir,
  chargeToSteadyState,
  DEFAULT_AIR,
  partHoses,
  RETAINED_PSI,
  stepAir,
} from './airbrake.ts';
export type { AirBrakeOptions, AirSpec, AirTrain, CarAir, RetainerPosition } from './airbrake.ts';

export {
  acknowledgeAlerter,
  buildAlerter,
  buildPcs,
  DEFAULT_CAB,
  dynamicBrakeFactor,
  stepCab,
} from './cab.ts';
export type {
  Alerter,
  AlerterState,
  CabOptions,
  CabTrain,
  Pcs,
  PcsReason,
} from './cab.ts';

export {
  beamReach,
  buildLights,
  ditchPhase,
  HORN_GAP,
  HORN_LONG,
  HORN_SHORT,
  HORN_SIGNALS,
  hornDuration,
  hornSounding,
  lampLevel,
  soundHorn,
  stepLights,
} from './lights.ts';
export type {
  HeadlightSetting,
  HornElement,
  HornSignal,
  Lights,
  LightsSpec,
} from './lights.ts';

export {
  buildCrossing,
  crossingLights,
  DEFAULT_CROSSING,
  stepCrossings,
  trafficStops,
} from './crossing.ts';
export type {
  Crossing,
  CrossingOccupant,
  CrossingOptions,
  CrossingProtection,
  CrossingSpec,
  CrossingState,
} from './crossing.ts';

export { buildBridge, DEFAULT_BENT_SPACING, onBridge } from './bridge.ts';
export type { Bent, Bridge, BridgeKind, BridgeSpec } from './bridge.ts';
export { DEFAULT_BRIDGE_STYLE, drawBridges } from './render/bridge.ts';
export type { BridgeStyle } from './render/bridge.ts';

export { autoDrive, buildAutoDriver, DEFAULT_DISPATCH, permittedSpeed } from './dispatch.ts';
export type { AutoDriver, AutoSpec, DispatchOptions } from './dispatch.ts';

export {
  buildWildlife,
  DEFAULT_WILDLIFE,
  inWater,
  roamTo,
  SPECIES,
  stepWildlife,
} from './wildlife.ts';
export type {
  Animal,
  AnimalSpec,
  AnimalState,
  Species,
  SpeciesTraits,
  WildlifeContext,
  WildlifeOptions,
  WildlifeSpec,
} from './wildlife.ts';
export { DEFAULT_WILDLIFE_STYLE, drawWildlife } from './render/wildlife.ts';
export type { WildlifeStyle } from './render/wildlife.ts';

export { DEFAULT_WASHOUT, findWashouts, washedOutAt } from './washout.ts';
export type { Washout, WashoutOptions } from './washout.ts';

export { VISIBILITY, WEATHER_LABEL } from './weather.ts';
export type { Weather } from './weather.ts';

export { EventLog } from './events.ts';
export type { EventKind, WorldEvent } from './events.ts';

export {
  buildPerson,
  canWork,
  checkInjuries,
  distanceTo,
  FOULING_HALF_WIDTH,
  locate,
  projectOntoTrack,
  stepPerson,
  task,
  TASK_SECONDS,
  WALK_SPEED,
  WORKING_DISTANCE,
} from './person.ts';
export { fell, INJURY_LABEL } from './person.ts';
export type { Injury, Person, PersonRole, PersonSpec, Posture, Task, TaskKind } from './person.ts';

export { World } from './world.ts';
export type { Bounds, OfferedAction, SceneSpec, SceneStyle, WorkZone } from './world.ts';
export { DEFAULT_ROAD_RAIL, stepRoadRail } from './roadrail.ts';
export type { RoadRailHit, RoadRailOptions } from './roadrail.ts';

export { IsoCamera } from './render/camera.ts';
export type { CameraOptions, Projected } from './render/camera.ts';
export { Painter } from './render/painter.ts';
export type { Vec3 } from './render/painter.ts';
export { Renderer } from './render/renderer.ts';
export type { RendererOptions } from './render/renderer.ts';
export { attachCameraControls } from './render/controls.ts';
export type { ControlOptions } from './render/controls.ts';
export { DEFAULT_TERRAIN_STYLE, drawTerrain } from './render/terrain.ts';
export type { TerrainStyle } from './render/terrain.ts';
export { DEFAULT_TRACK_STYLE, drawTrack } from './render/track.ts';
export type { TrackStyle } from './render/track.ts';
export { DEFAULT_NETWORK_STYLE, drawNetwork, drawObstructions } from './render/network.ts';
export type { NetworkStyle } from './render/network.ts';
export { DEFAULT_CROSSING_STYLE, drawCrossings } from './render/crossings.ts';
export type { CrossingStyle } from './render/crossings.ts';
export { DEFAULT_LIGHT_STYLE, drawLights } from './render/lights.ts';
export type { LightStyle } from './render/lights.ts';
export { DEFAULT_TRAIN_STYLE, drawCar, drawTrain } from './render/train.ts';
export type { TrainStyle } from './render/train.ts';
export { DEFAULT_RAMP, mix, parseHex, sampleRamp, shade, toHex } from './render/color.ts';
export type { RampStop, Rgb } from './render/color.ts';

export * from './units.ts';
