// ============================================================================
//  T-012: привязки модели из glTF extras (кастомные свойства Blender).
//
//  Два слоя проверки:
//    * чистые функции src/core/gltf-extras.js — разбор GLB/.gltf JSON без
//      three.js и бинарных буферов, пометки t3d, сборка и слияние привязок,
//      discoverBindings описания модели (поля редактора ДО постройки сцены);
//    * полный путь на СБОРЕННЫХ копиях (dist/src/core/): createObjectModel
//      с bindingsFrom: { gltfExtras: true } → настоящий GLTFLoader
//      (фикстура test/fixtures/extras.gltf) → SceneEngine → состояния
//      «из Home Assistant» → свет, цвет, вращение, дверь.
//
//  Фикстура содержит ВСЕ варианты пометок: вложенная t3d (Lamp_Kitchen),
//  плоская t3d_* (Door_Front), t3d без entity_id (Fan_Bathroom),
//  проигрывание клипа (Sensor_Plane: play + clip «walk», T-013),
//  t3d без действий (Empty_Mark), посторонние extras (Plain_Wall — игнорируется).
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

// ---- минимальный DOM (как в object-model.test.js) ---------------------------

class El {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = { cssText: "", display: "" };
    this.dataset = {};
    this.className = "";
    this._listeners = {};
  }
  appendChild(n) { this.children.push(n); if (n) n.parentNode = this; return n; }
  insertBefore(n) { this.children.push(n); if (n) n.parentNode = this; return n; }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); return n; }
  remove() {}
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener() {}
  dispatchEvent() { return true; }
  setPointerCapture() {}
  releasePointerCapture() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getRootNode() { return this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 300 }; }
  getContext() {
    return {
      font: "", fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1,
      textAlign: "", textBaseline: "",
      measureText: () => ({ width: 40 }),
      clearRect() {}, fillRect() {}, fillText() {}, strokeRect() {},
      beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
      arcTo() {}, arc() {}, roundRect() {}, save() {}, restore() {}, drawImage() {},
      createRadialGradient: () => ({ addColorStop() {} }),
    };
  }
  get clientWidth() { return 400; }
  get clientHeight() { return 300; }
  get textContent() { return ""; }
  set textContent(v) {}
  get innerHTML() { return ""; }
  set innerHTML(v) {}
}

globalThis.document = {
  head: new El("head"),
  body: new El("body"),
  documentElement: new El("html"),
  createElement: (t) => new El(t),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = {
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
globalThis.Element = El;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
globalThis.ProgressEvent = class {
  constructor(type, init = {}) {
    this.type = type;
    this.lengthComputable = !!init.lengthComputable;
    this.loaded = init.loaded || 0;
    this.total = init.total || 0;
  }
};
// Нативный fetch Node — для data: URL: GLTFLoader читает встроенные буферы
// (uri: "data:...;base64,...") через глобальный fetch.
const nodeFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "" });

// Настоящий three.js — для честных узлов в collectUserDataMarks.
const THREE_REAL = await import("three");

class FakeRenderer {
  constructor(params = {}) {
    this.domElement = params.canvas || new El("canvas");
    this.shadowMap = { enabled: false, type: 0, needsUpdate: false };
    this.info = { render: { calls: 0, triangles: 0 }, memory: {} };
    this.capabilities = { maxTextures: 16 };
    this.toneMapping = 0;
    this.toneMappingExposure = 1;
    this.renders = 0;
  }
  setSize() {}
  setPixelRatio() {}
  setClearColor() {}
  render() { this.renders++; }
  dispose() { this.disposed = true; }
  forceContextLoss() {}
  getContext() { return { isContextLost: () => false }; }
}

const THREE = Object.assign(Object.create(null), THREE_REAL, { WebGLRenderer: FakeRenderer });

// ---- фикстура и fetch-заглушки -----------------------------------------------

const FIXTURE_PATH = new URL("./fixtures/extras.gltf", import.meta.url);
const fixtureText = await fs.readFile(FIXTURE_PATH, "utf8");

