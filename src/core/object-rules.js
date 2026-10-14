// ============================================================================
//  Движок правил: привязка сущностей Home Assistant к объектам загруженной
//  модели и действия по состоянию.
//
//  Действия (rule.action):
//    color  — цвет объекта (по условиям или по состоянию целиком)
//    hide   — видимость объекта
//    light  — подсветка: emissive + точечный источник света
//    rotate — непрерывное вращение (вентилятор, ротор)
//    door   — поворот/сдвиг на угол (двери, окна, шторы)
//    text   — подпись с состоянием (спрайт поверх объекта)
//
//  Каждое правило задаёт цель (target), условие (when/conditions/state) и
//  параметры. Значения плавно подводятся к цели, поэтому анимации выглядят
//  естественно, а не «щёлкают».
// ============================================================================

import { resolveColor, clamp, ease, fmtNumber } from "./util.js";
import { prettyState, numericValue, isAvailable } from "./state.js";

const DEFAULT_RATE = 6;        // скорость сглаживания, 1/с

/**
 * Построить движок правил по спецификации модели.
 * @param {object} spec   объект `bindings` из спецификации (или сама спецификация)
 * @param {object} ctx    контекст модели (THREE, makeLabel, report, …)
 * @param {THREE.Object3D} root  корень загруженной модели
 */
export function createRuleEngine(spec, ctx, root) {
  const THREE = ctx.THREE;
  const index = buildIndex(root);
  // Группы объектов объявляются в спецификации и разрешаются до привязок,
  // чтобы в target можно было писать "@lights".
  registerGroups(index, spec && spec.groups, ctx);
  const bindings = collectBindings(spec, index, ctx);
  const labels = [];
  const lights = [];
  const warnings = [];

  for (const b of bindings) {
    for (const rule of b.rules) {
      prepareRule(rule, b, { THREE, ctx, index, labels, lights, warnings });
    }
  }
  if (warnings.length && ctx.report) warnings.forEach((w) => ctx.report("warn", w));

  // --- состояние -------------------------------------------------------------

  const runtime = new Map();     // ключ привязки -> текущее состояние сущности
  /** Счётчики применений по действиям — для диагностики (см. status()). */
  const applied = { color: 0, hide: 0, light: 0, rotate: 0, door: 0, text: 0 };

  function setEntity(key, info) {
    runtime.set(key, info);
    for (const b of bindings) {
      if (b.entityKey !== key) continue;
      for (const rule of b.rules) {
        rule._dirty = true;
      }
    }
  }

  function frame(dt, time) {
    for (const b of bindings) {
      for (const rule of b.rules) {
        if (rule._dirty) {
          computeRule(rule, b, runtime.get(b.entityKey), ctx);
          rule._dirty = false;
        }
        try {
          applyRule(rule, dt, time, ctx);
        } catch (e) {
          // Ошибку в правиле показываем один раз на правило, но не роняем кадр:
          // из-за одной модели без материала не должна пропадать вся сцена.
          if (!rule._failed) {
            rule._failed = e.message || String(e);
            if (ctx.report) ctx.report("error", `правило ${rule.action} для «${rule.target}»: ${rule._failed}`);
          }
        }
        applied[rule.action] = (applied[rule.action] || 0) + 1;
      }
    }
  }

  function dispose() {
    for (const l of labels) {
      if (l.sprite && l.sprite.parent) l.sprite.parent.remove(l.sprite);
      if (l.sprite && l.sprite.material) {
        if (l.sprite.material.map) l.sprite.material.map.dispose();
        l.sprite.material.dispose();
      }
    }
    for (const light of lights) {
      if (light.parent) light.parent.remove(light);
      if (light.dispose) light.dispose();
    }
    labels.length = 0;
    lights.length = 0;
  }

  return {
    setEntity,
    frame,
    dispose,
    /** Список найденных привязок — для диагностики и тестов. */
    describe() {
      return bindings.map((b) => ({
        entityKey: b.entityKey,
        targets: b.rules.map((r) => r.target),
        actions: b.rules.map((r) => r.action),
        missing: !!b.missing,
      }));
    },
    /**
     * Текущее состояние правил: что должно быть и что есть.
     * Помогает понять, почему объект не реагирует на сущность.
     */
    status() {
      return bindings.flatMap((b) => b.rules.map((r) => {
        const info = runtime.get(b.entityKey);
        return {
          entity: b.entityKey,
          target: r.target,
          action: r.action,
          hasState: !!info,
          state: info && info.state ? String(info.state.state) : null,
          value: info ? info.value : undefined,
          targetColor: r._targetColor ? `#${r._targetColor.getHexString()}` : undefined,
          hasColor: r._hasColor,
          materials: r._materials ? r._materials.length : undefined,
          materialColor: r._materials && r._materials[0] && r._materials[0].color
            ? `#${r._materials[0].color.getHexString()}`
            : undefined,
          targetIntensity: r._targetIntensity,
          currentIntensity: r._currentIntensity,
          targetVisible: r._targetVisible,
          visible: r.object ? r.object.visible : undefined,
          speed: r._speed,
          doorProgress: r._targetProgress,
          hinge: r._hingeClosedPivot
            ? [`${r._hingeClosedPivot.x.toFixed(2)}`, `${r._hingeClosedPivot.y.toFixed(2)}`, `${r._hingeClosedPivot.z.toFixed(2)}`]
            : undefined,
          objectCenter: r._objectCenter
            ? [`${r._objectCenter.x.toFixed(2)}`, `${r._objectCenter.y.toFixed(2)}`, `${r._objectCenter.z.toFixed(2)}`]
            : undefined,
          objectPos: r.object && r.object.position
            ? [`${r.object.position.x.toFixed(2)}`, `${r.object.position.y.toFixed(2)}`, `${r.object.position.z.toFixed(2)}`]
            : undefined,
          text: r._lastText,
        };
      }));
    },
    /** Имена объектов модели (для редактора и проверок). */
    objectNames() { return [...index.byName.keys()]; },

    /** Счётчики применений действий — для диагностики. */
    appliedCounters() { return Object.assign({}, applied); },

    /** Диагностика: совпадает ли материал правила с ожидаемым объектом. */
    colorMaterialIs(target, indexInRule, material) {
      for (const b of bindings) {
        for (const r of b.rules) {
          if (r.target === target && r._materials && r._materials.length) {
            return r._materials[indexInRule || 0] === material;
          }
        }
      }
      return "правило с материалами не найдено";
    },
  };
}

