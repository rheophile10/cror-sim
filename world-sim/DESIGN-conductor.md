# The conductor

*What was built, why, and what was deliberately left out. This is the record of
decisions made while implementing `BRIEF-conductor-simulation.md`, not a proposal
— everything described as built is in `src/person.ts`, `src/events.ts` and
`src/render/person.ts`, with tests in `tests/person.test.ts` and
`tests/scenario.test.ts`.*

The brief asked thirteen questions and said plainly that a design saying yes to
all of them is not a design. Questions 1, 3, 5, 10 and 13 are one feature and
that feature is built. Question 7 (cutting, joining, the air) is a second and is
not. Questions 8, 9, 11 and 12 are a third and a fourth, and one of them should
probably never live in this package at all.

## The body, and where it lives

A person's position is **`(track, at, offset)`** — the track they are working
along, how far along it, how far to one side. World coordinates are derived every
step and never stored.

This was the question the brief guessed was load-bearing, and it was right. The
alternative — a free `(x, y, z)` on the terrain — makes "which track is he
working on" a search against the whole network, and *every* rule that matters
asks exactly that. Track-relative also round-trips through `World.toJSON()`
without inventing anything, and it is the same coordinate `Car.s`, signals and
obstructions already use, so a person and a car can be compared without a
conversion.

The `offset` is the point, not a detail. `CROR/sim`'s
`checks/104-hand-operated-switches.ts` defers 104(j) — where employees may stand
relative to a switch stand — with the reason *"people are placed on tracks, not
offset from them"*. Supplying that offset is what this feature is for.

Three postures: `on-ground`, `riding`, `in-cab`. Somebody riding is slaved to a
car, and when that car derails and `Car.body` takes over from `Car.s`, they go
with it — a test asserts this, because somebody riding the side of a car that
rolls over is somewhere very specific and the model should not pretend otherwise.

## Work takes time

A person has a queue of `Task`s, each with a duration in **simulated seconds**.
`TASK_SECONDS` in `person.ts` gives the starting numbers and says where each came
from: twenty seconds to line a hand switch (unlock, throw, examine, relock),
thirty for a handbrake, eight to point and call, eight to get on or off. Walking
is 1.25 m/s, which is the brief's own "1.5 km in twenty minutes".

Nothing is instantaneous except being *told* to do something. That is the whole
justification for the feature: 112 and 115 are rules about what somebody can get
to in time, and a version where a handbrake and a walking inspection are both one
function call has thrown that away. The scenario test runs the brief's tour end
to end and asserts it takes more than twenty simulated minutes.

**Time compression is allowed** and nothing breaks under it, because durations
are in simulated seconds and the app's rate multiplier scales simulated time.
That will stop being true when radio arrives — 123.2's distance cadence is about
real intervals between transmissions — and the honest note is that compression is
safe *for now* rather than safe in principle.

## Control: say where, then say what

The scheme is the middle ground the brief describes. `World.send(person, to,
then?)` walks somebody somewhere and optionally has them do something on arrival;
`World.sendToSwitch` is the common case wrapped up. Having arrived,
`World.actionsAt(person)` returns what is **within reach from where they are
standing**, and the app's crew panel is exactly those two halves: a row that
picks who, and a row of what that person could touch right now.

Being in the wrong place fails loudly. A task whose target is out of reach is
refused with a reason (`too far away — 40 m from sw-w`), the refusal is recorded
as an event, and the person stops. There is deliberately no UI path to command an
out-of-reach action; the refusal is for mistakes you make by walking away
mid-task or by driving the API, not one the interface hands you.

`WORKING_DISTANCE` is 5 m, and the number was measured off the railway rather
than guessed: a switch stand sits 3.4 m from the centre line (`render/network.ts`)
while the node is on it, so anything tighter reports somebody standing at the
stand as too far from the switch. This was found by the implementation refusing a
job the conductor had walked seven minutes to reach.

## Embodiment is opt-in

`SceneSpec.embodied` defaults to **false**, and that default is backwards
compatibility rather than a judgement: every scene written before there were
people still runs. Turned on, a hand-worked switch or a derail can only be
operated by somebody standing at it, and `World.canThrowSwitch` refuses with
*"hand-worked — somebody has to be at it"*. Power switches are unaffected —
`isHandWorked` in `network.ts` already knew which is which, which is the brief's
point that the model had half the answer already.

## The seam: events, and no dependency

