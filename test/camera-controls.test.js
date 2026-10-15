// ============================================================================
//  Тесты createCameraControls (T-001) — общего модуля управления камерой.
//
//  Модуль не знает про Home Assistant и сцену: тест прогоняет его на
//  DOM-заглушке (класс El со сбором слушателей) и заглушке three.js с
//  честной математикой Vector3, чтобы проверить, куда доведена камера.
//  Покрытие: мышь (ЛКМ/ПКМ/Shift/колесо/двойной клик), касания (один
//  палец, щипок, сдвиг двумя, тап, двойной тап), пороги, клампы,
//  panoramic/tilt, ветка apply и dispose.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { createCameraControls } from "../src/core/camera-controls.js";

// ---- заглушка DOM -----------------------------------------------------------

class El {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.style = {};
    this._listeners = {};
  }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    const l = this._listeners[t] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 400 }; }
}

// ---- заглушка three.js -------------------------------------------------------
// Vector3 с настоящей арифметикой: по позиции камеры видно, куда доведён вид.

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
}

const THREE = { Vector3 };

/** Камера-заглушка: начинается в (999,999,999), чтобы каждое доведение было видно. */
function makeCamera() {
  return {
    position: new Vector3(999, 999, 999),
    lookAt(v) { this.lookedAt = v; },
  };
}

// ---- события -----------------------------------------------------------------

function makeEvent(type, props = {}) {
  return Object.assign({
    type,
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    shiftKey: false,
    clientX: 0,
    clientY: 0,
    deltaY: 0,
    preventDefault() { this.prevented = true; },
  }, props);
}

function fire(el, e) {
  (el._listeners[e.type] || []).forEach((fn) => fn(e));
  return e;
}

/** Перетаскивание одним указателем: down, moves шагов, up. */
function drag(el, { id = 1, type = "mouse", button = 0, shift = false, from, to, moves = 1 } = {}) {
  fire(el, makeEvent("pointerdown", { pointerId: id, pointerType: type, button, shiftKey: shift, clientX: from[0], clientY: from[1] }));
  for (let i = 1; i <= moves; i++) {
    fire(el, makeEvent("pointermove", {
      pointerId: id, pointerType: type, button, shiftKey: shift,
      clientX: from[0] + ((to[0] - from[0]) * i) / moves,
      clientY: from[1] + ((to[1] - from[1]) * i) / moves,
    }));
  }
  fire(el, makeEvent("pointerup", { pointerId: id, pointerType: type, button, shiftKey: shift, clientX: to[0], clientY: to[1] }));
}

/** Щипок: два пальца сходятся/расходятся от aFrom/bFrom к aTo/bTo. */
function pinch(el, aFrom, bFrom, aTo, bTo) {
  fire(el, makeEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: aFrom[0], clientY: aFrom[1] }));
  fire(el, makeEvent("pointerdown", { pointerId: 2, pointerType: "touch", clientX: bFrom[0], clientY: bFrom[1] }));
  fire(el, makeEvent("pointermove", { pointerId: 1, pointerType: "touch", clientX: aTo[0], clientY: aTo[1] }));
  fire(el, makeEvent("pointermove", { pointerId: 2, pointerType: "touch", clientX: bTo[0], clientY: bTo[1] }));
  fire(el, makeEvent("pointerup", { pointerId: 1, pointerType: "touch", clientX: aTo[0], clientY: aTo[1] }));
  fire(el, makeEvent("pointerup", { pointerId: 2, pointerType: "touch", clientX: bTo[0], clientY: bTo[1] }));
}

function wheel(el, deltaY) { return fire(el, makeEvent("wheel", { deltaY })); }

/** Фиксировать часы: t — время «сейчас». */
const realNow = performance.now;
function clock(t) { performance.now = () => t; }
function unclock() { performance.now = realNow; }

// ---- фабрика тестового модуля --------------------------------------------------
// Начальный вид: ориентир (0,0,0), radius 5, phi 1.2, theta 0; пределы —
// minRadius 1, maxRadius 20, minPhi 0.2, maxPhi 2.6.

