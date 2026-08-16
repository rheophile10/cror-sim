import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CAB, dynamicBrakeFactor } from '../src/cab.ts';
import { DEFAULT_PHYSICS, stepTrain, telemetry } from '../src/physics.ts';
import { Terrain } from '../src/terrain.ts';
import { TrackPath } from '../src/track.ts';
import { Train } from '../src/train.ts';

const level = () => new Terrain({ cols: 400, rows: 20, cellSize: 10, baseElevation: 0 });

const straight = (terrain: Terrain) =>
  new TrackPath({ points: [[2, 10], [200, 10], [398, 10]], spacing: 5 }, terrain);

/** A descending grade, steep enough that a train has to be held down it. */
function descent(): { terrain: Terrain; path: TrackPath } {
  const terrain = new Terrain({
    cols: 400,
    rows: 20,
    cellSize: 10,
    features: [{ kind: 'ramp', from: [380, 10], to: [20, 10], height: 90 }],
  });
  const path = new TrackPath(
    { points: [[20, 10], [200, 10], [380, 10]], spacing: 5, maxGrade: 2.5, smoothing: 4 },
    terrain,
  );
  return { terrain, path };
}

function run(train: Train, path: TrackPath, seconds: number, dt = 0.02): void {
  for (let t = 0; t < seconds; t += dt) stepTrain(train, path, dt, DEFAULT_PHYSICS);
}

/** A train with somebody in the seat, which is the only kind the alerter watches. */
function manned(spec: ConstructorParameters<typeof Train>[0]): Train {
  const train = new Train(spec);
  train.attended = true;
  return train;
}

// ── The dynamic brake ──────────────────────────────────────────────────────

test('dynamic braking fades out as the train slows, and away again at speed', () => {
  assert.equal(dynamicBrakeFactor(0), 0, 'nothing at a stand');
  assert.ok(dynamicBrakeFactor(1) < 0.25, 'next to nothing at a walking pace');
  assert.ok(dynamicBrakeFactor(DEFAULT_CAB.dynamicPeakSpeed) > 0.99, 'full at the peak');
  // Constant power above the fade speed: twice the speed, half the force.
  const fade = DEFAULT_CAB.dynamicFadeSpeed;
  assert.ok(Math.abs(dynamicBrakeFactor(fade * 2) - 0.5) < 0.01);
});

test('the dynamic brake slows a train without touching the air', () => {
  const path = straight(level());
  const train = new Train({
    position: 1200,
    template: 'balanced',
    carCount: 6,
    speed: 20,
    alerter: { enabled: false },
  });
  const pipeBefore = train.cars[0]!.air.brakePipePsi;
  train.dynamic = 1;
  run(train, path, 40);
  assert.ok(train.speed < 14, `only came down to ${train.speed.toFixed(1)} m/s`);
  // The whole point of it: no air was used to do that. The pipe is within a
  // hundredth of a psi of where it started — leaking and being made up, which is
  // what a charged train does whatever else is going on.
  assert.ok(Math.abs(train.cars[0]!.air.brakePipePsi - pipeBefore) < 0.05);
  assert.ok(train.cars[0]!.air.cylinderPsi < 1, 'no application was made');
  assert.ok(telemetry(train, path).dynamicForce > 0);
});

test('the dynamic brake cannot pull a train backwards, however long it is left on', () => {
  const path = straight(level());
  const train = new Train({
    position: 1200,
    template: 'balanced',
    carCount: 6,
    speed: 4,
    alerter: { enabled: false },
  });
  train.dynamic = 1;
  run(train, path, 120);
  assert.ok(train.speed >= 0, `ran backwards at ${train.speed} m/s`);
  assert.ok(train.speed < 0.05, 'and did come to a stand');
});