`world-sim` emits `WorldEvent`s using **`CROR/sim`'s act vocabulary** — `turned`,
`examined`, `point-and-call`, `handbrake-applied`, `boarded`, `derail-set` — and
neither package imports the other. The vocabulary matches by agreement; an
adapter outside both walks this log and produces that package's events, and
converts metres to feet on the way. That keeps the two models separable, which is
worth something, and it is the reason the task set was chosen to fit the
vocabulary rather than the other way round.

Every task that completes emits an event or refuses. A task that completed
silently would be one the rules layer could never see.

The log carries no verdicts. An event says the switch was turned at 433 s by this
person standing at `main-w 816 m`. Whether that discharged 104(b) or broke it is
a question for the package with the rulebook.

One thing fell out of this that was not planned: `World` reads its own event log
to decide when to rebuild routes. A person who turns a switch changes the way
ahead of every movement exactly as the control machine would, and watching for
`turned` in the log is how that happens without `person.ts` needing to know that
routes exist.

## The camera: no

The brief asked directly whether the answer is a third-person view of a figure
walked about the isometric plane. It is not, and the renderer says why: the
painter is depth-sorted with **one depth value per face** and no z-buffer, and
things on the ground carry a depth bias of about one terrain cell — commonly
18 m. A half-metre figure beside a switch stand, between two cars, or under a
coupler is precisely the case that sorting gets wrong. Fixing it means a
z-buffer, and a z-buffer means abandoning the painter, which is why a hill hides
the train behind it for a hundred lines of code.

So a person is drawn as a **marker that happens to be person-shaped** — body,
head, high-visibility vest, about 1.8 m — with a name and what they are doing
above it, and optionally a ring at working distance so "too far away" is visible
before it happens. The camera mode does not change and there is no follow-the-
person view yet; the isometric view's value is showing a kilometre of railway,
and the answer to wanting to see somebody closely is to zoom.

Refused: hands, gait, eye level, and any suggestion that this is a place a person
inhabits rather than a plan of a railway with people marked on it.

## Fixed on the way

`World.toJSON()` was silently dropping `secured`, `locked`, `target`, `spiked`
and `clearancePoint` from every node — so a conductor who locked a switch and
exported the scene lost the lock. The brief flagged it; it is fixed and tested.

`Terrain.hasLineOfSight` now exists: a march along the line checking the ground
never rises above it. `Person.sightFt` in `CROR/sim` has had to be *asserted*
because nothing could work it out, and 115(a) and 105(c) both turn on it. It
answers "does the land get in the way" and will say yes to a sightline straight
through a standing cut of cars, which is the honest limit of what a height field
knows.

`Car.handbrake` exists and the physics honours it, with a force about a fifth of
the air brake — which is why 112 asks for a *number* of handbrakes.

## Not built, and why

**Cutting and joining consists, and the air (Q7).** `Train.cars` is `readonly`
and there is no train line. This is a second feature of comparable size: a split
means constructing a `Train`, giving it a `Route`, and getting the `s`-origin
shift right, which is the arithmetic `rebuildRoute` already warns teleports
trains. Until it exists, the scenario test runs the brief's tour *minus the cut*
and says so. My recommendation when it comes: build the minimal train line —
per-coupler hose connected, angle cocks, a charge state that propagates — because
without it "bucking up the air" has no substrate and GOI 7 stays undecidable.

**Radio (Q8).** The most valuable thing in the brief and the largest. 123.2(iii)'s
"has travelled one-half the distance required" becoming arithmetic over the world
is a genuinely new capability, and it deserves designing rather than appending.

**Documents (Q9).** Should probably never be in `world-sim`. A bulletin is not a
physical object with a position; it is a fact about what somebody knows, and that
belongs with the rules layer.

**Belief (Q11).** Deferred, and this is the real cost of the current design. The
event log records what *happened*, not what anybody thinks happened, so 104(d)'s
verbal confirmation and reporting a switch normal when it is reverse remain
undecidable. What would have to change: events gain an observer, and a person
gains a set of beliefs updated by what they see and are told. That is a coherent
next step and it is not small.

**Other people who can fail (Q12).** Multiple people are supported and each is
commanded independently, but nobody acts autonomously and an instructed person
always complies. A second person who always complies is, as the brief says, a
function call with a costume on — so the honest statement is that this feature
gives you *bodies*, not *agents*.

## Deferred rules this retires

