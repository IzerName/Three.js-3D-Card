// ============================================================================
//  T-013 — glTF-анимации: loadGeometryEx + действие play в движке правил.
//
//  Фикстура test/fixtures/anim.gltf: два узла с мешами — именованный «Pivot»
//  (клип «walk»: сдвиг x от -1 до 1 за 1 с) и безымянный (клип «ghost»:
//  трек по uuid — в клоне модели не привязывается).
//
//  Загрузка модели — через настоящий GLTFLoader из dist (динамический
//  импорт vendor-заглушки разрешён только в собранных модулях), three.js —
//  из node_modules, рендерер — заглушка. Те же DOM-заглушки, что в
//  gltf-extras.test.js.
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

// Настоящий three.js — для честных узлов и unit-проверок миксера.
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

const FIXTURE_PATH = new URL("./fixtures/anim.gltf", import.meta.url);
const animText = await fs.readFile(FIXTURE_PATH, "utf8");

/** fetch, отдающий anim.gltf на заданном URL (у каждого теста — свой URL,
 *  потому что кэш геометрии процессный). */
function animFetch(fixtureUrl) {
  return async (reqOrUrl) => {
    const u = typeof reqOrUrl === "string" ? reqOrUrl
      : (reqOrUrl && reqOrUrl.url) ? String(reqOrUrl.url) : String(reqOrUrl);
    if (u === fixtureUrl) return new Response(animText, { status: 200 });
    if (u.startsWith("data:")) return nodeFetch(u);
    return new Response("", { status: 200 });
  };
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

/**
 * Сцена с моделью из anim.gltf и привязками play.
 * opts.reduced — имитация prefers-reduced-motion (до построения модели).
 */
async function makePlayEngine(bindings, opts = {}) {
  const { createObjectModel } = await import("../dist/src/core/object-model.js");
  const { SceneEngine } = await import("../src/core/scene.js");

  const realFetch = globalThis.fetch;
  const realMatchMedia = globalThis.window.matchMedia;
  if (opts.reduced) globalThis.window.matchMedia = () => ({ matches: true });
  globalThis.fetch = animFetch(opts.url);
  try {
    const entities = Object.fromEntries(bindings.map((b) => [b.entity, b.entity]));
    const model = createObjectModel({
      manifest: { id: opts.id || "anim-play", name: "Anim play" },
      source: { format: "gltf", url: opts.url },
      bindings,
    });
    const engine = new SceneEngine(new El("div"), {
      type: "custom:threejs-3d-card",
      entities,
    }, model, { THREE });
    await engine.init();
    return engine;
  } finally {
    globalThis.fetch = realFetch;
    globalThis.window.matchMedia = realMatchMedia;
  }
}

function runFrames(engine, n, dt = 0.016) {
  for (let i = 0; i < n; i++) engine._frame(dt);
}

const logLines = (engine) => engine.diagnostics().log;
const logErrors = (engine) => logLines(engine).filter((l) => l.startsWith("error:"));

// ---- loadGeometryEx ------------------------------------------------------------

test("loadGeometryEx: root + 2 клипа, новое клонирование на каждый вызов", async () => {
  const geo = await import("../dist/src/core/geometry.js");
  const url = "http://t013-a.local/anim.gltf";
  const realFetch = globalThis.fetch;
  globalThis.fetch = animFetch(url);
  try {
    const ctx = { THREE: THREE_REAL, report: () => {} };
    const loaded = await geo.loadGeometryEx(ctx, { format: "gltf", url });
    assert.ok(loaded.root, "root");
    assert.equal(loaded.animations.length, 2, "два клипа");
    const names = loaded.animations.map((a) => a.name).sort();
    assert.deepEqual(names, ["ghost", "walk"]);

    const walk = loaded.animations.find((a) => a.name === "walk");
    assert.equal(walk.duration, 1, "walk длится 1 с");
    assert.equal(walk.tracks.length, 1, "один трек");
    assert.equal(walk.tracks[0].name, "Pivot.position", "трёк по именованному узлу");

    const ghost = loaded.animations.find((a) => a.name === "ghost");
    assert.ok(ghost.tracks[0].name && !ghost.tracks[0].name.startsWith("Pivot"),
      "ghost — безымянный узел (имя трека — uuid)");

    assert.ok(findByName(loaded.root, "Pivot"), "Pivot есть в клоне");

    // Повторная загрузка: модель кэшируется, но клона возвращается новый
    // (каждая сцена — независимое дерево).
    const again = await geo.loadGeometryEx(ctx, { format: "gltf", url });
    assert.notEqual(again.root, loaded.root, "новое клонирование на каждый вызов");
    assert.equal(again.animations, loaded.animations, "клипы — общий кэшированный массив");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- e2e: state mode -------------------------------------------------------------

test("e2e: state — on проигрывает клип до конца, off — назад", async () => {
  const url = "http://t013-b.local/anim.gltf";
  const engine = await makePlayEngine(
    // clampWhenFinished: «дверь открылась и стоит» — поза держится на конце клипа.
    [{ entity: "switch.player", target: "Pivot", play: { clip: "walk", clampWhenFinished: true } }],
    { url, id: "anim-state" },
  );
  assert.deepEqual(logErrors(engine), [], `ошибки в диагностике: ${JSON.stringify(logErrors(engine))}`);

  const pivot = findByName(engine._modelHandle.root, "Pivot");
  assert.equal(pivot.position.x, 0, "старт — исходная поза");

  engine.applyStates({ "switch.player": { state: "on", attributes: {} } });
  runFrames(engine, 100);
  // LoopOnce: последний применённый кадр на 0.016 раньше конца клипа.
  assert.ok(Math.abs(pivot.position.x - 1) < 0.05, `on: клип отыгран до конца, x=${pivot.position.x}`);
  assert.ok(Math.abs(pivot.position.y - 0.5) < 1e-3, "y не менялась");

  engine.applyStates({ "switch.player": { state: "off", attributes: {} } });
  runFrames(engine, 100);
  assert.ok(Math.abs(pivot.position.x + 1) < 0.05, `off: клип отыгран назад, x=${pivot.position.x}`);

  engine.dispose();
});

// ---- e2e: value mode ---------------------------------------------------------------

test("e2e: value — позиция клипа из значения (0..valueMax, с ограничением)", async () => {
  const url = "http://t013-c.local/anim.gltf";
  const engine = await makePlayEngine(
    [{ entity: "number.progress", target: "Pivot", play: { clip: "walk", mode: "value" } }],
    { url, id: "anim-value" },
  );
  assert.deepEqual(logErrors(engine), [], `ошибки в диагностике: ${JSON.stringify(logErrors(engine))}`);

  const pivot = findByName(engine._modelHandle.root, "Pivot");
  const set = (state, frames) => {
    engine.applyStates({ "number.progress": { state, attributes: {} } });
    runFrames(engine, frames);
  };

  set("50", 300);
  assert.ok(Math.abs(pivot.position.x) < 0.01, `50 → середина клипа, x=${pivot.position.x}`);

  set("100", 300);
  assert.ok(Math.abs(pivot.position.x - 1) < 0.01, `100 → конец клипа, x=${pivot.position.x}`);

  set("0", 300);
  assert.ok(Math.abs(pivot.position.x + 1) < 0.01, `0 → начало клипа, x=${pivot.position.x}`);

  // valueMax по умолчанию 100: 150 ограничивается до 100.
  set("150", 300);
  assert.ok(Math.abs(pivot.position.x - 1) < 0.01, `150 ограничивается до 100, x=${pivot.position.x}`);

  engine.dispose();
});

// ---- e2e: unnamed clip ---------------------------------------------------------------

test("e2e: клип безымянного объекта — предупреждение, ошибок нет", async () => {
  const url = "http://t013-d.local/anim.gltf";
  const engine = await makePlayEngine(
    [{ entity: "switch.ghost", target: "Pivot", play: { clip: "ghost" } }],
    { url, id: "anim-ghost" },
  );
  const log = logLines(engine);
  assert.deepEqual(logErrors(engine), [], "непривязанный клип — не ошибка");
  assert.ok(log.some((l) => l.includes("назовите объекты в Blender")),
    `нет предупреждения про имена объектов: ${JSON.stringify(log)}`);

  // Играем клип: трек не привязан к клону, поза безымянного узла не меняется.
  const model = engine._modelHandle.root.children[0];
  const unnamed = model.children.find((c) => !c.name);
  assert.ok(unnamed, "безымянный узел есть в сцене");
  const beforeX = unnamed.position.x;
  engine.applyStates({ "switch.ghost": { state: "on", attributes: {} } });
  runFrames(engine, 30);
  assert.equal(unnamed.position.x, beforeX, "непривязанный трек не двигает узел");

  engine.dispose();
});

// ---- e2e: conflict play + door ----------------------------------------------------------

test("e2e: play и door на одном объекте — предупреждение, play выигрывает", async () => {
  const url = "http://t013-e.local/anim.gltf";
  const engine = await makePlayEngine(
    [{ entity: "switch.door", target: "Pivot",
       play: { clip: "walk", clampWhenFinished: true }, door: { hinge: "left", degrees: 90 } }],
    { url, id: "anim-conflict" },
  );
  const log = logLines(engine);
  assert.deepEqual(logErrors(engine), [], "конфликт — не ошибка");
  assert.ok(log.some((l) => l.includes("play и door заданы на один объект")),
    `нет предупреждения о конфликте: ${JSON.stringify(log)}`);

  const st = engine._modelHandle.ruleEngine.status();
  const doorSt = st.find((s) => s.action === "door");
  const playSt = st.find((s) => s.action === "play");
  assert.ok(doorSt && doorSt.playConflict, "door-правило помечено конфликтом");
  assert.ok(playSt && !playSt.playConflict, "play-правило не в конфликте");

  const pivot = findByName(engine._modelHandle.root, "Pivot");
  engine.applyStates({ "switch.door": { state: "on", attributes: {} } });
  runFrames(engine, 100);
  assert.ok(Math.abs(pivot.position.x - 1) < 0.05, `play отыграл клип, x=${pivot.position.x}`);
  const angle = quatAngle(new THREE_REAL.Quaternion(), pivot.quaternion);
  assert.ok(angle < 0.01, `door не вращал створку, угол ${angle.toFixed(3)} рад`);

  engine.dispose();
});

// ---- e2e: dispose -------------------------------------------------------------------------

test("e2e: dispose — миксер остановлен, поза возвращается к исходной", async () => {
  const url = "http://t013-f.local/anim.gltf";
  const engine = await makePlayEngine(
    [{ entity: "switch.dispose", target: "Pivot", play: { clip: "walk", clampWhenFinished: true } }],
    { url, id: "anim-dispose" },
  );
  const pivot = findByName(engine._modelHandle.root, "Pivot");
  engine.applyStates({ "switch.dispose": { state: "on", attributes: {} } });
  runFrames(engine, 100);
  assert.ok(Math.abs(pivot.position.x - 1) < 0.05, "клип отыгран");

  engine.dispose();
  assert.ok(Math.abs(pivot.position.x) < 1e-3, `x вернулся к исходному: ${pivot.position.x}`);
  assert.ok(Math.abs(pivot.position.y - 0.5) < 1e-3, "y исходная");
});

// ---- e2e: reduced motion ---------------------------------------------------------------------

test("e2e: reduced motion — поза сразу целевая, без проигрывания", async () => {
  const url = "http://t013-g.local/anim.gltf";
  const engine = await makePlayEngine(
    [{ entity: "switch.rm", target: "Pivot", play: { clip: "walk" } }],
    { url, id: "anim-reduced", reduced: true },
  );
  assert.equal(engine.reducedMotion, true, "движок определил reduced motion");
  const pivot = findByName(engine._modelHandle.root, "Pivot");

  engine.applyStates({ "switch.rm": { state: "on", attributes: {} } });
  runFrames(engine, 3);
  assert.ok(Math.abs(pivot.position.x - 1) < 0.05, `on: поза в конце клипа, x=${pivot.position.x}`);

  engine.applyStates({ "switch.rm": { state: "off", attributes: {} } });
  runFrames(engine, 3);
  assert.ok(Math.abs(pivot.position.x + 1) < 0.05, `off: поза в начале клипа, x=${pivot.position.x}`);

  engine.dispose();
});

// ---- e2e: loop repeat ---------------------------------------------------------------------------

test("e2e: loop repeat — клип зацикливается, а не останавливается в конце", async () => {
  const url = "http://t013-h.local/anim.gltf";
  const engine = await makePlayEngine(
    [{ entity: "switch.repeat", target: "Pivot", play: { clip: "walk", loop: "repeat" } }],
    { url, id: "anim-repeat" },
  );
  const pivot = findByName(engine._modelHandle.root, "Pivot");
  engine.applyStates({ "switch.repeat": { state: "on", attributes: {} } });
  runFrames(engine, 78); // 1.248 с: при once клип уже закончился бы (x ≈ 1)
  // repeat: 1.248 mod 1 ≈ 0.25 → x ≈ -1 + 2·0.25 = -0.5
  assert.ok(Math.abs(pivot.position.x + 0.5) < 0.15, `repeat: клип зациклен, x=${pivot.position.x}`);
  engine.dispose();
});

// ---- e2e: speed ------------------------------------------------------------------------------------

test("e2e: speed 2 — клип завершается вдвое быстрее", async () => {
  const url = "http://t013-i.local/anim.gltf";
  const engine = await makePlayEngine(
    [{ entity: "switch.speed", target: "Pivot", play: { clip: "walk", speed: 2, clampWhenFinished: true } }],
    { url, id: "anim-speed" },
  );
  const pivot = findByName(engine._modelHandle.root, "Pivot");
  engine.applyStates({ "switch.speed": { state: "on", attributes: {} } });
  runFrames(engine, 35); // 0.56 с: при speed 1 клип был бы на t ≈ 0.56 (x ≈ 0.12)
  assert.ok(Math.abs(pivot.position.x - 1) < 0.15, `speed 2: клип завершён, x=${pivot.position.x}`);
  engine.dispose();
});

// ---- unit: loop → AnimationAction --------------------------------------------------------------------

test("play: loop — once/repeat/pingpong/неизвестный → константы THREE", async () => {
  const { createRuleEngine } = await import("../src/core/object-rules.js");
  const T = THREE_REAL;

  const make = (loop) => {
    const model = new T.Group();
    const pivot = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial());
    pivot.name = "Pivot";
    model.add(pivot);
    const clip = new T.AnimationClip("walk", 1, [
      new T.VectorKeyframeTrack("Pivot.position", [0, 1], [0, 0, 0, 1, 0, 0]),
    ]);
    const mixer = new T.AnimationMixer(model);
    const reports = [];
    const ctx = { THREE: T, report: (lvl, msg) => reports.push([lvl, msg]) };
    createRuleEngine(
      { bindings: [{ entity: "s.x", target: "Pivot", play: { clip: "walk", loop } }] },
      ctx, model, { root: model, animations: [clip], mixer },
    );
    return { mixer, clip, reports };
  };

  const cOnce = make("once");
  assert.equal(cOnce.mixer.clipAction(cOnce.clip).loop, T.LoopOnce, "once → LoopOnce");
  assert.equal(cOnce.mixer.clipAction(cOnce.clip).repetitions, Infinity, "repetitions Infinity");

  const cRepeat = make("repeat");
  assert.equal(cRepeat.mixer.clipAction(cRepeat.clip).loop, T.LoopRepeat, "repeat → LoopRepeat");

  const cPing = make("pingpong");
  assert.equal(cPing.mixer.clipAction(cPing.clip).loop, T.LoopPingPong, "pingpong → LoopPingPong");

  const cWeird = make("weird");
  assert.equal(cWeird.mixer.clipAction(cWeird.clip).loop, T.LoopOnce, "неизвестный loop → LoopOnce");
  assert.ok(cWeird.reports.some(([lvl, m]) => lvl === "warn" && m.includes("неизвестный loop")),
    `нет предупреждения про неизвестный loop: ${JSON.stringify(cWeird.reports)}`);
});
