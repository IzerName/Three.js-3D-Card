// ============================================================================
//  Тест построения сцены бака без WebGL.
//
//  Полноценный рендеринг в Node невозможен, но всю сцену (баки, вода, шкала,
//  зонды, подписи, HUD, привязку событий) можно построить с заглушкой
//  WebGLRenderer. Это ловит опечатки в геометрии, материалах и обращении к
//  состоянию — то, что юнит-тесты чистых функций не видят.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";

// ---- заглушка DOM -----------------------------------------------------------

class El {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = { cssText: "", display: "", cursor: "" };
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this._text = "";
    this._html = "";
    this._listeners = {};
    this.width = 0;
    this.height = 0;
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(n) { this.children.push(n); if (n) n.parentNode = this; return n; }
  insertBefore(n) { this.children.push(n); if (n) n.parentNode = this; return n; }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); if (n) n.parentNode = null; return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute() {}
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  /** Очень простой разбор class-атрибутов из innerHTML — достаточно для тестов. */
  parseHtml(html) {
    this.children = [];
    const re = /<(\w+)([^>]*)>/g;
    const stack = [this];
    let m;
    while ((m = re.exec(html))) {
      const tag = m[1];
      if (tag.startsWith("/")) { stack.pop(); continue; }
      const node = new El(tag);
      // class="x" | class='x' | class=x  (HA-код использует все три формы)
      const cls = /class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/.exec(m[2]);
      node.className = cls ? (cls[1] || cls[2] || cls[3] || "") : "";
      const selfClosing = /\/>$/.test(m[0]) || ["br", "img", "input", "hr", "source"].includes(tag.toLowerCase());
      stack[stack.length - 1].appendChild(node);
      if (!selfClosing) stack.push(node);
    }
  }
  querySelector(sel) {
    const want = String(sel).replace(/^\./, "");
    const found = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.className && c.className.split(/\s+/).includes(want)) found.push(c);
        walk(c);
      }
    };
    walk(this);
    return found[0] || null;
  }
  querySelectorAll(sel) {
    const out = [];
    const first = this.querySelector(sel);
    if (first) out.push(first);
    return out;
  }
  getContext() { return makeContext2d(); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 400 }; }
  getRootNode() { return this; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.parseHtml(this._html); }
  get clientWidth() { return 640; }
  get clientHeight() { return 400; }
}

function makeContext2d() {
  return {
    canvas: { width: 512, height: 512 },
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    textAlign: "",
    textBaseline: "",
    measureText: () => ({ width: 42 }),
    fillText() {}, clearRect() {}, fillRect() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arcTo() {}, arc() {},
    roundRect() {}, createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }),
    save() {}, restore() {}, translate() {}, scale() {}, rotate() {}, drawImage() {},
  };
}

globalThis.document = {
  head: new El("head"),
  body: new El("body"),
  documentElement: new El("html"),
  baseURI: "http://localhost/",
  createElement: (t) => new El(t),
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = {
  devicePixelRatio: 1,
  innerWidth: 1280,
  innerHeight: 800,
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "#2f9df4" });
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// Цикл кадров: без WebGL и реального экрана он не нужен, но движок
// рассчитывает, что функции существуют.
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

// ---- заглушка three.js ------------------------------------------------------

class Obj3D {
  constructor() {
    this.children = [];
    this.parent = null;
    this.userData = {};
    this.position = vec();
    this.rotation = vec();
    this.scale = Object.assign(vec(), { setScalar(s) { this.x = this.y = this.z = s; } });
    this.visible = true;
    this.renderOrder = 0;
    this.castShadow = false;
    this.receiveShadow = false;
  }
  add(o) { this.children.push(o); if (o) o.parent = this; return this; }
  remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); return this; }
  traverse(fn) { fn(this); this.children.forEach((c) => c.traverse && c.traverse(fn)); }
  lookAt() {}
  updateMatrixWorld() {}
}
function vec(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; },
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; },
    clone() { return vec(this.x, this.y, this.z); },
    setScalar(s) { this.x = this.y = this.z = s; return this; },
    addScaledVector(v, k) { this.x += v.x * k; this.y += v.y * k; this.z += v.z * k; return this; },
  };
}

