// ============================================================================
//  Юнит-тесты логики привязок, состояний и конфигурации.
//  Запуск: npm test   (node --test)
//
//  Тесты не требуют браузера: проверяются чистые функции ядра.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeBinding, normalizeBindings, normalizeParam, normalizeParams,
  readValue, entityMap, validateBindings, groupBindings, coerceParam,
} from "../src/core/bindings.js";
import {
  StateBus, prettyState, stateWithUnit, isActive, isAvailable, brightness01, looksNumeric,
} from "../src/core/state.js";
import { buildStubConfig, pickEntity } from "../src/core/stub.js";
import { clamp, resolveColor, esc, fmtNumber, getPath, setPath, deepMerge } from "../src/core/util.js";

// ---- привязки ---------------------------------------------------------------

test("normalizeBinding: заполняет значения по умолчанию", () => {
  const b = normalizeBinding({ key: "level", name: "Уровень" });
  assert.equal(b.key, "level");
  assert.equal(b.value.kind, "raw");
  assert.deepEqual(b.domain, []);
  assert.equal(b.required, undefined);
});

test("normalizeBinding: требует key", () => {
  assert.throws(() => normalizeBinding({ name: "Без ключа" }), /не задан key/);
});

test("normalizeBindings: сортирует по order и ловит дубли", () => {
  const list = normalizeBindings([
    { key: "b", order: 2 },
    { key: "a", order: 1 },
  ]);
  assert.deepEqual(list.map((b) => b.key), ["a", "b"]);
  assert.throws(() => normalizeBindings([{ key: "x" }, { key: "x" }]), /объявлен дважды/);
});

test("normalizeParams: тип по умолчанию text", () => {
  assert.equal(normalizeParam({ key: "k" }).type, "text");
  assert.deepEqual(normalizeParams([{ key: "z", order: 5 }, { key: "a", order: 1 }]).map((p) => p.key), ["a", "z"]);
});

test("readValue: number/boolean/brightness/scale", () => {
  const st = { state: "55", attributes: { unit_of_measurement: "%", brightness: 128 } };
  assert.equal(readValue({ value: { kind: "number" } }, st), 55);
  assert.equal(readValue({ value: { kind: "boolean" } }, { state: "on" }), true);
  assert.equal(readValue({ value: { kind: "boolean" } }, { state: "off" }), false);
  assert.equal(readValue({ value: { kind: "raw" } }, st), "55");
  assert.ok(Math.abs(readValue({ value: { kind: "brightness" } }, st) - 128 / 255) < 1e-9);
  const scaled = readValue({ value: { kind: "number", scale: { from: { min: 0, max: 1000 }, to: { min: 0, max: 1 } } } }, { state: "250" });
  assert.equal(scaled, 0.25);
  assert.equal(readValue({ value: { kind: "attribute", param: "brightness" } }, st), 128);
});

test("readValue: unavailable не превращается в число", () => {
  assert.ok(Number.isNaN(readValue({ value: { kind: "number" } }, { state: "unavailable" })));
  assert.ok(Number.isNaN(readValue({ value: { kind: "number" } }, { state: "unknown" })));
});

test("entityMap: только заполненные ключи", () => {
  const schema = { bindingKeys: new Set(["a", "b"]) };
  assert.deepEqual(entityMap({ a: "sensor.x", b: "  " }, schema), { a: "sensor.x" });
  assert.deepEqual(entityMap({ a: "sensor.x", legacy: "switch.y" }, schema), { a: "sensor.x", legacy: "switch.y" });
});

test("groupBindings: сохраняет порядок групп", () => {
  const groups = groupBindings([
    { group: "A", key: "1" }, { group: "", key: "2" }, { group: "A", key: "3" },
  ]);
  assert.deepEqual(groups.map((g) => g.name), ["A", ""]);
  assert.equal(groups[0].items.length, 2);
});

// ---- проверка привязок ------------------------------------------------------

const SCHEMA = {
  bindings: normalizeBindings([
    { key: "level", name: "Уровень", required: true, domain: ["sensor"], value: { kind: "number" } },
    { key: "pump", name: "Насос", domain: ["switch"], value: { kind: "boolean" } },
  ]),
};
SCHEMA.bindingKeys = new Set(SCHEMA.bindings.map((b) => b.key));

test("validateBindings: пустая обязательная привязка — ошибка", () => {
  const { rows, errors } = validateBindings({}, SCHEMA, {});
  assert.equal(errors.length, 1);
  assert.equal(rows.find((r) => r.key === "level").level, "error");
});

test("validateBindings: несуществующая сущность — ошибка", () => {
  const { errors } = validateBindings({ level: "sensor.nope" }, SCHEMA, {});
  assert.match(errors[0], /не найдена/);
});

test("validateBindings: не тот домен и нечисловое значение — предупреждения", () => {
  const { rows, warnings } = validateBindings(
    { level: "switch.wrong" },
    SCHEMA,
    { "switch.wrong": { state: "нечто", attributes: {} } }
  );
  assert.equal(warnings.length, 2);
  assert.equal(rows.find((r) => r.key === "level").level, "warn");
});

test("validateBindings: исправная привязка — ok", () => {
  const { rows, errors, warnings } = validateBindings(
    { level: "sensor.water" },
    SCHEMA,
    { "sensor.water": { state: "42", attributes: {} } }
  );
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
  assert.equal(rows.find((r) => r.key === "level").level, "ok");
});

