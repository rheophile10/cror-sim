/**
 * Drawing people, and walking them.
 *
 * A deliberately small amount of geometry, and the restraint is the design.
 *
 * The brief that produced this feature asked whether the answer is a
 * third-person view of a figure walked about the isometric plane. It is not, and
 * the renderer says why. The painter is depth-sorted with **one depth value per
 * face** and no z-buffer, and things standing on the ground carry a depth bias
 * of about one terrain cell — commonly 18 m. A half-metre-wide figure standing
 * beside a switch stand, between two cars, or under a coupler is precisely the
 * case that sorting gets wrong. Chasing that would mean a z-buffer, and a
 * z-buffer means abandoning the painter, and the painter is why a hill hides the
 * train behind it for a hundred lines of code.
 *
 * So a person is drawn as a **marker that happens to be person-shaped**: a body,
 * a head, and a stripe of high-visibility colour, standing about 1.8 m. It is
 * legible at the zoom where you can also see a train, which is the zoom this
 * simulation is for, and it never needs to interpenetrate anything.
 *
 * What that buys, and it is the whole point: you can see *where somebody is*,
 * which is the thing every rule in question is about. What it refuses: hands, a
 * view from eye level, and any suggestion that this is a place a person inhabits
 * rather than a plan of a railway with people marked on it.
 *
 * The one concession is a **walk cycle** — two legs and a small bob — because a
 * marker that slides along the ground does not read as somebody walking, and how
 * long the walking takes is the substance of the whole feature. The cycle is
 * driven by distance covered rather than by elapsed time, so it cannot run on
 * the spot and cannot speed up when the simulation rate does.
 */
import { INJURY_LABEL, type Person } from '../person.ts';
import { paintBox, paintCone } from './solid.ts';
import type { Painter } from './painter.ts';

export interface PersonStyle {
  ambient?: number;
  /** High-visibility vest. The reason a person is findable on a green hillside. */
  vestColor?: string;
  /** Trousers, boots, the lower half. */
  bodyColor?: string;
  headColor?: string;
  /** Overall height, metres. */
  height?: number;
  /** Draw names, and what they are doing. */
  labels?: boolean;
  /** How far the legs swing, metres. Zero draws a figure that never walks. */
  stride?: number;
  /** Mark how far a person can reach, so "too far away" is visible before it happens. */
  showReach?: boolean;
  depthBias?: number;
}

export const DEFAULT_PERSON_STYLE: Required<PersonStyle> = {
  ambient: 0.55,
  vestColor: '#e8d44a',
  bodyColor: '#2f3a44',
  headColor: '#c9a888',
  height: 1.8,
  stride: 0.32,
  labels: true,
  showReach: false,
  depthBias: 0,
};

const ROLE_VEST: Partial<Record<Person['role'], string>> = {
  conductor: '#e8d44a',
  'locomotive-engineer': '#e88a3a',
  foreman: '#e2483d',
  workman: '#e2483d',
  switchtender: '#4aa3e8',
};

