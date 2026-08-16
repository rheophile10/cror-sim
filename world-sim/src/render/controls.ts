/**
 * Pointer and keyboard control of the camera.
 *
 * Drag pans, drag with the right button (or shift, or two fingers) orbits and
 * tilts, wheel zooms about the cursor. Zooming about the cursor rather than the
 * screen centre is the one thing here that matters: it is what makes the terrain
 * feel like a thing you are handling rather than a picture being scaled.
 *
 * Returns a detach function. Anything holding a renderer across a hot reload
 * needs it, and forgetting to call it is how you end up with two cameras
 * fighting over one canvas.
 */
import type { IsoCamera } from './camera.ts';

export interface ControlOptions {
  /** Called after any change, so the host can schedule a redraw. */
  onChange?: () => void;
  /** Degrees of yaw per pixel dragged. */
  orbitSpeed?: number;
  /** Degrees of pitch per pixel dragged. */
  tiltSpeed?: number;
  /** Zoom factor per wheel notch. */
  zoomStep?: number;
  /** Disable keyboard bindings. */
  keyboard?: boolean;
}

export function attachCameraControls(
  canvas: HTMLCanvasElement,
  camera: IsoCamera,
  opts: ControlOptions = {},
): () => void {
  const onChange = opts.onChange ?? (() => {});
  const orbitSpeed = opts.orbitSpeed ?? 0.4;
  const tiltSpeed = opts.tiltSpeed ?? 0.25;
  const zoomStep = opts.zoomStep ?? 1.12;

  let dragging: 'pan' | 'orbit' | null = null;
  let lastX = 0;
  let lastY = 0;
  let pointerId: number | null = null;

  const pointerPos = (e: PointerEvent | WheelEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const down = (e: PointerEvent) => {
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    dragging = e.button === 2 || e.shiftKey || e.ctrlKey ? 'orbit' : 'pan';
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = dragging === 'pan' ? 'grabbing' : 'move';
  };

  const move = (e: PointerEvent) => {
    if (dragging === null || e.pointerId !== pointerId) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (dragging === 'pan') camera.panBy(dx, dy);
    else {
      camera.orbit(-dx * orbitSpeed);
      camera.tilt(-dy * tiltSpeed);
    }
    onChange();
  };

  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    dragging = null;
    pointerId = null;
    canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = 'grab';
  };

  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = pointerPos(e);
    camera.zoomBy(e.deltaY < 0 ? zoomStep : 1 / zoomStep, p.x, p.y);
    onChange();
  };

  const context = (e: Event) => e.preventDefault();

  const key = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'q':
      case '[':
        camera.orbit(-15);
        break;
      case 'e':
      case ']':
        camera.orbit(15);
        break;
      case '-':
      case '_':
        camera.zoomBy(1 / zoomStep);
        break;
      case '=':
      case '+':
        camera.zoomBy(zoomStep);
        break;
      case 'PageUp':
        camera.tilt(5);
        break;
      case 'PageDown':
        camera.tilt(-5);
        break;
      default:
        return;
    }
    onChange();
  };

  canvas.style.cursor = 'grab';
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('contextmenu', context);
  if (opts.keyboard !== false) window.addEventListener('keydown', key);

  return () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
    canvas.removeEventListener('wheel', wheel);
    canvas.removeEventListener('contextmenu', context);
    window.removeEventListener('keydown', key);
  };
}