From `checks/104-hand-operated-switches.ts`:

- **104(j)** — where employees stand relative to a switch stand. Retired: people
  have an offset, and `somebodyAt` answers who is at the points.
- **104(b)**'s point-and-call — deferred as "a procedure replay". Retired as far
  as *ordering* goes: `point-and-call` is a task that takes eight seconds and
  emits an event, so the rules layer can see whether it happened and when
  relative to the turn.
- **104(q)** — confirming a switch position from the location of the switch.
  Retired: every `turned` event carries `where`.

Not retired: **104(d)**, which is about belief and needs observers.

From `112-securing-unattended-equipment.ts`: handbrakes are now applied to
specific cars by somebody who was standing there, and take half a minute each,
so "how many were tied and could they have been" is answerable. Whether that
discharges 112 is still the rules layer's call.

## Order of work from here

1. **Split and join consists.** Everything about switching is blocked on it.
2. **A minimal train line.** Then GOI 7 and the brake tests become expressible.
3. **Belief.** Observers on events; then 104(d) and the reporting rules.
4. **Radio**, built on 3, because a transmission is the paradigm case of somebody
   coming to believe something.

The thing to prove first was the coordinate question and the event seam, and the
brief guessed that correctly. Both worked; the surprise was how much fell out of
the event log once it existed.

---

# The rest of the control stand

*Added after the question "what actually are the controls on a CN locomotive?".
Everything here is in `src/cab.ts`, `src/lights.ts`, `src/render/lights.ts` and
the air flow additions to `src/airbrake.ts`, with tests in `tests/cab.test.ts`
and `tests/lights.test.ts`.*

The air brake and the throttle are what an engineer *uses*. What was missing was
the rest of the stand — and in particular the two devices that take control
*away*, which are exactly the kind of thing a rules simulation should be able to
show and which a model driven only by the player's hand cannot express at all.

## Dynamic brake

A retarding force on locomotives only, in the resistive sum rather than the
driving one, so it can bring a train to a crawl and never push it backwards. Two
properties are the whole reason it is here: it **fades out at low speed**, and it
is **adhesion-limited** like tractive effort. A test holds a loaded train down a
2.5% grade on dynamic alone and asserts it gets away — the retarding force
disappears exactly when it is least wanted, and there is nothing in the
cylinders because none was ever put there.

Exclusive with the throttle, enforced in the physics rather than by a setter, so
a scene can describe an impossible handle position and see it refused.

## The alerter, and the PCS

`stepCab` runs before the air, because a penalty application has to be in the
brake handle before the pipe is stepped.

The alerter **watches the engineer, not the locomotive**: `Train.attended`, set
by `World` each step from `cabOccupant`. That decision was forced by evidence —
switching it on unconditionally made four existing scenario tests fail, every one
of them a train nobody was driving. A movement with an empty cab is a state this
package exists to model and it must not be penalised for it. The rule is also
simply true: the device is asking *a person* whether they are still there.

Recovering from a penalty takes the automatic brake handle into suppression and
the PCS timing out; releasing straight away — which is what a hand reaches for —
does not work, and there is a test that says so.

## Two bugs this uncovered

**Emergency cleared itself in one frame.** `train.emergency = true` against a
still-full pipe passed the release condition (`brake ≤ 0.01` and head pressure
above 90% of regulating) on the very next step, so nothing happened at all. The
flag was never the emergency; the *hole* is. `dumpBrakePipe` makes the hole, and
`Train.emergencyBrake()` is what callers should use.

**Holding the pipe target at zero while in emergency was a deadlock.** The
emergency only lifts once the pipe is back up, and the pipe could never come back
up. An emergency application is a hole that has already been made; what recovers
from it is the handle to release and the pipe filling again.

**`toJSON` was dropping the stand.** `independent`, `reverser`, `dynamic`, `sand`
and the lights were all lost on a round trip — the same class of loss that once
dropped `locked` off a switch, and worse here: a scene saved set and centred came
back with the engine live and nothing holding it.

## The air flow indicator

`train.airFlowCfm`, damped the way the real gauge is, from what the head end had
to feed to hold the pipe where it is. At steady state that is exactly the whole
train's leakage, which is why the gauge reads the *train* and not the cab. The
60 CFM everybody quotes is marked in the app's telemetry.

## Lights, horn and bell — and what "modelling a light" can honestly mean