function build(extra = {}) {
  const el = extra.element || new El("canvas");
  const camera = extra.camera || makeCamera();
  const changes = [];
  const taps = [];
  const resets = [];
  const ctl = createCameraControls(Object.assign({
    element: el,
    THREE,
    camera,
    target: new Vector3(0, 0, 0),
    radius: 5,
    phi: 1.2,
    theta: 0,
    minRadius: 1,
    maxRadius: 20,
    minPhi: 0.2,
    maxPhi: 2.6,
    onChange: (v) => changes.push({ target: v.target.clone(), radius: v.radius, phi: v.phi, theta: v.theta }),
    onTap: (x, y, e) => taps.push({ x, y, e }),
    onReset: () => resets.push(1),
  }, extra));
  return { el, camera, ctl, changes, taps, resets };
}

// ---- тесты ---------------------------------------------------------------------

test("создание: начальный вид сразу доведён до камеры, onChange сработал", () => {
  const { camera, ctl, changes } = build();
  const r = 5, p = 1.2, t = 0;
  assert.ok(Math.abs(camera.position.x - r * Math.sin(p) * Math.sin(t)) < 1e-9, "camera.x");
  assert.ok(Math.abs(camera.position.y - r * Math.cos(p)) < 1e-9, "camera.y");
  assert.ok(Math.abs(camera.position.z - r * Math.sin(p) * Math.cos(t)) < 1e-9, "camera.z");
  assert.ok(camera.lookedAt, "lookAt не вызван");
  assert.equal(changes.length, 1, "при создании должен быть ровно один onChange");
  const v = ctl.getView();
  assert.equal(v.radius, 5);
  assert.equal(v.phi, 1.2);
  assert.equal(v.theta, 0);
  assert.equal(v.target.x, 0);
  ctl.dispose();
});

test("мышь: ЛКМ вращает — theta и phi меняются по смещению указателя", () => {
  const { el, camera, ctl } = build();
  drag(el, { from: [100, 100], to: [200, 140] }); // dx=100, dy=40
  const v = ctl.getView();
  assert.ok(Math.abs(v.theta - (0 - 100 * 0.006)) < 1e-9, `theta=${v.theta}`);
  assert.ok(Math.abs(v.phi - (1.2 - 40 * 0.006)) < 1e-9, `phi=${v.phi}`);
  assert.equal(v.radius, 5);
  // камера доведена до нового вида
  const r = v.radius, p = v.phi, t = v.theta;
  assert.ok(Math.abs(camera.position.x - r * Math.sin(p) * Math.sin(t)) < 1e-9, "camera.x");
  assert.ok(Math.abs(camera.position.y - r * Math.cos(p)) < 1e-9, "camera.y");
  assert.ok(Math.abs(camera.position.z - r * Math.sin(p) * Math.cos(t)) < 1e-9, "camera.z");
  ctl.dispose();
});

test("мышь: ПКМ и Shift+ЛКМ сдвигают ориентир, углы не меняются", () => {
  const { el, camera, ctl } = build();
  drag(el, { button: 2, from: [0, 0], to: [100, 0] }); // dx=100
  let v = ctl.getView();
  assert.ok(Math.abs(v.theta) < 1e-9, "ПКМ не должен вращать азимут");
  assert.ok(Math.abs(v.phi - 1.2) < 1e-9, "ПКМ не должен наклонять");
  // right = (1,0,0) при theta=0, шаг = radius * 0.0016 = 0.008
  assert.ok(Math.abs(v.target.x - 100 * 0.008) < 1e-9, `target.x=${v.target.x}`);
  assert.ok(Math.abs(camera.position.x - (100 * 0.008 + 5 * Math.sin(1.2) * Math.sin(0))) < 1e-9, "camera.x");
  ctl.dispose();

  const s = build();
  drag(s.el, { shift: true, from: [50, 0], to: [100, 0] }); // dx=50
  v = s.ctl.getView();
  assert.ok(Math.abs(v.target.x - 50 * 0.008) < 1e-9, "Shift+ЛКМ не сдвинул");
  assert.ok(Math.abs(v.theta) < 1e-9, "Shift+ЛКМ не вращает");
  s.ctl.dispose();
});