// ---- разбор спецификации ----------------------------------------------------

function collectBindings(spec, index, ctx) {
  const list = Array.isArray(spec) ? spec : (spec && spec.bindings) || [];
  const out = [];
  for (const raw of list) {
    if (!raw || !raw.entity) continue;
    const targets = Array.isArray(raw.target) ? raw.target : [raw.target].filter(Boolean);
    if (!targets.length) continue;
    const rules = [];
    let missing = false;
    for (const action of normalizeActions(raw)) {
      for (const target of targets) {
        const objects = resolveTarget(target, index);
        if (!objects.length) {
          missing = true;
          if (ctx && ctx.report) ctx.report("warn", `объект «${target}» не найден в модели (привязка ${raw.entity})`);
          continue;
        }
        for (const obj of objects) {
          rules.push(Object.assign({}, action, {
            action: action.action,
            target,
            object: obj,
            entityKey: raw.entity,
            id: `${raw.entity}:${target}:${action.action}`,
            rate: Number.isFinite(action.rate) ? action.rate : DEFAULT_RATE,
            _dirty: true,
          }));
        }
      }
    }
    out.push({
      entityKey: raw.entity,
      entity: raw,
      targets,
      rules,
      missing,
    });
  }
  return out;
}

/** Привести описание действий к массиву (поддерживаем краткую запись). */
function normalizeActions(raw) {
  const out = [];
  const push = (a) => { if (a && a.action) out.push(a); };

  if (Array.isArray(raw.actions)) raw.actions.forEach(push);

  // Краткие формы: цвета, видимость, вращение, дверь, свет, текст
  if (raw.colors) push({ action: "color", colors: raw.colors, restore: raw.restore });
  if (raw.color !== undefined && !raw.colors) push({ action: "color", colors: raw.color, restore: raw.restore });
  if (raw.hide !== undefined) push({ action: "hide", hidden: parseVisibleStates(raw.hide) });
  if (raw.rotate) push(Object.assign({ action: "rotate" }, raw.rotate));
  if (raw.door) push(Object.assign({ action: "door" }, raw.door));
  if (raw.light) push(Object.assign({ action: "light" }, raw.light));
  if (raw.text) push(Object.assign({ action: "text" }, raw.text));

  return out;
}

