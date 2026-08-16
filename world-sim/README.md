# world-sim

Isometric terrain on a canvas, track graded onto it, and trains running over that
track under Newtonian physics. A TypeScript library with no runtime dependencies;
`../world-sim-app` is the one-page viewer built on it.

A whole scene — landscape, alignment, consist, camera, styling — is one JSON
document, and it round-trips back to one.

```ts
import { World, Renderer, attachCameraControls } from 'world-sim';

const world = World.fromJSON(sceneJson);
const renderer = new Renderer(canvas, world);
attachCameraControls(canvas, renderer.camera, { onChange: () => renderer.render() });

let last = performance.now();
const frame = (now: number) => {
  world.step(Math.min(0.1, (now - last) / 1000));
  last = now;
  renderer.render();
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
```

## What it does

**Terrain from a sparse description.** The JSON never lists heights. It gives a
grid and a short list of additive features — hills, ridges, ramps, basins, value
noise — each with a bounded footprint and a falloff profile. A 200×200 landscape
is a twenty-line file, and it stays hand-editable. Heights live at lattice
*nodes*, so a cell is drawn as a genuinely tilted plane rather than a flat plate.

**Track that a train can actually run on.** Control points become a centripetal
Catmull-Rom curve, resampled to uniform arc length so distance along the path is
the coordinate everything else uses. The ground under it is sampled, low-passed,
and then grade-limited to a stated ruling grade. Raw draped terrain gives ±20%
grades and a train that cannot move; this gives a grade line.

**Earthworks that exist in the world.** Once the grade line is set, `terraform`
cuts and fills the height field to carry it — level formation, then a side slope
back to natural ground. The cuts and fills you see are the terrain, not a decal
drawn over it.

**A catalogue of rolling stock.** Locomotives, box cars, covered and open
hoppers, gondolas, tank cars, auto carriers, flats, cabooses, and intermodal
well cars that take no, one or two containers. Each type carries a tare weight
and a capacity, and a `load` between 0 and 1 mixes them — an empty and a loaded
hopper are the same car with four times the weight, which is the number every
interesting behaviour turns on. Bodies are extrusions of a cross-section, so a
tank car is a cylinder and a well car is a U with boxes stacked in it.

**Longitudinal train dynamics.** Every car is a point mass with its own position
and velocity, joined to its neighbours by couplers with slack and a stiff
spring-damper. Forces: adhesion-limited tractive effort, grade, Davis rolling
resistance, curve resistance, brakes, and draft/buff through the couplers.
Semi-implicit Euler on a fixed 1/240 s substep. Run-in on a crest and stretch on
a descent are emergent, not scripted.

**Derailments that actually happen.** Past the L/V limit a car stops being a
point on a path and becomes a free body: it is thrown to the outside of the
curve carrying its forward speed, flies, lands on the terrain, slides, and rolls
over. The couplers to it part, the head end runs on, and the cars behind arrive
and pile in — each to the opposite side of the last, which is what makes an
accordion. Simulation does not pause when a train derails; that is the part
worth watching.

**Switches and turnouts.** Tracks are edges meeting at nodes, and a switch is a
node with three ports. A movement's way through the network is a `Route` — an
ordered list of legs with one running distance over the whole thing — so the
physics never had to learn what a switch is, and a train straddling one, with
cars on two different tracks at once, needs no special handling. Arriving at the
points is a facing move and the switch decides; arriving from a leg is trailing,
and if the switch is lined the other way the movement **runs through it** and
goes on the ground.

**Collisions.** Another movement, a car lying where it derailed, a truck stalled
on a crossing: all of them are put into one common frame — position on a track —
so a train can find what is in front of it whatever coordinate that thing thinks
in. Impacts resolve as an inelastic impulse plus a position correction, and
closing speed decides what kind of event it was: under a few km/h things simply
come together and one shoves the other, past `derailSpeed` the cars that touched
go on the ground. Mass decides the rest — a train sweeps a stalled car aside
without noticing and derails on a loaded rock truck.

**Scenery.** Trees, buildings, roads and traffic on them, authored as sparsely
as the terrain is — a forest is a rectangle, a count and a seed, expanded
deterministically, and it will not grow on the right-of-way. None of it can be
hit: scenery exists for scale and place, and the moment a tree can be struck it
needs mass, collision geometry and a wreck state, which is a different feature.

