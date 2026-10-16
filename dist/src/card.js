// ============================================================================
//  custom:threejs-3d-card — 3D-сцена Home Assistant на three.js.
//
//  Одна карточка, много моделей. Модель выбирается в визуальном редакторе
//  (встроенная или импортированная по URL). Модель сама объявляет свои
//  привязки (bindings) и параметры (params) — из них строится форма
//  настроек с выбором устройств через ha-entity-picker.
//
//  Регистрируемые элементы:
//    <threejs-3d-card>          — карточка Lovelace
//    <threejs-3d-card-editor>   — визуальный редактор (ha-form-подобный)
//
//  Конфигурация (YAML):
//    type: custom:threejs-3d-card
//    model: water-tank            # id встроенной модели
//    # либо
//    model_url: /local/3d-models/my-model.js
//    title: Бак чистой воды
//    height: 360
//    show_hud: true
//    entities:
//      level: sensor.water_level
//    params:
//      full_value: 100
// ============================================================================

import { loadThree, threeSync } from "./core/three-loader.js";
import { SceneEngine } from "./core/scene.js";
import { registry, defineModel, builtinIds, absoluteUrl } from "./core/registry.js";
import { createObjectModel } from "./core/object-model.js";
import {
  CARD_TAG, EDITOR_TAG, CARD_VERSION, API_VERSION, THREE_CDN_URL, globalApi,
} from "./core/constants.js";
import { ensureStyles } from "./core/styles.js";
import { buildStubConfig } from "./core/stub.js";
import { esc } from "./core/util.js";

// Встроенные модели перечислены в core/registry.js и подгружаются лениво
// (отдельные ES-модули), поэтому импорт сцены не попадает в стартовый путь.

// Редактор подключается сразу: Lovelace вызывает getConfigElement()
// синхронно, элемент должен быть уже определён.
import { ThreeDModelCardEditor } from "./editor.js";

/** Публичный API для внешних моделей и отладки из консоли браузера. */
const api = globalApi();
api.version = CARD_VERSION;
api.apiVersion = API_VERSION;
api.threeCdnUrl = THREE_CDN_URL;
api.registry = registry;
api.defineModel = defineModel;
// Декларативный слой объектных моделей (OBJ/MTL, glTF/GLB + правила).
// Публикуется в глобальном API, чтобы файл модели не зависел от каталога
// установки карточки: import "/hacsfiles/<имя-репозитория>/…" сломался бы
// при установке вручную в /local/<любая-папка>/.
api.createObjectModel = createObjectModel;
api.absoluteUrl = absoluteUrl;
api.builtinIds = builtinIds;
api.SceneEngine = SceneEngine;
api.CardClass = null; // заполняется ниже

api.models = () => registry.list().map((m) => m.manifest);
api.loadModel = (idOrUrl, opts) => registry.resolve(idOrUrl, opts);
api.loadThree = loadThree;
// Промис, который разрешается после загрузки three.js. Внешние модели обычно
// берут библиотеку из ctx.THREE, но это позволяет дождаться её заранее.
api.threeReady = null;
// Загружаем three.js сразу при подключении ресурса: к моменту, когда модель
// вызовет create(), библиотека уже на месте (модель может обратиться к
// window.ThreeJS3DCard.THREE и на верхнем уровне файла).
api.threeReady = loadThree().catch((e) => {
  console.warn("[threejs-3d-card] three.js не загрузился при старте:", e && e.message);
  return null;
});
// Защита от раннего обращения: пока библиотеки нет, api.THREE читается как
// undefined, а не бросает исключение.
Object.defineProperty(api, "THREE", {
  configurable: true,
  enumerable: true,
  get() { return threeSync(); },
  set(v) { Object.defineProperty(api, "THREE", { value: v, writable: true, configurable: true, enumerable: true }); },
});

/** Минимальная высота карточки в пикселях (как в styles.js: .t3d-root). */
const MIN_CARD_HEIGHT = 120;

/** Задержка перед показом «Загрузка модели…» (кэш отвечает быстрее). */
const STATUS_DELAY_MS = 180;

