// ============================================================================
//  Контракт модели глазами SceneEngine.
//
//  Проверяет то, что нельзя проверить тестами адаптеров: движок карточки
//  обязан сообщать модели об изменениях через applyState(key, info), а не
//  через какой-либо другой метод. Именно эта ошибка (модель реализовала
//  applyState, движок звал applyStates) оставляла сцену бака на нуле.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";

// ---- минимальный DOM --------------------------------------------------------

class El {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = { cssText: "", display: "" };
    this.dataset = {};
    this.className = "";
    this.shadowRoot = null;
    this._listeners = {};
  }
  appendChild(n) { this.children.push(n); if (n) n.parentNode = this; return n; }
  insertBefore(n) { this.children.push(n); if (n) n.parentNode = this; return n; }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); return n; }
  remove() {}
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getRootNode() { return this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 300 }; }
  getContext() { return null; }
  getBoundingClientRect2() {}
  get clientWidth() { return 400; }
  get clientHeight() { return 300; }
  get textContent() { return ""; }
  set textContent(v) { /* noop */ }
  get innerHTML() { return ""; }
  set innerHTML(v) { /* noop */ }
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

// ---- минимальный three.js ---------------------------------------------------

const anyClass = (name) =>
  class {
    constructor(...a) {
      this.args = a;
      this.children = [];
      this.userData = {};
      this.position = vec();
      this.rotation = vec();
      this.scale = Object.assign(vec(), { setScalar() {} });
      this.isObject3D = true;
      // Поля, которые движок настраивает у рендерера/камеры
      this.shadowMap = { enabled: false, type: 0 };
      this.info = { render: {} };
      Object.defineProperty(this, "name2", { value: name, enumerable: false });
    }
    add(o) { this.children.push(o); return this; }
    remove() { return this; }
    traverse(fn) { fn(this); this.children.forEach((c) => c.traverse && c.traverse(fn)); }
    dispose() { this.disposed = true; }
    lookAt() {}
    setFromCamera() {}
    intersectObjects() { return []; }
    setSize() {}
    setPixelRatio() {}
    render() { this.rendered = (this.rendered || 0) + 1; }
    updateProjectionMatrix() {}
    forceContextLoss() {}
    get domElement() { return this._el || (this._el = new El("canvas")); }
  };
function vec(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; },
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; },
    clone() { return vec(this.x, this.y, this.z); },
    addScaledVector() { return this; },
  };
}

const THREE = new Proxy({
  Scene: anyClass("Scene"),
  Group: anyClass("Group"),
  Mesh: anyClass("Mesh"),
  Sprite: anyClass("Sprite"),
  PerspectiveCamera: anyClass("PerspectiveCamera"),
  WebGLRenderer: anyClass("WebGLRenderer"),
  HemisphereLight: anyClass("HemisphereLight"),
  DirectionalLight: anyClass("DirectionalLight"),
  PointLight: anyClass("PointLight"),
  Raycaster: anyClass("Raycaster"),
  Vector2: class { constructor(x, y) { this.x = x; this.y = y; } },
  Vector3: class {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new THREE.Vector3(this.x, this.y, this.z); }
    addScaledVector(v, k) { this.x += v.x * k; this.y += v.y * k; this.z += v.z * k; return this; }
    setScalar(s) { this.x = this.y = this.z = s; return this; }
  },
  Color: class { constructor(v) { this.v = v; } setHex() { return this; } copy() { return this; } clone() { return this; } },
  CanvasTexture: anyClass("CanvasTexture"),
  GridHelper: anyClass("GridHelper"),
  SRGBColorSpace: "srgb",
  PCFSoftShadowMap: 1,
  REVISION: "160-stub",
  shadowMap: {},
}, {
  get(t, p) { return p in t ? t[p] : (typeof p === "string" && /^[A-Z]/.test(p) ? (t[p] = anyClass(p)) : undefined); },
});

// ---- тест -------------------------------------------------------------------

async function makeEngine(modelDef, config) {
  const { SceneEngine } = await import("../src/core/scene.js");
  const container = new El("div");
  const model = Object.assign({
    manifest: { id: "test", name: "Тест", apiVersion: 1, environment: { floor: "none" } },
    bindings: [],
    params: [],
    defaults: {},
  }, modelDef);
  const engine = new SceneEngine(container, config, model, { THREE });
  await engine.init();
  return engine;
}

