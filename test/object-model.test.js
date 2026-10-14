// ============================================================================
//  Объектная модель целиком: спецификация → createObjectModel → SceneEngine.
//
//  Проверяется то, что нельзя увидеть в тестах движка правил: подстановку
//  entity_id из спецификации, доставку состояний Home Assistant до объектов и
//  реакцию сцены на изменения. Именно здесь ломалась связка «карточка знает
//  привязки, но состояния не приходят».
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

// ---- минимальный DOM (как в engine-contract.test.js) ------------------------
//
// three.js здесь настоящий (см. ниже), а DOM — рукописный: библиотеке нужны
// document.createElement/canvas, window и getComputedStyle.

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
    // Минимальный 2D-контекст: нужен для рисования подписей (makeLabel).
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
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "" });

// Настоящий three.js (нужен для честных Box3/Vector3/Quaternion/Color).
const THREE_REAL = await import("three");

// ---- объекты модели ---------------------------------------------------------
//
// Рукописной заглушки three.js (Obj3D/Mesh/vec/Color) здесь больше нет: с
// настоящей библиотекой она несовместима. Настоящий Group.add() вызывает у ребёнка
// dispatchEvent (у заглушки его не было — «object.dispatchEvent is not a
// function»), а vec().applyQuaternion() ничего не делал, из-за чего дверь
// «не поворачивалась». Объекты модели создаём настоящие: у Mesh честные
// Box3/Vector3/Quaternion, а у MeshStandardMaterial есть и color (правило
// color), и emissive (правило light).

function makeMesh(name, color = 0x38383d) {
  const mesh = new THREE_REAL.Mesh(
    new THREE_REAL.BoxGeometry(1, 1, 1),
    new THREE_REAL.MeshStandardMaterial({ color, roughness: 0.85 }),
  );
  mesh.name = name;
  return mesh;
}

// ---- настоящий three.js -----------------------------------------------------
//
// Раньше здесь была рукописная заглушка THREE. Она оказалась источником
// ложных сбоев: цвет не интерполировался (lerp с порогом), Box3 возвращал
// выдуманные габариты, Quaternion не поворачивал — и тесты падали на КОРРЕКТНОМ
// коде движка. Настоящая библиотека уже есть в node_modules и в Node работает,
// если подставить document/window (см. заглушки DOM выше).
//
// WebGLRenderer настоящий создать нельзя (нужен WebGL), поэтому подменяем
// только его — остальное берём из библиотеки.

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

const THREE = Object.assign(Object.create(null), THREE_REAL, {
  WebGLRenderer: FakeRenderer,
});

// ---- подготовка -------------------------------------------------------------

const specPath = "skills/threejs-3d-model/examples/room.json";
const spec = JSON.parse(await fs.readFile(specPath, "utf8"));

// Геометрия не грузится из сети: подменяем create и собираем объекты вручную.
// opts.makeLabel позволяет подменить создание подписей ДО постройки сцены —
// иначе проверить текст нельзя (спрайты создаются внутри createRuleEngine).
async function makeEngine(opts = {}) {
  const { createObjectModel } = await import("../src/core/object-model.js");
  const { SceneEngine } = await import("../src/core/scene.js");
  const model = createObjectModel(Object.assign({}, spec, {
    source: { url: "http://test.local/room.obj" },
  }));

  // Патчим create: подставляем готовое дерево объектов вместо загрузки OBJ.
  const names = ["Floor", "Lamp_Ceiling", "Door_Front", "Fan_Bathroom", "Sensor_Panel", "Label_Temp"];
  const patched = Object.assign({}, model, {
    async create(ctx) {
      const THREEi = ctx.THREE;
      if (opts.makeLabel) ctx.makeLabel = opts.makeLabel;
      const group = new THREEi.Group();
      group.name = model.manifest.id;
      for (const n of names) group.add(makeMesh(n));
      // Правила собираем напрямую, минуя загрузчик файлов.
      const { createRuleEngine } = await import("../src/core/object-rules.js");
      const engine = createRuleEngine(spec, ctx, group);
      return {
        root: group,
        external: true,
        applyState(key, info) { engine.setEntity(key, info); },
        frame(dt) { engine.frame(dt, 0); },
        dispose() { engine.dispose(); },
        ruleEngine: engine,
      };
    },
  });

  const container = new El("div");
  const engine = new SceneEngine(container, { type: "custom:threejs-3d-card" }, patched, { THREE });
  await engine.init();
  return engine;
}