/**
 * Память вида камеры на время «горячей» пересборки сцены.
 *
 * Home Assistant в режиме предпросмотра (окно редактирования карточки)
 * пересоздаёт элемент карточки на каждое изменение конфигурации — новый
 * элемент, новая сцена, камера по умолчанию. Запоминаем последний вид и
 * возвращаем его, если сцена пересобралась только что (короткий TTL, чтобы
 * не влиять на разные карточки на дашборде).
 */
const VIEW_MEMORY = { key: "", view: null, at: 0 };
const VIEW_MEMORY_TTL = 2000;

class ThreeDModelCard extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._engine = null;
    this._model = null;
    this._hass = null;
    this._booting = false;
    this._bootAgain = false;
    this._pendingStates = null;
    this._root = null;
    this._shadow = null;
    this._reloaded = false;
  }

  // ---- конфигурация --------------------------------------------------------

  setConfig(config) {
    if (!config) throw new Error("threejs-3d-card: пустая конфигурация");
    const type = String(config.type || "");
    if (type && !type.startsWith("custom:")) {
      throw new Error("threejs-3d-card: ожидается type: custom:threejs-3d-card");
    }
    const modelId = config.model || config.model_id || legacyModelId(config) || "water-tank";
    const next = Object.assign({}, config, { model: modelId });
    const changedModel = !this._config || this._config.model !== next.model
      || this._config.model_url !== next.model_url;

    // Совместимость: старый вид конфигурации с одним ключом entities
    if (config.entities && typeof config.entities === "object") {
      next.entities = Object.assign({}, config.entities);
    }

    this._config = next;
    if (!this._root && this.isConnected) this._mount();
    this._applyHeight();
    if (this._engine) {
      if (changedModel) this._rebuild();
      else {
        // Высота карточки — только оформление: сцену она не пересобирает,
        // а размер рендерера подхватывает ResizeObserver движка.
        this._engine.applyConfig(this._config);
        this._syncDiagnostics();
      }
    } else {
      // Сцена ещё не построена (первый setConfig или конфигурация пришла
      // раньше подключения элемента) — запускаем построение.
      this._boot();
    }
    return this;
  }

  getConfig() {
    return this._config;
  }

  set hass(value) {
    this._hass = value;
    if (this._engine) {
      this._engine.applyHass(value);
      this._syncDiagnostics();
    } else if (value) {
      this._pendingStates = value.states;
      // Конфигурация могла прийти раньше подключения элемента: состояния
      // Home Assistant — подходящий момент, чтобы построить сцену.
      if (this._config) this._boot();
    }
  }

  get hass() {
    return this._hass;
  }

  // ---- жизненный цикл ------------------------------------------------------

  connectedCallback() {
    if (!this._root) this._mount();
    if (!this._config) return;
    this._boot();
  }

  disconnectedCallback() {
    // Полностью освобождаем WebGL-контекст: на дашборде карточка может
    // пересоздаваться при переключении вкладок, а число контекстов ограничено.
    //
    // Перед освобождением запоминаем вид камеры: в окне редактирования
    // Lovelace пересоздаёт элемент карточки на каждое изменение конфигурации,
    // и без этого камера возвращалась бы к виду по умолчанию после каждого
    // введённого символа.
    this._rememberView();
    if (this._engine) {
      this._engine.dispose();
      this._engine.disposeDom();
      this._engine = null;
    }
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;
  }

  _mount() {
    // Теневой корень создаём ровно один раз на элемент.
    //
    // Lovelace переиспользует узлы карточек (и переподключает их при переходе
    // между панелями), а повторный attachShadow бросает NotSupportedError
    // «Shadow root cannot be created on a host which already hosts a shadow
    // tree» — в HA это выглядит как красная плашка с ошибкой фронтенда.
    let shadow = this.shadowRoot || null;
    if (!shadow && typeof this.attachShadow === "function") {
      try {
        shadow = this.attachShadow({ mode: "open" });
      } catch (e) {
        // Теневой корень мог создать кто-то другой (например,
        // scoped-custom-element-registry) — работаем с тем, что есть.
        shadow = this.shadowRoot || null;
      }
    }
    this._shadow = shadow;
    const root = document.createElement("div");
    root.className = "t3d-root";
    root.style.cssText = "width:100%;position:relative;";
    (shadow || this).appendChild(root);
    this._root = root;
    ensureStyles(shadow || document.head);
    this._applyHeight();
  }

  /**
   * Высота карточки в пикселях или `null`, если высота не задана.
   *
   * `height` — необязательный параметр Lovelace: раньше он подставлялся из
   * модели и задавал фиксированную высоту (и попадал в конфигурацию модели как
   * «высота» — из-за этого правка поля «Высота, px» выглядела как изменение
   * самой модели). Теперь без `height` карточка занимает всю доступную
   * область: в разделе (Sections) — клетку сетки, в «кирпичной» раскладке —
   * рекомендованную моделью высоту.
   */
  _heightPx() {
    const c = this._config || {};
    const raw = typeof c.height === "number" ? c.height : parseFloat(c.height);
    if (Number.isFinite(raw)) return Math.max(MIN_CARD_HEIGHT, raw);
    return null;
  }

  /** Рекомендованная моделью высота в пикселях (для авто-режима). */
  _recommendedHeightPx() {
    const size = (this._model && this._model.manifest && this._model.manifest.size) || {};
    const h = Number(size.defaultHeight);
    return Number.isFinite(h) && h > MIN_CARD_HEIGHT ? h : 360;
  }

  /**
   * Применить высоту к корню карточки.
   *
   * Явная высота (`height` в конфигурации) — фиксированные пиксели, как и
   * раньше. Без неё карточка занимает всю доступную область: `height: 100%`
   * растягивает её на клетку сетки раздела (или на весь панельный вид), а если
   * родитель высоты не задаёт («кирпичная» раскладка) — подставляем
   * рекомендованную моделью высоту (см. _fillAutoHeight).
   */
  _applyHeight() {
    const root = this._root;
    if (!root) return;
    const px = this._heightPx();
    if (px !== null) {
      this._autoFilled = false;
      root.style.height = `${px}px`;
      root.style.minHeight = `${MIN_CARD_HEIGHT}px`;
      return;
    }
    if (this._autoFilled) {
      // Уже выяснили, что родитель высоты не задаёт («кирпичная» раскладка):
      // держим рекомендованную высоту, уточняя её по мере загрузки модели.
      root.style.height = `${this._recommendedHeightPx()}px`;
      root.style.minHeight = `${MIN_CARD_HEIGHT}px`;
      return;
    }
    root.style.height = "100%";
    // Пока высота родителя неизвестна, держим нижнюю границу: иначе канвас
    // успел бы построиться нулевого размера.
    root.style.minHeight = `${MIN_CARD_HEIGHT}px`;
    this._fillAutoHeight();
  }

  /**
   * «Кирпичная» раскладка (и режим auto height в разделе) не задаёт карточке
   * высоту: тогда `height: 100%` схлопывается к нижней границе. После раскладки
   * это видно по фактической высоте — если родитель её не задал, ставим
   * рекомендованную моделью высоту, чтобы карточка не была полоской.
   */
  _fillAutoHeight() {
    const root = this._root;
    if (!root) return;
    const measure = () => {
      if (this._root !== root) return;                 // карточку пересобрали
      if (this._heightPx() !== null) return;           // height задан явно
      if (this._autoFilled) return;
      const h = root.clientHeight || 0;
      if (h > MIN_CARD_HEIGHT + 1) return;             // высоту задал родитель
      root.style.height = `${this._recommendedHeightPx()}px`;
      this._autoFilled = true;
      if (this._engine) this._engine.resize();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(measure);
    else setTimeout(measure, 0);
  }

  /** Ключ, по которому запоминается вид камеры (модель + настройки вида). */
  _viewKey() {
    const c = this._config || {};
    return `${c.model || ""}|${JSON.stringify(c.camera || null)}`;
  }

  _rememberView() {
    const engine = this._engine;
    if (!engine || typeof engine.getView !== "function") return;
    try {
      const view = engine.getView();
      if (!view || !Array.isArray(view.target)) return;
      VIEW_MEMORY.key = this._viewKey();
      VIEW_MEMORY.view = view;
      VIEW_MEMORY.at = Date.now();
    } catch (e) { /* вид камеры — не критичная часть */ }
  }

  _restoreView(engine) {
    const view = VIEW_MEMORY.view;
    if (!view || VIEW_MEMORY.key !== this._viewKey()) return;
    if (Date.now() - VIEW_MEMORY.at > VIEW_MEMORY_TTL) return;
    try {
      engine.setView(view);
    } catch (e) { /* вид камеры — не критичная часть */ }
  }

  /** Пересоздать сцену (смена модели в редакторе). */
  _rebuild() {
    if (this._engine) {
      // Канвас сохраняем: так контекст переживает смену модели.
      this._engine.dispose();
      this._engine.disposeDom();
      this._engine = null;
    }
    this._currentEngine = null;
    this._model = null;
    if (this._root) this._root.innerHTML = "";
    this._boot();
  }

  /**
   * Построить сцену.
   *
   * Вызывается из connectedCallback, setConfig и hass-сеттера, поэтому
   * возможны несколько одновременных вызовов: Lovelace отдаёт конфигурацию,
   * состояние и подключает элемент в произвольном порядке. Пока инициализация
   * идёт, повторные запросы только помечаются (_bootAgain), а не игнорируются —
   * иначе карточка может остаться пустой, если конфигурация пришла во время
   * загрузки модели.
   */
  async _boot() {
    if (this._booting) { this._bootAgain = true; return; }
    if (this._engine || !this._config || !this._root) {
      this._bootAgain = false;
      return;
    }
    this._bootAgain = false;
    this._booting = true;
    const root = this._root;
    this._applyHeight();

    // Заглушка «Загрузка модели…» показывается не сразу: модель (модуль и
    // геометрия) обычно уже в кэше, и в окне редактирования, где Lovelace
    // пересоздаёт карточку на каждое изменение конфигурации, мгновенная
    // вспышка выглядела как «модель загружается заново после каждого символа».
    const status = this._fallbackNode("Загрузка модели…");
    status.style.visibility = "hidden";
    root.appendChild(status);
    const statusTimer = setTimeout(() => { status.style.visibility = ""; }, STATUS_DELAY_MS);

    try {
      // reload_model — разовый флаг (редактор перечитал файл модели):
      // повторно его не применяем, иначе файл качался бы при каждом рендере.
      const oneShotReload = !!this._config.reload_model && !this._reloaded;
      this._reloaded = true;

      const model = await registry.resolve(this._config.model, {
        force: oneShotReload,
        allowExternal: this._config.allow_external_models !== false,
      });
      const THREE = await loadThree();
      clearTimeout(statusTimer);
      if (status.parentNode) status.parentNode.removeChild(status);

      // Элемент мог быть удалён с дашборда, пока грузилась модель.
      if (!this.isConnected) { this._booting = false; return; }

      this._model = model;
      // Каждая сцена получает собственный canvas: предыдущий освобождается
      // вместе с WebGL-контекстом в engine.dispose().
      const engine = new SceneEngine(root, this._config, model, {
        THREE,
        hass: this._hass,
        onService: (domain, service, data) => {
          if (this._hass && this._hass.callService) this._hass.callService(domain, service, data || {});
        },
        onDeepLink: (entityId) => this._openEntity(entityId),
      });
      this._currentEngine = engine;
      await engine.init();
      this._engine = engine;
      // В окне редактирования карточка пересоздаётся на каждое изменение
      // конфигурации: возвращаем тот вид камеры, который был у прежней сцены,
      // иначе модель «прыгала» бы к виду по умолчанию после каждой буквы.
      this._restoreView(engine);
      // Модель могла задать свои габариты — уточняем авто-высоту.
      this._applyHeight();
    } catch (e) {
      console.error("[threejs-3d-card]", e);
      if (status.parentNode) {
        status.innerHTML = this._errorHtml(e);
        status.classList.add("t3d-fallback-error");
      }
    } finally {
      clearTimeout(statusTimer);
      this._booting = false;
      const built = this._engine;
      if (built) {
        if (this._hass) built.applyHass(this._hass);
        else if (this._pendingStates) built.applyStates(this._pendingStates);
        built.setDiagnosticsVisible(!!(this._config.show_diagnostics));
        built.start();
      }
      if (this._bootAgain) {
        this._bootAgain = false;
        setTimeout(() => this._boot(), 0);
      }
    }
  }

  /**
   * Показать или скрыть панель диагностики по конфигурации карточки (T-018).
   *
   * Нужны оба направления: раньше вызов был только на включение, поэтому
   * панель, показанная один раз, оставалась висеть после выключения
   * `show_diagnostics` в редакторе.
   */
  _syncDiagnostics() {
    if (!this._engine) return;
    this._engine.setDiagnosticsVisible(!!(this._config && this._config.show_diagnostics));
  }

  _fallbackNode(text) {
    const d = document.createElement("div");
    d.className = "t3d-fallback";
    d.textContent = text;
    return d;
  }

  _errorHtml(e) {
    const msg = esc(e && e.message ? e.message : e);
    const model = esc((this._config && this._config.model) || "");
    return `<div>Не удалось построить 3D-сцену${model ? ` (модель <code>${model}</code>)` : ""}.<br><b>${msg}</b></div>`;
  }

  _openEntity(entityId) {
    // Основной путь: Lovelace открывает окно «Подробнее» по этому событию.
    const ev = new CustomEvent("hass-more-info", {
      detail: { entityId },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(ev);
  }

  // ---- требования Lovelace -------------------------------------------------

  getCardSize() {
    const px = this._heightPx();
    // Явная высота — относительный «вес» карточки в «кирпичной» раскладке:
    // 1 = 50 px (как и раньше).
    if (px !== null) return Math.max(3, Math.round(px / 50));
    // Высота не задана — карточка занимает доступную область, а до раскладки
    // Lovelace резервирует место по рекомендации модели (см. _applyHeight).
    return Math.max(3, Math.round(this._recommendedHeightPx() / 50));
  }

  /**
   * Размер клетки в сетке разделов (Sections). Карточка занимает клетку
   * целиком: 6 строк ≈ 376 px — близко к рекомендованным моделью 400–480 px;
   * пользователь меняет размер в редакторе раскладки (там же есть «auto
   * height» — тогда высоту задаёт сама карточка).
   */
  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: 6, min_rows: 3, max_rows: 16 };
  }

  /** Lovelace: конфигурация по умолчанию при добавлении карточки. */
  static getStubConfig(hass, entities) {
    const list = registry.list();
    const model = (list.find((m) => m.manifest.id === "water-tank") || list[0]) || null;
    return buildStubConfig(model, hass, entities);
  }

  static getConfigElement() {
    ensureStyles(document.head);
    return document.createElement(EDITOR_TAG);
  }

  static async getModelList() {
    return registry.list().map((m) => m.manifest);
  }
}

/** Определить legacy-модель по полю type (custom:water-tank-card и т.п.). */
function legacyModelId(config) {
  const type = String(config.type || "");
  const map = {
    "custom:water-tank-card": "water-tank",
    "custom:production-room-card": "production-room",
    "custom:water-tank-3d-card": "water-tank",
    "custom:production-room-3d-card": "production-room",
  };
  return map[type] || null;
}

api.CardClass = ThreeDModelCard;

if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, ThreeDModelCard);
if (!customElements.get(EDITOR_TAG)) customElements.define(EDITOR_TAG, ThreeDModelCardEditor);

if (typeof console !== "undefined" && console.info) {
  console.info(
    `%c THREEJS-3D-CARD %c v${CARD_VERSION} · моделей: ${registry.list().length} `,
    "color:#fff;background:#1f6feb;font-weight:700;border-radius:3px 0 0 3px;padding:2px 4px",
    "color:#1f6feb;background:#0d1117;border-radius:0 3px 3px 0;padding:2px 4px"
  );
}

export { ThreeDModelCard, SceneEngine, registry, defineModel, loadThree };
export default ThreeDModelCard;