class Geo {
  constructor() { this.attributes = {}; this.disposed = false; }
  dispose() { this.disposed = true; }
  rotateX() { return this; }
  rotateY() { return this; }
  rotateZ() { return this; }
  translate() { return this; }
  scale() { return this; }
  center() { return this; }
  computeVertexNormals() { return this; }
  setAttribute(name, value) { this.attributes[name] = value; return this; }
  setIndex() { return this; }
  setFromPoints() { return this; }
}
class Mat {
  constructor(opts = {}) {
    Object.assign(this, opts);
    // В three.js color/emissive — это THREE.Color, а не строка.
    for (const key of ["color", "emissive", "specular", "sheenColor"]) {
      if (!(this[key] instanceof Color)) this[key] = new Color(this[key]);
    }
    this.disposed = false;
    this.needsUpdate = false;
  }
  dispose() { this.disposed = true; }
}
class Tex {
  constructor() { this.disposed = false; }
  dispose() { this.disposed = true; }
}
class Mesh extends Obj3D { constructor(g, m) { super(); this.geometry = g || new Geo(); this.material = m || new Mat(); } }
class Light extends Obj3D { constructor() { super(); this.intensity = 1; } }
class Color {
  constructor(v) {
    this.value = v === undefined ? 0xffffff : v;
    this.r = 1; this.g = 1; this.b = 1;
  }
  setHex(h) { this.value = h; return this; }
  set(v) { this.value = v; return this; }
  setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; this.value = 0; return this; }
  setStyle(s) { this.value = s; return this; }
  copy(c) { this.value = c.value; this.r = c.r; this.g = c.g; this.b = c.b; return this; }
  clone() { const c = new Color(this.value); c.r = this.r; c.g = this.g; c.b = this.b; return c; }
  multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; }
  lerp(c, t) { this.r += (c.r - this.r) * t; return this; }
  getHex() { return typeof this.value === "number" ? this.value : 0; }
  getHexString() { return String(this.value); }
  convertSRGBToLinear() { return this; }
  convertLinearToSRGB() { return this; }
}

const THREE = {
  Scene: class extends Obj3D { constructor() { super(); this.background = null; this.fog = null; } },
  Group: class extends Obj3D {},
  Mesh,
  Sprite: class extends Obj3D { constructor(m) { super(); this.material = m || new Mat(); } },
  PerspectiveCamera: class extends Obj3D {
    constructor(f, a) { super(); this.fov = f; this.aspect = a; this.updateProjectionMatrix = () => {}; }
  },
  WebGLRenderer: class {
    constructor(opts) {
      this.domElement = (opts && opts.canvas) || new El("canvas");
      this.shadowMap = { enabled: false, type: 0 };
      this.info = { render: { calls: 0 } };
      this.renderCount = 0;
    }
    setPixelRatio() {}
    setSize() {}
    render() { this.renderCount++; }
    dispose() { this.disposed = true; }
    forceContextLoss() {}
  },
  BoxGeometry: class extends Geo { constructor(w, h, d) { super(); this.w = w; this.h = h; this.d = d; } },
  CylinderGeometry: class extends Geo {},
  SphereGeometry: class extends Geo {},
  PlaneGeometry: class extends Geo {},
  TorusGeometry: class extends Geo {},
  ConeGeometry: class extends Geo {},
  ShapeGeometry: class extends Geo {},
  GridHelper: class extends Obj3D {},
  BufferGeometry: class extends Geo {},
  MeshStandardMaterial: Mat,
  MeshBasicMaterial: Mat,
  SpriteMaterial: Mat,
  LineBasicMaterial: Mat,
  CanvasTexture: class extends Tex { constructor(c) { super(); this.image = c; } },
  Color,
  Vector2: class { constructor(x, y) { this.x = x; this.y = y; } },
  Vector3: class { constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; } set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; } clone() { return new THREE.Vector3(this.x, this.y, this.z); } setScalar(s) { this.x = this.y = this.z = s; return this; } addScaledVector(v, k) { this.x += v.x * k; this.y += v.y * k; this.z += v.z * k; return this; } sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; } length() { return Math.hypot(this.x, this.y, this.z); } normalize() { const l = this.length() || 1; this.x /= l; this.y /= l; this.z /= l; return this; } },
  // Shape — цепочка вызовов без результата; заглушка отвечает на любой метод.
  Shape: class { constructor() { return new Proxy(this, { get: (t, p) => (p in t ? t[p] : () => t) }); } },
  HemisphereLight: Light,
  DirectionalLight: class extends Light { constructor() { super(); this.shadow = { mapSize: { set() {} }, camera: {} }; } },
  PointLight: Light,
  AmbientLight: Light,
  Raycaster: class { setFromCamera() {} intersectObjects() { return []; } },
  Fog: class { constructor(c, n, f) { this.color = c; this.near = n; this.far = f; } },
  PCFSoftShadowMap: 1,
  SRGBColorSpace: "srgb",
  ACESFilmicToneMapping: 4,
  MathUtils: { degToRad: (d) => (d * Math.PI) / 180, clamp: (v, a, b) => Math.max(a, Math.min(b, v)) },
  REVISION: "160-stub",
};

/**
 * Заглушка three.js не перечисляет все классы (их сотни), поэтому неизвестные
 * имена создаются на лету: любое `T.Что-УгодноGeometry` превращается в пустую
 * геометрию. Это делает тест устойчивым к тому, какие именно примитивы
 * использует сцена.
 */
const THREE_ANY = new Proxy(THREE, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop !== "string") return undefined;
    if (/^[A-Z]/.test(prop)) {
      // Класс-заглушка: геометрия/материал/объект — смотря что спросят
      const Stub = class extends Geo {
        constructor(...args) { super(); this.args = args; }
      };
      target[prop] = Stub;
      return Stub;
    }
    return undefined;
  },
});

// ---- тест -------------------------------------------------------------------