// ---- состояния --------------------------------------------------------------

test("state: prettyState/stateWithUnit/isActive/isAvailable", () => {
  assert.equal(prettyState({ state: "on" }), "Включено");
  assert.equal(prettyState({ state: "42.5" }), "42.5");
  assert.equal(prettyState(null), "—");
  assert.equal(stateWithUnit({ state: "42.5", attributes: { unit_of_measurement: "%" } }), "42.5 %");
  assert.equal(isActive({ state: "on" }), true);
  assert.equal(isActive({ state: "off" }), false);
  assert.equal(isActive({ state: "0" }), false);
  assert.equal(isActive({ state: "3" }), true);
  assert.equal(isAvailable({ state: "unavailable" }), false);
  assert.equal(isAvailable({ state: "12" }), true);
  assert.equal(brightness01({ state: "on", attributes: { brightness_pct: 40 } }), 0.4);
  assert.equal(looksNumeric({ state: "12.5", attributes: {} }), true);
  assert.equal(looksNumeric({ state: "12.5", attributes: { unit_of_measurement: "км" } }), false);
  assert.equal(looksNumeric({ state: "unavailable" }), false);
});

test("StateBus: сообщает только об изменениях", () => {
  const bus = new StateBus();
  const map = { level: "sensor.level" };
  const st1 = { state: "10", attributes: {}, last_updated: "1" };
  assert.equal(bus.apply({ "sensor.level": st1 }, map), true);
  assert.equal(bus.apply({ "sensor.level": st1 }, map), false);
  const st2 = { state: "20", attributes: {}, last_updated: "2" };
  assert.equal(bus.apply({ "sensor.level": st2 }, map), true);
  assert.deepEqual([...bus.changedKeys], ["level"]);
});

test("StateBus: исчезнувшая сущность очищается", () => {
  const bus = new StateBus();
  const map = { level: "sensor.level" };
  bus.apply({ "sensor.level": { state: "1", attributes: {} } }, map);
  assert.equal(bus.apply({}, map), true);
  assert.equal(bus.get("sensor.level"), undefined);
});

test("StateBus: rebind помечает ключ изменившимся", () => {
  const bus = new StateBus();
  bus.apply({ "sensor.a": { state: "1", attributes: {} } }, { level: "sensor.a" });
  bus.rebind({ level: "sensor.b" });
  assert.ok(bus.changedKeys.has("level"));
});

// ---- getStubConfig ----------------------------------------------------------

test("pickEntity: выбирает сущность по device_class", () => {
  const states = {
    "sensor.other": { state: "1", attributes: {} },
    "sensor.humidity_x": { state: "2", attributes: { device_class: "humidity" } },
  };
  const binding = normalizeBinding({ key: "h", name: "Влажность", domain: ["sensor"], deviceClass: ["humidity"] });
  assert.equal(pickEntity(binding, states, []), "sensor.humidity_x");
});

test("pickEntity: предпочитает сущности дашборда", () => {
  const binding = normalizeBinding({ key: "l", name: "Уровень", domain: ["sensor"] });
  assert.equal(pickEntity(binding, {}, ["sensor.on_dashboard"]), "sensor.on_dashboard");
});

test("buildStubConfig: собирает валидную конфигурацию", () => {
  const model = {
    manifest: { id: "water-tank", size: { defaultHeight: 400 } },
    bindings: [
      { key: "level", name: "Уровень", required: true, domain: ["sensor"] },
      { key: "pump", name: "Насос", domain: ["switch"] },
    ],
    defaults: { config: { title: "Бак", params: { full_value: 100 } } },
  };
  const stub = buildStubConfig(model, {}, ["sensor.water_level"]);
  assert.equal(stub.type, "custom:threejs-3d-card");
  assert.equal(stub.model, "water-tank");
  assert.equal(stub.title, "Бак");
  assert.equal(stub.height, 400);
  assert.equal(stub.entities.level, "sensor.water_level");
  assert.equal(stub.params.full_value, 100);
});

// ---- утилиты ----------------------------------------------------------------

test("util: clamp/resolveColor/esc/fmtNumber", () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(resolveColor("#ff0000", "#000"), "#ff0000");
  assert.equal(esc('<b>&"'), "&lt;b&gt;&amp;&quot;");
  assert.equal(fmtNumber(12.34, 1), "12.3");
});

test("util: getPath/setPath/deepMerge", () => {
  assert.equal(getPath({ a: { b: { c: 7 } } }, "a.b.c"), 7);
  assert.equal(getPath({}, "a.b.c", "нет"), "нет");
  const o = {};
  setPath(o, "probe_levels.high", 85);
  assert.deepEqual(o, { probe_levels: { high: 85 } });
  assert.deepEqual(deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 5 } }), { a: { x: 1, y: 5 } });
});

test("coerceParam: приводит типы и ограничивает диапазон", () => {
  assert.equal(coerceParam("42", { type: "number" }), 42);
  assert.equal(coerceParam("42,5", { type: "number" }), 42.5);
  assert.equal(coerceParam(150, { type: "range", min: 0, max: 100 }), 100);
  assert.equal(coerceParam("true", { type: "boolean" }), true);
  assert.equal(coerceParam("abc", { type: "number", default: 7 }), 7);
});