test("мышь: колесо зумит с factor = exp(deltaY * k) и вызывает preventDefault", () => {
  const { el, ctl } = build();
  const e = wheel(el, 100);
  assert.ok(e.prevented, "wheel не получил preventDefault");
  const r1 = ctl.getView().radius;
  assert.ok(Math.abs(r1 - 5 * Math.exp(100 * 0.0012)) < 1e-9, `radius=${r1}`);
  wheel(el, -100);
  const r2 = ctl.getView().radius;
  assert.ok(Math.abs(r2 - 5) < 1e-9, "обратное колесо не вернуло дистанцию");
  assert.ok(Math.abs(ctl.getView().theta) < 1e-9, "колесо не вращает");
  ctl.dispose();
});

test("мышь: двойной клик возвращает исходный вид и вызывает onReset", () => {
  const { el, camera, ctl, changes, resets } = build();
  drag(el, { button: 2, from: [0, 0], to: [100, 0] });
  drag(el, { from: [0, 0], to: [50, 30] });
  const e = fire(el, makeEvent("dblclick"));
  assert.ok(e.prevented, "dblclick не получил preventDefault");
  assert.equal(resets.length, 1, "onReset не вызван");
  const v = ctl.getView();
  assert.equal(v.radius, 5);
  assert.equal(v.phi, 1.2);
  assert.equal(v.theta, 0);
  assert.equal(v.target.x, 0);
  assert.equal(v.target.y, 0);
  assert.ok(Math.abs(camera.position.y - 5 * Math.cos(1.2)) < 1e-9, "камера не доведена до исходного вида");
  assert.ok(changes.length > 1, "сброс не сообщил onChange");
  ctl.dispose();
});

test("касания: один палец вращает", () => {
  const { el, ctl } = build();
  drag(el, { type: "touch", from: [50, 50], to: [150, 70] }); // dx=100, dy=20
  const v = ctl.getView();
  assert.ok(Math.abs(v.theta - (-0.6)) < 1e-9, `theta=${v.theta}`);
  assert.ok(Math.abs(v.phi - (1.2 - 20 * 0.006)) < 1e-9, `phi=${v.phi}`);
  ctl.dispose();
});

test("касания: щипок меняет дистанцию (factor = отношение дистанций)", () => {
  const { el, ctl } = build();
  // 100 px -> 300 px: накопленный factor = 100/300, radius 5 -> 5/3
  pinch(el, [250, 0], [350, 0], [150, 0], [450, 0]);
  const v = ctl.getView();
  assert.ok(Math.abs(v.radius - 5 / 3) < 1e-9, `radius=${v.radius}`);
  // середина в итоге на месте: сдвиг не больше промежуточных артефактов
  assert.ok(Math.abs(v.target.x) < 0.2, `target.x=${v.target.x}`);
  assert.equal(v.target.y, 0);
  ctl.dispose();
});

test("касания: сдвиг двумя пальцами двигает ориентир по смещению середины", () => {
  const { el, ctl } = build();
  // Оба пальца сдвинулись на +50 px: дистанция в итоге прежняя (100 px),
  // середина — на +50. Зум не накопился, ориентир сдвинулся.
  pinch(el, [250, 0], [350, 0], [300, 0], [400, 0]);
  const v = ctl.getView();
  assert.ok(Math.abs(v.radius - 5) < 1e-9, `radius=${v.radius}, зум при сдвиге не накопился`);
  // первый шаг: s = 10*0.0016, +25 px -> 0.4; второй: s = 5*0.0016, +25 px -> 0.2
  assert.ok(Math.abs(v.target.x - 0.6) < 1e-9, `target.x=${v.target.x}`);
  assert.ok(Math.abs(v.theta) < 1e-9, "сдвиг не вращает");
  ctl.dispose();
});