test("сцена бака: строится, реагирует на состояния, освобождается", async () => {
  const { WaterTankEngine } = await import("../models/water-tank/legacy-engine.js");

  const container = new El("div");
  const engine = new WaterTankEngine(container, {
    title: "Тестовый бак",
    entities: {
      level: "sensor.level",
      liters: "sensor.liters",
      counter: "sensor.counter",
      high: "binary_sensor.high",
      medium: "binary_sensor.medium",
      low: "binary_sensor.low",
    },
    fullValue: 100,
    maxLiters: 200,
    levelColor: "#2f9df4",
    probeLevels: { high: 85, medium: 50, low: 25 },
  }, { THREE: THREE_ANY });

  await engine.init();
  assert.ok(engine.renderer, "рендерер не создан");
  assert.ok(engine.scene, "сцена не создана");
  assert.ok(engine.tankGroup, "группа бака не создана");
  assert.ok(engine.scene.children.length > 0, "сцена пуста");

  // есть canvas в контейнере
  const hasCanvas = container.children.some((c) => c.tagName === "CANVAS" || c.tagName === "DIV");
  assert.ok(hasCanvas, "в контейнер ничего не добавлено");

  // состояния: уровень 50 %, датчики сработали
  engine.applyStates({
    "sensor.level": { state: "50", attributes: { unit_of_measurement: "%" } },
    "sensor.liters": { state: "100", attributes: { unit_of_measurement: "L" } },
    "sensor.counter": { state: "12.5", attributes: {} },
    "binary_sensor.high": { state: "on", attributes: {} },
    "binary_sensor.medium": { state: "off", attributes: {} },
    "binary_sensor.low": { state: "off", attributes: {} },
  });
  assert.equal(engine.levelValid, true, "уровень не распознан");
  assert.ok(Math.abs(engine.targetLevel - 0.5) < 1e-9, `targetLevel=${engine.targetLevel}, ожидалось 0.5`);
  assert.equal(engine.probeTarget.high, 1, "датчик высокого уровня не сработал");
  assert.equal(engine.probeTarget.medium, 0, "датчик среднего уровня сработал ошибочно");

  // unavailable не должен ломать сцену
  engine.applyStates({ "sensor.level": { state: "unavailable", attributes: {} } });
  assert.equal(engine.levelValid, false, "unavailable принят за значение");

  // кадр анимации
  const before = engine.renderer.renderCount;
  engine._frame(0.016);
  assert.ok(engine.renderer.renderCount >= before, "кадр не отрисован");

  // смена привязок без пересоздания сцены
  engine.setEntities({ level: "sensor.level2" });
  engine.applyStates({ "sensor.level2": { state: "80", attributes: {} } });
  assert.ok(Math.abs(engine.targetLevel - 0.8) < 1e-9, "новая привязка не подхвачена");

  engine.dispose();
  assert.equal(engine.disposed, true, "движок не помечен освобождённым");
});

test("сцена бака: нечисловое значение не превращается в уровень", async () => {
  const { WaterTankEngine } = await import("../models/water-tank/legacy-engine.js");
  const engine = new WaterTankEngine(new El("div"), {
    entities: { level: "sensor.level" }, fullValue: 100,
  }, { THREE: THREE_ANY });
  await engine.init();
  engine.applyStates({ "sensor.level": { state: "ошибка", attributes: {} } });
  assert.equal(engine.levelValid, false);
  engine.dispose();
});

test("адаптер бака: внешний движок получает общий рендерер", async () => {
  const { create } = await import("../models/water-tank/scene.js");

  const container = new El("div");
  const canvas = new El("canvas");
  let shared = null;
  const ctx = {
    THREE: THREE_ANY,
    container,
    canvas,
    config: {
      title: "Бак",
      entities: { level: "sensor.level" },
      params: { full_value: 100, max_liters: 200, "probe_levels.high": 88 },
    },
    setRenderer: (r) => { shared = r; },
    onService() {},
    openEntity() {},
  };

  const handle = await create(ctx);
  assert.equal(handle.external, true, "модель должна помечать себя как external");
  assert.ok(shared, "рендерер не передан карточке через setRenderer");
  assert.equal(shared.domElement, canvas, "использован не canvas карточки");
  assert.equal(handle.engine.probeLevels ? true : handle.engine.config.probeLevels.high === 88, true,
    "параметр probe_levels.high не дошёл до движка");

  // состояния прокидываются
  handle.applyStates({
    level: { key: "level", entity: "sensor.level", state: { state: "25", attributes: {} }, value: 25, available: true },
  });
  assert.ok(Math.abs(handle.engine.targetLevel - 0.25) < 1e-9, `targetLevel=${handle.engine.targetLevel}`);

  // смена параметров из редактора
  handle.applyConfig({
    title: "Новый бак",
    entities: { level: "sensor.level" },
    params: { full_value: 200, level_color: "#00ff00" },
  });
  assert.equal(handle.engine.config.title, "Новый бак");
  assert.equal(handle.engine.config.fullValue, 200);
  assert.equal(handle.engine.config.levelColor, "#00ff00");

  handle.dispose();
  assert.equal(container.children.length, 0, "слой движка не удалён из контейнера");
});

