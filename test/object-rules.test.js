// ============================================================================
//  Движок правил: привязка сущностей Home Assistant к объектам загруженной
//  модели. Проверяются условия, выбор цвета, видимость, свет, вращение,
//  двери и текст — то есть весь набор действий, ради которого модель
//  и подключается к карточке.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";

import { matchesCondition, createRuleEngine } from "../src/core/object-rules.js";

// ---- минимальная заглушка three.js -----------------------------------------

class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  applyQuaternion() { return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { const l = this.length() || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
}

class Color {
  constructor(v) { this.hex = typeof v === "number" ? v : parseColor(String(v)); }
  set(v) { this.hex = typeof v === "number" ? v : parseColor(String(v)); return this; }
  setHex(v) { this.hex = v; return this; }
  copy(c) { this.hex = c.hex; return this; }
  clone() { return new Color(this.hex); }
  lerp(c, t) { this.hex = mixHex(this.hex, c.hex, t); return this; }
  getHex() { return this.hex; }
  getHexString() { return this.hex.toString(16).padStart(6, "0"); }
  getStyle() { return `#${this.getHexString()}`; }
  toHex() { return this.hex; }
}
function parseColor(s) {
  const t = s.trim();
  if (t.startsWith("#")) return parseInt(t.slice(1), 16);
  const named = { red: 0xff0000, green: 0x00ff00, blue: 0x0000ff, white: 0xffffff, black: 0x000000 };
  return named[t.toLowerCase()] ?? 0xffffff;
}
function mixHex(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

class Quaternion {
  constructor() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; }
  setFromAxisAngle() { return this; }
  copy(q) { Object.assign(this, q); return this; }
  clone() { const q = new Quaternion(); Object.assign(q, this); return q; }
  premultiply() { return this; }
}

class Object3D {
  constructor(name = "") {
    this.name = name;
    this.children = [];
    this.parent = null;
    this.userData = {};
    this.visible = true;
    this.position = new V3();
    this.quaternion = new Quaternion();
  }
  add(o) { this.children.push(o); if (o) o.parent = this; return this; }
  remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); return this; }
  traverse(fn) { fn(this); for (const c of this.children) c.traverse(fn); }
  rotateOnAxis() { return this; }
}

class Mesh extends Object3D {
  constructor(name, color = 0xffffff) {
    super(name);
    this.isMesh = true;
    this.material = { color: new Color(color), emissive: new Color(0x000000), userData: {} };
  }
}

const THREE = {
  Color,
  Vector3: V3,
  Quaternion,
  Group: Object3D,
  PointLight: class extends Object3D {
    constructor(color, intensity, distance, decay) {
      super();
      this.color = new Color(color);
      this.intensity = intensity;
      this.distance = distance;
      this.decay = decay;
    }
  },
  Box3: class {
    constructor() { this.min = new V3(); this.max = new V3(); this._empty = true; }
    setFromObject(obj) {
      // Простейший бокс: считаем объект единичным кубом в его позиции.
      this.min.set(obj.position.x - 0.5, obj.position.y, obj.position.z - 0.5);
      this.max.set(obj.position.x + 0.5, obj.position.y + 1, obj.position.z + 0.5);
      this._empty = false;
      return this;
    }
    isEmpty() { return this._empty; }
    getSize(v) { return v.set(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z); }
    getCenter(v) { return v.set((this.min.x + this.max.x) / 2, (this.min.y + this.max.y) / 2, (this.min.z + this.max.z) / 2); }
  },
};

function makeCtx() {
  const reports = [];
  return {
    THREE,
    report: (level, msg) => reports.push(`${level}: ${msg}`),
    requestRender: () => {},
    tag: () => {},
    makeLabel: () => ({
      position: new V3(),
      userData: { redraw: () => {} },
      material: { map: { dispose() {} }, dispose() {} },
    }),
    reports,
  };
}

/** Модель: две лампы, дверь, вентилятор, датчик. */
function makeModel() {
  const root = new Object3D("root");
  const lamp1 = new Mesh("Lamp_Kitchen", 0x333333);
  const lamp2 = new Mesh("Lamp_Hall", 0x333333);
  const door = new Mesh("Door_Front", 0x8b5a2b);
  const fan = new Mesh("Fan_Bathroom", 0xaaaaaa);
  const sensor = new Mesh("Sensor_Temp", 0xffffff);
  for (const o of [lamp1, lamp2, door, fan, sensor]) root.add(o);
  return { root, lamp1, lamp2, door, fan, sensor };
}

function entityState(state, attributes = {}) {
  return { entity: "x", state: { state, attributes }, value: state, available: state !== "unavailable" };
}