**Signals, and the flags people put in the field.** The CROR signal table, rules
405 to 439 — 37 named aspects with their indications, the lamps that display
them, and *two* speeds each: what is permitted passing the signal and what must
be arranged for at the next one. Signals stand at a mileage on a track facing one
way, so they are in sequence along it, and they come in the two kinds a railway
has. An **automatic** signal is worked by nobody: it reads its block and steps
back from whatever the next signal is asking for. A **controlled** signal is
worked by the RTC — it shows Stop until somebody clears it, which is why a
movement can sit at a red on perfectly clear track, and once cleared it shows a
turnout aspect if the route is lined through the points.

The step-back is one rule for every speed class rather than a list of cases:

    block occupied        → Stop, or Stop and Proceed if permissive
    next asks for X       → Clear to X
    next says Clear to X  → Advance Clear to X
    next is Clear         → Clear

which is why lining a switch for the siding turns a controlled signal into
Medium to Clear *and* the two automatics behind it into Clear to Medium and
Advance Clear to Medium, without any of those cases being written down. Flags are modelled separately, as they are in `CROR/sim`,
because a flag is displayed *by somebody*: blue, red between the rails, Rule 42's
yellow over red on one staff, yellow and green.

Nothing enforces a signal. A movement runs straight past a Stop — what it gets
instead is a **record**: `World.signalsPassed` reports every signal a movement
went by, the aspect it was *given* (the last one displayed while the signal was
still ahead, not the red it drops to as you take its block), the speed at the
time, and whether that was a stop passed or an overspeed. That is a physical
observation and not a verdict; deciding it violated Rule 439 is the rules
layer's job, and keeping the two apart is what lets an engineer run the red and
then see exactly what they did.

**People, and work that takes time.** A conductor has a position — `(track, at,
offset)`, because the offset is what rules like 104(j) are about — and a queue of
tasks with real durations: twenty seconds to line a hand switch, half a minute
for a handbrake, 1.25 m/s on the ballast. Nothing happens instantly except being
told to do it, and a task whose target is out of reach is refused out loud rather
than failing quietly. Every completed task emits a `WorldEvent` in `CROR/sim`'s
act vocabulary — `turned`, `examined`, `handbrake-applied` — which is the seam
between this package and the rules. See `DESIGN-conductor.md`.

With `embodied: true`, a hand-worked switch will not move unless somebody is
standing at it. Power switches are unaffected: they are worked from a control
machine. A conductor standing at an engine can climb into the cab; the throttle
is a control somebody has to be at, though a movement left with an empty cab and
the throttle open is a state the simulation stays in on purpose — that state is
what 62 and 112 are about.

**The air brake.** A brake pipe down the length of the train, joined car to car
by hoses that have to be coupled by hand, with an angle cock at each end of every
car. Air in the pipe holds the brakes *off*; the engineer applies them by
reducing pipe pressure, and each car's control valve moves air from that car's
own reservoir into its own cylinder. Three things fall out of modelling it that
way rather than as a number:

- **Parting the train applies the brakes.** Pull the pin with the angle cocks
  open and both ends vent — both portions go into emergency. Close the cocks
  first and neither does.
- **A cut leaks off and then releases.** Standing with its cocks closed, a cut
  loses pipe pressure (brakes apply), then cylinder pressure (brakes come off),
  then the reservoirs. Hours, not minutes — and it is why 112 is written about
  handbrakes and why "I left the air on it" is not securement.
- **The rear does not know yet.** Pressure propagates, so a long train applies
  from the head end back.

Also modelled: retaining valves (EX / SD / LP / HP), the branch pipe cut-out —
a car cut out brakes not at all while its brake pipe reads exactly like its
neighbours' — brake cylinder piston travel, which costs braking force past about
ten and a half inches, and per-car leakage.

**Cutting and coupling.** `World.uncouple(carId)` cuts a movement in two behind
a car, and the rear stands exactly where it was standing with nothing holding it
but whatever handbrakes were tied. `World.couple(a, b)` joins two movements at a
stand, working the merged order out from where the cars actually are rather than
from which end was coupled to which. Both are done *at the coupling*, which is
half a car length from the middle of either car — so somebody has to walk to the
joint, not to the car.

**Isometric rendering with real occlusion.** An orthographic camera with free yaw
and pitch, and a single depth-sorted draw list — terrain, track and rolling stock
all in the same list, painted far to near. A hill hides the train behind it
without a z-buffer.

## Scene JSON

