/**
 * The one page: load a scene, render it, drive the train in it.
 *
 * Everything of substance lives in `world-sim`. This file is the wiring — it
 * owns the animation loop, the DOM, and nothing else. Kept that way on purpose:
 * the library has to be usable from something that is not this page (a test, a
 * headless render, the CROR rules simulation later), and the way to keep that
 * true is to never let simulation logic drift into the UI.
 */
import {
  attachCameraControls,
  HORN_SIGNALS,
  hornSounding,
  Renderer,
  task,
  World,
  kgToTonnes,
  mpsToMph,
  type SceneSpec,
} from 'world-sim';
import { Sound } from './sound';
import { drawSignalCard, SignalTest, type Deck } from './flashcards';
import deckJson from '../decks/signals.json';
import './app.css';

/** Scenes are inlined at build time, so the built page needs no network. */
const sceneFiles = import.meta.glob('../scenes/*.json', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

interface SceneEntry {
  key: string;
  name: string;
  json: string;
}

const scenes: SceneEntry[] = Object.entries(sceneFiles)
  .map(([path, json]) => {
    const key = path.split('/').pop()!.replace('.json', '');
    let name = key;
    try {
      name = (JSON.parse(json) as SceneSpec).name ?? key;
    } catch {
      /* a malformed scene still gets listed, under its filename */
    }
    return { key, name, json };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>('view');
const el = {
  scene: $<HTMLSelectElement>('scene'),
  play: $<HTMLButtonElement>('play'),
  rate: $<HTMLSelectElement>('rate'),
  reset: $<HTMLButtonElement>('reset'),
  fit: $<HTMLButtonElement>('fit'),
  follow: $<HTMLButtonElement>('follow'),
  rotateL: $<HTMLButtonElement>('rotateL'),
  rotateR: $<HTMLButtonElement>('rotateR'),
  toggleJson: $<HTMLButtonElement>('toggleJson'),
  viewMenu: $<HTMLButtonElement>('viewMenu'),
  viewPanel: $<HTMLDivElement>('viewPanel'),
  showTelemetry: $<HTMLInputElement>('showTelemetry'),
  showView: $<HTMLInputElement>('showView'),
  worldMenu: $<HTMLButtonElement>('worldMenu'),
  worldPanel: $<HTMLDivElement>('worldPanel'),
  nMoose: $<HTMLInputElement>('nMoose'),
  nWolves: $<HTMLInputElement>('nWolves'),
  nBears: $<HTMLInputElement>('nBears'),
  nTres: $<HTMLInputElement>('nTres'),
  nTraffic: $<HTMLInputElement>('nTraffic'),
  nMooseOut: $<HTMLOutputElement>('nMooseOut'),
  nWolvesOut: $<HTMLOutputElement>('nWolvesOut'),
  nBearsOut: $<HTMLOutputElement>('nBearsOut'),
  nTresOut: $<HTMLOutputElement>('nTresOut'),
  nTrafficOut: $<HTMLOutputElement>('nTrafficOut'),
  sea: $<HTMLInputElement>('sea'),
  seaOut: $<HTMLOutputElement>('seaOut'),
  washoutNote: $<HTMLParagraphElement>('washoutNote'),
  telemetrySection: $<HTMLElement>('telemetrySection'),
  viewSection: $<HTMLElement>('viewSection'),
  throttle: $<HTMLInputElement>('throttle'),
  throttleOut: $<HTMLOutputElement>('throttleOut'),
  brake: $<HTMLInputElement>('brake'),
  brakeOut: $<HTMLOutputElement>('brakeOut'),
  emergency: $<HTMLButtonElement>('emergency'),
  independent: $<HTMLInputElement>('independent'),
  indOut: $<HTMLOutputElement>('indOut'),
  reverser: $<HTMLSelectElement>('reverser'),
  bail: $<HTMLButtonElement>('bail'),
  dynamic: $<HTMLInputElement>('dynamic'),
  dynamicOut: $<HTMLOutputElement>('dynamicOut'),
  sand: $<HTMLButtonElement>('sand'),
  ack: $<HTMLButtonElement>('ack'),
  cabWarn: $<HTMLParagraphElement>('cabWarn'),
  speedNow: $('speedNow'),
  trackSpeed: $('trackSpeed'),
  headlight: $<HTMLSelectElement>('headlight'),
  ditch: $<HTMLButtonElement>('ditch'),
  bell: $<HTMLButtonElement>('bell'),
  sound: $<HTMLButtonElement>('sound'),
  hornRow: $<HTMLDivElement>('hornRow'),
  setCentre: $<HTMLButtonElement>('setCentre'),
  cabControls: $<HTMLElement>('cabControls'),
  alert: $<HTMLParagraphElement>('alert'),
  pitch: $<HTMLInputElement>('pitch'),
  pitchOut: $<HTMLOutputElement>('pitchOut'),
  optContours: $<HTMLInputElement>('optContours'),
  optGrid: $<HTMLInputElement>('optGrid'),
  optForces: $<HTMLInputElement>('optForces'),
  optLabels: $<HTMLInputElement>('optLabels'),
  stats: $<HTMLParagraphElement>('stats'),
  crewSection: $<HTMLElement>('crewSection'),
  crew: $<HTMLDivElement>('crew'),
  crewDoing: $<HTMLParagraphElement>('crewDoing'),
  crewActions: $<HTMLDivElement>('crewActions'),
  studyActions: $<HTMLDivElement>('studyActions'),
  testSection: $<HTMLElement>('testSection'),
  testTitle: $<HTMLElement>('testTitle'),
  testCanvas: $<HTMLCanvasElement>('testCanvas'),
  testPrompt: $<HTMLParagraphElement>('testPrompt'),
  testAnswer: $<HTMLDivElement>('testAnswer'),
  testName: $<HTMLParagraphElement>('testName'),
  testRule: $<HTMLParagraphElement>('testRule'),
  testIndication: $<HTMLParagraphElement>('testIndication'),
  testReveal: $<HTMLButtonElement>('testReveal'),
  testRight: $<HTMLButtonElement>('testRight'),
  testWrong: $<HTMLButtonElement>('testWrong'),
  testScore: $<HTMLParagraphElement>('testScore'),
  testQuit: $<HTMLButtonElement>('testQuit'),

  lvfill: $<HTMLDivElement>('lvfill'),
  jsonPanel: $<HTMLElement>('jsonPanel'),
  json: $<HTMLTextAreaElement>('json'),
  jsonErr: $<HTMLParagraphElement>('jsonErr'),
  apply: $<HTMLButtonElement>('apply'),
  download: $<HTMLButtonElement>('download'),
  importBtn: $<HTMLButtonElement>('importBtn'),
  file: $<HTMLInputElement>('file'),
  closeJson: $<HTMLButtonElement>('closeJson'),
  tel: {
    speed: $('telSpeed'),
    grade: $('telGrade'),
    curve: $('telCurve'),
    elev: $('telElev'),
    draft: $('telDraft'),
    buff: $('telBuff'),
    lv: $('telLV'),
    mass: $('telMass'),
    pipe: $('telPipe'),
    cyl: $('telCyl'),
    cylRear: $('telCylRear'),
    flow: $('telFlow'),
    dynamic: $('telDynamic'),
    wreck: $('telWreck'),
    hit: $('telHit'),
  },
};

let world: World;
let renderer: Renderer;
// ---------------------------------------------------------------------------
// The signals test.
//
// Taken at a station, because that is where you would be taking it: a crew room
// with a book. It is not a railway act and it emits no events — the conductor
// is not doing anything to the railway while they sit there — so it lives
// entirely in the app and the library knows nothing about it.

const deck = deckJson as Deck;
/** The run in progress, if the conductor is sitting a test. */
let test: SignalTest | null = null;

/** How near a person has to be to a building to be *at* it. */
function buildingAt(personId: string | null) {
  const person = personId ? world.person(personId) : undefined;
  if (!person || person.posture !== 'on-ground') return null;
  for (const b of world.scenery.buildings) {
    if (!b.label) continue;
    // Measured to the wall rather than to the middle, so a grain elevator is
    // not harder to reach than a shed.
    // Generous: you are "at" a station from the platform, not from the door.
    const reach = person.reach + Math.max(b.width, b.depth) / 2 + 10;
    if (Math.hypot(person.x - b.x, person.y - b.y) <= reach) return b;
  }
  return null;
}

function startTest(label: string): void {
  // Seeded off the simulated clock so two runs differ, and so a run is
  // reproducible from a saved scene.
  test = new SignalTest(deck.cards, Math.floor(world.time * 1000) + 1, 20);
  el.testTitle.textContent = `Signals test · ${label}`;
  el.testSection.hidden = false;
  syncTest();
}

function endTest(): void {
  test = null;
  el.testSection.hidden = true;
}

function syncTest(): void {
  if (!test) return;
  const card = test.card;
  if (!card || test.done) {
    el.testPrompt.textContent = test.missed.length
      ? `Missed: ${[...new Set(test.missed.map((c) => c.name))].join(', ')}`
      : 'Every one of them.';
    el.testAnswer.hidden = true;
    el.testReveal.hidden = true;
    el.testRight.hidden = true;
    el.testWrong.hidden = true;
    el.testScore.textContent = `${test.right} of ${test.right + test.wrong}`;
    const ctx = el.testCanvas.getContext('2d');
    ctx?.clearRect(0, 0, el.testCanvas.width, el.testCanvas.height);
    return;
  }
  const { at, of } = test.position;
  el.testPrompt.textContent = 'Name this signal and give its indication.';
  el.testScore.textContent = `${at} of ${of} · ${test.right} right, ${test.wrong} wrong`;
  el.testAnswer.hidden = !test.revealed;
  el.testReveal.hidden = test.revealed;
  el.testRight.hidden = !test.revealed;
  el.testWrong.hidden = !test.revealed;
  if (test.revealed) {
    el.testName.textContent = card.name;
    el.testRule.textContent = `Rule ${card.rule} · ${card.form}`;
    el.testIndication.textContent = card.back;
  }
}

/**
 * What is on offer at a building, as opposed to on the railway.
 *
 * Kept apart from `World.actionsAt` on purpose: sitting a test is not a railway
 * act, it changes nothing physical, and it emits no event. Putting it in the
 * world's action list would mean the rules layer could see a conductor
 * "studying" as though it were turning a switch.
 */
let studyAt = '';
function syncStudyActions(personId: string | null): void {
  const building = test ? null : buildingAt(personId);
  const key = building?.label ?? '';
  if (key === studyAt) return;
  studyAt = key;
  el.studyActions.replaceChildren();
  if (!building) return;
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = `signals test at ${building.label}`;
  btn.title = `${deck.cards.length} cards, ${deck.edition} — twenty at a time`;
  btn.addEventListener('click', () => startTest(building.label ?? 'the station'));
  el.studyActions.append(btn);
}

/** Horn and bell. Silent until the first click; see `sound.ts`. */
const sound = new Sound();
let detachControls: (() => void) | null = null;
let detachWalk: (() => void) | null = null;
let playing = true;
let following = false;
/** The most recent impact, kept so the readout does not blink out immediately. */
let lastImpact: { what: string; closing: number; derailed: boolean } | null = null;
/** Which crew member the panels act on. */
let selected: string | null = null;
const baseHint = document.querySelector('.hint')?.textContent ?? '';
/** What was last offered, so the action buttons are not rebuilt every frame. */
let offeredSignature = '';
/** The spec the current world was built from, so Reset is exact. */
let currentSpec: SceneSpec;

function loadScene(spec: SceneSpec, keepCamera = false): void {
  const previous = renderer
    ? {
        yaw: renderer.camera.yaw,
        pitch: renderer.camera.pitch,
        zoom: renderer.camera.zoom,
        focus: { ...renderer.camera.focus },
        panX: renderer.camera.panX,
        panY: renderer.camera.panY,
      }
    : null;

  currentSpec = spec;
  world = World.fromJSON(JSON.parse(JSON.stringify(spec)) as SceneSpec);
  detachControls?.();
  renderer = new Renderer(canvas, world);

  if (keepCamera && previous) {
    Object.assign(renderer.camera, {
      yaw: previous.yaw,
      pitch: previous.pitch,
      zoom: previous.zoom,
      panX: previous.panX,
      panY: previous.panY,
    });
    renderer.camera.focus = previous.focus;
    renderer.camera.refresh();
  }

  detachWalk?.();
  detachWalk = attachWalkOnClick();
  detachControls = attachCameraControls(canvas, renderer.camera, {
    onChange: () => {
      following = false;
      el.follow.setAttribute('aria-pressed', 'false');
      syncPitch();
    },
  });

  const train = world.trains[0];
  el.throttle.value = String(Math.round((train?.throttle ?? 0) * 100));
  el.brake.value = String(Math.round((train?.brake ?? 0) * 100));
  applyStyleOptions();
  selected = world.crew[0]?.id ?? null;
  offeredSignature = '';
  buildCrewPanel();
  lastImpact = null;
  syncControlLabels();
  syncPitch();
  renderer.render();
}

/**
 * Click the ground to walk there.
 *
 * The other half of "say where, then say what": with somebody selected, a click
 * on the landscape sends them to it on foot. The click is turned into a place on
 * the *railway* — the nearest point on any track, plus however far to one side
 * the click actually was — because that is the coordinate a person lives in, and
 * because standing four metres off the main is a different thing from standing
 * on it.
 *
 * A click, not a drag: the camera controls own dragging, so this only fires when
 * the pointer barely moved between down and up. Getting that wrong would make
 * every attempt to pan the view send somebody on a walk.
 */
function attachWalkOnClick(): () => void {
  let downX = 0;
  let downY = 0;
  let downAt = 0;

  const down = (e: PointerEvent) => {
    downX = e.clientX;
    downY = e.clientY;
    downAt = performance.now();
  };

  const up = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (moved > 4 || performance.now() - downAt > 600) return;
    const person = selected ? world.person(selected) : undefined;
    if (!person) return;
    if (person.posture !== 'on-ground') {
      el.crewDoing.dataset.refused = 'true';
      el.crewDoing.textContent = 'get down first — you cannot walk off a moving car';
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const ground = renderer.pickGround(e.clientX - rect.left, e.clientY - rect.top);
    if (!ground) return;

    const near = world.nearestPointOnTrack(ground.x, ground.y);
    if (!near) return;
    const track = world.tracks.find((t) => t.id === near.track);
    if (!track) return;

    // How far to one side of that track the click actually was, signed the same
    // way `person.ts` reads an offset.
    const pt = track.at(near.at);
    const offset =
      (ground.x - pt.x) * Math.sin(pt.heading) - (ground.y - pt.y) * Math.cos(pt.heading);

    world.cancel(person.id);
    world.send(person.id, { track: near.track, at: near.at, offset });
    syncCrewPanel();
  };

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointerup', up);
  return () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointerup', up);
  };
}

/**
 * The crew panel.
 *
 * Two halves, and the split is the control scheme. The top row picks *who*; the
 * bottom row is what that person could do **from where they are standing right
 * now**, which is `World.actionsAt`. Walking somewhere is done by clicking a
 * switch in the switch panel while a person is selected — you say where, and the
 * world decides how long it takes and whether the job can be done from there.
 *
 * There is deliberately no way to make somebody act on something out of reach.
 * The refusal exists and is worth seeing, but it should be a mistake you make
 * with the API or by walking away mid-task, not one the UI hands you.
 */
function buildCrewPanel(): void {
  el.crew.replaceChildren();
  el.crewSection.hidden = false;
  updateHint();
  // Only the crew. Everybody else in a scene is there to be worked around
  // rather than commanded, which is the true situation on a railway.
  for (const person of world.crew) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.dataset.personId = person.id;
    btn.addEventListener('click', () => {
      selected = selected === person.id ? null : person.id;
      offeredSignature = '';
      syncCrewPanel();
      updateHint();
    });
    el.crew.append(btn);
  }
  syncCrewPanel();
}

/**
 * Lock the driving controls unless somebody is at them.
 *
 * Only in an embodied scene: everywhere else the control panel is the ambient
 * hand it has always been. And note what is *not* done — the throttle keeps
 * whatever value it was left at. A movement with an empty cab and the throttle
 * open is a state a real railway gets into, and it is exactly the state 62 and
 * 112 are about; hiding it would be worse than showing it.
 */
/**
 * The driving controls belong to whoever is sitting at them.
 *
 * They appear when the selected person is in a cab and vanish otherwise, which
 * is the whole point of putting them in the crew panel: a throttle is not an
 * ambient property of the simulation, it is a handle somebody's hand is on. A
 * scene with no people keeps them permanently, because there is nobody to be at
 * them and the old ambient behaviour is the only sensible one.
 */
function updateCabControls(): void {
  const person = selected ? world.person(selected) : undefined;
  const ambient = world.people.length === 0 || !world.embodied;
  const train = ambient
    ? world.trains[0]
    : person?.atControls
      ? world.trains.find((t) => t.id === person.trainId)
      : undefined;

  el.cabControls.hidden = !train;
  if (!train) return;

  el.throttle.value = String(Math.round(train.throttle * 100));
  el.brake.value = String(Math.round(train.brake * 100));
  el.independent.value = String(Math.round(train.independent * 100));
  el.dynamic.value = String(Math.round(train.dynamic * 100));
  el.reverser.value = train.reverser;
  el.sand.dataset.on = String(train.sand);
  // What you are doing against what you are allowed to do. Without the second
  // figure an aspect like "reduce to ten below permissible track speed" is not
  // an instruction, it is a riddle.
  const mph = Math.abs(mpsToMph(train.speed));
  el.speedNow.textContent = `${mph.toFixed(0)} mph`;
  el.speedNow.dataset.over = String(mph > world.trackSpeedMph + 1);
  el.trackSpeed.textContent = `${world.trackSpeedMph} mph`;
  el.headlight.value = train.lights.front;
  el.ditch.dataset.on = String(train.lights.ditch);
  el.bell.dataset.on = String(train.lights.bell);
  // A sounding runs itself out; while it does, every horn button is dead,
  // because half a Rule 14 signal is a different signal.
  for (const btn of el.hornRow.querySelectorAll<HTMLButtonElement>('button')) {
    btn.disabled = train.lights.horn !== null;
    btn.dataset.on = String(train.lights.horn?.signal.id === btn.dataset.signal);
  }
  el.ack.dataset.state = train.alerter.state;

  // The two things that take control away from the engineer, said plainly.
  // Both look identical from the seat — a handle that moves and does nothing —
  // so the reason has to be on the screen or the simulation is just broken.
  const warn = train.pcs.open
    ? train.pcs.reason === 'penalty'
      ? 'PENALTY — no power. Automatic brake to full and hold it until the PCS resets.'
      : 'PCS OPEN — no power. Throttle to idle until the pipe is back up.'
    : train.alerter.state === 'asking'
      ? 'ALERTER — answer it or it will apply the brakes.'
      : train.reverser === 'neutral'
        ? 'Reverser centred — the throttle will do nothing.'
        : '';
  el.cabWarn.hidden = warn === '';
  el.cabWarn.textContent = warn;
  el.cabWarn.dataset.state = train.pcs.open || train.alerter.state === 'penalty' ? 'bad' : 'warn';
  syncControlLabels();
}

/** The movement the driving controls act on right now, if any. */
function drivenTrain() {
  const person = selected ? world.person(selected) : undefined;
  if (world.people.length === 0 || !world.embodied) return world.trains[0];
  if (!person?.atControls) return undefined;
  return world.trains.find((t) => t.id === person.trainId);
}

/** Say what a click will do, since it depends on whether somebody is selected. */
function updateHint(): void {
  const hint = document.querySelector('.hint');
  if (!hint) return;
  const person = selected ? world.person(selected) : undefined;
  hint.textContent = person
    ? `Click the ground to send ${person.name} walking there · ${baseHint}`
    : baseHint;
}

function syncCrewPanel(): void {
  for (const btn of el.crew.querySelectorAll<HTMLButtonElement>('button')) {
    const person = world.people.find((p) => p.id === btn.dataset.personId);
    if (!person) continue;
    btn.setAttribute('aria-pressed', String(person.id === selected));
    btn.dataset.posture = person.posture;
    btn.dataset.injured = String(person.injury !== 'none');
    const where =
      person.injury !== 'none'
        ? 'injured'
        : person.posture === 'on-ground'
        ? `${person.trackId ?? '—'} ${Math.round(person.at)} m`
        : person.atControls
          ? `driving ${person.trainId}`
          : person.posture === 'in-cab'
            ? `cab of ${person.trainId}`
            : `riding ${person.trainId}`;
    btn.textContent = `${person.name} · ${where}`;
    btn.title = `${person.role} — ${where}`;
  }

  const person = selected ? world.person(selected) : undefined;
  syncStudyActions(person?.id ?? null);
  if (!person) {
    el.crewDoing.dataset.refused = 'false';
    el.crewDoing.textContent = 'nobody selected';
    el.crewActions.replaceChildren();
    offeredSignature = '';
    return;
  }

  if (person.injury !== 'none') {
    el.crewDoing.dataset.refused = 'true';
    el.crewDoing.textContent =
      person.injury === 'struck'
        ? 'struck by moving equipment — out of service'
        : 'caught between equipment — out of service';
  } else if (person.task) {
    const pct =
      person.task.duration > 0
        ? ` ${Math.round((person.task.elapsed / person.task.duration) * 100)}%`
        : '';
    const left = Math.max(0, person.task.duration - person.task.elapsed);
    el.crewDoing.dataset.refused = 'false';
    el.crewDoing.textContent = `${person.task.label}${pct} · ${fmt(left, 0)} s to go${
      person.queue.length > 0 ? ` (+${person.queue.length} queued)` : ''
    }`;
  } else if (person.lastRefusal) {
    el.crewDoing.dataset.refused = 'true';
    el.crewDoing.textContent = `refused: ${person.lastRefusal}`;
  } else {
    el.crewDoing.dataset.refused = 'false';
    el.crewDoing.textContent = 'standing by';
  }

  // Rebuilt only when the offered set changes, so the buttons do not flicker
  // out from under the pointer every frame.
  const actions = world.actionsAt(person.id);
  if (person.task || person.queue.length > 0) {
    actions.unshift({ kind: 'wait', target: '', label: 'stop what you are doing' });
  }
  const signature = actions.map((a) => `${a.kind}:${a.target}`).join('|');
  if (signature === offeredSignature) return;
  offeredSignature = signature;
  el.crewActions.replaceChildren(
    ...actions.map((action) => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = action.label;
      btn.title = action.label;
      btn.addEventListener('click', () => {
        if (action.kind === 'wait' && action.target === '') {
          world.cancel(person.id);
        } else {
          world.assign(person.id, task(action.kind, { target: action.target, label: action.label }));
        }
        offeredSignature = '';
        syncCrewPanel();
      });
      return btn;
    }),
  );
}