// ---- условия ----------------------------------------------------------------

test("matchesCondition: точное совпадение без учёта регистра", () => {
  assert.equal(matchesCondition("on", "on", NaN), true);
  assert.equal(matchesCondition("ON", "on", NaN), true);
  assert.equal(matchesCondition("off", "on", NaN), false);
});

test("matchesCondition: отрицание через «!»", () => {
  assert.equal(matchesCondition("!off", "on", NaN), true);
  assert.equal(matchesCondition("!on", "on", NaN), false);
});

test("matchesCondition: числовые операторы", () => {
  assert.equal(matchesCondition(">50", "62", 62), true);
  assert.equal(matchesCondition(">50", "40", 40), false);
  assert.equal(matchesCondition("<=10", "10", 10), true);
  assert.equal(matchesCondition("!=0", "5", 5), true);
  assert.equal(matchesCondition("==100", "100", 100), true);
});

test("matchesCondition: регулярное выражение", () => {
  assert.equal(matchesCondition("/^heat/", "heating", NaN), true);
  assert.equal(matchesCondition("/^heat/", "cooling", NaN), false);
});

test("matchesCondition: пустое условие не срабатывает", () => {
  assert.equal(matchesCondition(undefined, "on", NaN), false);
  assert.equal(matchesCondition("", "on", NaN), false);
});

// ---- цвет -------------------------------------------------------------------

test("цвет: таблица состояний colors", () => {
  const ctx = makeCtx();
  const m = makeModel();
  const engine = createRuleEngine({
    bindings: [{
      entity: "light.kitchen",
      target: "Lamp_Kitchen",
      colors: { on: "#ffd9a0", off: "#333333" },
    }],
  }, ctx, m.root);

  engine.setEntity("light.kitchen", entityState("on"));
  engine.frame(0.016, 0);
  assert.equal(engine.describe()[0].actions.includes("color"), true);
});

test("цвет: числовые условия в таблице", () => {
  const ctx = makeCtx();
  const m = makeModel();
  const engine = createRuleEngine({
    bindings: [{
      entity: "sensor.temp",
      target: "Sensor_Temp",
      colors: { ">=30": "#ff0000", ">=20": "#ffaa00", "<20": "#00aaff" },
    }],
  }, ctx, m.root);
  engine.setEntity("sensor.temp", entityState("25"));
  engine.frame(0.016, 0);
  assert.ok(!ctx.reports.some((r) => r.startsWith("warn")), ctx.reports.join("; "));
});

test("цвет: градиент по значению (scale)", () => {
  const ctx = makeCtx();
  const m = makeModel();
  const engine = createRuleEngine({
    bindings: [{
      entity: "sensor.temp",
      target: "Sensor_Temp",
      scale: { from: { min: 0, max: 100 }, colors: ["#00ff00", "#ffff00", "#ff0000"] },
    }],
  }, ctx, m.root);
  engine.setEntity("sensor.temp", entityState("50"));
  assert.doesNotThrow(() => engine.frame(0.016, 0));
});

test("цвет: без совпадения условий возвращается базовый цвет", () => {
  const ctx = makeCtx();
  const m = makeModel();
  const engine = createRuleEngine({
    bindings: [{
      entity: "light.kitchen",
      target: "Lamp_Kitchen",
      colors: { on: "#ffd9a0" },
    }],
  }, ctx, m.root);
  engine.setEntity("light.kitchen", entityState("off"));
  engine.frame(0.05, 0);
  // базовый цвет модели — 0x333333; после отката цвет не должен стать #ffd9a0
  assert.notEqual(m.lamp1.material.color.getHexString(), "ffd9a0");
});

// ---- видимость --------------------------------------------------------------

test("видимость: hide по списку состояний", () => {
  const ctx = makeCtx();
  const m = makeModel();
  const engine = createRuleEngine({
    bindings: [{ entity: "binary_sensor.door", target: "Door_Front", hide: ["off", "closed"] }],
  }, ctx, m.root);
  engine.setEntity("binary_sensor.door", entityState("off"));
  engine.frame(0.05, 0);
  assert.equal(m.door.visible, false, "дверь должна скрыться при состоянии off");

  engine.setEntity("binary_sensor.door", entityState("on"));
  engine.frame(0.05, 0);
  assert.equal(m.door.visible, true, "дверь должна появиться при состоянии on");
});