```jsonc
{
  "name": "Mountain Loop",
  "terrain": {
    "cols": 64, "rows": 64,
    "cellSize": 18,           // metres per cell
    "baseElevation": 6,
    "features": [
      { "x": 20, "y": 22, "radius": 20, "height": 130, "profile": "smooth" },
      { "kind": "ridge", "from": [8, 54], "to": [56, 60], "width": 9, "height": 40 },
      { "kind": "ramp",  "from": [10, 20], "to": [50, 20], "height": 170 },
      { "kind": "noise", "amplitude": 7, "scale": 6, "seed": 12, "octaves": 3 }
    ],
    "nodes": [[32, 32, 44]]   // explicit overrides, applied last
  },
  // Where tracks meet. Omit the whole block for a scene with one track.
  "nodes": [
    // `operation`: "hand" (default), "spring", or "power".
    // operation: hand | spring | auto-normal | semi-automatic | dual-control | power
    { "id": "sw-west", "kind": "switch", "position": "normal", "operation": "hand",
      "label": "W", "locked": true, "target": true },
    // derailType: standard | special | blue-flag, each with its own default position
    { "id": "d1", "kind": "derail", "derailType": "special", "derailing": true },
    { "id": "east-end", "kind": "end" }
  ],
  "tracks": [{
    "id": "main",
    "points": [[4, 20], [18, 17], [32, 22]],   // cell coordinates
    "loop":   { "center": [32, 32], "radiusX": 24, "radiusY": 20, "wobble": 5 },
    "closed": true,
    "spacing": 3,             // metres between path samples
    "maxGrade": 2.0,          // ruling grade, percent
    "smoothing": 30,          // earthwork low-pass passes
    "terraform": { "width": 5, "batter": 2.5, "maxReach": 90 },
    // Wiring into the network. A switch's ports are `trunk`, `normal` and
    // `reverse`, and must be named explicitly; plain joints default sensibly.
    "to": { "node": "sw-west", "port": "trunk" }
  }],
  // Signals stand at a mileage on a track and face one way; `up` governs
  // movements running with increasing mileage. Omit `aspect` and it works its
  // own out from the block ahead.
  "signals": [
    // control: automatic (default) | controlled | fixed
    { "id": "S2W", "track": "main", "at": 180, "facing": "up", "mast": "high",
      "control": "automatic", "permissive": true },
    { "id": "S6W", "track": "main", "at": 660, "facing": "up", "control": "controlled",
      "cleared": true, "divergingClass": "medium" },
    { "id": "S8W", "track": "main", "at": 900, "facing": "up", "aspect": "Restricting" }
  ],
  // Flags: colours top-first on one staff, so Rule 42's advance signal is one
  // object and not two.
  "flags": [
    { "track": "main", "at": 300, "colours": ["yellow", "red"], "rule": "42" },
    { "track": "main", "at": 620, "colours": ["red"], "rule": "41", "placement": "between-rails" }
  ],
  // Things standing on the track that are not trains.
  "obstructions": [
    { "id": "truck", "label": "Loaded rock truck", "track": "main", "at": 980, "mass": 34 }
  ],
  "trains": [{
    "id": "M301", "track": "main",
    "position": 300,          // lead coupler, metres along the path
    "direction": 1, "throttle": 0.45, "brake": 0, "speed": 0,
    "template": "unitGrain", "carCount": 14,
    "cars": [                 // or list them
      { "type": "locomotive" },
      { "type": "covered-hopper", "load": 0.95 },
      { "type": "tank", "load": 1, "label": "Loaded Tank Car" },
      { "type": "autorack", "load": 0.8 },
      { "type": "well", "containers": 2 },                 // double stacked
      { "type": "well", "containers": 1 },                 // one box
      { "type": "well", "containers": 0 },                 // running empty
      { "type": "well", "containers": [                    // or spell them out
        { "length": 53, "load": 0.9 }, { "length": 40, "load": 0.3 }
      ]},
      { "type": "boxcar", "mass": 61 }                     // or force the weight
    ]
  }],
  "physics": {
    "adhesion": 0.3,
    "derailLV": 0.8,
    "derailment": { "kick": 9, "friction": 0.8, "pileupKick": 3.5 }
  },
  "collision": { "derailSpeed": 4.5, "obstructionMassRatio": 0.06 },
  // Hand-worked switches and derails need somebody at them. Off by default.
  "embodied": true,
  "people": [
    { "id": "cond", "name": "Conductor", "role": "conductor",
      "track": "main", "at": 700, "offset": 3 },
    { "id": "eng", "role": "locomotive-engineer", "inCabOf": "M301" },
    { "id": "brakeman", "role": "employee", "ridingOn": "M301", "ridingSide": "left" }
  ],
  "scenery": [
    { "kind": "forest", "from": [2, 30], "to": [50, 56], "count": 240, "seed": 4,
      "species": "conifer", "clearance": 18, "maxElevation": 90 },
    { "kind": "tree", "at": [22, 19], "height": 16, "species": "broadleaf" },
    { "kind": "building", "at": [30, 30], "width": 16, "depth": 8, "height": 5,
      "rotation": -4, "roof": "gable", "label": "Station" },
    { "kind": "road", "id": "highway", "points": [[0, 32], [44, 33], [96, 32]], "width": 8 },
    { "kind": "vehicle", "road": "highway", "along": 120, "speed": 16, "type": "car" },
    { "kind": "vehicle", "at": [69, 20], "rotation": 100, "type": "truck" }
  ],
  "style": {
    "background": "#0c1014",
    "terrain": { "contourInterval": 20, "waterLevel": 8, "grid": null },
    "train": { "showCouplerForces": true, "labels": false }
  },
  "camera": { "yaw": 38, "pitch": 32 }
}
```