test("движок сообщает модели об изменениях через applyState(key, info)", async () => {
  const calls = [];
  const states = [];
  const model = {
    bindings: [
      { key: "level", name: "Уровень", domain: ["sensor"], value: { kind: "number" } },
      { key: "pump", name: "Насос", domain: ["switch"], value: { kind: "boolean" } },
    ],
    create() {
      return {
        root: null,
        applyState(key, info) { calls.push([key, info && info.entity, info && info.value]); },
        applyStates(view) { states.push(Object.keys(view)); },
      };
    },
  };

  const engine = await makeEngine(model, {
    entities: { level: "sensor.level", pump: "switch.pump" },
  });

  // При init движок один раз сообщает модели обо всех привязках — имена
  // сущностей известны, а данных от Home Assistant ещё нет (state === undefined).
  assert.ok(calls.length >= 2, "init должен сообщить модели обо всех привязках");
  assert.deepEqual(calls.map((c) => c[0]).sort(), ["level", "pump"]);
  assert.ok(calls.every((c) => c[1]), "на этапе init entity_id уже должны быть известны");
  calls.length = 0;

  engine.applyStates({
    "sensor.level": { state: "62", attributes: { unit_of_measurement: "%" } },
    "switch.pump": { state: "on", attributes: {} },
  });

  const keys = calls.map((c) => c[0]);
  assert.ok(keys.includes("level"), `applyState не вызван для level (вызовы: ${JSON.stringify(calls)})`);
  assert.ok(keys.includes("pump"), "applyState не вызван для pump");
  const level = calls.find((c) => c[0] === "level");
  assert.equal(level[1], "sensor.level", "в info.entity должен быть entity_id");
  assert.equal(level[2], 62, "значение должно быть прочитано как число");
  const pump = calls.find((c) => c[0] === "pump");
  assert.equal(pump[2], true, "boolean-привязка должна давать true");
  assert.deepEqual(states, [], "applyStates не должен вызываться, если модель умеет applyState");
});

test("движок использует applyStates, если модель не умеет applyState", async () => {
  const views = [];
  const model = {
    bindings: [{ key: "level", name: "Уровень", domain: ["sensor"], value: { kind: "number" } }],
    create() {
      return { root: null, applyStates(view) { views.push(Object.keys(view)); } };
    },
  };
  const engine = await makeEngine(model, { entities: { level: "sensor.level" } });
  engine.applyStates({ "sensor.level": { state: "10", attributes: {} } });
  assert.ok(views.length >= 2, `applyStates вызван ${views.length} раз`);
  assert.deepEqual(views[views.length - 1], ["level"]);
});

test("движок переживает исключение в модели", async () => {
  const model = {
    bindings: [{ key: "level", name: "Уровень", domain: ["sensor"], value: { kind: "number" } }],
    create() {
      return {
        root: null,
        applyState() { throw new Error("модель сломалась"); },
      };
    },
  };
  const engine = await makeEngine(model, { entities: { level: "sensor.level" } });
  assert.doesNotThrow(() => {
    engine.applyStates({ "sensor.level": { state: "5", attributes: {} } });
  });
  const log = engine.diagnostics().log || [];
  assert.ok(log.some((l) => /модель сломалась/.test(l)), `ошибка модели не попала в диагностику: ${JSON.stringify(log)}`);
});

test("движок не падает, если модель не вернула сцену (root: null)", async () => {
  const model = {
    bindings: [{ key: "level", name: "Уровень", domain: ["sensor"] }],
    create() { return { root: null }; },
  };
  const engine = await makeEngine(model, { entities: { level: "sensor.level" } });
  assert.doesNotThrow(() => engine._frame(0.016));
  assert.doesNotThrow(() => engine.dispose());
});

test("смена привязок на лету доходит до модели", async () => {
  const seen = [];
  const model = {
    bindings: [{ key: "level", name: "Уровень", domain: ["sensor"], value: { kind: "number" } }],
    create() {
      return { root: null, applyState(key, info) { seen.push([key, info.entity, info.value]); } };
    },
  };
  const engine = await makeEngine(model, { entities: { level: "sensor.a" } });
  seen.length = 0;
  engine.setEntities({ level: "sensor.b" });
  engine.applyStates({ "sensor.b": { state: "77", attributes: {} } });
  const last = seen[seen.length - 1];
  assert.equal(last[1], "sensor.b", "новая сущность не дошла до модели");
  assert.equal(last[2], 77, "значение новой сущности не прочитано");
});

// ============================================================================
//  T-003: host: "external" — управление камерой от общего модуля карточки.
//  Модель возвращает camera (и опционально apply/pick/resetView), движок
//  сам канвас не слушает: жесты приходят из createCameraControls один раз.
// ============================================================================

/** Прогнать событие через слушатели заглушки (реальных DOM-событий нет). */
function fire(el, type, props = {}) {
  const e = Object.assign({
    type,
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    shiftKey: false,
    clientX: 0,
    clientY: 0,
    deltaY: 0,
    preventDefault() {},
    stopPropagation() {},
  }, props);
  (el._listeners[type] || []).slice().forEach((fn) => fn(e));
  return e;
}