test("тап: одиночный вызывает onTap, после перетаскивания и по времени — не срабатывает", () => {
  const { el, ctl, taps } = build();
  try {
    // быстрый тап на месте
    clock(1000);
    fire(el, makeEvent("pointerdown", { pointerType: "touch", clientX: 10, clientY: 10 }));
    clock(1010);
    fire(el, makeEvent("pointerup", { pointerType: "touch", clientX: 10, clientY: 10 }));
    assert.equal(taps.length, 1, "быстрый тап не сработал");
    assert.equal(taps[0].x, 10);
    assert.equal(taps[0].y, 10);

    // перетаскивание на 20 px (> dragThreshold) — тапа нет
    drag(el, { type: "touch", from: [10, 10], to: [30, 10] });
    assert.equal(taps.length, 1, "тап сработал после перетаскивания");

    // малое дрожание 3 px (<= dragThreshold) — тап есть
    clock(2500);
    fire(el, makeEvent("pointerdown", { pointerType: "touch", clientX: 20, clientY: 20 }));
    clock(2505);
    fire(el, makeEvent("pointermove", { pointerType: "touch", clientX: 23, clientY: 20 }));
    clock(2510);
    fire(el, makeEvent("pointerup", { pointerType: "touch", clientX: 23, clientY: 20 }));
    assert.equal(taps.length, 2, "тап с малым дрожанием не сработал");

    // зажатие 600 мс (> tapMaxMs) — тапа нет
    clock(3000);
    fire(el, makeEvent("pointerdown", { pointerType: "touch", clientX: 40, clientY: 40 }));
    clock(3600);
    fire(el, makeEvent("pointerup", { pointerType: "touch", clientX: 40, clientY: 40 }));
    assert.equal(taps.length, 2, "тап сработал после долгого зажатия");
  } finally {
    unclock();
    ctl.dispose();
  }
});

test("двойной тап: сброс вида и onReset; одиночные тапы по-прежнему уходят в onTap", () => {
  const { el, camera, ctl, taps, resets } = build();
  // сначала уйди с исходного вида
  drag(el, { button: 2, from: [0, 0], to: [100, 0] });
  assert.ok(Math.abs(ctl.getView().target.x - 0.8) < 1e-9, "предварительный сдвиг не сработал");
  try {
    // первый тап
    clock(1000);
    fire(el, makeEvent("pointerdown", { pointerType: "touch", clientX: 10, clientY: 10 }));
    clock(1005);
    fire(el, makeEvent("pointerup", { pointerType: "touch", clientX: 10, clientY: 10 }));
    assert.equal(taps.length, 1, "первый тап двойной пары не ушёл в onTap");
    assert.equal(resets.length, 0);

    // второй тап через 150 мс (< doubleTapMs) рядом (< 24 px) — сброс
    clock(1150);
    fire(el, makeEvent("pointerdown", { pointerType: "touch", clientX: 12, clientY: 10 }));
    clock(1160);
    fire(el, makeEvent("pointerup", { pointerType: "touch", clientX: 12, clientY: 10 }));
    assert.equal(resets.length, 1, "двойной тап не сработал");
    const v = ctl.getView();
    assert.equal(v.radius, 5);
    assert.equal(v.phi, 1.2);
    assert.equal(v.theta, 0);
    assert.equal(v.target.x, 0);
    assert.ok(Math.abs(camera.position.y - 5 * Math.cos(1.2)) < 1e-9, "камера не сбросилась");

    // тап далеко (50 px > 24) — уже одиночный, сброса нет
    clock(5000);
    fire(el, makeEvent("pointerdown", { pointerType: "touch", clientX: 100, clientY: 100 }));
    clock(5005);
    fire(el, makeEvent("pointerup", { pointerType: "touch", clientX: 100, clientY: 100 }));
    assert.equal(resets.length, 1, "далёкий тап посчитали двойным");
    assert.equal(taps.length, 2, "далёкий тап не ушёл в onTap");
  } finally {
    unclock();
    ctl.dispose();
  }
});