/** fetch, отдающий фикстуру на URL с фиксированным суффиксом. */
function fixtureFetch(fixtureUrl) {
  return async (reqOrUrl) => {
    const u = typeof reqOrUrl === "string" ? reqOrUrl
      : (reqOrUrl && reqOrUrl.url) ? String(reqOrUrl.url) : String(reqOrUrl);
    if (u === fixtureUrl) return new Response(fixtureText, { status: 200 });
    if (u.startsWith("data:")) return nodeFetch(u);
    return new Response("", { status: 200 });
  };
}

/** Минимальный валидный GLB: заголовок + один JSON-чанк. */
function buildGlb(json, pad = 0x20) {
  let body = new TextEncoder().encode(JSON.stringify(json));
  while (body.length % 4 !== 0) body = new Uint8Array([...body, pad]);
  const total = 12 + 8 + body.length;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x46546c67, true);   // "glTF"
  dv.setUint32(4, 2, true);            // version
  dv.setUint32(8, total, true);        // length
  dv.setUint32(12, body.length, true); // длина чанка
  dv.setUint32(16, 0x4e4f534a, true);  // "JSON"
  new Uint8Array(buf, 20).set(body);
  return buf;
}

function makeMesh(name) {
  const mesh = new THREE_REAL.Mesh(
    new THREE_REAL.BoxGeometry(1, 1, 1),
    new THREE_REAL.MeshStandardMaterial({ color: 0x38383d, roughness: 0.85 }),
  );
  mesh.name = name;
  return mesh;
}

function findByName(root, name) {
  let found = null;
  root.traverse((n) => { if (n.name === name && !found) found = n; });
  return found;
}

function quatAngle(a, b) {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, dot));
}

function lights(root) {
  const out = [];
  root.traverse((n) => { if (n.isLight) out.push(n.intensity); });
  return out.length ? out : [0];
}

// ---- readGltfExtras: GLB и .gltf --------------------------------------------

test("readGltfExtras: GLB с padding 0x20 и 0x00", async () => {
  const { readGltfExtras } = await import("../src/core/gltf-extras.js");
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0, 1, 2] }],
    nodes: [
      { name: "LampA", extras: { t3d: { entity: "light.a", action: "light", lumens: 600 } } },
      { name: "FanB", extras: { t3d_entity: "fan.b", t3d_action: "rotate" } },
      { name: "WallC" },
    ],
  };
  for (const pad of [0x20, 0x00]) {
    const nodes = await readGltfExtras("http://t.local/a.glb",
      async () => new Response(buildGlb(json, pad)));
    assert.equal(nodes.length, 3, `pad 0x${pad.toString(16)}: все именованные узлы`);
    assert.deepEqual(nodes[0], { name: "LampA", extras: json.nodes[0].extras });
    assert.deepEqual(nodes[1].extras, json.nodes[1].extras);
    assert.equal(nodes[2].extras, null, "узел без extras — null");
  }
});

test("readGltfExtras: .gltf — обычный JSON-файл", async () => {
  const { readGltfExtras } = await import("../src/core/gltf-extras.js");
  const nodes = await readGltfExtras("http://t.local/a.gltf",
    async () => new Response(fixtureText));
  const names = nodes.map((n) => n.name);
  assert.deepEqual(names, ["Lamp_Kitchen", "Door_Front", "Fan_Bathroom", "Sensor_Plane", "Empty_Mark", "Plain_Wall"]);
  assert.deepEqual(nodes[0].extras, {
    t3d: { entity: "light.kitchen", action: "light", name: "Лампа", lumens: 800, on: "#ffd9a0", off: "#3a3a3a" },
  });
});

test("readGltfExtras: 404, битый JSON и не glTF — понятные ошибки", async () => {
  const { readGltfExtras } = await import("../src/core/gltf-extras.js");
  await assert.rejects(
    () => readGltfExtras("http://t.local/404.gltf", async () => new Response("nf", { status: 404 })),
    /не удалось прочитать файл модели \(404\)/,
  );
  await assert.rejects(
    () => readGltfExtras("http://t.local/bad.gltf", async () => new Response("это не json", { status: 200 })),
    Error,
  );
  const junk = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10]);
  await assert.rejects(
    () => readGltfExtras("http://t.local/junk.bin", async () => new Response(junk)),
    Error,
  );
});

