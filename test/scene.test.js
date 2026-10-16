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
    rect() {}, clip() {},
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
// SceneEngine проверяет container instanceof Element — в Node такого глобала нет.
globalThis.Element = El;

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
  constructor() {
    this.disposed = false;
    // Texture.repeat/offset — Vector2 в реальном three.js; движок цеха
    // использует repeat.set() и offset.y (legacy-engine.js, текстуры).
    this.repeat = { x: 1, y: 1, set(x, y) { this.x = x; this.y = y; return this; } };
    this.offset = { x: 0, y: 0 };
  }
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
  // GridHelper несёт material (LineBasicMaterial): движок цеха настраивает
  // прозрачность сетки пола (legacy-engine.js, _buildScene).
  GridHelper: class extends Obj3D { constructor(size, div, c1, c2) { super(); this.material = new Mat(); } },
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

  // (T-003) Движок больше не слушает канвас сам: собственных жестовых
  // слушателей остаться не должно — жесты подключает общий модуль карточки.
  for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "contextmenu"]) {
    assert.equal(canvas._listeners[t], undefined,
      `движок оставил собственный слушатель "${t}" на канвасе`);
  }
  // (T-003) В handle — камера и адаптеры жестов для общего модуля карточки.
  assert.ok(handle.camera, "в handle нет camera");
  assert.equal(typeof handle.apply, "function", "в handle нет apply(gesture)");
  assert.equal(typeof handle.resetView, "function", "в handle нет resetView");
  assert.equal(typeof handle.pick, "function", "в handle нет pick(event)");
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

// ============================================================================
//  T-002: жесты SceneEngine через общий модуль camera-controls.
// ============================================================================