// ---- тесты ------------------------------------------------------------------

test("спецификация подставляет entity_id по умолчанию", async () => {
  const engine = await makeEngine();
  const cfg = engine.config;
  assert.equal(cfg.entities["light.living_room"], "light.living_room",
    `entities конфигурации: ${JSON.stringify(cfg.entities)}`);
  assert.equal(cfg.entities["sensor.living_room_temperature"], "sensor.living_room_temperature");
  assert.equal(Object.keys(cfg.entities).length, 5, "должны быть все пять привязок");
});

test("состояния Home Assistant доходят до объектов", async () => {
  const engine = await makeEngine();
  const key = "light.living_room";

  engine.applyStates({
    "light.living_room": { state: "on", attributes: { brightness: 255 } },
    "binary_sensor.front_door": { state: "on", attributes: {} },
    "fan.bathroom": { state: "on", attributes: {} },
    "sensor.living_room_temperature": { state: "27.4", attributes: { unit_of_measurement: "°C" } },
    "binary_sensor.window_living": { state: "on", attributes: {} },
  });

  const bus = engine.bus;
  assert.ok(bus.get(key), "состояние не попало в шину состояний");

  const info = engine._bindingInfo(key);
  assert.equal(info.entity, key);
  assert.ok(info.state, "bindingView не отдаёт состояние модели");
  assert.equal(String(info.state.state), "on");
});

test("цвет лампы меняется по состоянию, свет включается", async () => {
  const engine = await makeEngine();
  const handle = engine._modelHandle;
  const lamp = findByName(handle.root, "Lamp_Ceiling");

  engine.applyStates({ "light.living_room": { state: "off", attributes: { brightness: 0 } } });
  for (let i = 0; i < 120; i++) engine._frame(0.016);
  const offColor = lamp.material.color.getHexString();
  const offLights = lights(handle.root);

  engine.applyStates({ "light.living_room": { state: "on", attributes: { brightness: 255 } } });
  const colorRule = handle.ruleEngine.status().find((s) => s.action === "color");
  // Прямая проверка применения: вызываем кадр вручную и смотрим на материал.
  const lampMaterial = lamp.material;
  engine._frame(0.016);
  const afterOneFrame = lampMaterial.color.getHexString();
  for (let i = 0; i < 240; i++) engine._frame(0.016);
  const onColor = lamp.material.color.getHexString();
  const onLights = lights(handle.root);

  assert.notEqual(onColor, offColor,
    `цвет не изменился (${offColor} → ${onColor}, после одного кадра ${afterOneFrame}); ` +
    `применений: ${JSON.stringify(handle.ruleEngine.status()[0] && handle.ruleEngine.appliedCounters())}; ` +
    `правило: ${JSON.stringify(colorRule)}`);
  assert.ok(Math.max(...onLights, 0) > Math.max(...offLights, 0),
    `интенсивность света: ${JSON.stringify(offLights)} → ${JSON.stringify(onLights)}`);
});