// ---- extrasToBindings: пометки → привязки ------------------------------------

test("extrasToBindings: фикстура — 5 привязок, 1 предупреждение", async () => {
  const { readGltfExtras, extrasToBindings } = await import("../src/core/gltf-extras.js");
  const nodes = await readGltfExtras("http://t.local/extras.gltf", fixtureFetch("http://t.local/extras.gltf"));
  const res = extrasToBindings(nodes);

  assert.equal(res.markedCount, 5, "Plain_Wall без t3d не пометка");
  assert.equal(res.bindings.length, 5);

  const byKey = Object.fromEntries(res.bindings.map((b) => [b.key, b]));
  assert.deepEqual(Object.keys(byKey).sort(),
    ["Empty_Mark", "Fan_Bathroom", "Sensor_Plane", "cover.front_door", "light.kitchen"]);

  // Вложенная пометка: лампа со светом и цветом.
  const lamp = byKey["light.kitchen"];
  assert.equal(lamp.entity, "light.kitchen");
  assert.equal(lamp.name, "Лампа");
  assert.equal(lamp.target, "Lamp_Kitchen");
  assert.deepEqual(lamp.actions, [
    { action: "light", lumens: 800 },
    { action: "color", colors: { on: "#ffd9a0", off: "#3a3a3a" } },
  ]);

  // Плоская пометка: дверь.
  const door = byKey["cover.front_door"];
  assert.equal(door.target, "Door_Front");
  assert.deepEqual(door.actions, [{ action: "door", hinge: "left", degrees: 95 }]);

  // Без entity_id: ключ = имя объекта, сущность выберет пользователь.
  const fan = byKey["Fan_Bathroom"];
  assert.equal(fan.entity, "");
  assert.equal(fan.name, "Вентилятор");
  assert.deepEqual(fan.actions, [{ action: "rotate", axis: "y", round_per_second: 1 }]);

  // T-013: play — известное действие, клип берётся из пометки.
  const sensor = byKey["Sensor_Plane"];
  assert.deepEqual(sensor.actions, [{ action: "play", clip: "walk" }]);

  // Пометка без действий — предупреждение.
  const empty = byKey["Empty_Mark"];
  assert.equal(empty.name, "Пустая пометка");
  assert.deepEqual(empty.actions, []);

  // Осталось одно предупреждение: Empty_Mark без действий.
  assert.equal(res.warnings.length, 1);
  assert.ok(res.warnings.some((w) => w.includes("пометка t3d без действий")),
    `нет предупреждения о пустой пометке: ${JSON.stringify(res.warnings)}`);
});

test("extrasToBindings: вложенная t3d перекрывает плоские t3d_* поля", async () => {
  const { extrasToBindings } = await import("../src/core/gltf-extras.js");
  const res = extrasToBindings([{
    name: "X",
    extras: { t3d_entity: "flat.x", t3d: { entity: "nested.y", action: "light", lumens: 10 } },
  }]);
  assert.equal(res.bindings.length, 1);
  assert.equal(res.bindings[0].key, "nested.y", "вложенная сущность побеждает");
  assert.equal(res.bindings[0].entity, "nested.y");
});

test("extrasToBindings: вложенный t3d с key — тег карточки, не пометка", async () => {
  const { extrasToBindings } = await import("../src/core/gltf-extras.js");
  const res = extrasToBindings([{
    name: "Tagged",
    extras: { t3d: { key: "light.a", entity: "light.a" } },
  }]);
  assert.equal(res.markedCount, 0);
  assert.deepEqual(res.bindings, []);
});

test("extrasToBindings: два объекта одной сущности — одна привязка, target-список", async () => {
  const { extrasToBindings } = await import("../src/core/gltf-extras.js");
  const res = extrasToBindings([
    { name: "LampA", extras: { t3d: { entity: "light.hall", action: "light", lumens: 400 } } },
    { name: "LampB", extras: { t3d: { entity: "light.hall", action: "light", lumens: 600 } } },
  ]);
  assert.equal(res.bindings.length, 1);
  const b = res.bindings[0];
  assert.deepEqual(b.target, ["LampA", "LampB"]);
});

