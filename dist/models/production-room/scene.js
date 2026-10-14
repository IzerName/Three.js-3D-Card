// ============================================================================
//  Сцена модели «Производственное помещение».
//
//  Реализация — движок ProductionRoomEngine (legacy-engine.js, перенесён из
//  проекта production-room-viewer без изменений в геометрии и анимациях).
//  Файл приводит его к контракту модели threejs-3d-card.
//
//  WebGL-контекст — один на карточку: движку передаётся canvas движка сцены,
//  а готовый рендерер возвращается обратно (см. ctx.setRenderer).
// ============================================================================

import { ProductionRoomEngine } from "./legacy-engine.js";
import { getPath } from "../../src/core/util.js";

const PARAM_DEFAULTS = { width: 12, depth: 8, height: 3.2 };

/**
 * Конфигурация legacy-движка из конфигурации карточки.
 * Поддерживает оба вида: новый (params) и старый (плоские width/depth/height).
 */
export function legacyConfigFrom(cardConfig) {
  const cfg = cardConfig || {};
  const params = cfg.params || {};
  const num = (key) => {
    const v = getPath(params, key, undefined);
    if (Number.isFinite(v)) return v;
    if (Number.isFinite(cfg[key])) return cfg[key];
    return PARAM_DEFAULTS[key];
  };  return Object.assign({}, cfg, {
    title: cfg.title || "Производственное помещение",
    width: num("width"),
    depth: num("depth"),
    height: num("height"),
    entities: Object.assign({}, cfg.entities),
  });
}

export async function create(ctx) {
  const container = ctx.container;

  const host = document.createElement("div");
  host.className = "t3d-legacy-host";
  host.style.cssText = "position:absolute;inset:0;";
  container.appendChild(host);

  // Движок создаёт собственный canvas и рендерер — подменяем контейнер так,
  // чтобы он работал с уже существующим canvas карточки.
  const fakeContainer = {
    appendChild(node) {
      if (node && node.tagName === "CANVAS") return ctx.canvas;
      host.appendChild(node);
      return node;
    },
    removeChild(node) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    get clientWidth() { return container.clientWidth || 800; },
    get clientHeight() { return container.clientHeight || 500; },
    querySelector() { return null; },
  };

  const engine = new ProductionRoomEngine(fakeContainer, legacyConfigFrom(ctx.config), {
    THREE: ctx.THREE,
    canvas: ctx.canvas,   // один WebGL-контекст на карточку
  });
  // Контекст общий с карточкой — движок не должен его освобождать.
  engine.disposeRenderer = false;
  engine.onService = (domain, service, data) => ctx.onService(domain, service, data);
  engine.onDeepLink = (entityId) => ctx.openEntity(entityId);

  // Рендерер общий с карточкой: не даём движку уничтожить контекст.
  // Без этого после смены модели (бак -> цех) канвас остаётся пустым:
  // renderer.dispose() освобождает WebGL-контекст, который переиспользует
  // следующая сцена.
  const legacyDispose = engine.dispose.bind(engine);
  engine.dispose = () => {
    const saved = engine.renderer;
    engine.renderer = null;
    try {
      legacyDispose();
    } finally {
      engine.renderer = saved;
      engine.disposeRenderer = false;
    }
  };

  await engine.init();

  const renderer = engine.renderer;
  if (renderer) {
    renderer.userData = Object.assign({}, renderer.userData, { t3dShared: true });
    if (ctx.setRenderer) ctx.setRenderer(renderer);
    renderer.setSize(container.clientWidth || 800, container.clientHeight || 500, false);
  }
  engine.start();

  let disposed = false;

  return {
    root: null,
    external: true,

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

    applyConfig(cardConfig) {
      engine.config.entities = Object.assign({}, cardConfig.entities || {});
      engine.keyToEntity = {};
      engine._syncFromStates && engine._syncFromStates();
    },

    setHudSub(text) {
      engine.setHudSub(text);
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
        console.warn("[production-room] ошибка при освобождении сцены", e);
      }
      if (host.parentNode) host.parentNode.removeChild(host);
    },

    engine,
  };
}

export default { create, legacyConfigFrom };