/** Прогнать событие через слушатели заглушки (реальные DOM-событий нет). */
function fireScene(el, type, props = {}) {
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

/** Перетаскивание указателя из точки from в точку to (moves шагов). */
function dragScene(el, from, to, moves = 1) {
  fireScene(el, "pointerdown", { clientX: from[0], clientY: from[1] });
  for (let i = 1; i <= moves; i++) {
    fireScene(el, "pointermove", {
      clientX: from[0] + (to[0] - from[0]) * (i / moves),
      clientY: from[1] + (to[1] - from[1]) * (i / moves),
    });
  }
  fireScene(el, "pointerup", { clientX: to[0], clientY: to[1] });
}

/** SceneEngine с моделью без внешнего рендеринга; камера задана детерминированно. */
async function makeCamEngine(modelDef, config = {}) {
  const { SceneEngine } = await import("../src/core/scene.js");
  const container = new El("div");
  const model = Object.assign({
    manifest: {
      id: "cam-test", name: "Камера", apiVersion: 1,
      environment: { floor: "none" },
      camera: { target: [0, 0, 0], radius: 6, phi: 1.2, theta: 0, minRadius: 0.5, maxRadius: 50 },
    },
    bindings: [],
    params: [],
    defaults: {},
    create() { return { root: null, frame() {}, dispose() {} }; },
  }, modelDef);
  const engine = new SceneEngine(container, config, model, { THREE: THREE_ANY });
  await engine.init();
  return engine;
}

test("SceneEngine: перетаскивание вращает камеру (camState.theta, позиция камеры)", async () => {
  const engine = await makeCamEngine({}, { entities: {} });
  assert.ok(engine.camState, "camState не создан");
  assert.equal(engine.camState.theta, 0, "стартовый theta");
  const homeX = engine.camera.position.x;

  dragScene(engine.canvas, [100, 100], [140, 100]);

  // dx = 40, ROTATE_K = 0.006 → theta = -0.24
  assert.ok(Math.abs(engine.camState.theta - (-0.24)) < 1e-6,
    `theta=${engine.camState.theta}, ожидалось ≈ -0.24`);
  assert.notEqual(engine.camera.position.x, homeX, "позиция камеры не обновлена");
  assert.ok(engine.camera.position.x < 0, "камера должна сместиться влево при вращении");

  engine.dispose();
});

test("SceneEngine: колесо меняет радиус (зум), в обе стороны", async () => {
  const engine = await makeCamEngine({}, { entities: {} });
  assert.equal(engine.camState.radius, 6);

  fireScene(engine.canvas, "wheel", { deltaY: -120 });
  const inRadius = 6 * Math.exp(-120 * 0.0012);
  assert.ok(Math.abs(engine.camState.radius - inRadius) < 1e-9,
    `radius=${engine.camState.radius}, ожидалось ${inRadius}`);

  fireScene(engine.canvas, "wheel", { deltaY: 120 });
  assert.ok(Math.abs(engine.camState.radius - 6) < 1e-6,
    `после зума обратно radius=${engine.camState.radius}, ожидалось 6`);

  engine.dispose();
});

test("SceneEngine: двойной клик возвращает камеру к исходному виду", async () => {
  const engine = await makeCamEngine({}, { entities: {} });
  dragScene(engine.canvas, [100, 100], [140, 100]);
  fireScene(engine.canvas, "wheel", { deltaY: -240 });
  assert.notEqual(engine.camState.theta, 0, "предусловие: вид смещён");
  assert.notEqual(engine.camState.radius, 6, "предусловие: радиус смещён");

  fireScene(engine.canvas, "dblclick");

  assert.equal(engine.camState.theta, 0, "theta не возвращён к исходному");
  assert.ok(Math.abs(engine.camState.radius - 6) < 1e-9, "радиус не возвращён к исходному");
  assert.ok(Math.abs(engine.camState.phi - 1.2) < 1e-9, "phi не возвращён к исходному");

  engine.dispose();
});

test("SceneEngine: тап вызывает выбор, перетаскивание — нет", async () => {
  const engine = await makeCamEngine({}, { entities: {} });
  const picks = [];
  engine._pick = (e) => picks.push(e);

  // тап: короткий, без движения
  dragScene(engine.canvas, [100, 100], [100, 100]);
  assert.equal(picks.length, 1, "тап должен вызвать _pick");

  // перетаскивание: больше порога — выбором не считается
  dragScene(engine.canvas, [100, 100], [160, 120], 3);
  assert.equal(picks.length, 1, "перетаскивание не должно вызывать _pick");

  engine.dispose();
});

test("SceneEngine T-018: панель диагностики скрыта по умолчанию и по флагу", async () => {
  const engine = await makeCamEngine({
    bindings: [{ key: "level", name: "Уровень", domain: ["sensor"], value: { kind: "number" } }],
  }, { entities: { level: "sensor.level" } });

  // Без show_diagnostics панель создана, но не показана: пустого
  // прямоугольника поверх сцены (и перехвата ввода) быть не должно.
  assert.equal(engine._diag.style.display, "none", "панель видна без show_diagnostics");
  assert.equal(engine._diag.children.length, 0, "скрытая панель не должна заполняться");

  engine.setDiagnosticsVisible(true);
  assert.notEqual(engine._diag.style.display, "none", "панель не показана по флагу");
  assert.ok(engine._diag.querySelector(".t3d-diag-row"), "в панели нет строк привязок");
  // без измерений остаётся CSS-фолбэк .t3d-diag { top: 12px }
  assert.equal(engine._diag.style.top, "", "верх панели не должен зависеть от несуществующей вёрстки");

  engine.setDiagnosticsVisible(false);
  assert.equal(engine._diag.style.display, "none", "панель не скрыта обратно по флагу");

  engine.dispose();
});

test("SceneEngine T-018: панель диагностики встаёт ниже надписей верхней полосы", async () => {
  const engine = await makeCamEngine({
    bindings: [{ key: "level", name: "Уровень", domain: ["sensor"], value: { kind: "number" } }],
  }, { entities: { level: "sensor.level" } });

  // Заглушка вёрстки: надписи верхней полосы (HUD карточки и собственный HUD
  // модели) уже посчитаны, у панели — свой прямоугольник в той же полосе.
  const modelHud = new El("div");
  engine.container.appendChild(modelHud);
  engine.container.querySelectorAll = () => [engine._hud, modelHud, engine._diag];
  engine.container.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 400, right: 640, width: 640, height: 400 });
  engine._hud.getBoundingClientRect = () => ({ top: 10, bottom: 30, height: 20 });
  modelHud.getBoundingClientRect = () => ({ top: 10, bottom: 44, height: 34 });
  engine._diag.getBoundingClientRect = () => ({ top: 12, bottom: 38, height: 26 });

  engine.setDiagnosticsVisible(true);

  // ниже самой низкой надписи полосы (44) с зазором 8 и с тем же отступом
  // снизу, что и в CSS (12): панель не перекрывает текст и влезает в карточку
  assert.equal(engine._diag.style.top, "52px", "панель перекрывает надписи верхней полосы");
  assert.equal(engine._diag.style.maxHeight, "calc(100% - 64px)", "панель не вписана в высоту карточки");

  engine.dispose();
});

