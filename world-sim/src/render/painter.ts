/**
 * Depth-sorted draw list — the painter's algorithm.
 *
 * Everything drawn in the scene, terrain quads included, goes into one list
 * keyed by camera depth and is painted far-to-near. One list rather than
 * "terrain first, then things on it" because the correct answer depends on the
 * scene: a train behind a ridge must be hidden by it, and a train on the near
 * slope of the same ridge must not be. Sorting the whole list gets both, and at
 * a few thousand faces it costs nothing worth optimising.
 *
 * The known limit of painter's-algorithm sorting is interpenetrating or
 * long-thin geometry, where no single depth value is right for a face. Track
 * segments are the case that shows it, so they are emitted short — a metre or
 * two each — which makes their depth honest.
 */
import type { IsoCamera } from './camera.ts';

interface PolyItem {
  kind: 'poly';
  depth: number;
  pts: number[];
  fill: string | null;
  stroke: string | null;
  width: number;
  alpha: number;
}

interface LineItem {
  kind: 'line';
  depth: number;
  pts: number[];
  stroke: string;
  width: number;
  alpha: number;
  round: boolean;
}

interface TextItem {
  kind: 'text';
  depth: number;
  x: number;
  y: number;
  text: string;
  fill: string;
  font: string;
  align: CanvasTextAlign;
  alpha: number;
}

type Item = PolyItem | LineItem | TextItem;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export class Painter {
  private items: Item[] = [];

  constructor(readonly camera: IsoCamera) {}

  clear(): void {
    this.items.length = 0;
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * A filled polygon from world-space points. `depthBias` nudges an item toward
   * the camera; use it for coplanar decals (a tie on ballast) that would
   * otherwise z-fight with the surface they sit on.
   */
  polygon(
    points: readonly Vec3[],
    opts: { fill?: string; stroke?: string; width?: number; alpha?: number; depthBias?: number } = {},
  ): void {
    const pts: number[] = [];
    let depth = 0;
    for (const p of points) {
      const q = this.camera.project(p.x, p.y, p.z);
      pts.push(q.sx, q.sy);
      depth += q.depth;
    }
    if (points.length === 0) return;
    this.items.push({
      kind: 'poly',
      depth: depth / points.length - (opts.depthBias ?? 0),
      pts,
      fill: opts.fill ?? null,
      stroke: opts.stroke ?? null,
      width: opts.width ?? 1,
      alpha: opts.alpha ?? 1,
    });
  }

  /** A polyline from world-space points. */
  line(
    points: readonly Vec3[],
    opts: { stroke: string; width?: number; alpha?: number; depthBias?: number; round?: boolean },
  ): void {
    if (points.length < 2) return;
    const pts: number[] = [];
    let depth = 0;
    for (const p of points) {
      const q = this.camera.project(p.x, p.y, p.z);
      pts.push(q.sx, q.sy);
      depth += q.depth;
    }
    this.items.push({
      kind: 'line',
      depth: depth / points.length - (opts.depthBias ?? 0),
      pts,
      stroke: opts.stroke,
      width: opts.width ?? 1,
      alpha: opts.alpha ?? 1,
      round: opts.round ?? true,
    });
  }

  text(
    at: Vec3,
    text: string,
    opts: { fill?: string; font?: string; align?: CanvasTextAlign; depthBias?: number } = {},
  ): void {
    const q = this.camera.project(at.x, at.y, at.z);
    this.items.push({
      kind: 'text',
      depth: q.depth - (opts.depthBias ?? 0),
      x: q.sx,
      y: q.sy,
      text,
      fill: opts.fill ?? '#fff',
      font: opts.font ?? '11px system-ui, sans-serif',
      align: opts.align ?? 'center',
      alpha: 1,
    });
  }

  /** Sort far-to-near and paint. Leaves the list empty. */
  flush(ctx: CanvasRenderingContext2D): void {
    this.items.sort((a, b) => b.depth - a.depth);
    let alpha = 1;
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'round';
    for (const item of this.items) {
      if (item.alpha !== alpha) {
        alpha = item.alpha;
        ctx.globalAlpha = alpha;
      }
      switch (item.kind) {
        case 'poly': {
          ctx.beginPath();
          ctx.moveTo(item.pts[0]!, item.pts[1]!);
          for (let i = 2; i < item.pts.length; i += 2) ctx.lineTo(item.pts[i]!, item.pts[i + 1]!);
          ctx.closePath();
          if (item.fill) {
            ctx.fillStyle = item.fill;
            ctx.fill();
          }
          if (item.stroke) {
            ctx.lineWidth = item.width;
            ctx.strokeStyle = item.stroke;
            ctx.stroke();
          }
          break;
        }
        case 'line': {
          ctx.beginPath();
          ctx.moveTo(item.pts[0]!, item.pts[1]!);
          for (let i = 2; i < item.pts.length; i += 2) ctx.lineTo(item.pts[i]!, item.pts[i + 1]!);
          ctx.lineCap = item.round ? 'round' : 'butt';
          ctx.lineWidth = item.width;
          ctx.strokeStyle = item.stroke;
          ctx.stroke();
          break;
        }
        case 'text': {
          ctx.fillStyle = item.fill;
          ctx.font = item.font;
          ctx.textAlign = item.align;
          ctx.textBaseline = 'middle';
          ctx.fillText(item.text, item.x, item.y);
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
    this.clear();
  }
}