test("extrasToBindings: hide и text — поля действия готовы к правилу", async () => {
  const { extrasToBindings } = await import("../src/core/gltf-extras.js");
  const res = extrasToBindings([
    { name: "Panel", extras: { t3d: { entity: "scene.dusk", action: "hide", hide: ["off", "closed"] } } },
    { name: "Label", extras: { t3d: { entity: "text.status", action: "text", template: "{{ state }} {{ unit }}", name: "Статус" } } },
    { name: "Always", extras: { t3d: { entity: "light.always", action: "hide", hide: true } } },
  ]);
  assert.deepEqual(res.warnings, [], "предупреждений нет");
  assert.equal(res.markedCount, 3);
  const byKey = Object.fromEntries(res.bindings.map((x) => [x.key, x]));
  assert.deepEqual(byKey["scene.dusk"].actions,
    [{ action: "hide", hidden: { states: ["off", "closed"], invert: false } }],
    "hide-список — предразобранный предикат");
  assert.deepEqual(byKey["text.status"].actions,
    [{ action: "text", template: "{{ state }} {{ unit }}" }]);
  assert.deepEqual(byKey["light.always"].actions,
    [{ action: "hide", hidden: { states: ["off", "closed", "unavailable", "unknown"], invert: true } }],
    "hide: true — инверсия типовых состояний");
  assert.equal(byKey["text.status"].name, "Статус", "авторское имя из пометки");
});

// ---- collectUserDataMarks: путь рантайма -------------------------------------

test("collectUserDataMarks: вложенные и плоские пометки, тег и чистые узлы мимо", async () => {
  const { collectUserDataMarks } = await import("../src/core/gltf-extras.js");
  const g = new THREE_REAL.Group();

  const lamp = makeMesh("Lamp");
  lamp.userData = { t3d: { entity: "light.x", action: "light", lumens: 100 } };

  const fan = makeMesh("Fan");
  fan.userData.t3d_entity = "fan.y";
  fan.userData.t3d_action = "rotate";

  // Ветка карточки (ctx.tag) — НЕ пометка автора.
  const tagged = makeMesh("Tagged");
  tagged.userData.t3d = { key: "light.x", entity: "light.x" };

  const plain = makeMesh("Plain");
  plain.userData.comment = "не t3d";

  g.add(lamp, fan, tagged, plain);
  const marks = collectUserDataMarks(g);
  assert.deepEqual(marks.map((m) => m.name), ["Lamp", "Fan"]);
  assert.equal(marks[0].extras.t3d.entity, "light.x");
  assert.equal(marks[1].extras.t3d_entity, "fan.y");
});

// ---- слияние ------------------------------------------------------------------

test("mergeBindingsExtras: приоритет у спека, конфликт — предупреждение", async () => {
  const { mergeBindingsExtras } = await import("../src/core/gltf-extras.js");
  const reports = [];
  const spec = [
    { entity: "light.kitchen", target: "Lamp_Kitchen", colors: { on: "#ffffff", off: "#000000" } },
    { entity: "fan.bathroom", target: "Fan_Bathroom" },
  ];
  const extras = [
    { key: "light.kitchen", entity: "light.kitchen", name: "Лампа", target: "Lamp_Kitchen", actions: [], _source: "extras" },
    { key: "cover.front_door", entity: "cover.front_door", name: "Door_Front", target: "Door_Front", actions: [], _source: "extras" },
  ];
  const merged = mergeBindingsExtras(spec, extras, (m) => reports.push(m));
  assert.equal(reports.length, 1);
  assert.match(reports[0], /конфликт привязок: «light\.kitchen»/);
  // Спека побеждает: цвета из спека, а не пустые actions из extras.
  assert.equal(merged[0].colors.on, "#ffffff");
  assert.equal(merged.length, 3);
  assert.equal(merged[2].key, "cover.front_door");
});