/** Style toggles write straight into the world's style block. */
function applyStyleOptions(): void {
  const s = world.style;
  s.terrain = {
    ...s.terrain,
    contourInterval: el.optContours.checked ? (s.terrain?.contourInterval ?? 20) : null,
    grid: el.optGrid.checked ? (s.terrain?.grid ?? 'rgba(0,0,0,0.18)') : null,
    // The sea is a world fact, not a drawing option — but the terrain renderer
    // already knows how to flood everything below a level, so it is told.
    waterLevel: world.seaLevel,
  };
  s.train = {
    ...s.train,
    showCouplerForces: el.optForces.checked,
    labels: el.optLabels.checked,
  };
}

function syncControlLabels(): void {
  el.throttleOut.textContent = `${el.throttle.value}%`;
  el.brakeOut.textContent = `${el.brake.value}%`;
  el.indOut.textContent = `${el.independent.value}%`;
  el.dynamicOut.textContent = `${el.dynamic.value}%`;
}

function syncPitch(): void {
  el.pitch.value = String(Math.round(renderer.camera.pitch));
  el.pitchOut.textContent = `${Math.round(renderer.camera.pitch)}°`;
}

const fmt = (n: number, digits = 1): string =>
  Number.isFinite(n) ? n.toFixed(digits) : '—';