test("клампы: radius держится в пределах min/max, phi — между minPhi/maxPhi", () => {
  const { el, ctl } = build();
  wheel(el, 100000);
  assert.equal(ctl.getView().radius, 20, "maxRadius не соблюдён");
  wheel(el, -100000);
  assert.equal(ctl.getView().radius, 1, "minRadius не соблюдён");
  drag(el, { from: [0, 0], to: [0, -10000] });
  assert.equal(ctl.getView().phi, 2.6, "maxPhi не соблюдён");
  drag(el, { from: [0, -10000], to: [0, 0] });
  assert.equal(ctl.getView().phi, 0.2, "minPhi не соблюдён");
  ctl.dispose();
});

test("panoramic: false — вращение не меняет theta; tilt: false — не меняет phi", () => {
  const a = build({ panoramic: false });
  drag(a.el, { from: [0, 0], to: [100, 40] });
  assert.ok(Math.abs(a.ctl.getView().theta) < 1e-9, "panoramic=false: theta изменился");
  assert.ok(Math.abs(a.ctl.getView().phi - (1.2 - 40 * 0.006)) < 1e-9, "panoramic=false: phi не изменился");
  a.ctl.dispose();

  const b = build({ tilt: false });
  drag(b.el, { from: [0, 0], to: [100, 40] });
  assert.ok(Math.abs(b.ctl.getView().phi - 1.2) < 1e-9, "tilt=false: phi изменился");
  assert.ok(Math.abs(b.ctl.getView().theta - (-0.6)) < 1e-9, "tilt=false: theta не изменился");
  b.ctl.dispose();

  const c = build({ panoramic: false, tilt: false });
  const before = c.camera.position.clone();
  drag(c.el, { from: [0, 0], to: [100, 40] });
  assert.ok(Math.abs(c.ctl.getView().theta) < 1e-9, "обе оси: theta изменился");
  assert.ok(Math.abs(c.ctl.getView().phi - 1.2) < 1e-9, "обе оси: phi изменился");
  assert.ok(Math.abs(c.camera.position.x - before.x) < 1e-9, "обе оси: камера сдвинулась");
  c.ctl.dispose();
});

test("ветка apply: жесты уходят в apply({type, dx, dy, factor}), camera не трогается", () => {
  const calls = [];
  const { el, camera, ctl, changes } = build({ apply: (g) => calls.push(g) });
  assert.equal(camera.position.x, 999, "camera тронута при создании в ветке apply");
  assert.equal(camera.lookedAt, undefined, "lookAt вызван в ветке apply");

  drag(el, { from: [10, 10], to: [110, 50] });        // orbit: dx=100, dy=40
  drag(el, { button: 2, from: [0, 0], to: [10, 0] }); // pan: dx=10, dy=0
  wheel(el, 100);                                      // zoom: factor=exp(0.12)
  pinch(el, [250, 0], [350, 0], [150, 0], [450, 0]);   // zoom+pan, zoom+pan
  fire(el, makeEvent("dblclick"));                     // reset

  assert.equal(calls.length, 8, `ожидается 8 жестов, получено ${calls.length}`);
  assert.deepEqual(calls[0], { type: "orbit", dx: 100, dy: 40 });
  assert.deepEqual(calls[1], { type: "pan", dx: 10, dy: 0 });
  assert.ok(Math.abs(calls[2].factor - Math.exp(100 * 0.0012)) < 1e-9, "factor колёса");
  assert.equal(calls[2].type, "zoom");
  assert.deepEqual({ type: calls[3].type, factor: calls[3].factor }, { type: "zoom", factor: 0.5 });
  assert.deepEqual(calls[4], { type: "pan", dx: -50, dy: 0 });
  assert.ok(Math.abs(calls[5].factor - 200 / 300) < 1e-9, "factor щипка");
  assert.equal(calls[5].type, "zoom");
  assert.deepEqual(calls[6], { type: "pan", dx: 50, dy: 0 });
  assert.deepEqual(calls[7], { type: "reset" });

  assert.equal(camera.position.x, 999, "жесты в ветке apply тронули camera");
  assert.equal(changes.length, 0, "ветка apply сообщает onChange");
  assert.equal(ctl.getView().radius, 5, "жесты изменили зеркало вида");
  ctl.setView({ radius: 7 });
  assert.equal(ctl.getView().radius, 7, "setView в ветке apply не дописал зеркало");
  assert.equal(camera.position.x, 999, "setView в ветке apply тронул camera");
  ctl.dispose();
});