test("mergeEditorBindings: дубли ключей не добавляются, спека побеждает", async () => {
  const { mergeEditorBindings } = await import("../src/core/gltf-extras.js");
  const spec = [{ key: "light.kitchen", name: "Спека-лампа", entity: "light.kitchen" }];
  const extras = [
    { key: "light.kitchen", name: "Extras-лампа" },
    { key: "Fan_Bathroom", name: "Вентилятор" },
  ];
  const merged = mergeEditorBindings(spec, extras);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].name, "Спека-лампа");
  assert.equal(merged[1].key, "Fan_Bathroom");
});

// ---- discoverBindings: редактор читает файл ДО сцены --------------------------

test("discoverBindings: редактор-форма из файла, normalizeBindings без ошибок", async () => {
  const { createObjectModel } = await import("../src/core/object-model.js");
  const { normalizeBindings } = await import("../src/core/bindings.js");

  const model = createObjectModel({
    manifest: { id: "extras-unit", name: "Extras unit" },
    source: { format: "gltf", url: "http://unit.local/extras.gltf" },
    bindingsFrom: { gltfExtras: true },
  });
  assert.equal(typeof model.discoverBindings, "function", "discoverBindings в описании");
  assert.equal(typeof model.defaultEntities, "function");

  const disc = await model.discoverBindings({ fetch: fixtureFetch("http://unit.local/extras.gltf") });
  assert.equal(disc.bindings.length, 5);
  // T-013: play из пометки стал известным действием — предупреждений только
  // об Empty_Mark (пометка без действий).
  assert.equal(disc.warnings.length, 1);

  // Форма совместима с редактором: normalizeBindings не бросает (ключи уникальны).
  const norm = normalizeBindings(disc.bindings);
  assert.equal(norm.length, 5);

  const byKey = Object.fromEntries(norm.map((b) => [b.key, b]));
  const lamp = byKey["light.kitchen"];
  assert.equal(lamp.entity, "light.kitchen", "автозаполнение сущности из пометки");
  assert.deepEqual(lamp.domain, ["light"]);
  assert.equal(lamp.required, true, "без сущности — предупреждение редактора");
  assert.match(lamp.hint, /Lamp_Kitchen/);

  const fan = byKey["Fan_Bathroom"];
  assert.equal(fan.entity, "", "без entity_id — пользователь выбирает");
  assert.deepEqual(fan.domain, []);
});

test("discoverBindings: без bindingsFrom.gltfExtras метода нет", async () => {
  const { createObjectModel } = await import("../src/core/object-model.js");
  const model = createObjectModel({
    manifest: { id: "no-extras", name: "No extras" },
    source: { format: "gltf", url: "http://unit.local/a.gltf" },
  });
  assert.equal(model.discoverBindings, undefined);
});

test("discoverBindings: нечитаемый файл — предупреждение, не исключение", async () => {
  const { createObjectModel } = await import("../src/core/object-model.js");
  const model = createObjectModel({
    manifest: { id: "extras-404", name: "404" },
    source: { format: "gltf", url: "http://unit.local/missing.gltf" },
    bindingsFrom: { gltfExtras: true },
  });
  const disc = await model.discoverBindings({
    fetch: async () => new Response("nf", { status: 404 }),
  });
  assert.deepEqual(disc.bindings, []);
  assert.equal(disc.warnings.length, 1);
  assert.match(disc.warnings[0], /не удалось прочитать файл модели \(404\)/);
});

test("discoverBindings: не glTF-модель — предупреждение, не исключение", async () => {
  const { createObjectModel } = await import("../src/core/object-model.js");
  const model = createObjectModel({
    manifest: { id: "extras-obj", name: "OBJ" },
    source: { format: "obj", url: "http://unit.local/a.obj" },
    bindingsFrom: { gltfExtras: true },
  });
  const disc = await model.discoverBindings({ fetch: fixtureFetch("http://unit.local/a.obj") });
  assert.deepEqual(disc.bindings, []);
  assert.match(disc.warnings[0], /доступны только для glTF\/GLB/);
});