Feature profiles are `smooth` (cosine bell), `linear` (cone), `plateau` and
`step`.

Switches come in the six kinds CROR names, and the difference is what a
*trailing* movement does to them. `hand` stays where it was left, and a trailing
move against it bursts the points. `spring` is pushed open and closes again
behind the movement, undamaged — the whole reason spring switches exist.
`auto-normal` bursts the same as a hand switch but puts itself back to normal
once the movement is clear. `semi-automatic` (104.4) is emphatically *not*
trailable, however much 104(a) groups it with the hand switches for the rules'
purposes. `dual-control` is power-operated with a hand throw, and `handMode`
carries which position it is in. `power` has no hand throw. Every kind is
interlocked against being thrown under a movement standing on the points,
because that is physics rather than policy.

Derails are modelled beside the switches, as CROR 104.5 treats them: `standard`
is left derailing, a `special` derail only when unattended equipment is present,
and a `blue-flag` derail only while protection for personnel is required — three
kinds with three different default positions, which is why the type is not
decoration.

Car types are `locomotive`, `boxcar`, `covered-hopper`, `open-hopper`,
`gondola`, `tank`, `autorack`, `well`, `flat` and `caboose`. Anything else is
treated as a label on a generic car, so older scenes that wrote free text in
`type` still load. Consist templates are `balanced`, `heavyRear`, `heavyFront`,
`unitGrain`, `unitTank`, `autoTrain`, `intermodal` and `mixedFreight` —
`heavyRear` and `heavyFront` are badly marshalled on purpose, because tonnage at
the wrong end of a train is what turns a curve on a grade into a string-lining.

Containers are `20`, `40`, `45` or `53` feet, with their own tare and lading.
Two on a well car double-stack; more than two is clamped; containers on anything
that is not a well car are ignored.

## Units

SI throughout the simulation: metres, kilograms, seconds, newtons. Grades are a
signed dimensionless rise/run internally. Scene JSON is authored in friendlier
units and converted in exactly one place per quantity — tonnes for mass, kN for
forces, percent for ruling grade, cells for terrain and track coordinates.

Note that `CROR/sim` counts in **feet**. When the two are joined, convert at the
boundary rather than relaxing either rule.

## Layout

| file | what it holds |
| --- | --- |
| `terrain.ts` | sparse features → node height field; bilinear sampling, normals |
| `spline.ts` | centripetal Catmull-Rom, arc-length resampling |
| `track.ts` | drape, smooth, grade-limit; `TrackPath.at(s)` |
| `network.ts` | nodes, ports, switches, and what a movement does at each |
| `route.ts` | the way through the network a movement takes; `Route.at(d)` |
| `collision.ts` | obstructions, and resolving impacts between anything on track |
| `signals.ts` | the CROR aspect table, signal and flag placement, block resolution |
| `airbrake.ts` | brake pipe, reservoirs, cylinders, cocks, retainers, leakage |
| `person.ts` | bodies with a position, tasks that take time, and what is in reach |
| `events.ts` | the act log — the seam to `CROR/sim`, and no dependency either way |
| `scenery.ts` | trees, buildings, roads, traffic; sparse specs expanded on load |
| `terraform.ts` | cut and fill the height field to carry the track |
| `equipment.ts` | the car catalogue: weights, capacities, cross-sections, containers |
| `train.ts` | consist model, car specs, templates |
| `physics.ts` | forces, integrator, the L/V criterion, telemetry |
| `derailment.ts` | free-body motion after the wheels leave the rail, and pile-ups |
| `world.ts` | the scene: build from JSON, `step`, serialise back |
| `render/camera.ts` | orthographic isometric projection and its inverse |
| `render/painter.ts` | depth-sorted draw list |
| `render/{terrain,track,train}.ts` | geometry for each layer |
| `render/renderer.ts` | one `render()` for the whole world |
| `render/controls.ts` | pointer and keyboard camera control |

