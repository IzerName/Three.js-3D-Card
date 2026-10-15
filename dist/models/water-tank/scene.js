// ============================================================================
//  Сцена модели «Бак чистой воды».
//
//  Реализация — проверенный движок WaterTankEngine (файл legacy-engine.js,
//  перенесённый из проекта water-tank-3d без изменений в геометрии и анимации).
//  Этот файл приводит движок к контракту модели threejs-3d-card.
//
//  Ключевые решения:
//    * WebGLRenderer — ОДИН на карточку: движку передаётся уже созданный
//      рендерер движка сцены (иначе на каждую карточку приходилось бы по два
//      WebGL-контекста, а их в браузере ограниченное число);
//    * состояния приходят из общей шины SceneEngine, движок получает их через
//      applyStates();
//    * собственный DOM движка (HUD, подсказки, модальное окно сущности)
//      живёт в отдельном слое внутри карточки.
//
//  Благодаря этому визуал не отличается от исходной карточки water-tank-3d,
//  а редактор карточки получает полноценные bindings/params из manifest.js.
// ============================================================================

import { WaterTankEngine } from "./legacy-engine.js";
import { getPath } from "../../src/core/util.js";

/** Значения по умолчанию (совпадают с manifest.params). */
const PARAM_DEFAULTS = {
  full_value: 100,
  max_liters: 200,
  level_color: "var(--color-2)",
  tank_radius: 0.55,
  tank_length: 1.7,
  wall: 0.05,
  "probe_levels.high": 85,
  "probe_levels.medium": 50,
  "probe_levels.low": 25,
};

/**
 * Прочитать параметр модели.
 *
 * Параметры в конфигурации карточки хранятся ПЛОСКО (ключ как объявлен в
 * manifest.js), например: params: { "probe_levels.high": 90 }. Для удобства
 * поддерживаем и вложенную запись (probe_levels: { high: 90 }) — она
 * встречается в конфигурациях, написанных руками.
 */
function param(params, key) {
  if (!params) return undefined;
  if (Object.prototype.hasOwnProperty.call(params, key)) return params[key];
  return getPath(params, key, undefined);
}

/**
 * Собрать конфигурацию legacy-движка из конфигурации карточки.
 * Карточка передаёт параметры плоско (config.params), движок ждёт camelCase
 * и вложенный probeLevels.
 */
export function legacyConfigFrom(cardConfig) {
  const cfg = cardConfig || {};
  const params = cfg.params || {};

  return Object.assign({}, cfg, {
    title: cfg.title || "Бак чистой воды",
    entities: Object.assign({}, cfg.entities),
    fullValue: pick(params, "full_value"),
    maxLiters: pick(params, "max_liters"),
    levelColor: pick(params, "level_color"),
    tankRadius: pick(params, "tank_radius"),
    tankLength: pick(params, "tank_length"),
    wall: pick(params, "wall"),
    probeLevels: {
      high: pick(params, "probe_levels.high"),
      medium: pick(params, "probe_levels.medium"),
      low: pick(params, "probe_levels.low"),
    },
  });
}

function pick(params, key) {
  const v = param(params, key);
  return v === undefined || v === null || v === "" ? PARAM_DEFAULTS[key] : v;
}

/**
 * Точка входа модели. Вызывается SceneEngine с контекстом ctx.
 * Возвращает handle, через который движок управляет сценой.
 */