/** `hide: true` / `hide: ["off","closed"]` / `hide: "off"` -> предикат состояния. */
function parseVisibleStates(hide) {
  if (hide === true) return { states: ["off", "closed", "unavailable", "unknown"], invert: true };
  if (hide === false) return null;
  const states = Array.isArray(hide) ? hide : [hide];
  return { states: states.map((s) => String(s).toLowerCase()), invert: false };
}

// ---- поиск объектов ---------------------------------------------------------

/** Индекс объектов модели по имени: точное, без регистра и по префиксу. */
function buildIndex(root) {
  const byName = new Map();
  const all = [];
  root.traverse((node) => {
    if (!node.name) return;
    all.push(node);
    byName.set(node.name, node);
    const lower = node.name.toLowerCase();
    if (!byName.has(lower)) byName.set(lower, node);
  });
  return { byName, all, root };
}

/**
 * Найти объекты по имени. Поддерживается:
 *   "Lamp_1"            — точное имя (регистр не важен)
 *   "/^Lamp_/"          — регулярное выражение
 *   "Lamp_*"            — шаблон со звёздочкой
 *   "@group:lights"     — группа объектов из спецификации
 */
function resolveTarget(target, index) {
  const t = String(target);
  if (t.startsWith("@")) {
    const group = index.groups && index.groups.get(t.slice(1));
    return group ? group.slice() : [];
  }
  if (index.byName.has(t)) return [index.byName.get(t)];
  const lower = t.toLowerCase();
  if (index.byName.has(lower)) return [index.byName.get(lower)];

  if (t.length > 2 && t.startsWith("/") && t.endsWith("/")) {
    try {
      const re = new RegExp(t.slice(1, -1), "i");
      return index.all.filter((n) => re.test(n.name));
    } catch (e) {
      return [];
    }
  }
  if (t.includes("*") || t.includes("?")) {
    const re = new RegExp("^" + t.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
    return index.all.filter((n) => re.test(n.name));
  }
  return [];
}

/** Зарегистрировать группы объектов (вызывается один раз после загрузки). */
export function registerGroups(index, groups, ctx) {
  index.groups = new Map();
  for (const [name, targets] of Object.entries(groups || {})) {
    const list = [];
    for (const t of (Array.isArray(targets) ? targets : [targets])) {
      list.push(...resolveTarget(t, index));
    }
    index.groups.set(name, list);
    if (!list.length && ctx && ctx.report) {
      ctx.report("warn", `группа «${name}» не нашла ни одного объекта`);
    }
  }
  return index;
}

// ---- правила: подготовка ----------------------------------------------------

function prepareRule(rule, binding, env) {
  const { THREE, ctx, index, labels, lights, warnings } = env;
  const obj = rule.object;

  switch (rule.action) {
    case "color": {
      rule._targetColor = new THREE.Color("#ffffff");
      rule._currentColor = new THREE.Color("#ffffff");
      const materials = collectMaterials(obj);
      rule._materials = materials;
      if (!materials.length) warnings.push(`«${rule.target}»: нет материалов для смены цвета`);
      for (const m of materials) {
        if (!m.userData) m.userData = {};
        if (!m.userData._baseColor && m.color) m.userData._baseColor = m.color.clone();
      }
      rule._baseColors = materials.map((m) => (m.userData._baseColor || m.color || new THREE.Color("#ffffff")).clone());
      break;
    }
    case "hide": {
      rule._currentVisible = true;
      break;
    }
    case "light": {
      const materials = collectMaterials(obj);
      rule._materials = materials;
      for (const m of materials) {
        if (!m.userData) m.userData = {};
        if (!m.userData._baseEmissive && m.emissive) m.userData._baseEmissive = m.emissive.clone();
      }
      rule._baseEmissive = materials.map((m) => (m.userData._baseEmissive || (m.emissive ? m.emissive.clone() : new THREE.Color(0x000000))));

      // Источник света ставим в центр объекта.
      const box = new THREE.Box3().setFromObject(obj);
      const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
      const color = resolveColor(rule.color || "#fff6e0");
      const maxLumens = Number.isFinite(rule.lumens) ? rule.lumens : 800;
      const light = new THREE.PointLight(
        new THREE.Color(color),
        0,
        Number.isFinite(rule.distance) ? rule.distance : 0,
        Number.isFinite(rule.decay) ? rule.decay : 2
      );
      // Источник света вешаем на корень модели: так он не наследует
      // трансформации объекта (иначе свет «уезжает» вместе с вращением лампы).
      // Позиция источника задаётся в системе родителя, а габариты Box3 —
      // мировые, поэтому переводим центр в локальные координаты родителя.
      const host = env.root || obj.parent || obj;
      const localCenter = host.worldToLocal
        ? host.worldToLocal(center.clone())
        : center;
      light.position.copy(localCenter);
      if (rule.offset) {
        light.position.add(new THREE.Vector3(rule.offset[0] || 0, rule.offset[1] || 0, rule.offset[2] || 0));
      }
      light.castShadow = !!rule.castShadow;
      light.userData._maxIntensity = Math.max(0.05, maxLumens / 1000);
      rule._light = light;
      rule._currentIntensity = 0;
      lights.push(light);
      host.add(light);
      break;
    }
    case "rotate": {
      rule._angle = 0;
      rule._speed = 0;
      const axis = String(rule.axis || "y").toLowerCase();
      rule._axis = axis === "x" ? new THREE.Vector3(1, 0, 0)
        : axis === "z" ? new THREE.Vector3(0, 0, 1)
          : new THREE.Vector3(0, 1, 0);
      break;
    }
    case "door": {
      rule._progress = 0;                 // 0 — закрыто, 1 — открыто
      rule._baseQuaternion = obj.quaternion.clone();
      rule._basePosition = obj.position.clone();
      if (rule.open === undefined && rule.states) rule.open = rule.states;
      if (!rule.hinge) {
        warnings.push(`«${rule.target}»: не задан hinge (точка подвеса), дверь будет вращаться вокруг своего центра`);
      }
      prepareHinge(rule, obj, THREE);
      break;
    }
    case "text": {
      const sprite = ctx.makeLabel(rule.prefix || rule.target, { scale: rule.scale || 0.0035 });
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
      const worldCenter = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
      const host = obj.parent || obj;
      const center = host.worldToLocal ? host.worldToLocal(worldCenter.clone()) : worldCenter;
      const span = Number.isFinite(rule.span) ? rule.span : 0;
      sprite.position.set(
        center.x + (rule.offset ? rule.offset[0] || 0 : 0),
        center.y + size.y * 0.5 + (Number.isFinite(rule.elevation) ? rule.elevation : 0.15) + span,
        center.z + (rule.offset ? rule.offset[2] || 0 : 0)
      );
      host.add(sprite);
      rule._sprite = sprite;
      rule._lastText = null;
      labels.push({ sprite, rule });
      break;
    }
    default:
      break;
  }
}

/**
 * Точка подвеса двери.
 *
 * Координаты габаритов в three.js мировые, а позиция объекта — локальная.
 * Смешивать их нельзя: при автоцентровке модели (source.center/ground)
 * разница давала ошибку в метрах — дверь «улетала» вместо поворота вокруг
 * края. Поэтому переводим мировой центр габаритов в систему родителя и
 * берём смещение относительно позиции объекта.
 */
function prepareHinge(rule, obj, THREE) {
  const parent = obj.parent;
  if (parent && parent.updateWorldMatrix) parent.updateWorldMatrix(true, false);
  if (obj.updateWorldMatrix) obj.updateWorldMatrix(true, false);

  const box = new THREE.Box3().setFromObject(obj);
  const size = box.isEmpty() ? null : box.getSize(new THREE.Vector3());

  // Центр створки в системе родителя. Box3 даёт МИРОВЫЕ координаты, позиция
  // объекта — локальные: смешивать нельзя (модель может быть сдвинута
  // автоцентровкой при загрузке).
  const worldCenter = box.isEmpty()
    ? obj.getWorldPosition(new THREE.Vector3())
    : box.getCenter(new THREE.Vector3());
  const center = parent && parent.worldToLocal
    ? parent.worldToLocal(worldCenter.clone())
    : worldCenter;
  if (rule.hingeOffset) {
    center.x += Number(rule.hingeOffset[0]) || 0;
    center.y += Number(rule.hingeOffset[1]) || 0;
    center.z += Number(rule.hingeOffset[2]) || 0;
  }

  const half = {
    x: size && Math.abs(size.x) > 1e-4 ? size.x / 2 : (Number.isFinite(rule.hingeSpan) ? rule.hingeSpan / 2 : 0.4),
    y: size && Math.abs(size.y) > 1e-4 ? size.y / 2 : 0.5,
  };

  const side = String(rule.hinge || "left").toLowerCase();
  const x = side.includes("left") ? -half.x
    : side.includes("right") ? half.x
      : 0;
  const y = side.includes("bottom") ? -half.y
    : side.includes("top") ? half.y
      : 0;

  // Точка подвеса в закрытом положении: край створки в системе родителя.
  rule._hingeClosedPivot = new THREE.Vector3(center.x + x, center.y + y, center.z);

  // Геометрию сдвигаем так, чтобы точка подвеса оказалась в НАЧАЛЕ КООРДИНАТ
  // объекта, а сам объект ставим в эту точку. Тогда поворот на любой угол —
  // это просто поворот объекта вокруг своей оси, без пересчёта позиции.
  if (obj.geometry && obj.geometry.translate) {
    obj.geometry.translate(rule._hingeClosedPivot.x - obj.position.x,
      rule._hingeClosedPivot.y - obj.position.y,
      rule._hingeClosedPivot.z - obj.position.z);
  }
  obj.position.copy(rule._hingeClosedPivot);

  rule._objectCenter = center;
  rule._hingeOffsetVec = new THREE.Vector3(x, y, 0);
  rule._hingeHalf = half;
}

// ---- правила: вычисление цели ----------------------------------------------

function computeRule(rule, binding, info, ctx) {
  const state = info && info.state;
  const value = info && info.value;
  const available = isAvailable(state);
  const raw = state ? String(state.state) : "unavailable";

  switch (rule.action) {
    case "color": {
      const color = pickColor(rule, raw, value, ctx);
      rule._targetColor.set(color || rule.color || "#ffffff");
      rule._hasColor = !!color;
      break;
    }
    case "hide": {
      rule._targetVisible = !isHidden(rule, raw, available);
      break;
    }
    case "light": {
      const on = isOn(rule, raw, available);
      const max = rule._light ? rule._light.userData._maxIntensity : 1;
      let intensity = on ? max : 0;
      // Для light с яркостью — плавная зависимость
      if (on && rule.useBrightness && info && info.brightness !== undefined) {
        intensity = max * clamp(info.brightness, 0, 1);
      } else if (on && Number.isFinite(value) && rule.valueMax) {
        intensity = max * clamp(value / rule.valueMax, 0, 1);
      }
      rule._targetIntensity = intensity;
      rule._emissiveOn = on;
      break;
    }
    case "rotate": {
      const on = isOn(rule, raw, available);
      const rps = Number.isFinite(rule.round_per_second) ? rule.round_per_second
        : Number.isFinite(rule.rps) ? rule.rps : 1;
      const dir = String(rule.direction || "").toLowerCase() === "reverse" ? -1 : 1;
      rule._speed = (on ? 1 : 0) * rps * dir * Math.PI * 2;
      break;
    }
    case "door": {
      rule._targetProgress = doorProgress(rule, raw, value, available);
      break;
    }
    case "text": {
      const text = formatText(rule, binding, info, ctx);
      if (text !== rule._lastText) {
        rule._lastText = text;
        if (rule._sprite && rule._sprite.userData.redraw) rule._sprite.userData.redraw(text);
      }
      break;
    }
    default:
      break;
  }
}

function pickColor(rule, raw, value, ctx) {
  // 1. Таблица состояний: colors: { "on": "#ffcc00", "off": "#333" }
  if (rule.colors && typeof rule.colors === "object" && !Array.isArray(rule.colors)) {
    const key = Object.keys(rule.colors).find((k) => k.toLowerCase() === raw.toLowerCase());
    if (key) return resolveColor(rule.colors[key]);
    // Числовой диапазон: colors: { ">=30": "#ff0000", "<10": "#00ff00" }
    const numeric = numericValue({ state: raw });
    if (Number.isFinite(numeric)) {
      for (const [cond, color] of Object.entries(rule.colors)) {
        if (matchesCondition(cond, raw, numeric)) return resolveColor(color);
      }
    }
  }
  // 2. Цвет по значению как по шкале (градиент)
  if (rule.scale && Number.isFinite(value)) {
    const from = rule.scale.from || { min: 0, max: 100 };
    const stops = rule.scale.colors || ["#2f9df4", "#ffcc00", "#e53935"];
    const t = clamp((value - (from.min || 0)) / (((from.max ?? 100) - (from.min || 0)) || 1), 0, 1);
    return lerpColors(stops, t, ctx);
  }
  // 3. Условия списком
  if (Array.isArray(rule.conditions)) {
    const numeric = numericValue({ state: raw });
    for (const c of rule.conditions) {
      const cond = c.condition !== undefined ? c.condition : c.state;
      if (matchesCondition(cond, raw, numeric)) return resolveColor(c.color);
    }
  }
  // 4. Одно условие
  if (rule.condition && matchesCondition(rule.condition, raw, numericValue({ state: raw }))) {
    return resolveColor(rule.color);
  }
  // 5. Без условий — цвет применяется всегда (например, «холодный» оттенок)
  if (!rule.conditions && !rule.colors && !rule.condition && rule.color) return resolveColor(rule.color);
  return null;
}

function lerpColors(stops, t, ctx) {
  const colors = stops.map((s) => resolveColor(s));
  const scaled = t * (colors.length - 1);
  const i = Math.min(colors.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = ctx.THREE.Color ? new ctx.THREE.Color(colors[i]) : null;
  if (!a) return colors[i];
  return a.lerp(new ctx.THREE.Color(colors[i + 1]), f).getStyle();
}

/** Скрывать ли объект: hide-условия («hide: ["off"]») или когда сущность недоступна. */
function isHidden(rule, raw, available) {
  if (rule.hidden) {
    if (rule.hidden.invert) return rule.hidden.states.includes(raw.toLowerCase());
    return rule.hidden.states.includes(raw.toLowerCase());
  }
  if (rule.hideWhen) {
    const list = Array.isArray(rule.hideWhen) ? rule.hideWhen : [rule.hideWhen];
    return list.some((s) => matchesCondition(s, raw, numericValue({ state: raw })));
  }
  if (rule.showWhen) {
    const list = Array.isArray(rule.showWhen) ? rule.showWhen : [rule.showWhen];
    return !list.some((s) => matchesCondition(s, raw, numericValue({ state: raw })));
  }
  if (!available && rule.hideUnavailable !== false) return false;
  return false;
}

function isOn(rule, raw, available) {
  if (!available) return false;
  const onStates = rule.on || rule.states || ["on", "open", "opening", "heat", "cool", "auto", "home", "playing", "detected"];
  const list = Array.isArray(onStates) ? onStates : [onStates];
  const lower = raw.toLowerCase();
  if (list.some((s) => String(s).toLowerCase() === lower)) return true;
  // Числовое значение: > 0 считается «включено»
  const n = numericValue({ state: raw });
  if (Number.isFinite(n)) return n > 0;
  return false;
}

function doorProgress(rule, raw, value, available) {
  if (!available) return 0;
  const openStates = rule.open || ["on", "open", "opening"];
  const list = Array.isArray(openStates) ? openStates : [openStates];
  const lower = raw.toLowerCase();
  if (list.some((s) => String(s).toLowerCase() === lower)) return 1;

  // Проценты: position, percentage, cover
  if (Number.isFinite(value)) {
    const max = Number.isFinite(rule.valueMax) ? rule.valueMax : 100;
    return clamp(value / max, 0, 1);
  }
  const pct = rule.percentage !== undefined ? rule.percentage : null;
  if (pct !== null) return clamp(Number(pct) / 100, 0, 1);
  return 0;
}

/** Проверка условия: "on", ">50", "<=10", "!off", "/^heat/". */
export function matchesCondition(condition, rawState, numeric) {
  if (condition === undefined || condition === null) return false;
  const cond = String(condition).trim();
  if (!cond) return false;

  if (cond.startsWith("/") && cond.endsWith("/") && cond.length > 2) {
    try { return new RegExp(cond.slice(1, -1), "i").test(rawState); } catch (e) { return false; }
  }
  const m = cond.match(/^(>=|<=|>|<|==|!=|=)\s*(-?[\d.]+)$/);
  if (m) {
    const target = parseFloat(m[2]);
    const v = Number.isFinite(numeric) ? numeric : parseFloat(rawState);
    if (!Number.isFinite(v)) return false;
    switch (m[1]) {
      case ">": return v > target;
      case ">=": return v >= target;
      case "<": return v < target;
      case "<=": return v <= target;
      case "!=": return v !== target;
      default: return v === target;
    }
  }
  if (cond.startsWith("!")) return rawState.toLowerCase() !== cond.slice(1).trim().toLowerCase();
  return rawState.toLowerCase() === cond.toLowerCase();
}

/** Подстановки в тексте: {state}, {value}, {name}, {unit}, {entity}. */
function formatText(rule, binding, info, ctx) {
  const state = info && info.state;
  const template = rule.template || rule.label_text || "{state}";
  const value = info && info.value;
  const unit = (state && state.attributes && state.attributes.unit_of_measurement) || "";
  const name = (state && state.attributes && state.attributes.friendly_name) || (binding.entity && binding.entity.name) || "";
  const digits = Number.isFinite(rule.digits) ? rule.digits : 1;

  const text = String(template)
    .replace(/\{state\}/g, state ? prettyState(state) : "—")
    .replace(/\{value\}/g, Number.isFinite(value) ? fmtNumber(value, digits) : (state ? state.state : "—"))
    .replace(/\{name\}/g, name)
    .replace(/\{unit\}/g, unit)
    .replace(/\{entity\}/g, (info && info.entity) || "")
    .replace(/\{friendly_state\}/g, state ? prettyState(state) : "—");

  return rule.prefix ? `${rule.prefix} ${text}` : text;
}

// ---- правила: применение ----------------------------------------------------

function applyRule(rule, dt, time, ctx) {
  rule._applied = (rule._applied || 0) + 1;
  switch (rule.action) {
    case "color": {
      if (!rule._materials || !rule._materials.length) return;
      const target = rule._hasColor || rule.restore === false
        ? rule._targetColor
        : null;
      for (let i = 0; i < rule._materials.length; i++) {
        const m = rule._materials[i];
        if (!m.color) continue;
        const dest = target || rule._baseColors[i];
        m.color.lerp(dest, 1 - Math.exp(-rule.rate * dt));
      }
      ctx.requestRender && ctx.requestRender();
      break;
    }
    case "hide": {
      const want = rule._targetVisible !== false;
      if (objVisible(rule.object) === want) return;
      setVisible(rule.object, want);
      ctx.requestRender && ctx.requestRender();
      break;
    }
    case "light": {
      const target = rule._targetIntensity || 0;
      rule._currentIntensity = ease(rule._currentIntensity, target, rule.rate, dt);
      if (rule._light) rule._light.intensity = rule._currentIntensity;
      // Свечение материала — чтобы «лампа» выглядела включённой и без источника
      if (rule._materials && rule._materials.length) {
        const k = rule._light && rule._light.userData._maxIntensity
          ? clamp(rule._currentIntensity / rule._light.userData._maxIntensity, 0, 1)
          : (rule._emissiveOn ? 1 : 0);
        for (let i = 0; i < rule._materials.length; i++) {
          const m = rule._materials[i];
          if (!m.emissive) continue;
          const base = rule._baseEmissive[i];
          const glow = new ctx.THREE.Color(resolveColor(rule.color || "#fff6e0"));
          m.emissive.copy(base).lerp(glow, k);
          if ("emissiveIntensity" in m) m.emissiveIntensity = Math.max(m.userData._baseEmissiveIntensity || 0, k);
        }
      }
      ctx.requestRender && ctx.requestRender();
      break;
    }
    case "rotate": {
      const speed = ease(rule._currentSpeed || 0, rule._speed || 0, 2, dt);
      rule._currentSpeed = speed;
      if (Math.abs(speed) < 1e-4) return;
      rule._angle += speed * dt;
      rule.object.rotateOnAxis(rule._axis, speed * dt);
      ctx.requestRender && ctx.requestRender();
      break;
    }
    case "door": {
      const target = rule._targetProgress || 0;
      rule._progress = ease(rule._progress, target, rule.rate, dt);
      const angle = (Number.isFinite(rule.degrees) ? rule.degrees : 90) * Math.PI / 180 * rule._progress;
      const obj = rule.object;
      obj.quaternion.copy(rule._baseQuaternion);
      obj.position.copy(rule._basePosition);
      if (rule.slide) {
        // Сдвиг (раздвижные двери, шторы): смещение вдоль оси
        const axis = String(rule.axis || "x").toLowerCase();
        const span = Number.isFinite(rule.span) ? rule.span : 1;
        const offset = span * rule._progress;
        if (axis === "x") obj.position.x += offset;
        else if (axis === "y") obj.position.y += offset;
        else obj.position.z += offset;
      } else {
        // Поворот створки вокруг вертикальной оси. Геометрия уже сдвинута так,
        // что ось проходит через начало координат объекта (см. prepareHinge),
        // поэтому достаточно применить поворот к кватерниону.
        const side = String(rule.hinge || "left").toLowerCase();
        const sign = side.includes("right") ? -1 : 1;
        const axisName = String(rule.axis || "y").toLowerCase();
        const rotAxis = axisName === "x" ? new ctx.THREE.Vector3(1, 0, 0)
          : axisName === "z" ? new ctx.THREE.Vector3(0, 0, 1)
            : new ctx.THREE.Vector3(0, 1, 0);
        const q = new ctx.THREE.Quaternion().setFromAxisAngle(rotAxis, angle * sign);
        obj.position.copy(rule._hingeClosedPivot);
        obj.quaternion.copy(rule._baseQuaternion).premultiply(q);
      }
      ctx.requestRender && ctx.requestRender();
      break;
    }
    default:
      break;
  }
}

function objVisible(obj) {
  return obj.visible;
}

function setVisible(obj, visible) {
  obj.visible = visible;
  // Если у объекта есть дети, скрываем и их: у OBJ-моделей группа — это объект.
  obj.traverse((n) => { if (n !== obj) n.visible = visible; });
}

function collectMaterials(obj) {
  const out = [];
  obj.traverse((n) => {
    if (!n.material) return;
    const list = Array.isArray(n.material) ? n.material : [n.material];
    for (const m of list) if (!out.includes(m)) out.push(m);
  });
  return out;
}
