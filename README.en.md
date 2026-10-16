# Three.js 3D Card for Home Assistant

**One card, many 3D scenes.** The `custom:threejs-3d-card` Lovelace card renders
an interactive three.js scene driven by live Home Assistant state. A *model* — a
plain JavaScript ES module — declares its own variables, and the card's visual
editor builds the configuration form from that declaration, using Home
Assistant's native entity picker for device selection.

* three.js **ships with the card** — works fully offline (CDN is optional);
* install and updates through **HACS**, public releases and CI — repository:
  <https://github.com/IzerName/Three.js-3D-Card>;
* HACS installs a **single file**, `threejs-3d-card.js` in the repository root,
  with three.js, the format loaders, the card core and the built-in models
  inside;
* import **your own model JS file** straight from the card editor — no rebuild,
  no release required;
* documented model API: [docs/MODEL_API.md](docs/MODEL_API.md) (Russian).

---

## Installation

### HACS

1. HACS → **Frontend** → ⋮ → **Custom repositories** → add
   `https://github.com/IzerName/Three.js-3D-Card`, category **Dashboard**.
2. Download **Three.js 3D Card**.
3. HACS puts **one file**, `threejs-3d-card.js`, into
   `config/www/community/Three.js-3D-Card/` (the directory is the repository
   name verbatim, case included). That file is the single-file build: three.js
   r160, the OBJ/MTL/glTF loaders, the card core and the built-in models are all
   inside, so nothing else — no `src/`, `models/` or `vendor/` — is needed on
   the server. HACS registers the resource itself. If it did not, add one
   manually: `/hacsfiles/Three.js-3D-Card/threejs-3d-card.js`, type *JavaScript
   module*. HACS writes the same URL with a `?hacstag=…` version marker and
   updates that marker on every new release.
4. Hard-refresh the page and add the card.

> The case-sensitive directory name is a HACS detail, not a card requirement:
> the single-file build is self-contained, and the `dist/` layout (below) loads
> three.js and the models through relative paths, so it works from any folder.

### Manual