There is **no illumination and there will not be**. The painter is depth-sorted
with one depth value per face, no z-buffer and no lighting pass. A real headlight
means a second light source per face, shadow casting so it reads as a beam rather
than a wash, and a depth buffer so it stops at the first thing it hits. That is a
renderer, not a feature.

What is drawn is what you can see of a lit locomotive from a distance in
daylight, which is the view this simulation has: **bright lamp faces** on the
nose, and a **translucent beam decal on the ground**, sampled in six quads so it
follows the terrain. It is a decal and it behaves like one — it brightens
nothing, it is not occluded, and it stops at a fixed distance. Called what it is,
it reads correctly; called illumination it would be a lie that got worse the
closer you looked.

The horn is a **pattern over time**, not a boolean, because the pattern is the
entire substance of Rule 14. A sounding runs itself out and cannot be
interrupted — half a signal is a different signal, and usually a wrong one. The
ditch lights alternate while it sounds. Neither the horn nor the bell can be
heard, so both are written above the locomotive.

Rule letters are given only for 14(l) and 14(n), which are not in doubt. The
patterns are the substance; check the letters against the edition in use.

## Still not built

**Car defects and inspection** — hot boxes, hot wheels, damaged cars, unstable
loads, with indications a conductor discovers within sighting distance. This is
the next thing on the list and it is a genuine feature rather than an addition:
it needs a defect model on `Car`, a discovery rule tied to `canSee` and working
distance, and an event that carries what was found.

**Sound.** The horn and bell are state and events with no audio. If they ever
make a noise, the horn pattern is already there to drive it.

---

# How big a world can be

*Measured, not estimated. The question was whether a subdivision you could run
for an hour is reachable; it is, and by a wide margin.*

A 130 km subdivision with 100 signals and a 101-car train:

| | |
|---|---|
| build (once, at load) | 570 ms |
| height field | 3.2 MB |
| `world.step` | **0.93 ms** per 1/60 s frame — 18× headroom |
| render, 550 m working view | **8 ms**, 2,600 faces |
| render, 2.2 km view | 31 ms, 10,000 faces |

Render time is now **flat in world size**. 260 km, 500 km, 1000 km and 2000 km
all render in the same 8–30 ms; only build time and memory scale, linearly and
cheaply (2000 km builds in ten seconds and costs 62 MB of heights).

An hour of running at 40 mph is 64 km. That builds in under half a second.

## What had to change to get there

Two things, and neither was the height field — the data was never the problem.

**The cull projected every cell to reject it.** Half a million cells is forty
milliseconds a frame spent deciding not to draw anything. The loop is now
**bounded first**, by unprojecting the four corners of the viewport onto the
terrain's lowest and highest planes and taking the cell range that covers; the
per-cell test trims what is left. Conservative in two ways on purpose — an
axis-aligned box around a rotated region, evaluated at the extremes of the
height field. Being generous costs a few thousand cells; being wrong cuts a hole
in the landscape.

**The skirt was not culled at all.** The vertical walls around the edge of the
grid were drawn unconditionally, and on a long subdivision that was ten thousand
quads along an edge nowhere near the camera — most of the frame. It gets the
same window as the ground now.

## What would break first if you went further

Not rendering. **Build time**, at roughly 4.5 s per 1000 km, because every
terrain node is evaluated against every feature and the whole track is resampled
and graded up front. If subdivisions ever need to be thousands of kilometres,
the answer is to build terrain in chunks on demand rather than to make the
per-node work faster — the render window already proves only a few hundred
metres are ever needed at once.

Also untested at that scale: `Route` already bounds itself to 8 km ahead and
1.2 km behind, so movements do not care how long the railway is. Scenery has a
per-item cull but no spatial index, so a hundred thousand trees would cost a
hundred thousand projections a frame. That is the next thing to bucket.

---

# Riding in the cab, and the bleed rod

**In the cab is not at the controls.** `Person.atControls` is now separate from
`posture === 'in-cab'`, because a conductor rides in the cab for most of a trip
and is not driving. `World.cabOccupant` looks for the seat, so the throttle, the
horn and the alerter all follow it; `cabRiders` answers who is merely in there.
Three distinct acts — *climb into the cab*, *take the controls*, *leave the
controls* — and only one pair of hands on a movement at a time.

This uncovered a latent bug: `canWork` requires `posture === 'on-ground'`, so
the reach check refused `take-controls` to anybody already aboard. The comment in
`targetPosition` had always said "from aboard you are already on the movement",
and the code had never done it.

