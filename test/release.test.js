// ============================================================================
//  Тест загрузки релиза в эмуляции браузера.
//
//  Проверяет то, что нельзя проверить юнит-тестами: регистрацию кастомных
//  элементов, ленивую загрузку моделей, построение формы редактора и
//  нормализацию конфигурации. three.js и WebGL не нужны.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

// ---- минимальная эмуляция DOM ----------------------------------------------

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, on) { if (on === undefined) { this.set.has(c) ? this.set.delete(c) : this.set.add(c); } else if (on) this.set.add(c); else this.set.delete(c); }
  contains(c) { return this.set.has(c); }
}

class FakeNode {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = { cssText: "", display: "" };
    this.dataset = {};
    this.classList = new FakeClassList();
    this.attributes = {};
    this._text = "";
    this._html = "";
    this._listeners = {};
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(n) { if (n && n.parentNode) n.parentNode.removeChild(n); this.children.push(n); if (n) n.parentNode = this; return n; }
  insertBefore(n, ref) {
    if (n && n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, n); else this.children.push(n);
    if (n) n.parentNode = this;
    return n;
  }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); if (n) n.parentNode = null; return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { const l = this._listeners[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  dispatchEvent(ev) { (this._listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getRootNode() { return this.parentNode ? this.parentNode.getRootNode() : this; }
  attachShadow() { const s = new FakeNode("shadow-root"); s.host = this; this.shadowRoot = s; return s; }
  replaceWith() {}
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get clientWidth() { return 800; }
  get clientHeight() { return 400; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 400 }; }
}

class FakeHTMLElement extends FakeNode {
  constructor() { super("div"); this._props = {}; }
  connectedCallback() {}
  disconnectedCallback() {}
}
class FakeCustomElementRegistry {
  constructor() { this.map = new Map(); }
  define(name, cls) { this.map.set(name, cls); }
  get(name) { return this.map.get(name); }
  whenDefined(name) { return Promise.resolve(this.map.get(name)); }
}

const documentStub = {
  head: new FakeNode("head"),
  body: new FakeNode("body"),
  documentElement: new FakeNode("html"),
  baseURI: "http://localhost/threejs-3d-card.js",
  createElement: (tag) => (tag === "canvas" ? Object.assign(new FakeNode("canvas"), { getContext: () => null, width: 0, height: 0 }) : new FakeNode(tag)),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
};

globalThis.HTMLElement = FakeHTMLElement;
globalThis.customElements = new FakeCustomElementRegistry();
globalThis.document = documentStub;
globalThis.window = {
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false }),
  addEventListener: () => {},
  removeEventListener: () => {},
  ThreeJS3DCard: undefined,
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } };
globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

// ---- загрузка релиза --------------------------------------------------------

const DIST = path.resolve("dist");
const entryUrl = pathToFileURL(path.join(DIST, "threejs-3d-card.js")).href;

test("релиз: регистрирует элементы и публикует API", async () => {
  await import(entryUrl);
  assert.ok(customElements.get("threejs-3d-card"), "карточка не зарегистрирована");
  assert.ok(customElements.get("threejs-3d-card-editor"), "редактор не зарегистрирован");
  const api = window.ThreeJS3DCard;
  assert.ok(api, "window.ThreeJS3DCard не создан");
  assert.equal(typeof api.defineModel, "function");
  assert.equal(typeof api.loadModel, "function");
  assert.ok(api.registry, "реестр моделей недоступен");
  assert.equal(typeof api.CardClass.getStubConfig, "function");
  assert.equal(typeof api.CardClass.getConfigElement, "function");
});

test("релиз: встроенная модель water-tank загружается и валидна", async () => {
  const api = window.ThreeJS3DCard;
  const model = await api.loadModel("water-tank");
  assert.equal(model.manifest.id, "water-tank");
  assert.equal(model.manifest.apiVersion, 1);
  assert.ok(model.bindings.length >= 6, "у модели бака должно быть не меньше 6 привязок");
  assert.ok(model.params.length >= 8, "у модели бака должны быть параметры внешнего вида");
  const level = model.bindings.find((b) => b.key === "level");
  assert.ok(level, "нет привязки level");
  assert.equal(level.required, true);
  assert.deepEqual(level.domain, ["sensor", "input_number", "number"]);
  assert.equal(typeof model.create, "function");
});

test("реестр: псевдонимы старых карточек работают", async () => {
  const api = window.ThreeJS3DCard;
  const model = await api.loadModel("custom:water-tank-card");
  assert.equal(model.manifest.id, "water-tank");
});

test("реестр: понятная ошибка для неизвестной модели", async () => {
  const api = window.ThreeJS3DCard;
  await assert.rejects(() => api.loadModel("no-such-model"), /не найдена/);
});

test("getStubConfig: подставляет сущности из hass", () => {
  const api = window.ThreeJS3DCard;
  const hass = {
    states: {
      "sensor.tank_level": { state: "55", attributes: { unit_of_measurement: "%", friendly_name: "Уровень" } },
      "sensor.tank_liters": { state: "120", attributes: { unit_of_measurement: "L" } },
      "binary_sensor.tank_high": { state: "off", attributes: { device_class: "moisture" } },
    },
  };
  const stub = api.CardClass.getStubConfig(hass, []);
  assert.equal(stub.type, "custom:threejs-3d-card");
  assert.equal(stub.model, "water-tank");
  assert.ok(stub.entities, "getStubConfig не заполнил entities");
  assert.equal(stub.entities.level, "sensor.tank_level");
});

test("редактор: setConfig строит форму по схеме модели", async () => {
  const EditorClass = customElements.get("threejs-3d-card-editor");
  const editor = new EditorClass();
  editor.setConfig({ type: "custom:threejs-3d-card", model: "water-tank" });
  // ждём ленивую загрузку модели и повторный рендер
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(editor.config, "редактор не сохранил конфигурацию");
  assert.equal(editor.config.model, "water-tank");
  const host = editor.shadowRoot || editor;
  const html = JSON.stringify(host.children.map((c) => c.innerHTML)) + JSON.stringify(host.children.map((c) => c._html));
  assert.ok(html.includes("Устройства и параметры") || host.children.length > 0, "форма редактора пуста");
});

test("карточка: setConfig принимает legacy-формат (entities без model)", () => {
  const CardClass = customElements.get("threejs-3d-card");
  const card = new CardClass();
  card.setConfig({
    type: "custom:water-tank-card",
    entities: { level: "sensor.x" },
    full_value: 100,
  });
  const cfg = card.getConfig();
  assert.equal(cfg.model, "water-tank", "legacy-конфигурация не преобразована в модель");
  assert.equal(cfg.entities.level, "sensor.x");
});

test("карточка: getCardSize зависит от высоты", () => {
  const CardClass = customElements.get("threejs-3d-card");
  const card = new CardClass();
  card.setConfig({ type: "custom:threejs-3d-card", model: "water-tank", height: 500 });
  assert.equal(card.getCardSize(), 10);
});
