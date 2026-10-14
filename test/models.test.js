// ============================================================================
//  Тест адаптеров моделей: конфигурация карточки -> конфигурация движка.
//
//  Проверяет, что параметры (params) карточки корректно превращаются в
//  конфигурацию legacy-движков, включая вложенные параметры вида
//  probe_levels.high и обратную совместимость со старым плоским форматом.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";

import { legacyConfigFrom as tankConfig } from "../models/water-tank/scene.js";
import { legacyConfigFrom as roomConfig } from "../models/production-room/scene.js";

const TANK_DEFAULTS = {
  fullValue: 100,
  maxLiters: 200,
  levelColor: "var(--color-2)",
  tankRadius: 0.55,
  tankLength: 1.7,
  wall: 0.05,
  probeLevels: { high: 85, medium: 50, low: 25 },
};

test("бак: значения по умолчанию при пустых параметрах", () => {
  const cfg = tankConfig({ entities: { level: "sensor.x" }, params: {} });
  assert.equal(cfg.title, "Бак чистой воды");
  assert.equal(cfg.fullValue, 100);
  assert.equal(cfg.maxLiters, 200);
  assert.equal(cfg.levelColor, "var(--color-2)");
  assert.deepEqual(cfg.probeLevels, TANK_DEFAULTS.probeLevels);
  assert.equal(cfg.entities.level, "sensor.x");
});

test("бак: параметры карточки перекрывают значения по умолчанию", () => {
  const cfg = tankConfig({
    entities: { level: "sensor.x" },
    params: {
      full_value: 1000,
      max_liters: 500,
      level_color: "#00ff00",
      tank_radius: 0.8,
      "probe_levels.high": 90,
      "probe_levels.low": 10,
    },
  });
  assert.equal(cfg.fullValue, 1000);
  assert.equal(cfg.maxLiters, 500);
  assert.equal(cfg.levelColor, "#00ff00");
  assert.equal(cfg.tankRadius, 0.8);
  assert.equal(cfg.probeLevels.high, 90);
  assert.equal(cfg.probeLevels.low, 10);
  assert.equal(cfg.probeLevels.medium, 50, "не заданный параметр должен остаться по умолчанию");
});

test("бак: пустые значения не затирают настройки", () => {
  const cfg = tankConfig({ params: { full_value: "", max_liters: null, level_color: undefined } });
  assert.equal(cfg.fullValue, 100);
  assert.equal(cfg.maxLiters, 200);
  assert.equal(cfg.levelColor, "var(--color-2)");
});

test("бак: заголовок по умолчанию и из конфигурации", () => {
  assert.equal(tankConfig({}).title, "Бак чистой воды");
  assert.equal(tankConfig({ title: "Мой бак" }).title, "Мой бак");
});

test("цех: параметры размеров и старый плоский формат", () => {
  const fromParams = roomConfig({ params: { width: 20, depth: 12, height: 4 } });
  assert.equal(fromParams.width, 20);
  assert.equal(fromParams.depth, 12);
  assert.equal(fromParams.height, 4);

  // старый формат карточки production-room-card: размеры лежат в корне конфига
  const legacy = roomConfig({ width: 15, depth: 9, height: 3.5 });
  assert.equal(legacy.width, 15);
  assert.equal(legacy.depth, 9);
  assert.equal(legacy.height, 3.5);
});

test("цех: значения по умолчанию", () => {
  const cfg = roomConfig({});
  assert.equal(cfg.width, 12);
  assert.equal(cfg.depth, 8);
  assert.equal(cfg.height, 3.2);
  assert.equal(cfg.title, "Производственное помещение");
});

test("цех: нечисловые значения игнорируются", () => {
  const cfg = roomConfig({ params: { width: "abc" }, width: 7 });
  assert.equal(cfg.width, 7, "должно использоваться плоское значение, если параметр не число");
});