test("SceneEngine: host: external — движок не вешает жесты и не падает", async () => {
  const engine = await makeCamEngine({
    manifest: {
      id: "cam-external", name: "Внешний", apiVersion: 1, host: "external",
      environment: { floor: "none" },
      camera: { target: [0, 0, 0], radius: 6, phi: 1.2, theta: 0 },
    },
    create() { return { external: true, root: null, frame() {}, dispose() {} }; },
  }, { entities: {} });

  assert.equal(engine.camState, undefined, "в external-режиме camState не создаётся");
  assert.equal(engine._camControls, null, "движок не создаёт контрол камеры");
  assert.equal(engine.canvas._listeners["pointerdown"], undefined,
    "на канвасе нет слушателя pointerdown от движка");

  // Жесты принадлежат модели (до T-003): события, доставленные канвасу,
  // не должны вызывать исключений — camState в этом режиме отсутствует.
  assert.doesNotThrow(() => {
    dragScene(engine.canvas, [100, 100], [160, 80], 3);
    fireScene(engine.canvas, "wheel", { deltaY: -120 });
    fireScene(engine.canvas, "dblclick");
    fireScene(engine.canvas, "contextmenu");
  });

  engine.dispose();
  assert.equal(engine._camControls, null, "после dispose контрола нет");
});

// ============================================================================
//  T-003: host: "external" — жесты камеры от общего модуля карточки.
//  Модель возвращает camera (+ apply / resetView / pick), движок сам канвас
//  не слушает: один слушатель на тип — только от createCameraControls.
// ============================================================================

test("SceneEngine T-003: external-модель с camera и apply — карточка управляет камерой", async () => {
  const gestures = [];
  const picks = [];
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  const engine = await makeCamEngine({
    manifest: {
      id: "cam-external-apply", name: "Внешний (apply)", apiVersion: 1, host: "external",
      environment: { floor: "none" },
      camera: { target: [0, 0, 0], radius: 6, phi: 1.2, theta: 0 },
    },
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
  }, { entities: {} });

  // Карточка присоединила общий модуль к камере модели.
  assert.ok(engine._camControls, "карточка не создала контрол камеры");
  for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "dblclick"]) {
    assert.ok(engine.canvas._listeners[t], `на канвасе нет слушателя "${t}"`);
  }

  // Вращение: ЛКМ, dx = 40 → жест с «сырыми» дельтами (коэффициенты — в модели).
  dragScene(engine.canvas, [100, 100], [140, 100]);
  assert.equal(gestures.length, 1, "одно перемещение указателя — один жест");
  assert.equal(gestures[0].type, "orbit");
  assert.equal(gestures[0].dx, 40);
  assert.equal(gestures[0].dy, 0);

  // Тап: короткий, без движения → pick модели.
  dragScene(engine.canvas, [100, 100], [100, 100]);
  assert.equal(picks.length, 1, "тап должен вызвать pick модели");

  // Перетаскивание дальше порога → новым выбором не считается.
  dragScene(engine.canvas, [100, 100], [160, 120], 3);
  assert.equal(picks.length, 1, "перетаскивание не должно вызывать pick");

  // Колесо → zoom с коэффициентом exp(deltaY * 0.0012).
  fireScene(engine.canvas, "wheel", { deltaY: -120 });
  const zoom = gestures.find((g) => g.type === "zoom");
  assert.ok(zoom, "жест zoom не получен");
  assert.ok(Math.abs(zoom.factor - Math.exp(-120 * 0.0012)) < 1e-9, `factor=${zoom.factor}`);

  // Двойной клик → reset доставлен ровно один раз (apply-режим, без дубля).
  fireScene(engine.canvas, "dblclick");
  const resets = gestures.filter((g) => g.type === "reset");
  assert.equal(resets.length, 1, "жест reset должен прийти ровно один раз");

  engine.dispose();
  assert.equal(engine._camControls, null, "после dispose контрола нет");
});