test('a train held on a grade by dynamic brake alone gets away as it slows', () => {
  // The classic way of getting into trouble with it: retarding force disappears
  // exactly when it is least wanted, and there is nothing in the cylinders
  // because none was ever put there.
  const { path } = descent();
  const train = new Train({
    position: path.length / 2,
    template: 'unitGrain',
    carCount: 14,
    speed: 6,
    alerter: { enabled: false },
  });
  train.dynamic = 1;
  run(train, path, 180);
  assert.ok(train.speed > 5, `dynamic alone held it at ${train.speed.toFixed(1)} m/s`);
  // Nothing in the cylinders but the trickle that standing leakage puts there.
  assert.ok(train.cars[2]!.air.cylinderPsi < 1, 'it never made an air brake application');
});

test('the throttle does nothing while the dynamic brake is set up', () => {
  const path = straight(level());
  const train = new Train({ position: 200, template: 'balanced', carCount: 4, throttle: 1 });
  train.dynamic = 0.5;
  run(train, path, 20);
  assert.ok(Math.abs(train.speed) < 1e-6, `moved at ${train.speed} m/s`);
});

// ── The sanders ────────────────────────────────────────────────────────────

test('sand buys adhesion, and the acceleration limit moves with it', () => {
  const path = straight(level());
  const spec = {
    position: 200,
    cars: [{ kind: 'locomotive' as const, mass: 190, tractiveEffort: 1000 }],
    throttle: 1,
  };
  const dry = new Train(spec);
  const sanded = new Train({ ...spec, sand: true });
  run(dry, path, 6);
  run(sanded, path, 6);
  assert.ok(sanded.speed > dry.speed * 1.2, `${sanded.speed} vs ${dry.speed}`);
});

// ── The alerter ────────────────────────────────────────────────────────────

test('the alerter asks, then applies the brakes when nobody answers', () => {
  const path = straight(level());
  const train = manned({ position: 200, template: 'balanced', carCount: 4, speed: 15 });
  run(train, path, DEFAULT_CAB.alerterSeconds - 2);
  assert.equal(train.alerter.state, 'quiet', 'not yet');
  run(train, path, 4);
  assert.equal(train.alerter.state, 'asking');
  assert.equal(train.brake, 0, 'asking is not applying');
  run(train, path, DEFAULT_CAB.alerterWarningSeconds + 1);
  assert.equal(train.alerter.state, 'penalty');
  assert.equal(train.brake, 1, 'a penalty is a full service application');
  assert.equal(train.pcs.open, true, 'and the load comes off');
  run(train, path, 60);
  assert.ok(Math.abs(train.speed) < 0.1, `did not stop the train: ${train.speed} m/s`);
});

test('moving any control answers the alerter', () => {
  const path = straight(level());
  const train = manned({ position: 200, template: 'balanced', carCount: 4, speed: 15 });
  for (let i = 0; i < 6; i++) {
    run(train, path, DEFAULT_CAB.alerterSeconds - 3);
    // An engineer working the train is by definition awake.
    train.independent = train.independent > 0 ? 0 : 0.1;
    run(train, path, 0.02);
    assert.equal(train.alerter.state, 'quiet', `asked on round ${i}`);
  }
});

test('the reset button answers it, but does not undo a penalty', () => {
  const path = straight(level());
  const train = manned({ position: 200, template: 'balanced', carCount: 4, speed: 15 });
  run(train, path, DEFAULT_CAB.alerterSeconds + 1);
  assert.equal(train.alerter.state, 'asking');
  train.acknowledge();
  assert.equal(train.alerter.state, 'quiet');

  run(train, path, DEFAULT_CAB.alerterSeconds + DEFAULT_CAB.alerterWarningSeconds + 1);
  assert.equal(train.alerter.state, 'penalty');
  train.acknowledge();
  assert.equal(train.alerter.state, 'penalty', 'the button is not a way out of one');
  assert.equal(train.pcs.open, true);
});

test('a standing train set and centred is not watched by the alerter', () => {
  const path = straight(level());
  const train = manned({ position: 200, template: 'balanced', carCount: 4 });
  train.setAndCentre();
  run(train, path, 120);
  assert.equal(train.alerter.state, 'quiet');
  assert.equal(train.brake, 0);
});

// ── The PCS ────────────────────────────────────────────────────────────────

