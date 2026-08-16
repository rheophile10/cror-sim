/**
 * Orthographic isometric camera.
 *
 * Two angles and a scale. `yaw` spins the world about the vertical axis;
 * `pitch` is the camera's elevation above the horizon, and the projection
 * degenerates correctly at both ends — 90° is a plan view where height does
 * nothing, 0° is an elevation where northing does nothing. Classic 2:1 "video
 * game isometric" is pitch ≈ 30°, where a unit of northing is half a unit on
 * screen. Nothing here is hard-coded to 30°, because being able to lay the
 * camera down and read a grade off the screen is worth more than a look.
 *
 * The projection, for a point relative to the camera's focus:
 *
 *     rx =  x·cos θy − y·sin θy          (yaw)
 *     ry =  x·sin θy + y·cos θy
 *     sx =  rx·zoom
 *     sy = −(ry·sin θp + z·cos θp)·zoom
 *     depth = ry·cos θp − z·sin θp
 *
 * `depth` is distance along the view direction, so painting in *decreasing*
 * depth is a painter's algorithm: far things first. It is what makes a hill
 * hide the train behind it without a z-buffer.
 */
import { clamp } from '../units.ts';

export interface Projected {
  /** Screen x, pixels, origin top-left. */
  sx: number;
  /** Screen y, pixels, downward. */
  sy: number;
  /** Distance along the view direction; larger is farther from the camera. */
  depth: number;
}

export interface CameraOptions {
  /** Yaw in degrees, counter-clockwise. */
  yaw?: number;
  /** Elevation above the horizon, degrees. 90 is straight down. */
  pitch?: number;
  /** Pixels per metre. */
  zoom?: number;
  /** World point the camera looks at. */
  focus?: { x: number; y: number; z: number };
}

export class IsoCamera {
  yaw: number;
  pitch: number;
  zoom: number;
  focus: { x: number; y: number; z: number };
  /** Viewport size in CSS pixels. Kept in sync by the renderer. */
  width = 800;
  height = 600;
  /** Screen-space pan, pixels, applied after projection. */
  panX = 0;
  panY = 0;

  private cosY = 1;
  private sinY = 0;
  private cosP = 1;
  private sinP = 0;

  constructor(opts: CameraOptions = {}) {
    this.yaw = opts.yaw ?? 45;
    this.pitch = opts.pitch ?? 30;
    this.zoom = opts.zoom ?? 3;
    this.focus = opts.focus ?? { x: 0, y: 0, z: 0 };
    this.refresh();
  }

  /** Recompute the trig cache. Call after touching `yaw` or `pitch` directly. */
  refresh(): void {
    // Clamped short of the poles: at exactly 0° the depth ordering loses its
    // vertical term and coplanar faces start to flicker.
    this.pitch = clamp(this.pitch, 4, 89.5);
    this.zoom = clamp(this.zoom, 0.05, 200);
    const y = (this.yaw * Math.PI) / 180;
    const p = (this.pitch * Math.PI) / 180;
    this.cosY = Math.cos(y);
    this.sinY = Math.sin(y);
    this.cosP = Math.cos(p);
    this.sinP = Math.sin(p);
  }

  project(x: number, y: number, z: number): Projected {
    const dx = x - this.focus.x;
    const dy = y - this.focus.y;
    const dz = z - this.focus.z;
    const rx = dx * this.cosY - dy * this.sinY;
    const ry = dx * this.sinY + dy * this.cosY;
    return {
      sx: this.width / 2 + rx * this.zoom + this.panX,
      sy: this.height / 2 - (ry * this.sinP + dz * this.cosP) * this.zoom + this.panY,
      depth: ry * this.cosP - dz * this.sinP,
    };
  }

  /**
   * Inverse of `project` onto a horizontal plane at height `z`. Used for
   * pointer picking and for keeping the point under the cursor fixed while
   * zooming, which is the difference between a camera that feels attached to
   * the world and one that does not.
   */
  unproject(sx: number, sy: number, z = 0): { x: number; y: number } {
    const rx = (sx - this.width / 2 - this.panX) / this.zoom;
    const dz = z - this.focus.z;
    const ry = (-(sy - this.height / 2 - this.panY) / this.zoom - dz * this.cosP) / this.sinP;
    return {
      x: this.focus.x + rx * this.cosY + ry * this.sinY,
      y: this.focus.y - rx * this.sinY + ry * this.cosY,
    };
  }

  /**
   * Unit vector pointing from the camera into the scene, in world space. A face
   * is visible when its outward normal has a negative dot product with this,
   * which is how the box renderers cull their hidden faces without a z-buffer.
   */
  viewDirection(): { x: number; y: number; z: number } {
    return { x: this.cosP * this.sinY, y: this.cosP * this.cosY, z: -this.sinP };
  }

  /** Direction of the sun, for Lambert shading. Fixed relative to the world. */
  static readonly LIGHT = { x: -0.45, y: -0.35, z: 0.82 };

  orbit(degrees: number): void {
    this.yaw = (this.yaw + degrees) % 360;
    this.refresh();
  }

  tilt(degrees: number): void {
    this.pitch += degrees;
    this.refresh();
  }

  /** Zoom by a factor, keeping the world point under `(sx, sy)` in place. */
  zoomBy(factor: number, sx?: number, sy?: number): void {
    if (sx === undefined || sy === undefined) {
      this.zoom *= factor;
      this.refresh();
      return;
    }
    const before = this.unproject(sx, sy, this.focus.z);
    this.zoom *= factor;
    this.refresh();
    const after = this.unproject(sx, sy, this.focus.z);
    this.focus.x += before.x - after.x;
    this.focus.y += before.y - after.y;
  }

  /** Drag the world by a screen-space delta. */
  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
  }

  /**
   * Frame a footprint: centre on it and pick a zoom that fits, with a margin.
   * `heightSpan` is included because a tall landscape needs more screen height
   * than its plan extent suggests.
   */
  frame(
    box: { minX: number; minY: number; maxX: number; maxY: number; minZ: number; maxZ: number },
    margin = 0.9,
  ): void {
    this.focus = {
      x: (box.minX + box.maxX) / 2,
      y: (box.minY + box.maxY) / 2,
      z: (box.minZ + box.maxZ) / 2,
    };
    this.panX = 0;
    this.panY = 0;
    const w = box.maxX - box.minX;
    const d = box.maxY - box.minY;
    const h = box.maxZ - box.minZ;
    // Extent of the projected bounding box, worst case over the yaw already set.
    const spanX = Math.abs(w * this.cosY) + Math.abs(d * this.sinY);
    const spanY = (Math.abs(w * this.sinY) + Math.abs(d * this.cosY)) * this.sinP + h * this.cosP;
    this.zoom = Math.min(this.width / Math.max(1e-6, spanX), this.height / Math.max(1e-6, spanY)) * margin;
    this.refresh();
  }
}