function updateInstruments(): void {
  const train = world.trains[0];
  if (!train) return;
  const tel = world.telemetry(train);
  if (!tel) return;
  const path = world.trackFor(train)!;
  const lead = train.cars[0];

  el.tel.speed.textContent = `${fmt(Math.abs(mpsToMph(tel.speed)))} mph`;
  el.tel.grade.textContent = `${tel.grade >= 0 ? '+' : ''}${fmt(tel.grade * 100, 2)} %`;
  el.tel.curve.textContent = `${fmt(tel.curveDegrees, 1)}°`;
  el.tel.elev.textContent = `${fmt(path.at(lead ? lead.s : 0).z, 0)} m`;
  el.tel.draft.textContent = `${fmt(tel.maxDraft / 1000, 0)} kN`;
  el.tel.buff.textContent = `${fmt(tel.maxBuff / 1000, 0)} kN`;
  el.tel.lv.textContent = fmt(tel.maxLV, 2);
  el.tel.mass.textContent = `${fmt(kgToTonnes(tel.mass), 0)} t`;

  // The air, head and rear, because the difference between them *is* the
  // propagation delay and it is the thing an engineer is waiting on.
  const head = train.cars[0];
  const rear = train.cars[train.cars.length - 1];
  el.tel.pipe.textContent = head
    ? `${fmt(head.air.brakePipePsi, 0)} psi${train.emergency ? ' · EMERG' : ''}`
    : '—';
  el.tel.cyl.textContent = head ? `${fmt(head.air.cylinderPsi, 0)} psi` : '—';
  el.tel.cylRear.textContent = rear ? `${fmt(rear.air.cylinderPsi, 0)} psi` : '—';
  // 60 CFM is the number people quote, so it is worth marking when it is passed.
  el.tel.flow.textContent = `${fmt(tel.airFlowCfm, 0)} CFM`;
  el.tel.flow.dataset.state = tel.airFlowCfm > 60 ? 'warn' : 'ok';
  el.tel.dynamic.textContent =
    tel.dynamicForce > 0 ? `${fmt(tel.dynamicForce / 1000, 0)} kN` : '—';
  el.tel.wreck.textContent =
    tel.derailedCount === 0
      ? '—'
      : `${tel.derailedCount} car${tel.derailedCount === 1 ? '' : 's'}` +
        (tel.overturned > 0 ? `, ${tel.overturned} over` : '');
  el.tel.hit.textContent = lastImpact
    ? `${fmt(Math.abs(mpsToMph(lastImpact.closing)))} mph`
    : '—';

  const ratio = Math.min(1, tel.maxLV / world.physics.derailLV);
  el.lvfill.style.width = `${ratio * 100}%`;
  el.lvfill.style.background =
    ratio > 0.85 ? 'var(--danger)' : ratio > 0.6 ? 'var(--warn)' : 'var(--ok)';

  if (tel.derailed) {
    el.alert.dataset.state = 'derailed';
    el.alert.textContent = tel.reason;
  } else if (train.cars.some((c) => c.derailed)) {
    el.alert.dataset.state = 'derailed';
    el.alert.textContent = 'Equipment on the ground.';
  } else if (lastImpact && !lastImpact.derailed) {
    el.alert.dataset.state = 'warn';
    el.alert.textContent = `Struck ${lastImpact.what} at ${fmt(Math.abs(mpsToMph(lastImpact.closing)))} mph.`;
  } else if (ratio > 0.6) {
    el.alert.dataset.state = 'warn';
    el.alert.textContent = 'Lateral forces are climbing — ease off or slow down.';
  } else {
    el.alert.dataset.state = 'ok';
    el.alert.textContent = `${train.label ?? train.id} · ${train.cars.length} cars · ${fmt(train.length, 0)} m`;
  }

  el.stats.textContent = `${renderer.lastFaceCount} faces · ${fmt(world.time, 1)} s simulated · yaw ${Math.round(renderer.camera.yaw)}°`;
}