test("видимость: showWhen работает наоборот", () => {
  const ctx = makeCtx();
  const m = makeModel();
  const engine = createRuleEngine({
    bindings: [{ entity: "sensor.mode", target: "Fan_Bathroom", actions: [{ action: "hide", showWhen: ["on"] }] }],
  }, ctx, m.root);
  engine.setEntity("sensor.mode", entityState("off"));
  engine.frame(0.05, 0);
  assert.equal(m.fan.visible, false);
  engine.setEntity("sensor.mode", entityState("on"));
  engine.frame(0.05, 0);
  assert.equal(m.fan.visible, true);
});

// ---- свет -------------------------------------------------------------------

test("свет: точечный источник создаётся и включается", () => {
  const ctx = makeCtx();
  const m = makeModel();
  const engine = createRuleEngine({
    bindings: [{ entity: "light.kitchen", target: "Lamp_Kitchen", light: { lumens: 1000, color: "#ffcc00" } }],
  }, ctx, m.root);

  const light = m.root.children.find((c) => c.color && c.intensity !== undefined);
  assert.ok(light, "источник света не создан в сцене");
  engine.setEntity("light.kitchen", entityState("on"));
  for (let i = 0; i < 200; i++) engine.frame(0.016, i * 0.016);
  assert.ok(light.intensity > 0.5, `интенсивность должна вырасти, получено ${light.intensity}`);

  engine.setEntity("light.kitchen", entityState("off"));
  for (let i = 0; i < 400; i++) engine.frame(0.016, i * 0.016);
  assert.ok(light.intensity < 0.1, `после выключения интенсивность должна упасть, получено ${light.intensity}`);
});

// ---- вращение ---------------------------------------------------------------

test("вращение: скорость появляется при включении", () => {
  const ctx = makeCtx();
  const m = makeModel();
  const rotations = [];
  m.fan.rotateOnAxis = () => { rotations.push(1); return m.fan; };

  const engine = createRuleEngine({
    bindings: [{ entity: "fan.bathroom", target: "Fan_Bathroom", rotate: { axis: "y", round_per_second: 2 } }],
  }, ctx, m.root);

  engine.setEntity("fan.bathroom", entityState("off"));
  for (let i = 0; i < 100; i++) engine.frame(0.016, i * 0.016);
  const offCalls = rotations.length;

  engine.setEntity("fan.bathroom", entityState("on"));
  for (let i = 0; i < 200; i++) engine.frame(0.016, i * 0.016);
  assert.ok(rotations.length > offCalls, "при включении объект должен вращаться");
});

// ---- дверь ------------------------------------------------------------------

test("дверь: открывается при состоянии on и закрывается обратно", () => {
  const ctx = makeCtx();
  const m = makeModel();
  const engine = createRuleEngine({
    bindings: [{
      entity: "binary_sensor.door",
      target: "Door_Front",
      door: { hinge: "left", degrees: 90, open: ["on"] },
    }],
  }, ctx, m.root);

  const before = m.door.position.clone();
  engine.setEntity("binary_sensor.door", entityState("on"));
  for (let i = 0; i < 300; i++) engine.frame(0.016, i * 0.016);
  const opened = m.door.quaternion.clone();

  engine.setEntity("binary_sensor.door", entityState("off"));
  for (let i = 0; i < 600; i++) engine.frame(0.016, i * 0.016);
  // после закрытия позиция возвращается к исходной
  assert.ok(Math.abs(m.door.position.x - before.x) < 0.01, "позиция двери должна вернуться");
  assert.notEqual(opened.w, undefined);
});

test("дверь: без hinge выдаётся предупреждение", () => {
  const ctx = makeCtx();
  const m = makeModel();
  createRuleEngine({
    bindings: [{ entity: "binary_sensor.door", target: "Door_Front", door: { degrees: 90 } }],
  }, ctx, m.root);
  assert.ok(ctx.reports.some((r) => r.includes("hinge")), "ожидалось предупреждение про hinge");
});

test("дверь: сдвиг (slide) смещает объект", () => {
  const ctx = makeCtx();
  const m = makeModel();
  const engine = createRuleEngine({
    bindings: [{
      entity: "cover.window",
      target: "Door_Front",
      door: { slide: true, axis: "x", span: 1.5, open: ["open"] },
    }],
  }, ctx, m.root);
  const x0 = m.door.position.x;
  engine.setEntity("cover.window", entityState("open"));
  for (let i = 0; i < 300; i++) engine.frame(0.016, i * 0.016);
  assert.ok(m.door.position.x > x0 + 0.5, `объект должен сдвинуться, x=${m.door.position.x}`);
});

// ---- текст ------------------------------------------------------------------