export async function create(ctx) {
  const container = ctx.container;

  // Слой, внутри которого живёт DOM движка (canvas берём у движка сцены).
  // (T-016) Слой лежит поверх канваса карточки и обязан быть прозрачным для
  // ввода: жесты (камера, тап по объекту) должны доходить до canvas, к
  // которому карточка подключает createCameraControls. Единственный
  // интерактивный элемент слоя — модалка сущности, у неё свой
  // pointer-events:auto (в движке), поэтому выключение у host ничего не ломает.
  const host = document.createElement("div");
  host.className = "t3d-legacy-host";
  host.style.cssText = "position:absolute;inset:0;pointer-events:none;";
  container.appendChild(host);

  // Подменяем создание canvas: движок использует уже готовый рендерер.
  const fakeContainer = {
    appendChild(node) {
      if (node && node.tagName === "CANVAS") return ctx.canvas;
      host.appendChild(node);
      return node;
    },
    removeChild(node) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    },
    get clientWidth() { return container.clientWidth || 640; },
    get clientHeight() { return container.clientHeight || 400; },
    querySelector() { return null; },
  };

  const engine = new WaterTankEngine(fakeContainer, legacyConfigFrom(ctx.config), {
    THREE: ctx.THREE,
    canvas: ctx.canvas,   // один WebGL-контекст на карточку
  });
  engine.onService = (domain, service, data) => ctx.onService(domain, service, data);
  engine.onDeepLink = (entityId) => ctx.openEntity(entityId);

  // Рендерер общий с карточкой: legacy-движок не должен уничтожать контекст.
  const legacyDispose = engine.dispose.bind(engine);
  engine.dispose = () => {
    const saved = engine.renderer;
    engine.renderer = null;
    try {
      legacyDispose();
    } finally {
      engine.renderer = saved;
    }
  };
  await engine.init();

  // Один WebGL-контекст на карточку: отдаём рендерер движку сцены.
  const renderer = engine.renderer;
  if (renderer) {
    // Помечаем, что рендерер общий: legacy-движок не должен его уничтожать.
    renderer.userData = Object.assign({}, renderer.userData, { t3dShared: true });
    if (ctx.setRenderer) ctx.setRenderer(renderer);
    renderer.setSize(container.clientWidth || 640, container.clientHeight || 400, false);
  }

  engine.start();

  let disposed = false;

  return {
    // Своей сцены у модели нет: движок рисует тем же рендерером.
    root: null,
    // Признак: рендерер и цикл кадров принадлежат модели (движок сцены их не трогает).
    external: true,

    // (T-003) Камера и жесты — общий модуль карточки: движок больше не слушает
    // канвас, жесты приходят через applyGesture (apply ниже), а одиночный тап
    // — через pick.
    camera: engine.camera,
    apply: (g) => engine.applyGesture(g),
    resetView: () => engine.resetView(),
    pick: (e) => engine._pick(e),

    /**
     * Состояния приходят по одной привязке: движок карточки вызывает
     * applyState(key, info) для каждого изменённого ключа.
     */
    applyState(key, info) {
      if (!info || !info.entity) return;
      engine.applyStates({ [info.entity]: info.state });
    },

    /** Пакетное обновление (используется демо-страницей и тестами). */
    applyStates(view) {
      const states = {};
      for (const info of Object.values(view)) {
        if (info && info.entity) states[info.entity] = info.state;
      }
      engine.applyStates(states);
    },

    /** Изменения из редактора карточки — без пересоздания сцены. */
    applyConfig(cardConfig) {
      const next = legacyConfigFrom(cardConfig);
      engine.config.title = next.title;
      engine.config.fullValue = next.fullValue;
      engine.config.maxLiters = next.maxLiters;
      engine.config.levelColor = next.levelColor;
      engine.config.probeLevels = next.probeLevels;
      engine.setEntities(cardConfig.entities || {});
      if (engine._updateHud) engine._updateHud();
      if (engine._redrawPct) engine._redrawPct();
    },

    /** Подпись под заголовком в HUD. */
    setHudSub(text) {
      engine.setHudSub(text);
    },

    /** Кнопки под сценой (в этой модели не используются). */
    actions() {
      return [];
    },

    resize() {
      engine.resize();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        engine.dispose();
      } catch (e) {
        console.warn("[water-tank] ошибка при освобождении сцены", e);
      }
      if (host.parentNode) host.parentNode.removeChild(host);
    },

    /** Прямой доступ к движку — для демо-страницы и тестов. */
    engine,
  };
}

export default { create, legacyConfigFrom };