// ---- e2e: GLTFLoader + SceneEngine + состояния --------------------------------
//
// object-model.js берём из dist/src/core: только там литеральный динамический
// импорт ../../vendor/three-addons/loaders/GLTFLoader.js разрешается (в дереве
// исходников vendor/ нет — его создаёт сборка). dist/src побайтово совпадает
// с src (publish.test.js).

test("e2e: extras-привязки через настоящий GLTFLoader и SceneEngine", async () => {
  const { createObjectModel } = await import("../dist/src/core/object-model.js");
  const { SceneEngine } = await import("../src/core/scene.js");
  const { mergeEditorBindings } = await import("../src/core/gltf-extras.js");

  const FIXTURE_URL = "http://e2e.local/extras.gltf";
  const realFetch = globalThis.fetch;
  globalThis.fetch = fixtureFetch(FIXTURE_URL);
  try {
    const model = createObjectModel({
      manifest: { id: "extras-e2e", name: "Extras E2E" },
      source: { format: "gltf", url: FIXTURE_URL },
      bindingsFrom: { gltfExtras: true },
    });

    // Имитация редактора: поля привязок ДО постройки сцены, затем
    // автозаполненное конфигурацией entities.
    const disc = await model.discoverBindings({
      fetch: globalThis.fetch,
      asset: (rel) => new URL(rel, "http://e2e.local/").href,
    });
    assert.equal(disc.bindings.length, 5);
    model.bindings = mergeEditorBindings(model.bindings, disc.bindings);

    const engine = new SceneEngine(new El("div"), {
      type: "custom:threejs-3d-card",
      entities: {
        "light.kitchen": "light.kitchen",
        "Fan_Bathroom": "fan.bathroom",
        "cover.front_door": "cover.front_door",
      },
    }, model, { THREE });
    await engine.init();

    // Диагностический журнал create():
    const log = engine.diagnostics().log;
    const errors = log.filter((l) => l.startsWith("error:"));
    assert.deepEqual(errors, [], `ошибки в диагностике: ${JSON.stringify(errors)}`);
    assert.ok(log.some((l) => l.includes("объектов с пометками t3d — 5, привязок из extras — 5")),
      `нет отчёта о пометках: ${JSON.stringify(log)}`);
    // T-013: play-правило создано, но в extras.gltf нет ни одного клипа —
    // предупреждение о непривязанном клипе.
    assert.ok(log.some((l) => l.includes("клип «walk» не найден в модели")),
      "нет предупреждения о непривязанном клипе");
    assert.ok(log.some((l) => l.includes("пометка t3d без действий")), "нет предупреждения о пустой пометке");
    assert.ok(log.some((l) => l.includes("сущность не задана — выберите её в редакторе")),
      "нет подсказки про выбор сущности в редакторе");

    // Движок правил собрал все 5 ключей (включая без entity_id — ключ = имя).
    const desc = engine._modelHandle.ruleEngine.describe();
    const byKey = Object.fromEntries(desc.map((d) => [d.entityKey, d]));
    assert.deepEqual(Object.keys(byKey).sort(),
      ["Empty_Mark", "Fan_Bathroom", "Sensor_Plane", "cover.front_door", "light.kitchen"]);
    assert.deepEqual(byKey["light.kitchen"].actions, ["light", "color"]);
    assert.equal(byKey["light.kitchen"].targets[0], "Lamp_Kitchen");
    assert.deepEqual(byKey["cover.front_door"].actions, ["door"]);
    assert.deepEqual(byKey["Fan_Bathroom"].actions, ["rotate"]);
    assert.deepEqual(byKey["Sensor_Plane"].actions, ["play"], "T-013: play-правило создано (клип не найден — предупреждением)");
    assert.deepEqual(byKey["Empty_Mark"].actions, []);

    const handle = engine._modelHandle;
    const lamp = findByName(handle.root, "Lamp_Kitchen");
    const fan = findByName(handle.root, "Fan_Bathroom");
    const door = findByName(handle.root, "Door_Front");
    assert.ok(lamp && fan && door, "объекты найдены в загруженной сцене");
    // Стартовый цвет — серый из material файла (baseColorFactor 0.75). Точный
    // hex зависит от ColorManagement three (sRGB/linear), поэтому проверяем
    // смысл: это не on-цвет пометки и не белый.
    const startHex = lamp.material.color.getHexString();
    assert.notEqual(startHex, "ffd9a0", "стартовый цвет — не on-цвет пометки");
    assert.notEqual(startHex, "ffffff", "стартовый цвет — не белый");

    // Состояния «из Home Assistant».
    const changed = engine.applyStates({
      "light.kitchen": { state: "on", attributes: { brightness: 200 } },
      "fan.bathroom": { state: "on", attributes: {} },
      "cover.front_door": { state: "open", attributes: {} },
    });
    assert.ok(changed, "bus принял состояния");

    for (let i = 0; i < 400; i++) engine._frame(0.016);

    // Лампа: точечный свет загорелся, материал окрасился в цвет из пометки.
    assert.ok(Math.max(...lights(handle.root)) > 0, "точечный свет лампы горит");
    const lampHex = lamp.material.color.getHexString();
    assert.notEqual(lampHex, startHex, "цвет лампы изменился");
    // Roundtrip set("#ffd9a0") → getHexString() стабилен в three.
    assert.equal(lampHex, "ffd9a0", `цвет лампы — on-цвет из пометки, фактически #${lampHex}`);

    // Вентилятор: вращение — сущность под ключом ИМЕНИ объекта (фикс entityKey).
    assert.notEqual(fan.rotation.y, 0, "вентилятор вращается по состоянию fan.bathroom");

    // Дверь: поворот кватерниона от плоского маркера t3d_*.
    const doorAngle = quatAngle(new THREE_REAL.Quaternion(), door.quaternion);
    assert.ok(doorAngle > 0.8, `дверь повернулась примерно на 95°, угол ${doorAngle.toFixed(2)} рад`);

    engine.dispose();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("e2e: конфликт спека и extras — приоритет у спека, цвета из спека", async () => {
  const { createObjectModel } = await import("../dist/src/core/object-model.js");
  const { SceneEngine } = await import("../src/core/scene.js");

  const FIXTURE_URL = "http://e2e2.local/extras.gltf";
  const realFetch = globalThis.fetch;
  globalThis.fetch = fixtureFetch(FIXTURE_URL);
  try {
    const model = createObjectModel({
      manifest: { id: "extras-conflict", name: "Conflict" },
      source: { format: "gltf", url: FIXTURE_URL },
      bindingsFrom: { gltfExtras: true },
      // Спека объявила ту же сущность со СВОИМИ цветами — она побеждает.
      bindings: [
        { entity: "light.kitchen", target: "Lamp_Kitchen", colors: { on: "#ffffff", off: "#000000" } },
      ],
    });

    const engine = new SceneEngine(new El("div"), {
      type: "custom:threejs-3d-card",
      entities: { "light.kitchen": "light.kitchen" },
    }, model, { THREE });
    await engine.init();

    const log = engine.diagnostics().log;
    assert.ok(log.some((l) => l.includes("конфликт привязок: «light.kitchen» задана и в спецификации модели, и в extras")),
      `нет предупреждения о конфликте: ${JSON.stringify(log)}`);

    // У light.kitchen только правила спека (color), light-правило из extras не добавилось.
    const desc = engine._modelHandle.ruleEngine.describe();
    const lamp = desc.find((d) => d.entityKey === "light.kitchen");
    assert.deepEqual(lamp.actions, ["color"]);

    // Цвет из спека, а не из extras.
    const handle = engine._modelHandle;
    const lampMesh = findByName(handle.root, "Lamp_Kitchen");
    engine.applyStates({ "light.kitchen": { state: "on", attributes: {} } });
    for (let i = 0; i < 300; i++) engine._frame(0.016);
    assert.equal(lampMesh.material.color.getHexString(), "ffffff", "победили цвета спека");

    engine.dispose();
  } finally {
    globalThis.fetch = realFetch;
  }
});
