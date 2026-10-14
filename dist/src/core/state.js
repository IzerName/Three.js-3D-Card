// ============================================================================
//  Состояния Home Assistant: доступ, нормализация значений и «шина» обновлений.
//
//  Задача модуля — превратить сырой hass.states в понятные модели значения
//  и не дать движку перерисовываться на каждое обновление HA (hass-сеттер
//  вызывается очень часто).
// ============================================================================

import { STATE_LABELS } from "./constants.js";

/** Единицы, которые считаем числовыми без дополнительных условий. */
const NUMERIC_UNITS = new Set([
  "%", "°C", "°F", "K", "lx", "m³", "m3", "L", "l", "mL", "ml", "W", "kW", "Wh", "kWh",
  "V", "A", "mA", "Hz", "Pa", "bar", "psi", "m/s", "km/h", "mm", "cm", "m", "s", "min", "h",
  "dB", "dBm", "ppm", "µg/m³", "mg/m³", "l/min", "m³/h", "Aq", "pH", "rpm",
]);

/** Тексты, которые HA отдаёт вместо значения. */
const NON_VALUES = new Set(["unknown", "unavailable", "none", "null", "", "—"]);

/** Похоже ли состояние на число (без учёта единиц измерения). */
export function looksNumeric(state) {
  if (!state) return false;
  const raw = String(state.state).trim();
  if (NON_VALUES.has(raw.toLowerCase())) return false;
  if (!/^[+-]?(\d+([.,]\d+)?([eE][+-]?\d+)?)$/.test(raw)) return false;
  const unit = state.attributes && state.attributes.unit_of_measurement;
  if (!unit) return true; // "12.5" без единиц — тоже число
  return NUMERIC_UNITS.has(String(unit));
}

/** Числовое значение состояния или NaN. Поддерживает запятую как разделитель. */
export function numericValue(state) {
  if (!state) return NaN;
  const raw = String(state.state).trim().replace(",", ".");
  if (NON_VALUES.has(raw.toLowerCase())) return NaN;
  return parseFloat(raw);
}

/** Значение состояния в виде строки ("—", если данных нет). */
export function stateText(state) {
  if (!state) return "—";
  const raw = String(state.state);
  if (NON_VALUES.has(raw.toLowerCase())) return STATE_LABELS[raw.toLowerCase()] || raw;
  return raw;
}

/** Человекочитаемое состояние (RU, если знаем перевод). */
export function prettyState(state) {
  if (!state) return "—";
  const raw = String(state.state).toLowerCase();
  return STATE_LABELS[raw] || String(state.state);
}

/** Состояние с единицей измерения: "42.5 %". */
export function stateWithUnit(state) {
  if (!state) return "—";
  const txt = stateText(state);
  const unit = state.attributes && state.attributes.unit_of_measurement;
  return unit ? `${txt} ${unit}` : txt;
}

/** Сущность «включена»/активна (on, open, home, detected, heating…). */
export function isActive(state) {
  if (!state) return false;
  const raw = String(state.state).toLowerCase();
  if (NON_VALUES.has(raw)) return false;
  if (["on", "open", "opening", "home", "detected", "playing", "cleaning", "heat", "cool",
       "heat_cool", "dry", "fan", "auto", "locked", "problem", "unlocked"].includes(raw)) {
    // locked/unlocked/auto — нейтральные, для подсветки считаем активными только явные
    return !["unlocked", "auto"].includes(raw);
  }
  const n = numericValue(state);
  if (Number.isFinite(n)) return n > 0;
  return false;
}

/** Сущность требует внимания (проблема/тревога/недоступность). */
export function isProblem(state) {
  if (!state) return true;
  const raw = String(state.state).toLowerCase();
  if (NON_VALUES.has(raw)) return true;
  return ["problem", "detected", "open", "unlocked", "smoke", "moisture", "fire"].includes(raw);
}

/** Есть ли у сущности данные (не unavailable/unknown). */
export function isAvailable(state) {
  if (!state) return false;
  return !NON_VALUES.has(String(state.state).trim().toLowerCase());
}

/** Яркость 0..1 для light (с учётом brightness_pct / brightness). */
export function brightness01(state) {
  if (!state) return 0;
  const a = state.attributes || {};
  if (Number.isFinite(a.brightness_pct)) return Math.max(0, Math.min(1, a.brightness_pct / 100));
  if (Number.isFinite(a.brightness)) return Math.max(0, Math.min(1, a.brightness / 255));
  return String(state.state).toLowerCase() === "on" ? 1 : 0;
}

/**
 * Шина состояний: держит последние состояния привязанных сущностей,
 * сравнивает их и сообщает, что изменилось.
 */
export class StateBus {
  constructor() {
    /** @type {Record<string, object>} entity_id -> состояние */
    this.states = {};
    /** @type {Set<string>} entity_id, которые нас интересуют */
    this.watched = new Set();
    /** Номер версии: увеличивается при каждом значимом обновлении. */
    this.version = 0;
    /** Изменившиеся с прошлого раза ключи привязок (key -> true). */
    this.changedKeys = new Set();
    /** Признак «пришло хотя бы одно обновление от HA». */
    this.received = false;
  }

  /** Задать список интересующих сущностей (по entity_id). */
  watch(entityIds) {
    this.watched = new Set(entityIds.filter(Boolean));
  }

  /** Полное состояние сущности или undefined. */
  get(entityId) {
    return entityId ? this.states[entityId] : undefined;
  }

  /**
   * Принять hass.states и вернуть true, если что-то реально изменилось.
   * Сравнение — по state + last_updated/attributes (дешёвая эвристика).
   */
  apply(hassStates, keyToEntity) {
    if (!hassStates) return false;
    let changed = false;
    this.changedKeys.clear();
    for (const [key, entityId] of Object.entries(keyToEntity || {})) {
      if (!entityId) continue;
      const next = hassStates[entityId];
      const prev = this.states[entityId];
      if (next === prev) continue;
      if (!next) {
        if (prev) {
          delete this.states[entityId];
          this.changedKeys.add(key);
          changed = true;
        }
        continue;
      }
      if (!prev || prev.state !== next.state || prev.last_updated !== next.last_updated) {
        this.states[entityId] = next;
        this.changedKeys.add(key);
        changed = true;
      }
    }
    if (changed) {
      this.received = true;
      this.version += 1;
    }
    return changed;
  }

  /**
   * Сменить привязку ключей (в редакторе поменяли сущность).
   * Все затронутые ключи помечаются изменившимися: модель обязана перечитать их,
   * даже если новая сущность имеет то же значение состояния.
   */
  rebind(keyToEntity) {
    for (const [key, entityId] of Object.entries(keyToEntity || {})) {
      if (this._lastBind && this._lastBind[key] === entityId) continue;
      this.changedKeys.add(key);
      if (entityId && this.states[entityId] === undefined) this.states[entityId] = undefined;
    }
    this._lastBind = Object.assign({}, keyToEntity);
    this.version += 1;
  }

  /** Единичное обновление (используется в демо-режиме и при точечных правках). */
  setEntity(entityId, state) {
    if (!entityId) return false;
    if (!state) {
      if (!(entityId in this.states)) return false;
      delete this.states[entityId];
      this.version += 1;
      return true;
    }
    this.states[entityId] = state;
    this.received = true;
    this.version += 1;
    return true;
  }

  clear() {
    this.states = {};
    this.changedKeys.clear();
    this.version += 1;
  }
}