The simulation half has no DOM dependency; only `render/` touches a canvas.

## Scripts

```sh
npm run check     # typecheck
npm run build     # emit dist/ with declarations
npm test          # 152 tests, node:test

# render a scene to a PNG through headless Chrome — the real renderer, not a
# re-implementation, so a still from it is evidence about the library
node scripts/render-png.mjs ../world-sim-app/scenes/mountain-loop.json out.png \
  --seconds=20 --yaw=38 --pitch=32 --zoom=2.2 --focus=560,650
```

## What it does not do yet

- **Signals are displayed, not obeyed.** The aspects are right and the block
  logic is real, but no movement is stopped, slowed, or faulted by one, and
  there are no authorities: no OCS clearances, no track occupancy permits, no
  RTC. Signal *meaning* — and every duty that hangs off it — belongs to
  `CROR/sim`, which is canonical for rule logic and stays that way. The switch
  and derail fields here (`secured`, `locked`, `target`, `spiked`,
  `clearancePoint`, `handMode`) exist to be read by that layer; nothing in this
  one consults them.
- **No interlocking.** A controlled signal is cleared by asking, and nothing
  checks that the switches under the route are locked, that no conflicting route
  is already cleared, or that the signal drops behind the movement. It is a
  switch on a desk, not a control machine.
- **People get hurt.** Somebody standing foul of a track that equipment moves
  over is struck; somebody in a gap between two movements coming together is
  crushed. Both stop that person working, permanently, and emit an event saying
  what happened and where. This is in the model because the rules it exists to
  study are written in response to those two events.
- **Bodies, not agents.** People do what they are told and always comply;
  nobody acts on their own. And the event log records what *happened*, not what
  anybody believes happened, so 104(d)'s verbal confirmation — and every rule
  about reporting a switch position wrongly — stays undecidable. `DESIGN-
  conductor.md` says what would have to change.
- **No brake tests, and no locomotive independent brake.** The air is modelled
  but the *procedures* over it are not: GOI 7's tests, the leakage test, the
  running test. One reservoir per car rather than the auxiliary and emergency
  pair, no quick-service, no pressure maintaining.
- **No timetable, no authorities, no radio.** No OCS clearances, no track
  occupancy permits, no bulletins. The signals are the only thing on the railway
  that tells a movement anything.
- **No crossings or slips**, and no three-way switches: a node is an end, a
  joint, or an ordinary turnout.
- **Scenery is decoration.** A train runs through a forest or a building without
  noticing. Traffic drives its road and wraps round at the end; it does not
  steer, queue, or stop at level crossings.
- **Switch geometry is the scene author's problem.** Nothing checks that the two
  tracks meeting at a node actually meet, or that a turnout diverges at a
  plausible angle. Diverge too hard and the L/V limit simply derails everything
  that tries to take the siding — which is correct behaviour and a confusing way
  to find out you meant 1:12 and drew 1:1.5.
- **Simplified dynamics.** No cant, no vertical dynamics, no air propagation
  delay down the train line, no per-axle load transfer. The derailment criterion
  is a Nadal-flavoured L/V estimate — the right shape, with coefficients tuned to
  be illustrative rather than certified.
- **Crude wreck physics.** A derailed car has no inertia tensor, no contact
  manifold, and no car-to-car collision beyond the pile-up rule; cars ahead of a
  derailment are never dragged back, because their couplers are treated as
  parted. It answers "did this train derail, roughly where, and how much of it
  went over" — not "which coupler failed first". Lading does not spill, and
  nothing catches fire.
- **Coarse impact model.** One impulse between the two bodies that touched, no
  contact manifold, no override or climb, and the cars *ahead* of a wreck are
  never dragged back — their couplers are treated as parted.
- **Painter's algorithm, not a z-buffer.** Faces are sorted on one depth value
  each, which is why track is emitted in short spans and why things standing on
  the ground carry a depth bias of about one terrain cell. Interpenetrating
  geometry can still sort wrong.
