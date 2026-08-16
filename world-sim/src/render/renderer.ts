/**
 * Canvas renderer: one `render()` draws the whole world.
 *
 * It owns a camera and a painter and nothing else — no animation loop, no
 * input handling, no state. Whoever calls `render()` decides when, which keeps
 * the renderer usable from a `requestAnimationFrame` loop, from a test, or from
 * a one-shot screenshot without any of them fighting over a schedule.
 */
import type { World } from '../world.ts';
import { IsoCamera, type CameraOptions } from './camera.ts';
import { drawNetwork, drawObstructions } from './network.ts';
import { drawPeople } from './person.ts';
import { drawFlags, drawSignals } from './signals.ts';
import { drawScenery } from './scenery.ts';
import { Painter } from './painter.ts';
import { drawTerrain } from './terrain.ts';
import { drawTrack } from './track.ts';
import { drawTrain } from './train.ts';
import { drawLights } from './lights.ts';
import { drawCrossings } from './crossings.ts';
import { drawBridges } from './bridge.ts';
import { drawWildlife } from './wildlife.ts';

export interface RendererOptions {
  camera?: CameraOptions;
  /** Overrides the scene's own style block. */
  background?: string;
}

export class Renderer {
  readonly camera: IsoCamera;
  readonly painter: Painter;
  private readonly ctx: CanvasRenderingContext2D;
  /** Faces drawn on the last frame, for a stats readout. */
  lastFaceCount = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    public world: World,
    opts: RendererOptions = {},
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('world-sim: canvas 2d context unavailable');
    this.ctx = ctx;
    this.camera = new IsoCamera({ ...world.camera, ...opts.camera });
    this.painter = new Painter(this.camera);
    this.resize();
    if (world.camera.zoom === undefined && opts.camera?.zoom === undefined) {
      this.camera.frame(world.bounds());
    }
  }

  /**
   * Match the drawing buffer to the element's CSS size and the display's pixel
   * ratio. Called from `render()`, so a resized window needs no listener; the
   * next frame picks it up.
   */
  resize(): void {
    const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round((rect.width || this.canvas.width) * dpr));
    const h = Math.max(1, Math.round((rect.height || this.canvas.height) * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.camera.width = w / dpr;
    this.camera.height = h / dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Point the camera at the whole terrain. */
  frameAll(): void {
    this.camera.frame(this.world.bounds());
  }

  /**
   * Which point on the ground a screen position is over.
   *
   * `IsoCamera.unproject` inverts the projection onto a *horizontal plane*, and
   * the ground is not one. So this iterates: unproject at a guessed height,
   * sample the terrain there, unproject again at that height.
   *
   * Convergence is linear and its rate is roughly the ground slope over the
   * tangent of the camera pitch, so a flat field settles in one round and a
   * hillside takes several. Six is enough to get within centimetres on anything
   * a train could climb, and it is six height-field lookups per click.
   *
   * Returns null for a click that misses the terrain entirely, which is most of
   * the screen when the landscape is framed.
   */
  pickGround(screenX: number, screenY: number): { x: number; y: number; z: number } | null {
    const terrain = this.world.terrain;
    let z = this.camera.focus.z;
    let point = this.camera.unproject(screenX, screenY, z);
    for (let i = 0; i < 6; i++) {
      const clampedX = Math.min(Math.max(point.x, 0), terrain.width);
      const clampedY = Math.min(Math.max(point.y, 0), terrain.depth);
      z = terrain.heightAt(clampedX, clampedY);
      point = this.camera.unproject(screenX, screenY, z);
    }
    if (!terrain.contains(point.x, point.y)) return null;
    return { x: point.x, y: point.y, z: terrain.heightAt(point.x, point.y) };
  }

  /** Centre the camera on a point without changing zoom or angles. */
  lookAt(x: number, y: number, z: number): void {
    this.camera.focus = { x, y, z };
    this.camera.panX = 0;
    this.camera.panY = 0;
  }

  render(): void {
    this.resize();
    const style = this.world.style;
    const bg = style.background ?? '#0d1013';
    this.ctx.fillStyle = bg;
    this.ctx.fillRect(0, 0, this.camera.width, this.camera.height);

    // Things standing on the ground are sorted against terrain quads a whole
    // cell across, so they need a depth bias of roughly that size to stay on
    // top of the ground they rest on. A scene can override it; most should not.
    const bias = this.world.terrain.cellSize;

    drawTerrain(this.painter, this.world.terrain, style.terrain);
    drawScenery(this.painter, this.world.scenery, { depthBias: bias, ...style.scenery });
    // Bridges before the track they carry: the deck has to sort behind the
    // rails sitting on it, not in front of them.
    drawBridges(this.painter, this.world.bridges, { depthBias: bias, ...style.bridge });
    for (const track of this.world.tracks) {
      drawTrack(this.painter, track, { depthBias: bias, ...style.track });
    }
    // Crossings before the obstructions on them: a car stalled on a crossing is
    // an obstruction, and it must not be hidden by its own deck.
    drawCrossings(this.painter, this.world.crossings, this.world.time, {
      depthBias: bias,
      ...style.crossings,
    });
    drawObstructions(this.painter, this.world.obstructions, this.world.network.tracks, {
      depthBias: bias,
      ...style.network,
    });
    for (const train of this.world.trains) {
      const route = train.route;
      if (!route) continue;
      // Beams before the equipment that casts them, so a lamp face is never
      // sorted behind its own decal.
      drawLights(this.painter, train, route, this.world.terrain, this.world.time, {
        depthBias: bias,
        ...style.lights,
      });
      drawTrain(this.painter, train, route, { depthBias: bias, ...style.train });
    }
    // Switch stands last of the fixed plant: they are small, they are what you
    // look for, and they must not be lost behind the ballast beside them.
    drawNetwork(this.painter, this.world.network, { depthBias: bias, ...style.network });
    drawFlags(this.painter, this.world.flags, { depthBias: bias, ...style.signals });
    // People last: they are small, they are what you are looking for, and a
    // figure lost behind a boxcar is a figure you cannot command.
    // Animals with the people: both are small, both are what you are looking
    // for, and a bear lost behind a boxcar is a bear you walk into.
    drawWildlife(this.painter, this.world.animals, { depthBias: bias, ...style.wildlife });
    drawPeople(this.painter, this.world.people, { depthBias: bias, ...style.people });
    drawSignals(this.painter, this.world.signals, this.world.time, {
      depthBias: bias,
      ...style.signals,
    });
    this.lastFaceCount = this.painter.size;
    this.painter.flush(this.ctx);
  }
}