// ---------------------------------------------------------------------------
// Animation loop. Simulated time is frame time times the rate multiplier, with
// the frame delta clamped: a backgrounded tab returns with a delta of several
// seconds, and integrating that in one go would launch every train on the page.
// ---------------------------------------------------------------------------
let last = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (playing) {
    const rate = Number(el.rate.value);
    world.step(dt * rate);
    // Whichever movement the selected person is on, so you hear the horn of the
    // engine you are standing beside rather than every horn in the scene.
    const audible =
      drivenTrain() ??
      world.trains.find((t) => t.id === (selected ? world.person(selected)?.trainId : undefined)) ??
      world.trains[0];
    sound.update(
      audible ? hornSounding(audible.lights) : false,
      audible?.lights.bell ?? false,
      dt * rate,
      drivenTrain()?.alerter.state ?? 'quiet',
    );
    for (const hit of world.collisions) {
      lastImpact = { what: hit.what, closing: hit.closing, derailed: hit.derailed };
    }
    if (following) {
      const train = world.trains[0];
      const path = train ? world.trackFor(train) : undefined;
      if (train && path) {
        const p = path.at(train.cars[0]?.s ?? 0);
        renderer.lookAt(p.x, p.y, p.z);
      }
    }
  }
  renderer.render();
  updateInstruments();
  updateCabControls();
  // The card's flashing lamps run on wall-clock time, not simulated time: a
  // flashing aspect flashes at its own rate whatever the rate multiplier says.
  if (test && !test.done) {
    const card = test.card;
    const ctx = el.testCanvas.getContext('2d');
    if (card && ctx) drawSignalCard(ctx, card, now / 1000);
  }
  if (!el.worldPanel.hidden) {
    applyWorldCounts();
    syncWashoutNote();
  }
  // What a person can reach changes with every step they take.
  if (world.people.length > 0) syncCrewPanel();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