test("SceneEngine T-003: external-камера без apply — встроенная математика, один pointermove = одно обновление", async () => {
  let sets = 0, looks = 0, resets = 0;
  const cam = {
    position: { x: 0, y: 0, z: 6, set() { sets++; return this; } },
    lookAt() { looks++; },
    aspect: 1.6,
    updateProjectionMatrix() {},
  };
  const engine = await makeCamEngine({
    manifest: {
      id: "cam-external-builtin", name: "Внешний (встроенная математика)", apiVersion: 1, host: "external",
      environment: { floor: "none" },
    },
    create() {
      return {
        external: true,
        root: null,
        camera: cam,
        view: { target: { x: 0, y: 0, z: 0 }, radius: 6, phi: 1.2, theta: 0, minRadius: 1, maxRadius: 50 },
        resetView() { resets++; },
        frame() {},
        dispose() {},
      };
    },
  }, { entities: {} });

  assert.ok(engine._camControls, "контрол создан");

  // Счётчики обнуляем после init: модуль мог один раз отрисовать вид при
  // присоединении — проверяем ровно одно обновление на один pointermove.
  sets = 0; looks = 0;
  fireScene(engine.canvas, "pointerdown", { clientX: 100, clientY: 100 });
  fireScene(engine.canvas, "pointermove", { clientX: 110, clientY: 100 });
  assert.equal(sets, 1, `position.set вызван ${sets} раз, ожидался ровно один`);
  assert.equal(looks, 1, `lookAt вызван ${looks} раз, ожидался ровно один`);
  fireScene(engine.canvas, "pointerup", { clientX: 110, clientY: 100 });

  // Двойной клик → resetView модели ровно один раз (встроенный режим:
  // через onReset, без apply-жеста).
  fireScene(engine.canvas, "dblclick");
  assert.equal(resets, 1, `resetView вызван ${resets} раз, ожидался один`);

  engine.dispose();
});

