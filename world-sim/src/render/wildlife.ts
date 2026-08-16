/**
 * Drawing animals.
 *
 * Four boxes and a cone is a moose, and at the zoom this simulation is for that
 * is more than enough — the same argument the people renderer makes. What has to
 * read from a kilometre away is **which species** and **whether it is coming for
 * you**, because those are the only two facts that change what you do. So the
 * silhouettes are exaggerated apart: a moose is tall and dark with antlers, a
 * wolf is low and pale and there are five of them, a bear is a heavy lump.
 *
 * An animal that has noticed somebody is marked. That is not realism — you
 * cannot see intent at this distance — it is the interface admitting that a
 * plan view has no body language, and that the alternative is a hazard you
 * cannot see coming.
 */
import type { Animal, Species } from '../wildlife.ts';
import { paintBox, paintCone } from './solid.ts';
import type { Painter } from './painter.ts';

export interface WildlifeStyle {
  ambient?: number;
  /** Mark an animal that is stalking or attacking. */
  showIntent?: boolean;
  intentColor?: string;
  /** Colour of a carcass. */
  deadColor?: string;
  labels?: boolean;
  depthBias?: number;
}

export const DEFAULT_WILDLIFE_STYLE: Required<WildlifeStyle> = {
  ambient: 0.5,
  showIntent: true,
  intentColor: '#e2483d',
  deadColor: '#5a4a44',
  labels: true,
  depthBias: 0,
};

const NAME: Record<Species, string> = {
  moose: 'moose',
  wolf: 'wolves',
  bear: 'bear',
  dinosaur: 'DINOSAUR',
};

export function drawWildlife(
  painter: Painter,
  animals: readonly Animal[],
  style: WildlifeStyle = {},
): void {
  const st = { ...DEFAULT_WILDLIFE_STYLE, ...style };
  const cam = painter.camera;
  const margin = 100;

  for (const animal of animals) {
    const p = cam.project(animal.x, animal.y, animal.z + animal.traits.height);
    if (p.sx < -margin || p.sy < -margin || p.sx > cam.width + margin || p.sy > cam.height + margin) {
      continue;
    }

    const t = animal.traits;
    const bias = st.depthBias + 3;
    if (animal.state === 'dead') {
      // Lying where it was hit, and left there. A carcass on the right of way is
      // a thing crews report, which is the only reason it is drawn at all.
      paintBox(painter, animal.x, animal.y, animal.z, t.length, t.width, t.height * 0.35,
        animal.heading, st.deadColor, { ambient: 0.75, depthBias: bias });
      if (st.labels) {
        painter.text({ x: animal.x, y: animal.y, z: animal.z + 1.4 }, `dead ${animal.species}`, {
          fill: '#a08e86',
          font: '9px ui-monospace, monospace',
          depthBias: st.depthBias + 5,
        });
      }
      continue;
    }

    const legs = t.height * (animal.species === 'moose' ? 0.5 : 0.36);
    const body = t.height - legs;

    // Legs, as one block: four posts at this size would be four pixels.
    paintBox(painter, animal.x, animal.y, animal.z, t.length * 0.7, t.width * 0.7, legs,
      animal.heading, '#2e2a26', { ambient: st.ambient, depthBias: bias });
    // Barrel.
    paintBox(painter, animal.x, animal.y, animal.z + legs, t.length, t.width, body * 0.8,
      animal.heading, t.color, { ambient: st.ambient, depthBias: bias + 0.1 });

    // Head, out in front along the heading.
    const hx = animal.x + Math.cos(animal.heading) * t.length * 0.52;
    const hy = animal.y + Math.sin(animal.heading) * t.length * 0.52;
    paintBox(painter, hx, hy, animal.z + legs + body * 0.35, t.length * 0.26, t.width * 0.6,
      body * 0.5, animal.heading, t.color, { ambient: st.ambient, depthBias: bias + 0.2 });

    if (animal.species === 'moose') {
      // Antlers: the whole silhouette. Without them a moose is a brown box.
      for (const side of [1, -1] as const) {
        const nx = -Math.sin(animal.heading) * side;
        const ny = Math.cos(animal.heading) * side;
        paintBox(painter, hx + nx * 0.7, hy + ny * 0.7, animal.z + t.height * 0.82,
          0.5, 1.3, 0.18, animal.heading, '#8a7a5c',
          { ambient: 0.85, depthBias: bias + 0.3 });
      }
    }
    if (animal.species === 'dinosaur') {
      // A tail behind and a crest above, so it is unmistakably not a moose.
      const tx = animal.x - Math.cos(animal.heading) * t.length * 0.62;
      const ty = animal.y - Math.sin(animal.heading) * t.length * 0.62;
      paintBox(painter, tx, ty, animal.z + legs + body * 0.2, t.length * 0.5, t.width * 0.45,
        body * 0.35, animal.heading, t.color, { ambient: st.ambient, depthBias: bias + 0.1 });
      paintCone(painter, animal.x, animal.y, animal.z + t.height * 0.8, animal.z + t.height * 1.25,
        t.width * 0.5, 6, '#59703f', { ambient: 0.8, depthBias: bias + 0.4 });
    }

    // Coming for somebody. A ring on the ground, because a plan view has no
    // body language and a hazard you cannot see coming is not a hazard, it is
    // an ambush.
    if (st.showIntent && (animal.state === 'stalking' || animal.state === 'attacking')) {
      const ring: { x: number; y: number; z: number }[] = [];
      const r = t.length * 1.1;
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        ring.push({ x: animal.x + Math.cos(a) * r, y: animal.y + Math.sin(a) * r, z: animal.z + 0.06 });
      }
      painter.line(ring, { stroke: st.intentColor, width: 1.5, depthBias: st.depthBias + 2 });
    }

    if (st.labels) {
      // Only the leader of a pack is named, or five wolves are five labels.
      if (animal.pack && !animal.leader) continue;
      painter.text({ x: animal.x, y: animal.y, z: animal.z + t.height + 1 }, NAME[animal.species], {
        fill: animal.state === 'stalking' || animal.state === 'attacking' ? st.intentColor : '#b6b0a2',
        font: '9px ui-monospace, monospace',
        depthBias: st.depthBias + 5,
      });
    }
  }
}
