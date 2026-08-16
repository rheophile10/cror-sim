/**
 * Signals and flags, drawn so the aspect is the thing you read.
 *
 * A signal mast is nearly all structure and almost no information: the whole
 * message is in two or three lamps the size of a dinner plate, on a mast twenty
 * feet up, seen from a kilometre away. So the lamps are drawn deliberately
 * oversized for the scale — a lamp at true size would be a single pixel at any
 * zoom where you can also see the train — and everything else is kept thin and
 * dark so it does not compete.
 *
 * Unlit heads are drawn too, dark. A three-head mast showing one lamp is a
 * different object from a one-head mast showing the same lamp, and on a
 * signalled railway the number of heads is half of what tells you what kind of
 * signal you are looking at.
 *
 * Flashing aspects flash. The catalogue spells them out ('flashing yellow'),
 * the phase comes from simulated time, and a still frame catches them mid-cycle
 * — which is worth knowing when reading a screenshot rather than the screen.
 */
import type { Flag, Signal } from '../signals.ts';
import { paintBox, paintFace } from './solid.ts';
import type { Painter, Vec3 } from './painter.ts';

export interface SignalStyle {
  ambient?: number;
  mastColor?: string;
  /** Radius of a lamp, metres. Not to scale, on purpose. */
  lampRadius?: number;
  /** Height of the lowest lamp above the railhead on a high mast, metres. */
  highMast?: number;
  lowMast?: number;
  dwarfMast?: number;
  /** How far to the side of the centre line the mast stands, metres. */
  offset?: number;
  /** Draw the aspect name beside the signal. */
  labels?: boolean;
  /** Flashes per second. */
  flashRate?: number;
  depthBias?: number;
}

export const DEFAULT_SIGNAL_STYLE: Required<SignalStyle> = {
  ambient: 0.55,
  mastColor: '#33383e',
  lampRadius: 1.15,
  highMast: 6.4,
  lowMast: 3.0,
  dwarfMast: 1.1,
  offset: 4.2,
  labels: false,
  flashRate: 1.1,
  depthBias: 0,
};

const LAMP_COLORS: Record<string, string> = {
  red: '#e2483d',
  green: '#3fc06a',
  yellow: '#e8c14a',
  lunar: '#dfe6ee',
  white: '#dfe6ee',
};

/** A lamp that is not lit: still there, still round, just dark. */
const DARK = '#2a2e33';

function lampColor(spec: string, time: number, rate: number): string {
  const flashing = spec.startsWith('flashing ');
  const base = LAMP_COLORS[flashing ? spec.slice(9) : spec] ?? DARK;
  if (!flashing) return base;
  return Math.sin(time * Math.PI * 2 * rate) > 0 ? base : DARK;
}

/**
 * A lamp: a flat disc facing the way the signal faces.
 *
 * Drawn as a polygon rather than shaded as a solid, and lit at full brightness
 * regardless of where the sun is, because a signal lamp is a light source. A
 * red that goes dim on the shaded side of a mast is a red you misread.
 */
function paintLamp(
  painter: Painter,
  centre: Vec3,
  heading: number,
  radius: number,
  color: string,
  depthBias: number,
): void {
  const sides = 10;
  const rx = Math.sin(heading);
  const ry = -Math.cos(heading);
  const pts: Vec3[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    pts.push({
      x: centre.x + rx * Math.cos(a) * radius,
      y: centre.y + ry * Math.cos(a) * radius,
      z: centre.z + Math.sin(a) * radius,
    });
  }
  painter.polygon(pts, { fill: color, depthBias });
}