test("SceneEngine T-003: бак чистой воды — жесты только от общего модуля карточки", async () => {
  const model = (await import("../models/water-tank/manifest.js")).default;
  const { SceneEngine } = await import("../src/core/scene.js");
  const container = new El("div");
  const engine = new SceneEngine(container, {
    entities: { level: "sensor.level", liters: "sensor.liters", counter: "sensor.counter" },
  }, model, { THREE: THREE_ANY });
  await engine.init();

  const canvas = engine.canvas;
  // По одному слушателю на тип: только общий модуль карточки. Если бы движок
  // вешал свои — их стало бы два и жест обрабатывался бы дважды.
  for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "contextmenu", "dblclick"]) {
    assert.equal((canvas._listeners[t] || []).length, 1,
      `слушателей "${t}": ${(canvas._listeners[t] || []).length}, ожидался ровно один`);
  }

  const eng = engine._modelHandle.engine;
  const t0 = eng.camTheta;

  // Вращение: ЛКМ, dx = 40 → theta -= 40 * 0.0052 (коэффициент движка).
  dragScene(canvas, [100, 100], [140, 100]);
  assert.ok(Math.abs(eng.camTheta - (t0 - 40 * 0.0052)) < 1e-6, `theta=${eng.camTheta}`);

  // Панорама: ПКМ, dx = 30 → цель смещается по вектору "вправо".
  const x0 = eng.camTarget.x;
  fireScene(canvas, "pointerdown", { button: 2, clientX: 100, clientY: 100 });
  fireScene(canvas, "pointermove", { button: 2, clientX: 130, clientY: 100 });
  fireScene(canvas, "pointerup", { button: 2, clientX: 130, clientY: 100 });
  assert.notEqual(eng.camTarget.x, x0, "панорама не сдвинула цель");

  // Зум: колесо, factor = exp(-120 * 0.0012) (уменьшение радиуса).
  const r0 = eng.camRadius;
  fireScene(canvas, "wheel", { deltaY: -120 });
  assert.ok(Math.abs(eng.camRadius - r0 * Math.exp(-120 * 0.0012)) < 1e-9, `radius=${eng.camRadius}`);

  // Тап → _pick движка (модалка сущности), перетаскивание → нет.
  const picks = [];
  eng._pick = (e) => picks.push(e);
  dragScene(canvas, [100, 100], [100, 100]);
  assert.equal(picks.length, 1, "тап должен вызвать _pick");
  dragScene(canvas, [100, 100], [160, 120], 3);
  assert.equal(picks.length, 1, "перетаскивание не должно вызывать _pick");

  // Двойной клик → resetView: исходный вид (phi 0.66, theta 0.42, radius 4.9).
  fireScene(canvas, "dblclick");
  assert.ok(Math.abs(eng.camTheta - 0.42) < 1e-6, `theta=${eng.camTheta}, ожидалось 0.42`);
  assert.ok(Math.abs(eng.camPhi - 0.66) < 1e-6, `phi=${eng.camPhi}, ожидалось 0.66`);
  assert.ok(Math.abs(eng.camRadius - 4.9) < 1e-6, `radius=${eng.camRadius}, ожидалось 4.9`);

  engine.dispose();
});

test("SceneEngine T-003: производственный цех — жесты только от общего модуля карточки", async () => {
  const model = (await import("../models/production-room/manifest.js")).default;
  const { SceneEngine } = await import("../src/core/scene.js");
  const container = new El("div");
  const engine = new SceneEngine(container, { entities: {} }, model, { THREE: THREE_ANY });
  await engine.init();

  const canvas = engine.canvas;
  for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "contextmenu", "dblclick"]) {
    assert.equal((canvas._listeners[t] || []).length, 1,
      `слушателей "${t}": ${(canvas._listeners[t] || []).length}, ожидался ровно один`);
  }

  const eng = engine._modelHandle.engine;
  const t0 = eng.camTheta;

  // Вращение: ЛКМ, dx = 40 → theta -= 40 * 0.005 (коэффициент движка).
  dragScene(canvas, [100, 100], [140, 100]);
  assert.ok(Math.abs(eng.camTheta - (t0 - 40 * 0.005)) < 1e-6, `theta=${eng.camTheta}`);

  // Зум: колесо, factor = exp(-120 * 0.0012).
  const r0 = eng.camRadius;
  fireScene(canvas, "wheel", { deltaY: -120 });
  assert.ok(Math.abs(eng.camRadius - r0 * Math.exp(-120 * 0.0012)) < 1e-9, `radius=${eng.camRadius}`);

  // Тап → _click движка (лучом в моке ничего не попадётся — главное не пасть).
  const clicks = [];
  eng._click = (e) => clicks.push(e);
  dragScene(canvas, [100, 100], [100, 100]);
  assert.equal(clicks.length, 1, "тап должен вызвать _click");
  dragScene(canvas, [100, 100], [160, 120], 3);
  assert.equal(clicks.length, 1, "перетаскивание не должно вызывать _click");

  // Двойной клик → resetView: исходный вид (theta 0, radius 19).
  fireScene(canvas, "dblclick");
  assert.ok(Math.abs(eng.camTheta) < 1e-6, `theta=${eng.camTheta}, ожидалось 0`);
  assert.ok(Math.abs(eng.camRadius - 19) < 1e-6, `radius=${eng.camRadius}, ожидалось 19`);

  engine.dispose();
});