for (const s of scenes) {
  const opt = document.createElement('option');
  opt.value = s.key;
  opt.textContent = s.name;
  el.scene.append(opt);
}

const sceneByKey = new Map(scenes.map((s) => [s.key, s]));

function selectScene(key: string): void {
  const entry = sceneByKey.get(key);
  if (!entry) return;
  el.scene.value = entry.key;
  loadScene(JSON.parse(entry.json) as SceneSpec);
  el.json.value = entry.json.trim();
  el.jsonErr.textContent = '';
}

el.scene.addEventListener('change', () => {
  // The scene lives in the URL fragment, so a particular scene can be linked to
  // and reloaded into — and so the back button does something sensible.
  window.location.hash = el.scene.value;
  selectScene(el.scene.value);
});

window.addEventListener('hashchange', () => {
  const key = window.location.hash.replace('#', '');
  if (key && key !== el.scene.value) selectScene(key);
});

el.play.addEventListener('click', () => {
  playing = !playing;
  el.play.textContent = playing ? 'Pause' : 'Play';
});

el.reset.addEventListener('click', () => loadScene(currentSpec, true));

el.fit.addEventListener('click', () => {
  following = false;
  el.follow.setAttribute('aria-pressed', 'false');
  renderer.frameAll();
});

el.follow.addEventListener('click', () => {
  following = !following;
  el.follow.setAttribute('aria-pressed', String(following));
});