test("дверь поворачивается при открытии и возвращается обратно", async () => {
  const engine = await makeEngine();
  const handle = engine._modelHandle;
  const door = findByName(handle.root, "Door_Front");

  // Створка вращается вокруг своей оси (геометрия сдвинута к точке подвеса),
  // поэтому смещение меряем по центру её габаритов, а не по позиции объекта.
  const closedCenter = worldCenterOf(door);
  const closedQuat = door.quaternion.clone();

  engine.applyStates({ "binary_sensor.front_door": { state: "on", attributes: {} } });
  for (let i = 0; i < 300; i++) engine._frame(0.016);
  const openedCenter = worldCenterOf(door);
  const moved = distance(closedCenter, openedCenter);
  const turned = quatAngle(closedQuat, door.quaternion);

  assert.ok(moved > 0.05,
    `створка не сдвинулась: ${JSON.stringify(openedCenter)}; угол ${turned.toFixed(3)} рад; ` +
    `статус: ${JSON.stringify((handle.ruleEngine.status() || []).filter((s) => s.action === "door"))}`);
  assert.ok(turned > 0.5, `створка не повернулась: угол ${turned.toFixed(3)} рад`);

  engine.applyStates({ "binary_sensor.front_door": { state: "off", attributes: {} } });
  for (let i = 0; i < 600; i++) engine._frame(0.016);
  const backCenter = worldCenterOf(door);
  const back = distance(closedCenter, backCenter);
  assert.ok(back < 0.02, `створка не вернулась: отклонение ${back.toFixed(3)} м`);
  assert.ok(quatAngle(closedQuat, door.quaternion) < 0.02, "угол не вернулся к исходному");
});

test("вентилятор вращается только при включении", async () => {
  const engine = await makeEngine();
  const handle = engine._modelHandle;
  const fan = findByName(handle.root, "Fan_Bathroom");
  let rotations = 0;
  fan.rotateOnAxis = () => { rotations++; return fan; };

  engine.applyStates({ "fan.bathroom": { state: "off", attributes: {} } });
  for (let i = 0; i < 100; i++) engine._frame(0.016);
  const offCalls = rotations;

  engine.applyStates({ "fan.bathroom": { state: "on", attributes: {} } });
  for (let i = 0; i < 200; i++) engine._frame(0.016);
  assert.ok(rotations > offCalls, "вентилятор не вращается при включении");
});

test("числовое состояние даёт цвет по условию", async () => {
  const engine = await makeEngine();
  const handle = engine._modelHandle;
  const panel = findByName(handle.root, "Sensor_Panel");

  engine.applyStates({ "sensor.living_room_temperature": { state: "31", attributes: {} } });
  for (let i = 0; i < 200; i++) engine._frame(0.016);
  const hot = panel.material.color.getHexString();

  engine.applyStates({ "sensor.living_room_temperature": { state: "12", attributes: {} } });
  for (let i = 0; i < 200; i++) engine._frame(0.016);
  const cold = panel.material.color.getHexString();

  assert.notEqual(hot, cold, `цвет не зависит от значения (${cold} → ${hot})`);
});

test("текст состояния обновляется", async () => {
  // Заглушку подписи ставим ДО постройки сцены: спрайты создаются внутри
  // createRuleEngine, и подмена после этого уже ни на что не влияет.
  const texts = [];
  const engine = await makeEngine({
    makeLabel: () => ({
      position: new THREE_REAL.Vector3(),
      userData: { redraw: (t) => texts.push(t) },
      material: { map: { dispose() {} }, dispose() {} },
    }),
  });
  assert.ok(engine._modelHandle, "движок модели не создан");

  engine.applyStates({ "sensor.living_room_temperature": { state: "21.5", attributes: { unit_of_measurement: "°C" } } });
  for (let i = 0; i < 60; i++) engine._frame(0.016);

  assert.ok(texts.length > 0, "подпись ни разу не перерисована");
  const last = texts[texts.length - 1];
  assert.ok(/21[.,]5/.test(last), `в подписи нет значения: ${JSON.stringify(last)}`);
  assert.ok(last.includes("°C"), `в подписи нет единицы измерения: ${JSON.stringify(last)}`);
});

// ---- проверка на НАСТОЯЩЕЙ геометрии ----------------------------------------