export function drawPeople(painter: Painter, people: readonly Person[], style: PersonStyle = {}): void {
  const st = { ...DEFAULT_PERSON_STYLE, ...style };
  const cam = painter.camera;
  const margin = 60;

  for (const person of people) {
    const projected = cam.project(person.x, person.y, person.z + st.height);
    if (
      projected.sx < -margin ||
      projected.sy < -margin ||
      projected.sx > cam.width + margin ||
      projected.sy > cam.height + margin
    ) {
      continue;
    }

    // A casualty. Drawn lying down, in the ballast, exactly where it happened —
    // not tidied away and not dramatised. The position is the thing worth
    // recording, which is why it is drawn at all.
    if (person.injury !== 'none') {
      paintBox(
        painter,
        person.x,
        person.y,
        // A drowning leaves a body at the surface, not on the bottom. Half a
        // metre is not the water level — nothing here knows that — it is enough
        // to stop the shape disappearing under the sheet.
        person.z + (person.injury === 'drowned' ? 0.45 : 0),
        st.height * 0.95,
        0.5,
        0.35,
        person.heading,
        '#7d3b36',
        { ambient: 0.7, depthBias: st.depthBias + 3 },
      );
      if (st.labels) {
        painter.text({ x: person.x, y: person.y, z: person.z + 1.2 }, person.name, {
          fill: '#f0b4ae',
          font: '10px ui-monospace, monospace',
          depthBias: st.depthBias + 5,
        });
        painter.text({ x: person.x, y: person.y, z: person.z + 0.4 }, INJURY_LABEL[person.injury], {
          fill: '#e2483d',
          font: '9px ui-monospace, monospace',
          depthBias: st.depthBias + 5,
        });
      }
      continue;
    }

    // Somebody in a cab is inside a locomotive; drawing a figure there would put
    // a person through the roof of the long hood. A mark above it says where
    // they are without pretending to show them.
    if (person.posture === 'in-cab') {
      // Two people can be in a cab and only one of them is driving. The one at
      // the controls gets the taller mark; the other is along for the ride.
      const driving = person.atControls;
      paintCone(
        painter,
        person.x,
        person.y,
        person.z + (driving ? 2.6 : 2.2),
        person.z + 1.9,
        driving ? 0.5 : 0.34,
        6,
        ROLE_VEST[person.role] ?? st.vestColor,
        { ambient: 0.9, depthBias: st.depthBias + 4 },
      );
      if (st.labels) label(painter, person, person.z + (driving ? 3.4 : 3.0), st);
      continue;
    }

    const legs = st.height * 0.45;
    const torso = st.height * 0.32;
    const vest = ROLE_VEST[person.role] ?? st.vestColor;
    const walking = person.task?.kind === 'walk';

    // The stride is driven by **distance covered**, not by elapsed time, so the
    // legs cannot cycle while somebody stands still and cannot scale with the
    // simulation rate. `PACE` is metres per full stride: about 1.4 m is a
    // walking pace, so half a metre per leg swing.
    const PACE = 1.4;
    const phase = walking ? (person.stride / PACE) * Math.PI * 2 : 0;
    const swing = walking ? Math.sin(phase) * st.stride : 0;
    // A small vertical bob at twice the stride frequency: the body rises as each
    // leg passes under it. Tiny, but it is what stops a walking figure reading
    // as a box sliding along the ground.
    const bob = walking ? Math.abs(Math.sin(phase)) * 0.035 * st.height : 0;

    const ch = Math.cos(person.heading);
    const sh = Math.sin(person.heading);
    for (const side of [1, -1]) {
      const step = swing * side;
      // A swung leg lifts a little and is shorter to the ground for it.
      const lift = walking ? Math.max(0, step) * 0.35 : 0;
      paintBox(
        painter,
        person.x + ch * step + sh * 0.11 * side,
        person.y + sh * step - ch * 0.11 * side,
        person.z + lift,
        0.24,
        0.2,
        legs - lift,
        person.heading,
        st.bodyColor,
        { ambient: st.ambient, depthBias: st.depthBias + 3 },
      );
    }

    paintBox(
      painter,
      person.x,
      person.y,
      person.z + legs + bob,
      0.52,
      0.52,
      torso,
      person.heading,
      vest,
      { ambient: st.ambient, depthBias: st.depthBias + 3.1 },
    );
    paintBox(
      painter,
      person.x,
      person.y,
      person.z + legs + torso + bob,
      0.34,
      0.34,
      st.height - legs - torso,
      person.heading,
      st.headColor,
      { ambient: st.ambient, depthBias: st.depthBias + 3.2 },
    );

    if (st.showReach) {
      // A ring at working distance: the difference between being at the switch
      // and being near it, drawn rather than discovered.
      const ring: { x: number; y: number; z: number }[] = [];
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        ring.push({
          x: person.x + Math.cos(a) * person.reach,
          y: person.y + Math.sin(a) * person.reach,
          z: person.z + 0.05,
        });
      }
      ring.push(ring[0]!);
      painter.line(ring, { stroke: 'rgba(232,212,74,0.5)', width: 1, depthBias: st.depthBias + 2 });
    }

    if (st.labels) label(painter, person, person.z + st.height + 0.9, st);
  }
}

function label(painter: Painter, person: Person, z: number, st: Required<PersonStyle>): void {
  const doing = person.task
    ? `${person.task.label}${person.task.duration > 0 ? ` ${Math.round((person.task.elapsed / person.task.duration) * 100)}%` : ''}`
    : person.lastRefusal
      ? `— ${person.lastRefusal}`
      : null;

  painter.text({ x: person.x, y: person.y, z }, person.name, {
    fill: person.lastRefusal && !person.task ? '#f0b4ae' : '#e8eaed',
    font: '10px ui-monospace, monospace',
    depthBias: st.depthBias + 5,
  });
  if (doing) {
    painter.text({ x: person.x, y: person.y, z: z - 1.1 }, doing, {
      fill: person.task ? '#b9c3cc' : '#f0b4ae',
      font: '9px ui-monospace, monospace',
      depthBias: st.depthBias + 5,
    });
  }
}