el.rotateL.addEventListener('click', () => renderer.camera.orbit(-15));
el.rotateR.addEventListener('click', () => renderer.camera.orbit(15));

el.pitch.addEventListener('input', () => {
  renderer.camera.pitch = Number(el.pitch.value);
  renderer.camera.refresh();
  syncPitch();
});

el.throttle.addEventListener('input', () => {
  const train = drivenTrain();
  if (train) {
    train.throttle = Number(el.throttle.value) / 100;
    if (train.throttle !== 0 && train.dynamic > 0) {
      train.dynamic = 0;
      el.dynamic.value = '0';
    }
  }
  syncControlLabels();
});

el.brake.addEventListener('input', () => {
  const train = drivenTrain();
  if (train) train.brake = Number(el.brake.value) / 100;
  syncControlLabels();
});

el.independent.addEventListener('input', () => {
  const train = drivenTrain();
  if (train) train.independent = Number(el.independent.value) / 100;
  syncControlLabels();
});

el.reverser.addEventListener('change', () => {
  const train = drivenTrain();
  if (train) train.reverser = el.reverser.value as typeof train.reverser;
});

el.dynamic.addEventListener('input', () => {
  const train = drivenTrain();
  if (train) {
    train.dynamic = Number(el.dynamic.value) / 100;
    // The same motors cannot pull and generate at once. Setting up the dynamic
    // brake closes the throttle, which is what the real interlock does.
    if (train.dynamic > 0 && train.throttle !== 0) {
      train.throttle = 0;
      el.throttle.value = '0';
    }
  }
  syncControlLabels();
});