test("dispose(): слушатели сняты, touch-action возвращён, жесты после не работают", () => {
  const el = new El("canvas");
  el.style.touchAction = "auto";
  const { ctl } = build({ element: el });
  assert.equal(el.style.touchAction, "none", "модуль не выставил touch-action: none");
  assert.ok(el._listeners.pointerdown.length === 1, "pointerdown не привязан");
  assert.ok(el._listeners.wheel.length === 1, "wheel не привязан");

  ctl.dispose();
  assert.equal(el.style.touchAction, "auto", "dispose не вернул прежнее touch-action");
  for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "contextmenu", "dblclick"]) {
    assert.equal((el._listeners[t] || []).length, 0, `слушатель ${t} не снят`);
  }

  // после dispose жесты не работают
  wheel(el, 100);
  drag(el, { from: [0, 0], to: [100, 40] });
  const v = ctl.getView();
  assert.equal(v.radius, 5, "wheel после dispose изменил radius");
  assert.ok(Math.abs(v.theta) < 1e-9, "drag после dispose изменил theta");

  ctl.dispose(); // повторный вызов не падает
});

test("setEnabled(false): жесты игнорируются, после true — работают", () => {
  const { el, ctl } = build();
  ctl.setEnabled(false);
  drag(el, { from: [0, 0], to: [100, 40] });
  wheel(el, 100);
  assert.ok(Math.abs(ctl.getView().theta) < 1e-9, "жест при disabled изменил theta");
  assert.equal(ctl.getView().radius, 5, "жест при disabled изменил radius");
  ctl.setEnabled(true);
  drag(el, { from: [0, 0], to: [100, 40] });
  assert.ok(Math.abs(ctl.getView().theta - (-0.6)) < 1e-9, "жест после enable не работает");
  ctl.dispose();
});

test("setView/getView/update: программная смена вида доводится до камеры", () => {
  const { camera, ctl } = build();
  ctl.setView({ radius: 8, theta: 0.3 });
  let v = ctl.getView();
  assert.equal(v.radius, 8);
  assert.ok(Math.abs(v.theta - 0.3) < 1e-9);
  assert.ok(Math.abs(v.phi - 1.2) < 1e-9, "setView затёр неоткрытые поля");
  const r = 8, p = 1.2, t = 0.3;
  assert.ok(Math.abs(camera.position.x - r * Math.sin(p) * Math.sin(t)) < 1e-9, "setView не довёл камеру");

  // target принимает массив [x, y, z]
  ctl.setView({ target: [1, 2, 3] });
  v = ctl.getView();
  assert.equal(v.target.x, 1);
  assert.equal(v.target.y, 2);
  assert.equal(v.target.z, 3);
  assert.ok(Math.abs(camera.position.x - (1 + r * Math.sin(p) * Math.sin(t))) < 1e-9, "target не учтён в камере");

  // update() повторно доводит камеру (например, после внешнего вмешательства)
  camera.position.set(0, 0, 0);
  ctl.update();
  assert.ok(Math.abs(camera.position.x - (1 + r * Math.sin(p) * Math.sin(t))) < 1e-9, "update не довёл камеру");
  ctl.dispose();
});