test('an emergency application opens the PCS and the throttle stops working', () => {
  const path = straight(level());
  const train = new Train({
    position: 400,
    template: 'balanced',
    carCount: 6,
    speed: 10,
    alerter: { enabled: false },
  });
  train.emergencyBrake();
  run(train, path, 3);
  assert.equal(train.pcs.open, true);
  assert.equal(train.pcs.reason, 'emergency');
  assert.equal(train.throttle, 0, 'the handle is knocked back to idle');

  // Try to power out of it. Nothing doing.
  train.throttle = 1;
  run(train, path, 20);
  assert.equal(train.pcs.open, true, 'and it will not reset while the throttle is out');
  assert.ok(train.speed < 2, `still making power at ${train.speed} m/s`);
});

test('the PCS resets once the throttle is closed and the emergency has cleared', () => {
  const path = straight(level());
  const train = new Train({
    position: 400,
    template: 'balanced',
    carCount: 6,
    speed: 10,
    alerter: { enabled: false },
  });
  train.emergencyBrake();
  run(train, path, 2);
  assert.equal(train.pcs.open, true);

  train.throttle = 0;
  train.brake = 0;
  // Long enough for the pipe to recharge and the emergency to lift, then the
  // PCS times out on top of that.
  run(train, path, 90);
  assert.equal(train.emergency, false);
  assert.equal(train.pcs.open, false);

  train.reverser = 'forward';
  train.throttle = 1;
  run(train, path, 20);
  assert.ok(train.speed > 1, 'and the engine will pull again');
});

test('recovering from a penalty takes suppression, not just idle', () => {
  const path = straight(level());
  const train = manned({ position: 400, template: 'balanced', carCount: 4, speed: 15 });
  run(train, path, DEFAULT_CAB.alerterSeconds + DEFAULT_CAB.alerterWarningSeconds + 1);
  assert.equal(train.alerter.state, 'penalty');

  // Releasing straight away is what an engineer reaches for and it does not work.
  train.brake = 0;
  run(train, path, DEFAULT_CAB.pcsResetSeconds * 2);
  assert.equal(train.pcs.open, true, 'released out of the penalty and it held');

  // The handle into suppression, and wait.
  train.brake = 1;
  run(train, path, DEFAULT_CAB.pcsResetSeconds + 1);
  assert.equal(train.pcs.open, false);
  assert.equal(train.alerter.state, 'quiet');
});

// ── The air flow indicator ─────────────────────────────────────────────────

test('the air flow indicator reads the train, not the gauge in the cab', () => {
  const path = straight(level());
  const tight = new Train({
    position: 400,
    cars: Array.from({ length: 10 }, (_, i) =>
      i === 0 ? { type: 'locomotive' } : { type: 'boxcar', air: { leakPsiPerMin: 0.2 } },
    ),
  });
  const leaky = new Train({
    position: 400,
    cars: Array.from({ length: 10 }, (_, i) =>
      i === 0 ? { type: 'locomotive' } : { type: 'boxcar', air: { leakPsiPerMin: 3 } },
    ),
  });
  run(tight, path, 60);
  run(leaky, path, 60);
  assert.ok(tight.airFlowCfm < 60, `a tight train should sit low: ${tight.airFlowCfm.toFixed(0)}`);
  assert.ok(
    leaky.airFlowCfm > tight.airFlowCfm * 3,
    `${leaky.airFlowCfm.toFixed(0)} vs ${tight.airFlowCfm.toFixed(0)}`,
  );
  assert.equal(telemetry(leaky, path).airFlowCfm, leaky.airFlowCfm);
});

test('a recharge pins the flow, and it comes back down when the train is charged', () => {
  const path = straight(level());
  const train = new Train({ position: 400, template: 'balanced', carCount: 12, brake: 1 });
  run(train, path, 10);
  train.brake = 0;
  run(train, path, 6);
  const recharging = train.airFlowCfm;
  assert.ok(recharging > 100, `only ${recharging.toFixed(0)} CFM into an empty train`);
  run(train, path, 240);
  assert.ok(train.airFlowCfm < 60, `never settled: ${train.airFlowCfm.toFixed(0)} CFM`);
});