1. Take the single-file `threejs-3d-card.js` from the tag — the
   [v0.1.3 release](https://github.com/IzerName/Three.js-3D-Card/releases/tag/v0.1.3)
   (or the
   [file source](https://github.com/IzerName/Three.js-3D-Card/blob/v0.1.3/threejs-3d-card.js)
   on the tag) — and put it into `config/www/threejs-3d-card/`. The folder name
   may be anything: the single-file build is self-contained and needs nothing
   beside it.
2. Add a resource: `/local/threejs-3d-card/threejs-3d-card.js`,
   type *JavaScript module*.
3. Hard-refresh the page.

---

## Quick start

```yaml
type: custom:threejs-3d-card
model: water-tank
title: Clean water tank
height: 400
entities:
  level: sensor.water_preparation_level_clean_percentage
  liters: sensor.water_preparation_level_clean_liters
  counter: sensor.water_preparation_counter_clean_water
  high: binary_sensor.water_preparation_clean_high_sensor
  medium: binary_sensor.water_preparation_clean_medium_sensor
  low: binary_sensor.water_preparation_clean_low_sensor
params:
  full_value: 100
  max_liters: 200
  level_color: var(--color-2)
  probe_levels.high: 85
  probe_levels.medium: 50
  probe_levels.low: 25
```

Prefer the visual editor: it lists every binding of the selected model and lets
you pick an entity from a filtered dropdown, showing the current value live.

---

## Card options

| Option | Type | Default | Purpose |
|---|---|---|---|
| `model` | string | `water-tank` | Built-in model id or a URL of a model file |
| `model_url` | string | — | Explicit URL of an external model |
| `reload_model` | boolean | `false` | Re-read the model file (cache busting) |
| `allow_external_models` | boolean | `true` | Set `false` to forbid model URLs |
| `title` | string | from model | HUD title (`""` hides it) |
| `show_hud` | boolean | `true` | Show the HUD title |
| `height` | number | from model | Card height in pixels |
| `entities` | object | — | Bindings: `key: entity_id` |
| `params` | object | from model | Model settings (flat keys) |
| `camera` | object | from model | `radius`, `phi`, `theta`, `target`, `minRadius`, `maxRadius` |
| `environment` | object | from model | `floor`, `background`, `shadows`, … |
| `show_diagnostics` | boolean | `false` | Overlay with binding diagnostics |

Full reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

---

## Built-in models

| Model | Bindings | Scene |
|---|---|---|
| `water-tank` | `level` (required), `liters`, `counter`, `high`, `medium`, `low` | Horizontal tank, water level, 0–100 % gauge, three level probes, counter |
| `production-room` | `vru`, `water`, `water_flow`, `machine`, `light1`, `light2`, `fire`, `heater`, `ac`, `door`, `lux` | Top-down workshop view with animated equipment |

---

## Writing your own model

Put a file into `config/www/3d-models/my-model.js`, then select
**Model → “Import model by URL…”** in the card editor and enter
`/local/3d-models/my-model.js`.

```js

window.ThreeJS3DCard.defineModel({
  manifest: { id: "my-model", name: "My model", apiVersion: 1 },

  bindings: [
    { key: "power", name: "Power", domain: ["switch"], value: { kind: "boolean" } },
    { key: "level", name: "Level, %", domain: ["sensor"], unit: ["%"], value: { kind: "number" } },
  ],

  params: [
    { key: "color", name: "Colour", type: "theme-color", default: "var(--primary-color)" },
  ],

  create(ctx) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: ctx.resolveColor(ctx.params.color, "#1f6feb") })
    );
    mesh.position.y = 0.5;
    ctx.tag(mesh, "power");           // click opens the entity dialog

    return {
      root: mesh,
      applyStates(view) {
        const on = view.power && view.power.value;
        mesh.material.emissive.setHex(on ? 0x1f6feb : 0x000000);
        mesh.material.emissiveIntensity = on ? 0.6 : 0;
      },
      frame(dt) { mesh.rotation.y += dt * 0.5; },
      dispose() { mesh.geometry.dispose(); mesh.material.dispose(); },
    };
  },
});
```

Every field of `manifest`, `bindings`, `params` and the `ctx` object is
documented in [docs/MODEL_API.md](docs/MODEL_API.md).

> ⚠️ Model code runs inside your Home Assistant page with your session's
> privileges. Only load models you trust, or set
> `allow_external_models: false`.

---

## Development

```bash
npm install
npm run build     # build dist/ and the single-file threejs-3d-card.js in the root
npm run serve     # dev bench: http://localhost:8099/dev/harness.html
npm test          # unit and integration tests (185)
npm run check     # build + tests
```

The bench fakes `hass.states` with demo values, so scenes and the editor can be
checked without Home Assistant. It serves the release under
`/hacsfiles/threejs-3d-card/*` and `/local/threejs-3d-card/*`, and the
single-file build under `/bundle/threejs-3d-card.js` — those are bench URLs, not
an installation requirement.

`npm run build` produces **two layouts** from the same sources, and both must
behave identically:

* `threejs-3d-card.js` in the repository root — the **single-file build**
  (esbuild): three.js r160, the OBJ/MTL/glTF loaders, the card core and the
  built-in models inside one ~911 KB file. This is what HACS installs;
* `dist/` — the same card as plain ES modules (`dist/threejs-3d-card.js` plus
  `src/`, `models/`, `vendor/`). The dev bench serves it; the layout is
  committed to the repository and CI verifies it against the build. No bundler
  is involved here, which keeps browser debugging straightforward.

`dev/probe-bundle.html` checks the single-file build on the bench (module load,
element registration, API, three.js from inside the bundle, no requests to
`vendor/`, `src/` or `models/`, rendered frames); the other `dev/probe-*.html`
pages check the `dist/` layout.

### Releasing

1. Bump `version` in `package.json` and `CARD_VERSION` in
   `src/core/constants.js`, update `CHANGELOG.md`.
2. Run `npm run build` and commit the updated `dist/` **and the root
   `threejs-3d-card.js`** — HACS installs the files straight from the tag and
   never builds anything.
3. Tag `vX.Y.Z` and push: GitHub Actions
   ([.github/workflows/release.yml](.github/workflows/release.yml)) runs the
   tests, rebuilds both layouts, verifies that the committed `dist/` and bundle
   match the build (`git diff --exit-code -- dist threejs-3d-card.js`) and
   publishes the GitHub release **without file assets** — HACS takes the
   `threejs-3d-card.js` from the tag tree.
4. HACS picks up the new release; the resource needs no reinstall — HACS
   updates the `?hacstag=…` marker itself.

See [docs/HACS.md](docs/HACS.md) (Russian) for details.

---

## Repository layout

```
threejs-3d-card/
├─ hacs.json                    HACS manifest (filename: threejs-3d-card.js)
├─ threejs-3d-card.js           single-file build — committed, this is what HACS installs
├─ dist/                        ES-module layout: dev bench
│  ├─ threejs-3d-card.js        entry point (the Lovelace resource)
│  ├─ src/  models/             card core and models, same files as the sources
│  └─ vendor/                   three.js r160 + OBJ/MTL/glTF loaders
├─ src/                         card sources (card.js, editor.js, core/)
├─ models/                      built-in models: water-tank, production-room
├─ skills/threejs-3d-model/     agent skill: spec, validator, examples
├─ docs/                        MODEL_API, OBJECT_MODEL, CONFIGURATION, HACS
├─ dev/                         dev bench and browser self-check pages
├─ scripts/                     build.mjs (dist/ + root bundle), serve.mjs (dev server)
└─ test/                        unit and integration tests (185)
```

Both `dist/` and the root `threejs-3d-card.js` are produced by
`scripts/build.mjs` and committed. HACS looks for the `filename` in the
repository root on the tag and downloads the root `.js` files only — so the
root holds the single-file build, which needs nothing else on the server. The
`dist/` layout stays for the dev bench.

## Licence

MIT — see [LICENSE](LICENSE). three.js (MIT, © three.js authors) is bundled.