test("реальный OBJ: габариты деталей и физичный поворот двери", async () => {
  const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
  const { createRuleEngine } = await import("../src/core/object-rules.js");
  const objText = await fs.readFile("skills/threejs-3d-model/examples/room.obj", "utf8");

  // Разбираем тот же файл, что получает пользователь, настоящим загрузчиком.
  const loader = new OBJLoader();
  const root = await new Promise((resolve) => {
    const maybe = loader.parse(objText);
    if (maybe && typeof maybe.then === "function") maybe.then(resolve);
    else resolve(maybe);
  });

  const door = root.children.find((c) => c.name === "Door_Front");
  assert.ok(door, "в модели нет объекта Door_Front");

  const doorSize = new THREE_REAL.Box3().setFromObject(door).getSize(new THREE_REAL.Vector3());
  assert.ok(Math.abs(doorSize.x - 0.9) < 0.01, `ширина створки должна быть 0,9 м, получено ${doorSize.x}`);
  assert.ok(Math.abs(doorSize.y - 2.05) < 0.01, `высота створки должна быть 2,05 м, получено ${doorSize.y}`);

  const ctx = {
    THREE: THREE,
    report: () => {},
    requestRender: () => {},
    tag: () => {},
    makeLabel: () => ({
      position: new THREE_REAL.Vector3(),
      userData: { redraw: () => {} },
      material: { map: { dispose() {} }, dispose() {} },
    }),
  };

  const engine = createRuleEngine(spec, ctx, root);

  // Поворот створки проверяем по её собственному углу: геометрия сдвинута к
  // точке подвеса, поэтому вращение идёт вокруг оси объекта, а мировой центр
  // зависит от матриц родителей (в тестовой среде они обновляются не всегда).
  // Физичность смещения отдельно проверяется на синтетической геометрии в
  // тесте «дверь поворачивается при открытии и возвращается обратно».
  const closedQuat = door.quaternion.clone();
  const angle0 = quatAngle(QUAT_IDENTITY, closedQuat);
  assert.ok(angle0 < 0.01, `створка должна быть закрыта, угол ${angle0.toFixed(3)}`);

  engine.setEntity("binary_sensor.front_door", {
    entity: "binary_sensor.front_door",
    state: { state: "on", attributes: {} },
    value: true,
    available: true,
  });
  for (let i = 0; i < 400; i++) engine.frame(0.016, i * 0.016);
  const openedAngle = quatAngle(closedQuat, door.quaternion);
  assert.ok(openedAngle > 1.0 && openedAngle < 1.9,
    `створка должна повернуться примерно на 95° (1,66 рад), получено ${openedAngle.toFixed(2)} рад`);

  // Закрытие возвращает створку ровно на место.
  engine.setEntity("binary_sensor.front_door", {
    entity: "binary_sensor.front_door",
    state: { state: "off", attributes: {} },
    value: false,
    available: true,
  });
  for (let i = 0; i < 600; i++) engine.frame(0.016, i * 0.016);
  const backAngle = quatAngle(closedQuat, door.quaternion);
  assert.ok(backAngle < 0.02, `створка не вернулась: остаточный угол ${backAngle.toFixed(3)} рад`);
});

// ---- вспомогательное --------------------------------------------------------

/** Единичный кватернион — исходная ориентация объекта. */
const QUAT_IDENTITY = new THREE_REAL.Quaternion();

function findByName(root, name) {
  let found = null;
  root.traverse((n) => { if (n.name === name && !found) found = n; });
  return found;
}

/**
 * Мировой центр габаритов объекта. Локальный центр при вращении вокруг
 * собственной оси не меняется, поэтому смещение створки надо мерить в мире.
 */
function worldCenterOf(obj) {
  obj.updateWorldMatrix(true, true);
  obj.geometry.computeBoundingBox();
  const c = obj.geometry.boundingBox.getCenter(new THREE_REAL.Vector3());
  return obj.localToWorld(c);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Угол между кватернионами в радианах. */
function quatAngle(a, b) {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, dot));
}

function lights(root) {
  const out = [];
  root.traverse((n) => { if (n.isLight) out.push(n.intensity); });
  return out.length ? out : [0];
}
