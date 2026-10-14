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
