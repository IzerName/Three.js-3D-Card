// ============================================================================
//  createCameraControls — общее управление камерой (мышь и тачскрин).
//
//  Единственная реализация жестов (T-001): модуль не зависит ни от проекта,
//  ни от модели, ни от конфигурации карточки — только от DOM-элемента,
//  three.js и колбэков. Подключается к любому canvas и любой камере.
//
//  * Мышь: ЛКМ — вращение, ПКМ или Shift+ЛКМ — сдвиг, колесо — зум
//    (Math.exp(deltaY * k)), двойной клик — сброс вида; контекстное
//    меню подавляется.
//  * Касания: один палец — вращение, два — щипок-зум (отношение
//    дистанций) и сдвиг по смещению середины между пальцами, двойной
//    тап — сброс вида, одиночный тап — onTap(x, y, event).
//  * Модуль сам выставляет элементу touch-action: none и возвращает
//    прежнее значение в dispose().
//
//  Если передана опция `apply`, встроенная орбитальная математика не
//  работает: модуль только распознаёт жест и вызывает
//    apply({ type: "orbit" | "pan" | "zoom" | "reset", dx, dy, factor })
//  — состояние остаётся у движка, camera не трогается, onChange с жестов
//  не вызывается (движок сообщает об изменениях сам).
//
//  Семантика `factor` в зуме: > 1 — отдалить, < 1 — приблизить.
// ============================================================================

import { clamp } from "./util.js";

// Коэффициенты жёсткости, общие для всех подключений: значения, которые уже
// отлажены в SceneEngine (scene.js), чтобы поведение не менялось при переходе.
const ROTATE_K = 0.006;    // рад/px при вращении
const PAN_K = 0.0016;      // доля радиуса на px при сдвиге
const WHEEL_K = 0.0012;    // колесо: factor = exp(deltaY * k)
const DOUBLE_TAP_SLOP = 24; // px, зона двойного тапа

/** Привести target к THREE.Vector3: принимает Vector3, [x, y, z] или {x, y, z}. */
function toVector3(THREE, v) {
  if (v instanceof THREE.Vector3) return v.clone();
  if (Array.isArray(v)) return new THREE.Vector3(v[0] || 0, v[1] || 0, v[2] || 0);
  return new THREE.Vector3(v && v.x || 0, v && v.y || 0, v && v.z || 0);
}

/**
 * @param {object} options
 * @param {HTMLElement} options.element    canvas: pointer-события и wheel
 * @param {object} options.THREE           библиотека three.js
 * @param {object} [options.camera]        THREE.Camera — куда писать положение
 * @param {object} [options.target]        начальный ориентир: Vector3 | [x,y,z] | {x,y,z}
 * @param {number} [options.radius]        начальная дистанция (5)
 * @param {number} [options.phi]           начальный полярный угол (1.2)
 * @param {number} [options.theta]         начальный азимут (0)
 * @param {number} [options.minRadius]     (0.001)
 * @param {number} [options.maxRadius]     (10000)
 * @param {number} [options.minPhi]        (0.001)
 * @param {number} [options.maxPhi]        (Math.PI - 0.001)
 * @param {boolean} [options.panoramic]    разрешено ли вращать азимут (true)
 * @param {boolean} [options.tilt]         разрешено ли наклонять (true)
 * @param {function} [options.apply]       движок со своей математикой, см. шапку
 * @param {function} [options.onChange]    (view) — вид изменился (только встроенная математика)
 * @param {function} [options.onTap]       (x, y, event) — одиночный тап/клик
 * @param {function} [options.onReset]     () — сброс вида (двойной клик/тап, reset())
 * @param {number} [options.dragThreshold] px, после которых тап превращается в перетаскивание (4)
 * @param {number} [options.tapMaxMs]      ms, дольше — тап не считается (500)
 * @param {number} [options.doubleTapMs]   ms, окно двойного тапа/клика (300)
 *
 * @returns {{ getView: function, setView: function, reset: function,
 *             setEnabled: function, update: function, dispose: function }}
 */