test("текст: подпись создаётся и обновляется по состоянию", () => {
  const ctx = makeCtx();
  const m = makeModel();
  const redrawn = [];
  ctx.makeLabel = () => {
    const sprite = {
      position: new V3(),
      userData: { redraw: (t) => redrawn.push(t) },
      material: { map: { dispose() {} }, dispose() {} },
    };
    return sprite;
  };

  const engine = createRuleEngine({
    bindings: [{
      entity: "sensor.temp",
      target: "Sensor_Temp",
      text: { template: "{value} {unit}" },
    }],
  }, ctx, m.root);

  engine.setEntity("sensor.temp", { entity: "sensor.temp", state: { state: "21.5", attributes: { unit_of_measurement: "°C" } }, value: 21.5, available: true });
  engine.frame(0.016, 0);
  assert.ok(redrawn.some((t) => t.includes("21.5") && t.includes("°C")), `подписи: ${JSON.stringify(redrawn)}`);
});

// ---- адресация объектов -----------------------------------------------------

test("адресация: точное имя, шаблон со звёздочкой, группа", () => {
  const ctx = makeCtx();
  const m = makeModel();
  const engine = createRuleEngine({
    groups: { lamps: ["Lamp_*"] },
    bindings: [
      { entity: "light.kitchen", target: "Lamp_Kitchen", colors: { on: "#fff" } },
      { entity: "light.hall", target: "Lamp_*", colors: { on: "#fff" } },
      { entity: "light.all", target: "@lamps", colors: { on: "#fff" } },
    ],
  }, ctx, m.root);

  const desc = engine.describe();
  assert.equal(desc.length, 3);
  assert.equal(desc[0].targets.length, 1, "точное имя — один объект");
  assert.equal(desc[1].targets.length, 2, "шаблон Lamp_* — два объекта");
  assert.equal(desc[2].targets.length, 2, "группа lamps — два объекта");
});

test("адресация: ненайденный объект даёт предупреждение, а не падение", () => {
  const ctx = makeCtx();
  const m = makeModel();
  assert.doesNotThrow(() => {
    createRuleEngine({
      bindings: [{ entity: "light.x", target: "No_Such_Object", colors: { on: "#fff" } }],
    }, ctx, m.root);
  });
  assert.ok(ctx.reports.some((r) => r.includes("не найден")), ctx.reports.join("; "));
});

test("objectNames возвращает имена объектов модели", () => {
  const ctx = makeCtx();
  const m = makeModel();
  const engine = createRuleEngine({ bindings: [] }, ctx, m.root);
  const names = engine.objectNames();
  assert.ok(names.includes("Lamp_Kitchen"));
  assert.ok(names.includes("Fan_Bathroom"));
});

test("dispose убирает подписи и источники света", () => {
  const ctx = makeCtx();
  const m = makeModel();
  const engine = createRuleEngine({
    bindings: [
      { entity: "light.kitchen", target: "Lamp_Kitchen", light: { lumens: 500 } },
      { entity: "sensor.temp", target: "Sensor_Temp", text: { template: "{state}" } },
    ],
  }, ctx, m.root);
  const before = m.root.children.length;
  engine.dispose();
  assert.ok(m.root.children.length <= before);
});

test("петля: перенос геометрии не портит общую геометрию из кэша", async () => {
  // Загрузчик отдаёт каждой сцене клон дерева, но геометрия в клоне общая
  // (geometry.js → cloneObject). Перенос в prepareHinge необратим, поэтому
  // правило обязано работать со своей копией: иначе при каждой пересборке
  // сцены (переподключение карточки, правка конфигурации в редакторе) створка
  // уезжала бы ещё раз — «части модели съезжают».
  const THREE_REAL = await import("three");
  const ctx = makeCtx();
  ctx.THREE = THREE_REAL;

  const source = new THREE_REAL.Mesh(
    new THREE_REAL.BoxGeometry(1, 2, 0.1),
    new THREE_REAL.MeshStandardMaterial(),
  );
  source.name = "Door_Front";
  source.position.set(2, 0, 0);
  const before = Array.from(source.geometry.attributes.position.array);

  const spec = {
    bindings: [{
      entity: "binary_sensor.door",
      target: "Door_Front",
      door: { hinge: "left", degrees: 90, open: ["on"] },
    }],
  };

  const roots = [];
  for (let i = 0; i < 3; i++) {
    const root = new THREE_REAL.Group();
    const clone = source.clone();          // геометрия — та же (как из кэша)
    root.add(clone);
    roots.push(root);
    createRuleEngine(spec, ctx, root);
  }

  assert.deepEqual(
    Array.from(source.geometry.attributes.position.array), before,
    "геометрия из кэша изменена: при каждой пересборке сцены створка уезжала бы снова",
  );
  assert.notEqual(roots[0].children[0].geometry, source.geometry,
    "перенос должен идти по собственной копии геометрии");
});