test("T-003: external-модель, вернувшая camera, получает жесты от карточки", async () => {
  const gestures = [];
  const picks = [];
  const cam = { position: { x: 0, y: 0, z: 5 }, aspect: 1.33, updateProjectionMatrix() {} };
  const model = {
    manifest: { id: "ext-cam", name: "Внешняя камера", apiVersion: 1, host: "external", environment: { floor: "none" } },
    bindings: [],
    params: [],
    defaults: {},
    create() {
      return {
        external: true,
        root: null,
        camera: cam,
        apply: (g) => gestures.push(g),
        pick: (e) => picks.push(e),
        frame() {},
        dispose() {},
      };
    },
  };
  const engine = await makeEngine(model, { entities: {} });

  // Карточка присоединила общий модуль к камере модели.
  assert.ok(engine._camControls, "контрол камеры не создан");
  assert.ok(engine.canvas._listeners["pointerdown"], "на канвасе нет слушателя pointerdown");
  assert.ok(engine.canvas._listeners["wheel"], "на канвасе нет слушателя wheel");

  // Вращение: pointerdown → pointermove (dx = 30) → pointerup.
  fire(engine.canvas, "pointerdown", { clientX: 100, clientY: 100 });
  fire(engine.canvas, "pointermove", { clientX: 130, clientY: 100 });
  fire(engine.canvas, "pointerup", { clientX: 130, clientY: 100 });
  assert.equal(gestures.length, 1, "одно перемещение указателя — ровно один жест");
  assert.equal(gestures[0].type, "orbit");
  assert.equal(gestures[0].dx, 30);
  assert.equal(gestures[0].dy, 0);

  // Тап: короткий, без движения → pick.
  fire(engine.canvas, "pointerdown", { clientX: 50, clientY: 50 });
  fire(engine.canvas, "pointerup", { clientX: 50, clientY: 50 });
  assert.equal(picks.length, 1, "тап должен вызвать pick");

  // Перетаскивание дальше порога → новым выбором не считается.
  fire(engine.canvas, "pointerdown", { clientX: 50, clientY: 50 });
  fire(engine.canvas, "pointermove", { clientX: 90, clientY: 50 });
  fire(engine.canvas, "pointermove", { clientX: 130, clientY: 50 });
  fire(engine.canvas, "pointerup", { clientX: 130, clientY: 50 });
  assert.equal(picks.length, 1, "перетаскивание не должно вызывать pick");

  // Колесо → zoom с коэффициентом exp(deltaY * 0.0012).
  fire(engine.canvas, "wheel", { deltaY: -100 });
  const zoom = gestures.find((g) => g.type === "zoom");
  assert.ok(zoom, "жест zoom не получен");
  assert.ok(Math.abs(zoom.factor - Math.exp(-100 * 0.0012)) < 1e-9, `factor=${zoom.factor}`);

  // Двойной клик → reset ровно один раз (без дубля через onReset).
  fire(engine.canvas, "dblclick");
  assert.equal(gestures.filter((g) => g.type === "reset").length, 1, "reset должен прийти один раз");

  engine.dispose();
  assert.equal(engine._camControls, null, "после dispose контрола нет");
});

test("T-003: external-камера без apply — один pointermove = ровно одно обновление камеры", async () => {
  let sets = 0, looks = 0, resets = 0;
  const cam = {
    position: { x: 0, y: 0, z: 5, set() { sets++; return this; } },
    lookAt() { looks++; },
    aspect: 1.33,
    updateProjectionMatrix() {},
  };
  const model = {
    manifest: { id: "ext-cam-builtin", name: "Внешняя камера (встроенная математика)", apiVersion: 1, host: "external", environment: { floor: "none" } },
    bindings: [],
    params: [],
    defaults: {},
    create() {
      return {
        external: true,
        root: null,
        camera: cam,
        view: { target: { x: 0, y: 0, z: 0 }, radius: 5, phi: 1.2, theta: 0 },
        resetView() { resets++; },
        frame() {},
        dispose() {},
      };
    },
  };
  const engine = await makeEngine(model, { entities: {} });
  assert.ok(engine._camControls, "контрол камеры не создан");

  // Счётчики обнуляем после init: модуль мог один раз применить вид при
  // присоединении — проверяем ровно одно обновление на один pointermove.
  sets = 0; looks = 0;
  fire(engine.canvas, "pointerdown", { clientX: 100, clientY: 100 });
  fire(engine.canvas, "pointermove", { clientX: 110, clientY: 100 });
  assert.equal(sets, 1, `position.set вызван ${sets} раз, ожидался ровно один`);
  assert.equal(looks, 1, `lookAt вызван ${looks} раз, ожидался ровно один`);
  fire(engine.canvas, "pointerup", { clientX: 110, clientY: 100 });

  // Двойной клик → resetView модели ровно один раз.
  fire(engine.canvas, "dblclick");
  assert.equal(resets, 1, `resetView вызван ${resets} раз, ожидался один`);

  engine.dispose();
});