export function createCameraControls(options = {}) {
  const {
    element,
    THREE,
    camera = null,
    apply = null,
    onChange = null,
    onTap = null,
    onReset = null,
    dragThreshold = 4,
    tapMaxMs = 500,
    doubleTapMs = 300,
  } = options;

  if (!element || !element.addEventListener) throw new Error("createCameraControls: не передан element");
  if (!THREE) throw new Error("createCameraControls: не передан three.js");

  // ---- состояние вида --------------------------------------------------------
  // Во встроенной реализации state — единственный источник правды: жесты
  // меняют его, затем камера доводится до него. Во ветке apply state — только
  // зеркало для getView/setView, жестами не обновляется.

  const state = {
    target: toVector3(THREE, options.target),
    radius: Number.isFinite(options.radius) ? options.radius : 5,
    phi: Number.isFinite(options.phi) ? options.phi : 1.2,
    theta: Number.isFinite(options.theta) ? options.theta : 0,
  };
  const home = {
    target: state.target.clone(),
    radius: state.radius,
    phi: state.phi,
    theta: state.theta,
  };

  const minRadius = Number.isFinite(options.minRadius) ? options.minRadius : 0.001;
  const maxRadius = Number.isFinite(options.maxRadius) ? options.maxRadius : 10000;
  const minPhi = Number.isFinite(options.minPhi) ? options.minPhi : 0.001;
  const maxPhi = Number.isFinite(options.maxPhi) ? options.maxPhi : Math.PI - 0.001;
  const panoramic = options.panoramic !== false;
  const tilt = options.tilt !== false;

  let enabled = true;
  let disposed = false;

  // ---- жесты -----------------------------------------------------------------

  const pointers = new Map(); // pointerId -> { x, y }
  let mode = null;            // "rotate" | "pan" | "pinch" | null
  let lastX = 0, lastY = 0;   // предыдущая позиция активного указателя
  let pinchDist = 0;          // дистанция между пальцами на последнем move
  let midX = 0, midY = 0;     // середина между пальцами на последнем move
  let downAt = null;          // { x, y, t, moved, shift } — кандидат на тап
  let lastTap = null;         // { t, x, y } — для двойного тапа

  const now = () => performance.now();

  /** Перевести состояние в камеру (position + lookAt) и сообщить о смене вида. */
  function updateCamera() {
    if (!camera) return;
    const t = state.target, r = state.radius, p = state.phi, th = state.theta;
    camera.position.set(
      t.x + r * Math.sin(p) * Math.sin(th),
      t.y + r * Math.cos(p),
      t.z + r * Math.sin(p) * Math.cos(th),
    );
    camera.lookAt(t);
    if (onChange) onChange({ target: state.target, radius: state.radius, phi: state.phi, theta: state.theta });
  }

  function orbit(dx, dy) {
    if (apply) { apply({ type: "orbit", dx, dy }); return; }
    if (panoramic) state.theta -= dx * ROTATE_K;
    if (tilt) state.phi = clamp(state.phi - dy * ROTATE_K, minPhi, maxPhi);
    updateCamera();
  }

  function pan(dx, dy) {
    if (apply) { apply({ type: "pan", dx, dy }); return; }
    const s = state.radius * PAN_K;
    const fwd = new THREE.Vector3(Math.sin(state.theta), 0, Math.cos(state.theta));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
    state.target.addScaledVector(right, dx * s);
    state.target.y += dy * s;
    updateCamera();
  }

  function zoom(factor) {
    if (apply) { apply({ type: "zoom", factor }); return; }
    state.radius = clamp(state.radius * factor, minRadius, maxRadius);
    updateCamera();
  }

  function resetView() {
    if (apply) {
      apply({ type: "reset" });
    } else {
      state.target.copy(home.target);
      state.radius = home.radius;
      state.phi = home.phi;
      state.theta = home.theta;
      updateCamera();
    }
    if (onReset) onReset();
  }

  function firstTwo() {
    return [...pointers.values()].slice(0, 2);
  }

  function pointerDistance() {
    const [a, b] = firstTwo();
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Одиночный тап: либо onTap, либо (через doubleTapMs) сброс вида. */
  function handleTap(e) {
    const t = now();
    const x = e.clientX, y = e.clientY;
    if (lastTap && (t - lastTap.t) < doubleTapMs
        && Math.hypot(x - lastTap.x, y - lastTap.y) <= DOUBLE_TAP_SLOP) {
      lastTap = null;
      resetView();
      return;
    }
    lastTap = { t, x, y };
    if (onTap) onTap(x, y, e);
  }

  const onDown = (e) => {
    if (!enabled || disposed) return;
    element.setPointerCapture && element.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      mode = e.button === 2 || e.shiftKey ? "pan" : "rotate";
      lastX = e.clientX;
      lastY = e.clientY;
      downAt = { x: e.clientX, y: e.clientY, t: now(), moved: false, shift: !!e.shiftKey };
    } else if (pointers.size === 2) {
      mode = "pinch";
      downAt = null; // второй палец отменяет тап
      pinchDist = pointerDistance();
      const [a, b] = firstTwo();
      midX = (a.x + b.x) / 2;
      midY = (a.y + b.y) / 2;
    }
  };

  const onMove = (e) => {
    if (!enabled || disposed) return;
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (mode === "pinch" && pointers.size >= 2) {
      const d = pointerDistance();
      const [a, b] = firstTwo();
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (pinchDist > 0 && d !== pinchDist) zoom(pinchDist / Math.max(d, 1));
      if (mx !== midX || my !== midY) pan(mx - midX, my - midY);
      pinchDist = d;
      midX = mx;
      midY = my;
      return;
    }
    if (!mode) return;

    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (downAt && (Math.abs(e.clientX - downAt.x) > dragThreshold || Math.abs(e.clientY - downAt.y) > dragThreshold)) {
      downAt.moved = true;
    }

    if (mode === "rotate") orbit(dx, dy);
    else if (mode === "pan") pan(dx, dy);
  };

  const onUp = (e) => {
    if (disposed) return;
    pointers.delete(e.pointerId);
    element.releasePointerCapture && element.releasePointerCapture(e.pointerId);

    if (pointers.size === 0) {
      // Тап: короткий, без перетаскивания, на «тапабельном» указателе
      // (касающийся палец либо ЛКМ без Shift — ПКМ тапом не считается).
      if (enabled && downAt && !downAt.moved && (now() - downAt.t) < tapMaxMs
          && (e.pointerType !== "mouse" || (e.button === 0 && !downAt.shift))) {
        handleTap(e);
      }
      mode = null;
      downAt = null;
    } else if (pointers.size === 1) {
      // Палец ушёл: продолжаем тем, что остался, как вращением.
      const [p] = pointers.values();
      lastX = p.x;
      lastY = p.y;
      mode = "rotate";
    }
  };

  const onWheel = (e) => {
    if (!enabled || disposed) return;
    e.preventDefault && e.preventDefault();
    zoom(Math.exp((e.deltaY || 0) * WHEEL_K));
  };

  const onContext = (e) => e.preventDefault && e.preventDefault();
  const onDblClick = (e) => {
    if (!enabled || disposed) return;
    e.preventDefault && e.preventDefault();
    resetView();
  };

  element.addEventListener("pointerdown", onDown);
  element.addEventListener("pointermove", onMove);
  element.addEventListener("pointerup", onUp);
  element.addEventListener("pointercancel", onUp);
  element.addEventListener("wheel", onWheel, { passive: false });
  element.addEventListener("contextmenu", onContext);
  element.addEventListener("dblclick", onDblClick);

  // Без touch-action: none браузер уводит жест на прокрутку страницы — в любом
  // проекте, где живёт модуль. Прежнее значение храним, чтобы откатить.
  const prevTouchAction = element.style && element.style.touchAction ? element.style.touchAction : "";
  if (element.style) element.style.touchAction = "none";

  // Начальный вид сразу доводим до камеры (один вызов onChange при создании).
  if (!apply && camera) updateCamera();

  // ---- публичный API ----------------------------------------------------------

  function getView() {
    return { target: state.target, radius: state.radius, phi: state.phi, theta: state.theta };
  }

  function setView(partial = {}) {
    if (partial.target !== undefined) state.target.copy(toVector3(THREE, partial.target));
    if (Number.isFinite(partial.radius)) state.radius = partial.radius;
    if (Number.isFinite(partial.phi)) state.phi = partial.phi;
    if (Number.isFinite(partial.theta)) state.theta = partial.theta;
    if (!apply) updateCamera();
  }

  function reset() {
    resetView();
  }

  function setEnabled(flag) {
    enabled = !!flag;
  }

  /** Довести камеру до текущего состояния (например, после setView снаружи). */
  function update() {
    if (!apply) updateCamera();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    element.removeEventListener("pointerdown", onDown);
    element.removeEventListener("pointermove", onMove);
    element.removeEventListener("pointerup", onUp);
    element.removeEventListener("pointercancel", onUp);
    element.removeEventListener("wheel", onWheel);
    element.removeEventListener("contextmenu", onContext);
    element.removeEventListener("dblclick", onDblClick);
    if (element.style) element.style.touchAction = prevTouchAction;
    pointers.clear();
    mode = null;
    downAt = null;
    lastTap = null;
  }

  return { getView, setView, reset, setEnabled, update, dispose };
}
