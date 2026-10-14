// ============================================================================
//  Привязки (bindings) — сердце идеи «модель сама объявляет свои переменные».
//
//  Модель описывает массив bindings. Из него:
//    1) строится форма в редакторе карточки (ha-entity-picker + параметры),
//    2) нормализуется конфигурация карточки (config.entities / config.params),
//    3) движок знает, какие сущности слушать и как читать их значения.
//
//  Поддерживаемые поля описания привязки:
//    key         {string}   ключ, под которым модель получает значение (обязателен)
//    name        {string}   подпись в редакторе (обязателен)
//    description {string}   пояснение под полем
//    domain      {string[]} домены для фильтра ha-entity-picker
//    deviceClass {string|string[]} фильтр по device_class (частичное совпадение)
//    unit        {string|string[]} фильтр по unit_of_measurement (частичное совпадение)
//    required    {boolean}  подсветить как обязательную привязку
//    optional    {boolean}  по умолчанию true для всех, кроме required
//    group       {string}   заголовок группы в редакторе
//    order       {number}   порядок внутри группы
//    value       {object}   как читать значение (см. VALUE_KINDS)
//    picker      {object}   доп. настройки ha-entity-picker (allowCustomEntity и т.п.)
//    options     {Array}    [{value,label}] — если нужно выбрать конкретное состояние
//    hint        {string}   текст-подсказка под полем
// ============================================================================

/** Способы чтения значения из состояния HA. */
export const VALUE_KINDS = {
  /** Сырое состояние строкой ("on", "42.5"). */
  raw: (state) => (state ? String(state.state) : undefined),
  /** Число (NaN, если не число). */
  number: (state) => {
    if (!state) return NaN;
    const raw = String(state.state).trim().replace(",", ".");
    if (["unknown", "unavailable", "none", "null", ""].includes(raw.toLowerCase())) return NaN;
    return parseFloat(raw);
  },
  /** true/false по «активности» состояния. */
  boolean: (state) => {
    if (!state) return false;
    const raw = String(state.state).toLowerCase();
    if (["unknown", "unavailable", "none", "null", ""].includes(raw)) return false;
    if (["on", "open", "opening", "home", "detected", "playing", "cleaning"].includes(raw)) return true;
    if (["off", "closed", "closing", "not_home", "idle", "docked"].includes(raw)) return false;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n > 0 : false;
  },
  /** Яркость 0..1 (light). */
  brightness: (state) => {
    if (!state) return 0;
    const a = state.attributes || {};
    if (Number.isFinite(a.brightness_pct)) return Math.max(0, Math.min(1, a.brightness_pct / 100));
    if (Number.isFinite(a.brightness)) return Math.max(0, Math.min(1, a.brightness / 255));
    return String(state.state).toLowerCase() === "on" ? 1 : 0;
  },
  /** Значение конкретного атрибута. */
  attribute: (state, param) => {
    if (!state || !param) return undefined;
    return (state.attributes || {})[param];
  },
};

const DEFAULT_VALUE = { kind: "raw" };

/** Привести одну привязку к предсказуемому виду. */
export function normalizeBinding(raw, index = 0) {
  if (!raw || !raw.key) throw new Error(`bindings[${index}]: не задан key`);
  const b = Object.assign({}, raw);
  b.name = b.name || b.key;
  b.domain = toArray(b.domain);
  b.deviceClass = toArray(b.deviceClass);
  b.unit = toArray(b.unit);
  b.order = Number.isFinite(b.order) ? b.order : index;
  b.value = Object.assign({}, DEFAULT_VALUE, b.value || {});
  if (b.value.kind !== "attribute" && b.value.param) {
    // param имеет смысл только для attribute
    b.value = Object.assign({}, b.value);
    delete b.value.param;
  }
  return b;
}

/** Нормализовать массив привязок модели + проверить уникальность ключей. */
export function normalizeBindings(list) {
  const arr = (list || []).map((b, i) => normalizeBinding(b, i));
  const seen = new Set();
  for (const b of arr) {
    if (seen.has(b.key)) throw new Error(`bindings: ключ "${b.key}" объявлен дважды`);
    seen.add(b.key);
  }
  return arr.sort((a, b) => a.order - b.order);
}

/** Привести описание параметра к предсказуемому виду. */
export function normalizeParam(raw, index = 0) {
  if (!raw || !raw.key) throw new Error(`params[${index}]: не задан key`);
  const p = Object.assign({}, raw);
  p.name = p.name || p.key;
  p.type = p.type || "text";
  p.order = Number.isFinite(p.order) ? p.order : index;
  return p;
}

export function normalizeParams(list) {
  return (list || []).map((p, i) => normalizeParam(p, i)).sort((a, b) => a.order - b.order);
}

/**
 * Нормализовать конфигурацию карточки по схеме модели.
 * Возвращает:
 *   {
 *     entities: { key: entityId },        // только непустые
 *     params:   { key: value },           // только заданные пользователем
 *     warnings: [ "…" ],                  // проблемы, которые стоит показать
 *   }
 */