el.sand.addEventListener('click', () => {
  const train = drivenTrain();
  if (!train) return;
  train.sand = !train.sand;
  updateCabControls();
});

el.ack.addEventListener('click', () => {
  const train = drivenTrain();
  if (!train) return;
  // Through the world rather than the train, so it is refused when nobody is in
  // the seat and recorded as an act when somebody is.
  if (!world.acknowledge(train)) train.acknowledge();
  updateCabControls();
});

// One button per Rule 14 signal. Built once: the catalogue does not change.
for (const signal of HORN_SIGNALS) {
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.dataset.signal = signal.id;
  btn.textContent = signal.name;
  btn.title = signal.meaning;
  btn.addEventListener('click', () => {
    const train = drivenTrain();
    if (train) world.sound(train, signal.id);
    updateCabControls();
  });
  el.hornRow.append(btn);
}

el.headlight.addEventListener('change', () => {
  const train = drivenTrain();
  if (!train) return;
  const to = el.headlight.value as 'bright' | 'dim' | 'off';
  if (!world.setHeadlight(train, 'front', to)) train.lights.front = to;
  updateCabControls();
});

el.ditch.addEventListener('click', () => {
  const train = drivenTrain();
  if (!train) return;
  if (!world.setDitchLights(train, !train.lights.ditch)) train.lights.ditch = !train.lights.ditch;
  updateCabControls();
});

el.bell.addEventListener('click', () => {
  const train = drivenTrain();
  if (!train) return;
  if (!world.setBell(train, !train.lights.bell)) train.lights.bell = !train.lights.bell;
  updateCabControls();
});

el.testReveal.addEventListener('click', () => {
  test?.reveal();
  syncTest();
});
el.testRight.addEventListener('click', () => {
  test?.mark(true);
  syncTest();
});
el.testWrong.addEventListener('click', () => {
  test?.mark(false);
  syncTest();
});
el.testQuit.addEventListener('click', () => {
  endTest();
  studyAt = '';
});

el.sound.addEventListener('click', () => {
  sound.unlock();
  sound.setEnabled(!sound.on);
  el.sound.dataset.on = String(sound.on);
});

el.bail.addEventListener('click', () => drivenTrain()?.bailOff());

el.setCentre.addEventListener('click', () => {
  const train = drivenTrain();
  if (!train) return;
  train.setAndCentre();
  updateCabControls();
});

el.emergency.addEventListener('click', () => {
  const train = drivenTrain();
  if (!train) return;
  train.brake = 1;
  // Dump the pipe, rather than merely raising the flag — a flag against a full
  // pipe clears itself on the next step and nothing happens at all.
  train.emergencyBrake();
  updateCabControls();
});

// The autoplay policy wants a gesture before there is any audio context at all,
// so the first click anywhere in the page is it.
document.addEventListener('pointerdown', () => sound.unlock(), { once: true });

for (const box of [el.optContours, el.optGrid, el.optForces, el.optLabels]) {
  box.addEventListener('change', applyStyleOptions);
}

// ── The View menu ─────────────────────────────────────────────────────────
//
// Telemetry and the view options are instrumentation, not part of the job. They
// are off unless asked for, so what is on screen by default is the railway and
// the controls — which is what an engineer has.
function syncViewMenu(): void {
  el.telemetrySection.hidden = !el.showTelemetry.checked;
  el.viewSection.hidden = !el.showView.checked;
}
// ── The World menu ────────────────────────────────────────────────────────
//
// How busy the country is, as five numbers. Applied by adding or taking away
// rather than by rebuilding the scene: a rebuild is two seconds and would throw
// away wherever the train had got to.
function syncWorldCounts(fromWorld = false): void {
  const census = world.census();
  if (fromWorld) {
    el.nMoose.value = String(census.moose ?? 0);
    el.nWolves.value = String(census.wolf ?? 0);
    el.nBears.value = String(census.bear ?? 0);
    el.nTres.value = String(world.people.filter((p) => p.role === 'trespasser').length);
    el.nTraffic.value = String(world.scenery.vehicles.filter((v) => !v.wrecked).length);
  }
  el.nMooseOut.textContent = el.nMoose.value;
  el.nWolvesOut.textContent = el.nWolves.value;
  el.nBearsOut.textContent = el.nBears.value;
  el.nTresOut.textContent = el.nTres.value;
  el.nTrafficOut.textContent = el.nTraffic.value;
}

