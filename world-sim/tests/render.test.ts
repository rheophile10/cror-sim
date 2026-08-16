/**
 * Render smoke tests against a recording canvas stub.
 *
 * There is no headless browser here, so instead of comparing pixels these
 * record the 2D context calls the renderer makes and assert on their shape:
 * that terrain, track and rolling stock all reach the canvas, that nothing is
 * drawn at a NaN coordinate (the failure mode a degenerate camera produces, and
 * one that shows up as an invisible frame rather than an error), and that the
 * painter really does sort far to near.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IsoCamera } from '../src/render/camera.ts';
import { parseHex } from '../src/render/color.ts';
import { Painter } from '../src/render/painter.ts';
import { Renderer } from '../src/render/renderer.ts';
import { World, type SceneSpec } from '../src/world.ts';

interface Recorded {
  fills: string[];
  /** `globalAlpha` at each fill, which is how a translucent decal is spotted. */
  alphas: number[];
  strokes: string[];
  points: number[][];
  texts: string[];
}

/** Enough of `CanvasRenderingContext2D` for the painter, and it remembers. */
function stubCanvas(width: number, height: number): { canvas: HTMLCanvasElement; rec: Recorded } {
  const rec: Recorded = { fills: [], alphas: [], strokes: [], points: [], texts: [] };
  let current: number[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    setTransform() {},
    fillRect() {},
    beginPath() {
      current = [];
    },
    moveTo(x: number, y: number) {
      current.push(x, y);
    },
    lineTo(x: number, y: number) {
      current.push(x, y);
    },
    closePath() {},
    fill() {
      rec.fills.push(String(ctx.fillStyle));
      rec.alphas.push(ctx.globalAlpha);
      rec.points.push([...current]);
    },
    stroke() {
      rec.strokes.push(String(ctx.strokeStyle));
      rec.points.push([...current]);
    },
    fillText(t: string) {
      rec.texts.push(t);
    },
  };
  const canvas = {
    width,
    height,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width, height, top: 0, left: 0 }),
    style: {} as CSSStyleDeclaration,
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, rec };
}

const scene: SceneSpec = {
  name: 'render test',
  terrain: {
    cols: 24,
    rows: 24,
    cellSize: 20,
    baseElevation: 2,
    features: [{ x: 12, y: 12, radius: 8, height: 55 }],
  },
  tracks: [{ id: 'main', loop: { center: [12, 12], radiusX: 9 }, maxGrade: 2 }],
  trains: [{ id: 'T1', position: 60, template: 'balanced', carCount: 4 }],
  style: { terrain: { contourInterval: 10 }, train: { labels: true } },
};

test('a full frame draws terrain, track and train without a bad coordinate', () => {
  const { canvas, rec } = stubCanvas(900, 600);
  const world = new World(scene);
  const renderer = new Renderer(canvas, world);
  renderer.render();

  assert.ok(rec.fills.length > 24 * 24, 'every terrain cell reached the canvas');
  assert.ok(rec.strokes.length > 0, 'rails and contours were stroked');
  assert.ok(rec.texts.includes('0'), 'car labels were drawn');

  for (const path of rec.points) {
    for (const v of path) assert.ok(Number.isFinite(v), `non-finite coordinate ${v}`);
  }
});

test('geometry lands inside the viewport once the camera has framed it', () => {
  const { canvas, rec } = stubCanvas(900, 600);
  const world = new World(scene);
  const renderer = new Renderer(canvas, world);
  renderer.frameAll();
  renderer.render();

  const all = rec.points.flat();
  const xs = all.filter((_, i) => i % 2 === 0);
  const ys = all.filter((_, i) => i % 2 === 1);
  // Generous bounds: the skirt hangs below the terrain, so the fit is on the
  // ground surface rather than on every face.
  assert.ok(Math.min(...xs) > -200 && Math.max(...xs) < 1100);
  assert.ok(Math.min(...ys) > -200 && Math.max(...ys) < 900);
});

test('rolling stock adds geometry to the frame', () => {
  const render = (spec: SceneSpec) => {
    const { canvas, rec } = stubCanvas(900, 600);
    new Renderer(canvas, new World(spec)).render();
    return rec;
  };
  const empty = render({ ...scene, trains: [], style: {} });
  const withTrain = render({ ...scene, style: {} });
  // Four cars, each a body and an underframe, each showing three faces.
  assert.ok(
    withTrain.fills.length - empty.fills.length >= 4 * 2 * 3,
    `only ${withTrain.fills.length - empty.fills.length} extra faces for a four-car train`,
  );
});

test('the painter paints far to near, whatever order it was given', () => {
  const cam = new IsoCamera({ yaw: 0, pitch: 30, zoom: 1, focus: { x: 0, y: 0, z: 0 } });
  cam.width = 400;
  cam.height = 300;
  const painter = new Painter(cam);
  const quad = (y: number, fill: string) =>
    painter.polygon(
      [
        { x: -1, y, z: 0 },
        { x: 1, y, z: 0 },
        { x: 1, y: y + 1, z: 0 },
        { x: -1, y: y + 1, z: 0 },
      ],
      { fill },
    );
  // Pushed nearest first; yaw 0 looks toward +y, so larger y is farther away.
  quad(0, '#near');
  quad(100, '#far');
  quad(50, '#mid');

  const { canvas, rec } = stubCanvas(400, 300);
  const ctx = canvas.getContext('2d')!;
  painter.flush(ctx);
  assert.deepEqual(rec.fills, ['#far', '#mid', '#near']);
  assert.equal(painter.size, 0, 'flushing empties the list');
});