**The bleed rod** was the missing act, and its absence read as a bug: cut a
portion off on a grade and it does not roll. It does not roll because parting the
hoses puts it in emergency — the brakes go hard on and stay on for the best part
of an hour while the cylinder leaks down. That is correct, and it is not what a
crew would see, because a crew bleeds the cars off.

`bleed` dumps a car's reservoir, cylinder and pipe to atmosphere. After it the
car has no air brake at all until somebody recharges it from a locomotive, and
only a handbrake will hold it. Two tests: a bled cut on a 2.5% grade runs away,
and the same cut with handbrakes tied stands with no air in it whatsoever —
which is the whole of 112 in two assertions.

---

# Crossings at grade

*`src/crossing.ts`, `src/render/crossings.ts`, traffic in `src/scenery.ts`, and
`tests/crossing.test.ts`.*

The one place in this model where the railway deals with people who have not
read the rulebook. Almost everything else here is a conversation between a crew
and a book; a crossing is a conversation with a driver.

## Three levels of protection, behaving differently

`passive` is crossbucks and nothing else — nothing warns anybody, and traffic
stops only when there is visibly something on the crossing, because a driver can
see a train. `flashing-lights` adds lights started by the approach.
`gates` adds arms that come down a few seconds behind the lights.

**Constant warning time**, not a fixed distance: the system is set for about
twenty-two seconds, so it starts further out for a fast movement than a slow one.
A movement that stops on the approach goes on holding the road, because the real
equipment cannot tell "stopped" from "about to start" — which is why a crew that
stops short of a crossing ties up a highway.

Detection works from **every car**, not the head end, so a movement standing
*across* a road holds it. That is the case that matters.

## `outOfOrder`, and why the flag is not decoration

A failed warning system leaves the lights dark and the arms up, and traffic does
not stop. That is precisely the situation in which a crew member has to get down
and protect the crossing on foot: `protect-crossing` is a task with a reach
check, and it is the **only** thing that stops the road when the equipment has
failed. There is a test that asserts exactly that sequence, because the feature
is worthless if a flag is a cosmetic label.

## A vehicle on the crossing is an `Obstruction`

Not a special case. A stalled car is built as a real obstruction on the track, so
the collision code strikes it, shoves it and reports the closing speed without
knowing what a crossing is. Mass decides the rest — a car is shoved and a train
is not derailed; a loaded truck is another matter.

The stalled vehicle is filtered out of `toJSON`'s obstruction list, because the
crossing spec already declares it and serialising both stood a second car on the
rails every time a scene round-tripped.

## Bugs this turned up

**Vehicles lap their road; the holding check did not.** `along` grows without
bound while `roadAt` is a position within one lap, so comparing them worked
exactly once and then never again — the crossing appeared permanently behind.
The gap is now measured within the lap and put back into `along`'s frame.

**Gate arms swung along the road instead of across it.** A gate blocks the
roadway, so the arm lies along the *track*, not along the road. It also covers
about half the width, which is what leaves the far lane open for anybody already
on the crossing to get off it.

`Vehicle.cruise` is now separate from `Vehicle.speed`, so a car stopped at a
crossing knows what to go back to — and so "parked" stays distinguishable from
"waiting", which look identical in a single frame and are not the same thing.

---

# A subdivision-sized scene

`scenes/whiteshell-sub.json`: 48 km of single main track, five signalled sidings
with dual-control switches at both ends, two industrial spurs with hand switches
and special derails, 40 signals, eight crossings — one with its warning system
out of order and two with a vehicle stopped on the rails. 63 km of railway in
all. About three quarters of an hour end to end.

It is **generated** rather than hand-written, which is a departure from "a scene
is a file you can write by hand". The generated file is still plain JSON that
diffs and edits like the others; what a script bought was the alignment
arithmetic — sixty-odd track segments joined at the right ports, each signal
resolved to a mileage on the right segment.

## Two more unbounded loops it exposed

**Trees, buildings and vehicles had no viewport cull at all.** On this scene that
was the entire frame: seven thousand trees at nine faces each, all drawn, nearly
all of them kilometres away. 223 ms and 67,000 faces became **46 ms and 8,500**.

**A big scene opens looking at nothing.** `Renderer` frames the whole world only
when the scene gives no `zoom`; give one and the focus stays at the default,
which on a 49 km scene is a corner of the map. The scene now names a focus. A
better default would be the first movement, and that is worth doing.