export function drawSignals(
  painter: Painter,
  signals: readonly Signal[],
  time: number,
  style: SignalStyle = {},
): void {
  const st = { ...DEFAULT_SIGNAL_STYLE, ...style };

  for (const signal of signals) {
    const side = signal.side === 'left' ? -1 : 1;
    const nx = Math.sin(signal.heading) * st.offset * side;
    const ny = -Math.cos(signal.heading) * st.offset * side;
    const x = signal.x + nx;
    const y = signal.y + ny;

    const base =
      signal.mast === 'high' ? st.highMast : signal.mast === 'low' ? st.lowMast : st.dwarfMast;
    const lamps = signal.aspect.lamps;
    const spacing = st.lampRadius * 2.5;
    const topZ = signal.z + base + spacing * Math.max(0, lamps.length - 1);

    // Mast and a foundation, kept slim: the lamps carry the message.
    paintBox(painter, x, y, signal.z - 0.3, 0.55, 0.55, topZ - signal.z + 0.8, signal.heading, st.mastColor, {
      ambient: st.ambient,
      depthBias: st.depthBias + 2,
    });

    // Backing board behind the heads, so a lamp reads against the landscape.
    const boardHalf = st.lampRadius * 1.45;
    const bx = Math.sin(signal.heading) * boardHalf;
    const by = -Math.cos(signal.heading) * boardHalf;
    const boardTop = topZ + st.lampRadius * 1.3;
    const boardBottom = signal.z + base - st.lampRadius * 1.3;
    paintFace(
      painter,
      [
        { x: x - bx, y: y - by, z: boardBottom },
        { x: x + bx, y: y + by, z: boardBottom },
        { x: x + bx, y: y + by, z: boardTop },
        { x: x - bx, y: y - by, z: boardTop },
      ],
      '#1c2024',
      { ambient: 0.9, noCull: true, depthBias: st.depthBias + 2.5 },
    );

    lamps.forEach((spec, i) => {
      const z = topZ - i * spacing;
      paintLamp(
        painter,
        { x, y, z },
        signal.heading,
        st.lampRadius,
        lampColor(spec, time, st.flashRate),
        st.depthBias + 3,
      );
    });

    // Plates below the heads: L, DV, R.
    if (signal.plates.length > 0 || (signal.aspect.plates?.length ?? 0) > 0) {
      const text = (signal.plates.length > 0 ? signal.plates : signal.aspect.plates!).join(' ');
      painter.text({ x, y, z: boardBottom - 1.2 }, text, {
        fill: '#e8e8e8',
        font: '10px ui-monospace, monospace',
        depthBias: st.depthBias + 4,
      });
    }

    if (st.labels) {
      painter.text({ x, y, z: boardTop + 1.8 }, signal.aspect.name, {
        fill: '#cfd6dd',
        font: '10px ui-monospace, monospace',
        depthBias: st.depthBias + 4,
      });
    }
  }
}

const FLAG_COLORS: Record<string, string> = {
  blue: '#3a6ecb',
  red: '#d43b30',
  yellow: '#e8c14a',
  green: '#3fc06a',
};

/**
 * Flags on a staff.
 *
 * Placement is drawn honestly because the rules turn on it: Rule 41's track work
 * protection is displayed *between the rails*, and a red flag standing beside
 * the track means something else entirely. Colours are drawn top-first, so a
 * Rule 42 advance signal reads as the yellow over red it is.
 */
export function drawFlags(painter: Painter, flags: readonly Flag[], style: SignalStyle = {}): void {
  const st = { ...DEFAULT_SIGNAL_STYLE, ...style };

  for (const flag of flags) {
    const beside = flag.placement === 'between-rails' ? 0 : 2.6;
    const nx = Math.sin(flag.heading) * beside;
    const ny = -Math.cos(flag.heading) * beside;
    const x = flag.x + nx;
    const y = flag.y + ny;
    const staff = 1.5 + flag.colours.length * 0.75;

    painter.line(
      [
        { x, y, z: flag.z },
        { x, y, z: flag.z + staff },
      ],
      { stroke: '#d8d8d8', width: 1.6, depthBias: st.depthBias + 2 },
    );

    // Each flag hangs off the staff, square to the track so it is readable from
    // a movement rather than from the side.
    const w = 1.5;
    const h = 0.85;
    const dx = Math.cos(flag.heading) * w;
    const dy = Math.sin(flag.heading) * w;
    flag.colours.forEach((colour, i) => {
      const top = flag.z + staff - i * (h + 0.12);
      paintFace(
        painter,
        [
          { x, y, z: top - h },
          { x: x + dx, y: y + dy, z: top - h },
          { x: x + dx, y: y + dy, z: top },
          { x, y, z: top },
        ],
        FLAG_COLORS[colour] ?? '#cccccc',
        { ambient: 0.95, noCull: true, depthBias: st.depthBias + 3 },
      );
    });
  }
}