export function normalizeConfig(config, schema) {
  const warnings = [];
  const entities = {};
  const params = {};

  const rawEntities = Object.assign({}, (config && config.entities) || {});

  // 1. Сущности по схеме
  for (const b of schema.bindings) {
    const id = trim(rawEntities[b.key]);
    if (id) {
      entities[b.key] = id;
      continue;
    }
    if (b.required) warnings.push(`Не выбрана сущность для «${b.name}» (${b.key})`);
  }

  // 2. Сущности, которых нет в схеме (совместимость с legacy-конфигами):
  //    молча не теряем — модель получит их через ctx.entities.
  for (const [key, id] of Object.entries(rawEntities)) {
    if (schema.bindingKeys.has(key)) continue;
    const clean = trim(id);
    if (clean) entities[key] = clean;
  }

  // 3. Параметры модели: значения пользователя поверх значений по умолчанию
  const userParams = Object.assign({}, (config && config.params) || {});
  for (const p of schema.params) {
    const hasUser = Object.prototype.hasOwnProperty.call(userParams, p.key);
    const value = hasUser ? userParams[p.key] : p.default;
    if (value === undefined || value === null || value === "") continue;
    params[p.key] = coerceParam(value, p);
  }
  // 4. Параметры вне схемы — сохраняем как есть (модель может знать о них больше)
  for (const [key, value] of Object.entries(userParams)) {
    if (schema.paramKeys.has(key)) continue;
    if (value !== undefined) params[key] = value;
  }

  return { entities, params, warnings };
}

/** Привести значение параметра к типу, объявленному в схеме. */
export function coerceParam(value, param) {
  switch (param.type) {
    case "number":
    case "range": {
      const n = typeof value === "number" ? value : parseFloat(String(value).replace(",", "."));
      if (!Number.isFinite(n)) return param.default;
      let out = n;
      if (Number.isFinite(param.min)) out = Math.max(param.min, out);
      if (Number.isFinite(param.max)) out = Math.min(param.max, out);
      return out;
    }
    case "boolean":
      return value === true || value === "true" || value === 1 || value === "1";
    default:
      return value;
  }
}

/** Прочитать значение привязки из состояния (с учётом value.kind и value.param). */
export function readValue(binding, state, params) {
  const kind = (binding.value && binding.value.kind) || "raw";
  const fn = VALUE_KINDS[kind] || VALUE_KINDS.raw;
  let v = fn(state, binding.value && binding.value.param);
  const scale = binding.value && binding.value.scale;
  if (scale && Number.isFinite(v)) {
    const from = scale.from || { min: 0, max: 1 };
    const to = scale.to || { min: 0, max: 1 };
    const span = (from.max - from.min) || 1;
    v = to.min + ((v - from.min) / span) * (to.max - to.min);
    if (scale.round) v = Math.round(v);
  }
  return v;
}

/** Собрать карту key -> entity_id для шины состояний. */
export function entityMap(entities, schema) {
  const map = {};
  const keys = new Set([...(schema ? schema.bindingKeys : []), ...Object.keys(entities || {})]);
  for (const key of keys) {
    const id = trim(entities && entities[key]);
    if (id) map[key] = id;
  }
  return map;
}

/**
 * Проверить привязки против hass.states.
 * Возвращает { rows, errors, warnings } — используется в редакторе и в
 * диагностической панели карточки.
 */
export function validateBindings(entities, schema, hassStates) {
  const rows = [];
  const errors = [];
  const warnings = [];
  const hasStates = !!hassStates;

  for (const b of schema.bindings) {
    const id = trim(entities[b.key]);
    const state = hasStates && id ? hassStates[id] : undefined;
    const row = { key: b.key, name: b.name, entity: id || "", state, level: "ok", message: "" };

    if (!id) {
      if (b.required) {
        row.level = "error";
        row.message = "Обязательная привязка не заполнена";
        if (hasStates) errors.push(`«${b.name}»: не выбрана сущность`);
      } else {
        row.level = "empty";
        row.message = "Не используется";
      }
      rows.push(row);
      continue;
    }

    if (!hasStates) {
      row.level = "unknown";
      row.message = "Нет данных от Home Assistant";
      rows.push(row);
      continue;
    }

    if (!state) {
      row.level = "error";
      row.message = "Сущность не найдена";
      errors.push(`«${b.name}»: сущность ${id} не найдена`);
      rows.push(row);
      continue;
    }

    const raw = String(state.state).toLowerCase();
    if (["unavailable", "unknown"].includes(raw)) {
      row.level = "warn";
      row.message = "Сущность недоступна";
      warnings.push(`«${b.name}»: ${id} — ${raw}`);
      rows.push(row);
      continue;
    }

    const domain = id.split(".")[0];
    if (b.domain.length && !b.domain.includes(domain)) {
      row.level = "warn";
      row.message = `Ожидался домен ${b.domain.join("/")}, получен ${domain}`;
      warnings.push(`«${b.name}»: ${id} — неожиданный домен ${domain}`);
    }

    if (b.value.kind === "number" && !Number.isFinite(readValue(b, state))) {
      row.level = "warn";
      row.message = "Значение не является числом";
      warnings.push(`«${b.name}»: ${id} — значение «${state.state}» не число`);
    }

    rows.push(row);
  }

  return { rows, errors, warnings };
}

// ---- вспомогательное --------------------------------------------------------

export function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v.slice() : [v];
}

export function trim(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

/** Заголовки групп в порядке первого появления. */
export function groupBindings(bindings) {
  const groups = [];
  const index = new Map();
  for (const b of bindings) {
    const name = b.group || "";
    if (!index.has(name)) {
      index.set(name, { name, items: [] });
      groups.push(index.get(name));
    }
    index.get(name).items.push(b);
  }
  return groups;
}
