// ============================================================================
//  getStubConfig: конфигурация карточки «по умолчанию».
//
//  Lovelace передаёт сюда hass и список сущностей дашборда. Мы стараемся
//  подобрать осмысленные сущности под привязки модели, чтобы только что
//  добавленная карточка сразу показывала данные (как в исходных проектах
//  с баком и цехом), а не пустую сцену.
// ============================================================================

import { normalizeBindings } from "./bindings.js";

/**
 * @param {object} model  описание модели (manifest/bindings/defaults)
 * @param {object} [hass] объект hass от Lovelace
 * @param {string[]|object} [entities] сущности, уже используемые на дашборде
 */
export function buildStubConfig(model, hass, entities) {
  const def = model || { manifest: { id: "water-tank" }, bindings: [], defaults: {} };
  const bindings = normalizeBindings(def.bindings || []);
  const defaults = (def.defaults && def.defaults.config) || {};
  const manifest = def.manifest || {};

  const out = { type: "custom:threejs-3d-card", model: manifest.id };
  if (defaults.title) out.title = defaults.title;
  const h = defaults.height || (manifest.size && manifest.size.defaultHeight);
  if (h) out.height = h;

  const states = hass && hass.states;
  const candidates = entities && typeof entities === "object" && !Array.isArray(entities)
    ? Object.values(entities)
    : (Array.isArray(entities) ? entities : []);

  const picked = {};
  for (const b of bindings) {
    const id = pickEntity(b, states, candidates);
    if (id) picked[b.key] = id;
  }
  if (Object.keys(picked).length) out.entities = picked;
  if (defaults.params && Object.keys(defaults.params).length) out.params = Object.assign({}, defaults.params);
  return out;
}

/** Подобрать сущность под описание привязки. */
export function pickEntity(binding, states, candidates = []) {
  const domains = binding.domain && binding.domain.length ? binding.domain : null;

  // 1. Сущности, уже используемые на этом дашборде
  if (candidates && candidates.length) {
    const hit = candidates.find((id) => {
      const d = String(id).split(".")[0];
      return !domains || domains.includes(d);
    });
    if (hit) return hit;
  }
  if (!states) return null;

  // 2. По совпадению device_class / единицы измерения / подсказки
  let best = null;
  let bestScore = 0;
  for (const id of Object.keys(states)) {
    const d = id.split(".")[0];
    if (domains && !domains.includes(d)) continue;
    const st = states[id];
    if (!st) continue;
    const a = st.attributes || {};
    let s = 0;
    if (binding.deviceClass && binding.deviceClass.length && partialMatch(a.device_class, binding.deviceClass)) s += 6;
    if (binding.unit && binding.unit.length && partialMatch(a.unit_of_measurement, binding.unit)) s += 3;
    if (binding.name && a.friendly_name && partialMatch(a.friendly_name, hintWords(binding))) s += 1;
    if (s > bestScore) { bestScore = s; best = id; }
  }
  return bestScore > 0 ? best : null;
}

function hintWords(binding) {
  const words = [];
  if (binding.hint) words.push(...String(binding.hint).split(/\s+/));
  if (binding.name) words.push(...String(binding.name).split(/\s+/));
  if (binding.key) words.push(binding.key);
  return words.filter((w) => w.length > 3).map((w) => w.toLowerCase());
}

function partialMatch(value, needles) {
  if (value === undefined || value === null) return false;
  const s = String(value).toLowerCase();
  return needles.some((n) => s.includes(String(n).toLowerCase()));
}
