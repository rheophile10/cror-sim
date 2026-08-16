# world-sim-app

One page that loads a `world-sim` scene, renders it isometrically, and lets you
drive the train in it.

```sh
npm install
npm run dev      # builds ../world-sim, then serves on :5173
npm run build    # one self-contained dist/index.html
```

`npm run build` produces a single HTML file with the library, the styles and
every bundled scene inlined. It opens from `file://`, offline, with nothing
fetched at runtime — the same constraint `track-viz`'s visualiser works under.

## Using it

- **Drag** to pan, **right-drag** or **shift-drag** to orbit and tilt, **wheel**
  to zoom about the cursor. `q`/`e` rotate, `+`/`-` zoom, `PageUp`/`PageDown`
  tilt, `space` pauses, `f` fits.
- **Throttle** and **automatic brake** drive the train; **Reverse** needs a stand
  first, as the rules do. **Emergency** shuts off and applies fully.
- **Stage a wreck** puts a car on the ground a third of the way back and lets the
  rest of the train run into it — the same code path a real derailment takes, so
  you can watch a pile-up without first having to earn one.
- **Crew** appears when a scene has people. The top row picks who — click again
  to deselect. The bottom row is what that person can do **from where they are
  standing**, which is the whole control scheme: you cannot act on what you are
  not at.
- **With somebody selected, click the ground to send them walking there.** The
  click becomes a place on the railway: the nearest point on any track, plus
  however far to one side you actually clicked, because standing four metres off
  the main is a different thing from standing on it. Clicking a switch in the
  Switches panel walks them to that switch instead of reaching in and throwing
  it. Half a kilometre is about seven minutes at 1×, so use the **Rate** control.
  Dragging still pans — only a click that barely moved counts.
- **Consist** lists the cars, with the couplings as narrow buttons between them.
  Clicking a car walks the selected person to it; clicking a coupling walks them
  to the joint, which is where cutting off is done — half a car length away, and
  the difference is why standing at the car is not standing at its coupler.
- **The driving controls grey out when nobody is in the cab** in an embodied
  scene. Walk somebody to the engine and *climb into the cab* to get them back.
  The throttle keeps whatever value it was left at: an unmanned engine with the
  throttle open is a real state and the simulation will not tidy it away.
- **Signal ahead** is the engineer's readout: the aspect, its rule number, its
  indication in full, how far off it is, what it permits passing it, and what to
  be ready for at the next one. Below it, any **controlled** signals in the scene
  get a button — that is the RTC's half of the job, standing in for a control
  machine. Automatic signals get no button, because there is nothing to press.
- **Signals passed** is the tape: every signal the movement went by, the aspect
  it was given on approach, and the speed. Running a Stop is recorded in red, not
  prevented.
- **Switches** appear in their own panel when a scene has any. Click one to throw
  it; green is lined for the straight route, amber for the diverging one. Every
  movement is re-routed the instant you do, including one already halfway
  through the turnout. A movement that trails through a switch lined against it
  bursts the points and goes on the ground.
- **Follow train** locks the camera to the head end. Any camera input releases it.
- **Scene JSON** opens the scene document. Edit it and press **Apply** to rebuild
  the world in place, keeping the camera. **Export** saves the running state
  (train positions and speeds included); **Import** loads a file back.
- The **L/V bar** under the telemetry is the derailment margin. When it turns
  amber you are running out of curve; past the limit the cars leave the rails,
  are thrown to the outside of the curve, land on the terrain and roll over. The
  **On the ground** row counts them, and how many ended up on their side.

## Scenes

`scenes/*.json`, inlined at build time by `import.meta.glob(..., '?raw')`. Drop a
new file in and it appears in the picker.

| scene | what it is for |
| --- | --- |
| `mountain-loop` | a continuous 2% loop cut through a saddle between two summits |
| `river-valley` | a point-to-point subdivision on a valley floor, water at 8 m |
| `summit-climb` | a heavy grade laid out to run a loaded train out of adhesion |
| `prairie-curve` | flat ground, a tight loop, a rear-heavy consist — find the L/V limit |
| `intermodal-crossing` | a stack train: wells running empty, single- and double-stacked |
| `derailment-curve` | holds at 110 km/h; open the throttle and the tank train goes over |
| `siding-meet` | a siding and two turnouts, with a train standing in it to meet |
| `blocked-crossing` | a stalled car the train destroys, and a rock truck that derails it |
| `wayside` | forest, a village, a highway with traffic, and a spring-switch mill spur |
| `signalled-siding` | block signals stepping back from a meet, flags, and a Special Derail |

## Where the code is

Almost nowhere. `src/main.ts` owns the animation loop and the DOM and nothing
else; everything of substance is in `../world-sim`. That split is deliberate —
the library has to stay usable from something that is not this page.