/**
 * The sea, and what it has taken.
 *
 * Below the slider's floor there is no water table at all, which is a different
 * thing from a sea at zero — a scene inland has no sea, and saying so is worth
 * one position on the scale.
 */
function applySeaLevel(): void {
  const raw = Number(el.sea.value);
  world.seaLevel = raw < 0 ? null : raw;
  el.seaOut.textContent = raw < 0 ? 'off' : `${raw} m`;
  applyStyleOptions();
  syncWashoutNote();
}

function syncWashoutNote(): void {
  if (!world.trackWashedOut) {
    el.washoutNote.textContent =
      world.seaLevel === null
        ? 'No water table. Raise it and the low ground floods; raise it to the ties and the railway is gone.'
        : `Water at ${world.seaLevel} m. The railway is clear of it.`;
    el.washoutNote.dataset.state = 'ok';
    return;
  }
  const metres = world.washouts.reduce((m, x) => m + (x.to - x.from), 0);
  el.washoutNote.textContent =
    `TRACK WASHED OUT — ${world.washouts.length} ` +
    `${world.washouts.length === 1 ? 'stretch' : 'stretches'}, ${Math.round(metres)} m of railway ` +
    `in the water. Nothing on the train can see it coming.`;
  el.washoutNote.dataset.state = 'bad';
}

function applyWorldCounts(): void {
  const census = world.census();
  for (const [species, input] of [
    ['moose', el.nMoose],
    ['wolf', el.nWolves],
    ['bear', el.nBears],
  ] as const) {
    const want = Number(input.value);
    let have = census[species] ?? 0;
    // A few at a time: dragging a slider fires on every pixel, and adding
    // eighty animals in one frame is a visible stall.
    for (let i = 0; i < 6 && have < want; i++, have++) world.spawnAnimal(species);
    for (let i = 0; i < 6 && have > want; i++, have--) world.removeAnimal(species);
  }
  const wantTres = Number(el.nTres.value);
  let tres = world.people.filter((p) => p.role === 'trespasser').length;
  for (let i = 0; i < 4 && tres < wantTres; i++, tres++) world.spawnTrespasser();
  for (let i = 0; i < 4 && tres > wantTres; i++, tres--) world.removeTrespasser();

  const wantTraffic = Number(el.nTraffic.value);
  let cars = world.scenery.vehicles.filter((v) => !v.wrecked).length;
  for (let i = 0; i < 8 && cars < wantTraffic; i++, cars++) world.spawnVehicle();
  for (let i = 0; i < 8 && cars > wantTraffic; i++, cars--) world.removeVehicle();
  syncWorldCounts();
}

el.worldMenu.addEventListener('click', () => {
  const open = el.worldPanel.hidden;
  if (open) syncWorldCounts(true);
  el.worldPanel.hidden = !open;
  el.worldMenu.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => {
  if (el.worldPanel.hidden) return;
  const t = e.target as Node;
  if (el.worldPanel.contains(t) || el.worldMenu.contains(t)) return;
  el.worldPanel.hidden = true;
  el.worldMenu.setAttribute('aria-expanded', 'false');
});
el.sea.addEventListener('input', applySeaLevel);

for (const input of [el.nMoose, el.nWolves, el.nBears, el.nTres, el.nTraffic]) {
  input.addEventListener('input', () => syncWorldCounts());
  input.addEventListener('change', applyWorldCounts);
}

el.viewMenu.addEventListener('click', () => {
  const open = el.viewPanel.hidden;
  el.viewPanel.hidden = !open;
  el.viewMenu.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => {
  if (el.viewPanel.hidden) return;
  const t = e.target as Node;
  if (el.viewPanel.contains(t) || el.viewMenu.contains(t)) return;
  el.viewPanel.hidden = true;
  el.viewMenu.setAttribute('aria-expanded', 'false');
});
for (const box of [el.showTelemetry, el.showView]) box.addEventListener('change', syncViewMenu);
syncViewMenu();

el.toggleJson.addEventListener('click', () => {
  el.jsonPanel.hidden = !el.jsonPanel.hidden;
});
el.closeJson.addEventListener('click', () => {
  el.jsonPanel.hidden = true;
});

el.apply.addEventListener('click', () => {
  try {
    const spec = JSON.parse(el.json.value) as SceneSpec;
    loadScene(spec, true);
    el.jsonErr.textContent = '';
  } catch (err) {
    el.jsonErr.textContent = err instanceof Error ? err.message : String(err);
  }
});

el.download.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(world.toJSON({ state: true }), null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${world.name.toLowerCase().replace(/\s+/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

el.importBtn.addEventListener('click', () => el.file.click());

el.file.addEventListener('change', () => {
  const file = el.file.files?.[0];
  if (!file) return;
  void file.text().then((text) => {
    try {
      loadScene(JSON.parse(text) as SceneSpec);
      el.json.value = text.trim();
      el.jsonErr.textContent = '';
      el.jsonPanel.hidden = false;
    } catch (err) {
      el.jsonErr.textContent = err instanceof Error ? err.message : String(err);
      el.jsonPanel.hidden = false;
    }
  });
  el.file.value = '';
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
  if (e.key === ' ') {
    e.preventDefault();
    el.play.click();
  }
  if (e.key === 'f') el.fit.click();
});

selectScene(window.location.hash.replace('#', '') || scenes[0]?.key || '');
requestAnimationFrame(frame);