The RTC panel also needed bounding — forty signals is a wall of buttons, not a
control machine. It now offers controlled signals within nine kilometres of the
movement, nearest first, and rebuilds as the movement runs.

---

# Bridges, rivers, opposing trains, and a test at the station

## A bridge is defined by what it stops

`terraform` normally brings the ground up to meet the railhead, so a line
crossing a river valley would simply fill the valley in — there is a test that
asserts it does. A `BridgeSpec` excludes its stretch from the earthworks
(`TerraformOptions.spans`), tapered over an abutment so the embankment runs out
to nothing rather than ending in a wall, and what is left is a railhead in
mid-air with a hole under it. The trestle is what stands in the hole.

Spans are read **before** anything is cut. A span declared afterwards would
arrive to find its valley already filled.

The geometry is modelled — deck, bents, height above ground, and `onBridge` to
ask whether a movement is out over one. The structure is not: nothing carries
load, nothing fails, nothing washes out. A trestle here is a picture of a
trestle with correct dimensions.

## Water is level, and its banks are not a number

A river is not a road with a blue colour. A road follows the ground; water is
**level**, and a surface that undulated with the terrain would read as a painted
stripe. But a flat sheet at a fixed width runs visibly up a hillside, so each
bank is walked outward from the centre line until the ground rises above the
surface — the scene says how wide the river may be, and the ground decides how
wide it is. Where the course leaves the water entirely the banks collapse onto
the centre line and the renderer skips that reach.

## Opposing movements

`DESIGN-conductor.md` said this package gives you bodies, not agents, and that a
second person who always complies is a function call with a costume on. That is
still true of people. `dispatch.ts` is the narrow exception, for one reason: **a
railway with one train on it cannot teach you anything about signals.**

What an opposing movement has to do is small — read the signal in front of it,
slow for the ones that ask, stop at a Stop. **There is no dispatcher.** Where a
movement goes, and whether it takes the siding, is decided by the switches and
the signals exactly as on a railway. The moment this module starts choosing
which train takes the siding it has taken over the job the signals exist to do.

So the meet in the Whiteshell scene is arranged the way a real one is: Brereton's
east switch is lined reverse and its east signal works itself, so Q199 puts
*itself* away in the siding and is held by the dwarf at the west end. Nothing
decided that but the plant.

`obeySignals: false` is not an oversight. G881 runs past everything — it takes
out the stalled car at Sixth Line at 63 km/h on the way — and if M304 is still
standing on the main at Rennie when it arrives, it arrives. Being able to watch
that from the cab of the train it is coming at is the point of modelling signals.

Two things the tests pinned down. A **Stop is a place to be stopped short of,
not a speed** — the permitted speed approaching one is whatever you could still
stop from in the room left. And an **assumed braking rate you cannot achieve
overruns the signal**: told it can stop at 0.9 m/s², the driver runs straight
past the Stop it was braking for. That is why the default is a gentle 0.28.

## Consists need the power they would really have

A 4,570-tonne grain train behind one unit cannot start itself on a 1.6% grade,
and the physics correctly refused to let it — which showed up as an automatic
movement sitting still with the throttle wide open. The scene now writes its
consists out car by car with two or three units on the head end, because the
`templateCars` shorthand puts exactly one locomotive on anything.

## The signals test

At a station, because that is where you would take it. It uses the study tool's
own deck — the **cror-live** edition, whose indications carry the full wording,
which is a choice worth revisiting if this app is ever published.

It lives **entirely in the app**, and that boundary is the design. Sitting a test
is not a railway act: it changes nothing physical and emits no event. Putting it
in `World.actionsAt` would mean the rules layer could see a conductor "studying"
as though it were turning a switch. So the app checks the distance to a building
itself and offers its own button.

Each card's front is a set of *arguments* — mast, alignment, lamp colours top to
bottom, plates — not an image, so the signal is drawn from them in about sixty
lines of canvas and the deck stays a text file that diffs. Grading is by hand:
these are rote cards with long prose answers, and a string comparison would mark
"proceed at medium speed" wrong against "Proceed at MEDIUM speed".

## What this cost elsewhere

The `facing` field on 40 generated signals was `with`/`against`; the type is
`up`/`down`. They were silently defaulting, so none of them governed anything.
Worth remembering that a scene is JSON and JSON does not typecheck.
