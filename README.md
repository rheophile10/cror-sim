# cror-sim

A railway simulated physically: isometric terrain, track graded onto it, and
trains running over that track under Newtonian train dynamics — couplers with
slack, adhesion-limited tractive effort, and derailments that throw a car off the
rail and let the rest of the train pile into it.

**[Open the simulator →](https://rheophile10.github.io/cror-sim/)**

Two packages, and the split between them is deliberate:

| | |
| --- | --- |
| [`world-sim/`](world-sim) | the library. No runtime dependencies, no DOM outside `src/render/`. A whole scene — landscape, alignment, consist, signals, camera — is one JSON document that round-trips back to one. |
| [`world-sim-app/`](world-sim-app) | the viewer. `src/main.ts` owns the animation loop and the DOM and nothing else; everything of substance is in the library. |

```sh
cd world-sim-app
npm install
npm run dev      # builds ../world-sim, then serves on :5173
npm run build    # one self-contained dist/index.html
```

`npm run build` emits a single HTML file with the library, the styles and every
bundled scene inlined. It opens from `file://`, offline, with nothing fetched at
runtime — which is also why it deploys to GitHub Pages as one artifact and needs
no base-path configuration.

Run the library's tests with `npm test` in `world-sim/`, and render a scene to a
PNG through headless Chrome — the real renderer, not a re-implementation — with
`node scripts/render-png.mjs`.

## What it is for

This is the physical half of a larger body of work on the Canadian Rail Operating
Rules. It knows where everything is and what happens when it moves; it does not
know what the rules require of it. A signal here is displayed, not obeyed — a
movement runs straight past a Stop, because whether it should have is a question
for a rules model that lives elsewhere. The switch and derail state this library
carries (`secured`, `locked`, `target`, `spiked`, `clearancePoint`, `handMode`)
exists to be read by that layer.

See [`world-sim/README.md`](world-sim/README.md) for what the simulation does in
detail, the scene JSON schema, and an honest list of what it does not do yet.

## cror.ca

The published site is assembled in [`site/`](site): a menu at the root with the
viewer above at `sim/`, the conductor game at `game/`, Ballast (the test
system) at `ballast/` and its tutorial at `tutorial/`. The game and Ballast come from local projects, so their
builds are committed in `site/vendor/`:

```sh
npm run pack --prefix site                                            # refresh site/vendor from ../../conductor-gameand ../../ballast
npm run build --prefix world-sim-app && npm run build --prefix site   # site/dist
npm test --prefix site                                                # Chromium, file:// and http
```