test('rendering is stable when the camera is laid flat or pointed straight down', () => {
  for (const pitch of [5, 89]) {
    const { canvas, rec } = stubCanvas(600, 400);
    const world = new World(scene);
    const renderer = new Renderer(canvas, world, { camera: { pitch } });
    renderer.render();
    assert.ok(rec.fills.length > 0, `nothing drawn at pitch ${pitch}`);
    for (const path of rec.points) {
      for (const v of path) assert.ok(Number.isFinite(v), `non-finite at pitch ${pitch}`);
    }
  }
});


test('a signal draws one lamp per head, lit or not', () => {
  const { canvas, rec } = stubCanvas(900, 600);
  const world = new World({
    terrain: { cols: 60, rows: 20, cellSize: 12, baseElevation: 3 },
    tracks: [{ id: 'main', points: [[2, 10], [30, 10], [58, 10]], spacing: 3 }],
    signals: [{ id: 'S1', track: 'main', at: 300, facing: 'up', aspect: 'Clear' }],
    style: { terrain: { skirt: false } },
  });
  const renderer = new Renderer(canvas, world);
  renderer.render();

  const aspect = world.signals[0]!.aspect;
  assert.equal(aspect.lamps.length, 3, 'Clear is green over red over red');
  // Lamp discs are ten-sided, which is a shape nothing else in the scene draws.
  const discs = rec.points.filter((p) => p.length === 20).length;
  assert.equal(discs, aspect.lamps.length, `drew ${discs} lamps for ${aspect.lamps.length} heads`);
});

test('a flag is drawn once per colour on its staff', () => {
  const { canvas, rec } = stubCanvas(900, 600);
  const world = new World({
    terrain: { cols: 60, rows: 20, cellSize: 12, baseElevation: 3 },
    tracks: [{ id: 'main', points: [[2, 10], [30, 10], [58, 10]], spacing: 3 }],
    flags: [{ id: 'F1', track: 'main', at: 300, colours: ['yellow', 'red'], rule: '42' }],
    style: { terrain: { skirt: false } },
  });
  new Renderer(canvas, world).render();

  // Faces are shaded before they are filled, so the exact hex is not the one the
  // flag was given; look for something close to it instead.
  const near = (hex: string) => {
    const want = parseHex(hex);
    return rec.fills.some((f) => {
      const got = parseHex(f);
      return Math.abs(got.r - want.r) + Math.abs(got.g - want.g) + Math.abs(got.b - want.b) < 40;
    });
  };
  assert.ok(near('#e8c14a'), 'the yellow');
  assert.ok(near('#d43b30'), 'the red under it');
});

test('picking the ground inverts the projection, over sloping terrain', () => {
  const { canvas } = stubCanvas(900, 600);
  const world = new World({
    terrain: {
      cols: 60,
      rows: 60,
      cellSize: 12,
      baseElevation: 4,
      features: [{ x: 30, y: 30, radius: 18, height: 70 }],
    },
    tracks: [{ id: 'main', points: [[2, 30], [30, 30], [58, 30]], spacing: 3 }],
  });
  const renderer = new Renderer(canvas, world);
  renderer.frameAll();

  // Project points on the ground to the screen, then pick them back. The hill is
  // the interesting part: unprojecting onto a flat plane would land the pick
  // metres downhill of where the pointer actually is.
  for (const [x, y] of [[360, 360], [200, 300], [520, 420], [90, 640]] as [number, number][]) {
    const z = world.terrain.heightAt(x, y);
    const screen = renderer.camera.project(x, y, z);
    const picked = renderer.pickGround(screen.sx, screen.sy);
    assert.ok(picked, `nothing picked at ${x},${y}`);
    assert.ok(
      Math.hypot(picked!.x - x, picked!.y - y) < 2,
      `picked ${picked!.x.toFixed(0)},${picked!.y.toFixed(0)} for ${x},${y}`,
    );
  }

  // A click off the edge of the world picks nothing rather than guessing.
  assert.equal(renderer.pickGround(-500, -500), null);
});

test('a lit headlight puts a translucent beam on the ground and a lamp on the nose', () => {
  const lit = { canvas: stubCanvas(900, 600), world: new World(scene) };
  const dark = {
    canvas: stubCanvas(900, 600),
    world: new World({
      ...scene,
      trains: [{ ...scene.trains![0]!, lights: { front: 'off', rear: 'off', ditch: false } }],
    }),
  };
  for (const s of [lit, dark]) {
    const renderer = new Renderer(s.canvas.canvas, s.world);
    renderer.frameAll();
    renderer.render();
  }

  // The beam is the only thing in the scene drawn at a low alpha, so counting
  // translucent fills is a direct test of "is the headlight drawn".
  const faint = (rec: { alphas: number[] }) => rec.alphas.filter((a) => a > 0 && a < 0.4).length;
  assert.ok(faint(lit.canvas.rec) >= 6, `no beam: ${faint(lit.canvas.rec)} translucent fills`);
  assert.equal(faint(dark.canvas.rec), 0, 'lights off draws no beam at all');

  // And it is a decal on the ground, not light: nothing about the rest of the
  // frame changes when the headlight is switched off except those fills.
  assert.ok(lit.canvas.rec.fills.length > dark.canvas.rec.fills.length);
  for (const path of lit.canvas.rec.points) {
    for (const v of path) assert.ok(Number.isFinite(v), `non-finite coordinate ${v}`);
  }
});
