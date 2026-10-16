// ============================================================================
//  SceneEngine — общий движок 3D-сцены для Lovelace-карточки.
//
//  Отвечает за всё, что одинаково для любой модели:
//    * WebGLRenderer, свет, окружение, ресайз (ResizeObserver);
//    * орбитальная камера через createCameraControls (src/core/camera-controls.js):
//      мышь — ЛКМ вращение, ПКМ или Shift+ЛКМ сдвиг, колесо зум, двойной клик
//      сброс вида; касания — один палец вращение, два щипок-зум и сдвиг, двойной
//      тап сброс вида, одиночный тап — выбор объекта; тот же набор жестов работает
//      и у моделей с host: "external" — карточка сама присоединяет модуль к
//      камере модели (T-003);
//    * выбор объектов лучом (Raycaster) и модальное окно сущности
//      с атрибутами, управлением и переходом в Home Assistant;
//    * HUD-оверлей (заголовок, подпись, диагностика);
//    * шина состояний: hass.states -> модель;
//    * жизненный цикл: пауза вне экрана, потеря WebGL-контекста, dispose.
//
//  Модель получает контекст (см. docs/MODEL_API.md) и возвращает объект
//  с полями root/targets/applyState/frame/applyConfig/dispose.
// ============================================================================

import { StateBus, prettyState, stateWithUnit, isAvailable } from "./state.js";
import {
  normalizeBindings, normalizeParams, normalizeConfig, entityMap, validateBindings, readValue,
} from "./bindings.js";
import { clamp, ease, esc, resolveColor, isDarkTheme, observeVisibility, prefersReducedMotion } from "./util.js";
import { ensureStyles } from "./styles.js";
import { DOMAIN_LABELS, CARD_VERSION } from "./constants.js";
import { createCameraControls } from "./camera-controls.js";

const MAX_PIXEL_RATIO = 2;

/** Зазор между надписями верхней полосы карточки и панелью диагностики (T-018). */
const DIAG_GAP = 8;
/**
 * Верхняя полоса карточки (T-018), в которой ищутся надписи, которые панель
 * диагностики не должна перекрывать: HUD карточки и HUD модели начинаются от
 * `top: 10px`, поэтому полосы в 64 px хватает с запасом.
 */
const DIAG_TOP_BAND = 64;

/**
 * Привести точку ориентира (THREE.Vector3, [x, y, z] или {x, y, z}) к обычному
 * объекту без обращений к three.js — чтобы исходный вид внешней камеры
 * (_externalView) можно было вычислить и с мок-камерой в тестах.
 */
function plainTarget(t) {
  if (!t) return { x: 0, y: 0, z: 0 };
  if (Array.isArray(t)) return { x: t[0] || 0, y: t[1] || 0, z: t[2] || 0 };
  return { x: t.x || 0, y: t.y || 0, z: t.z || 0 };
}

export class SceneEngine {
  /**
   * @param {HTMLElement} container  элемент, внутри которого строится сцена
   * @param {object} cardConfig      конфигурация карточки (entities/params/title/…)
   * @param {object} model           нормализованное описание модели
   * @param {object} opts            { THREE, hass, onService, onDeepLink, onStatus }
   */
  constructor(container, cardConfig, model, opts = {}) {    this.container = container;
    this._model = model;
    this.THREE = opts.THREE;
    this.opts = opts;

    this.schema = {
      bindings: normalizeBindings(model.bindings),
      params: normalizeParams(model.params),
    };
    this.schema.bindingKeys = new Set(this.schema.bindings.map((b) => b.key));
    this.schema.paramKeys = new Set(this.schema.params.map((p) => p.key));

    this.normalized = normalizeConfig(cardConfig, this.schema);
    this.config = this._buildConfig(cardConfig);
    this.panelConfig = cardConfig || {};

    this.bus = new StateBus();
    this.bus.watch(Object.values(entityMap(this.normalized.entities, this.schema)));

    this.hass = opts.hass || null;
    this.onService = opts.onService || null;
    this.onDeepLink = opts.onDeepLink || null;
    this.onStatus = opts.onStatus || null;

    this.running = false;
    this.disposed = false;
    this.visible = true;
    this.contextLost = false;
    this.reducedMotion = prefersReducedMotion();
    this._raf = 0;
    this._lastT = 0;
    this._time = 0;
    this._needsRender = true;
    this._syncedVersion = -1;
    this._lastReportedVersion = -1;
    this.openKey = null;
    // Панель диагностики строится всегда, но по умолчанию скрыта (T-018):
    // пустой прямоугольник поверх сцены закрывал HUD и перехватывал ввод.
    this._diagVisible = false;
    this._listeners = [];
    this._modelHandle = null;
    this._camControls = null;
  }

  // ---- конфигурация --------------------------------------------------------

  /**
   * Описание модели сцены. После dispose() возвращает null: движок снимается
   * в момент смены модели, и удерживаемые снаружи ссылки не должны падать при
   * обращении к model.manifest.
   */
  get model() {
    return this.disposed ? null : this._model;
  }

  _buildConfig(cardConfig) {
    const cfg = cardConfig || {};
    const meta = this.model.manifest;
    const size = meta.size || {};
    const cam = Object.assign({}, meta.camera || {}, cfg.camera || {});
    const env = Object.assign({}, meta.environment || {}, cfg.environment || {});
    const defaults = (this.model.defaults && this.model.defaults.config) || {};

    // Значения привязок по умолчанию от модели (например, объектная модель
    // подставляет собственные entity_id, чтобы работать без настройки).
    // Явно указанные пользователем значения приоритетнее.
    let modelDefaults = {};
    if (typeof this.model.defaultEntities === "function") {
      try {
        modelDefaults = this.model.defaultEntities() || {};
      } catch (e) {
        this._report && this._report("warn", `defaultEntities(): ${e.message}`);
      }
    }
    const entities = Object.assign({}, modelDefaults, this.normalized.entities);
    for (const key of Object.keys(entities)) {
      if (!entities[key]) delete entities[key];
    }

    return {
      model: meta.id,
      modelUrl: cfg.model_url || cfg.modelUrl || null,
      title: cfg.title !== undefined ? cfg.title : (defaults.title || meta.name),
      showHud: cfg.show_hud !== undefined ? !!cfg.show_hud : (defaults.show_hud !== false),
      background: resolveColor(cfg.background || env.background || "", ""),
      height: numberOr(cfg.height, numberOr(size.defaultHeight, 360)),
      entities: Object.assign({}, entities),
      params: Object.assign({}, defaults.params || {}, this.normalized.params),
      camera: Object.assign({
        target: [0, 0, 0], radius: 5, phi: 1.1, theta: 0.7,
        minRadius: 1.2, maxRadius: 40, mode: "orbit",
        panoramic: true, tilt: true, minPhi: 0.12, maxPhi: Math.PI / 2 - 0.02,
      }, cam),
      environment: env,
    };
  }

  /** Реконфигурация без пересоздания сцены (редактор карточки). */
  applyConfig(cardConfig) {
    this.panelConfig = cardConfig || {};
    this.normalized = normalizeConfig(cardConfig, this.schema);
    this.config = this._buildConfig(cardConfig);
    this.bus.watch(Object.values(entityMap(this.normalized.entities, this.schema)));
    this.bus.rebind(entityMap(this.normalized.entities, this.schema));
    this._syncFromStates(true);
    if (this.envGroup) this._applyEnvironment();
    if (this._modelHandle && this._modelHandle.applyConfig) {
      try { this._modelHandle.applyConfig(this.config); } catch (e) { this._reportError("applyConfig", e); }
    }
    this._resizeRenderer();
    this._needsRender = true;
  }

  /** Текущая конфигурация (для редактора и внешних потребителей). */
  getConfig() {
    return this.panelConfig;
  }

  // ---- инициализация -------------------------------------------------------

  async init() {
    const T = this.THREE;
    if (!T) throw new Error("SceneEngine: не передан three.js");

    const rootNode = this.container.getRootNode ? this.container.getRootNode() : document;
    ensureStyles(rootNode);

    this._setupRenderer();
    this._setupScene();
    this._buildEnvironment();
    this._buildOverlay();

    const ctx = this._createModelContext();
    // three.js должен быть готов до вызова create(): модель вправе обращаться
    // к библиотеке на верхнем уровне своего файла (window.ThreeJS3DCard.THREE).
    if (typeof window !== "undefined" && window.ThreeJS3DCard && window.ThreeJS3DCard.threeReady) {
      await window.ThreeJS3DCard.threeReady;
    }
    if (this.model.attach) {
      // legacy-режим: модель сама управляет сценой (готовый движок)
      this._modelHandle = await this.model.attach(ctx);
    } else {
      this._modelHandle = await this.model.create(ctx);
    }
    if (!this._modelHandle) throw new Error("Модель не вернула объект-описание сцены");
    if (this._modelHandle.root) this.scene.add(this._modelHandle.root);

    this._bindInput();
    this._io = observeVisibility(this.container, (v) => this._setVisible(v));
    this._onVis = () => this._setVisible(!document.hidden);
    document.addEventListener("visibilitychange", this._onVis);

    this._resizeRenderer();
    this._syncFromStates(true);
    this._needsRender = true;
    return this;
  }

  _setupRenderer() {
    const T = this.THREE;

    // Модель с собственным рендерером (manifest.host === "external") сама
    // создаёт WebGLRenderer на канвасе карточки. Два контекста на одном
    // канвасе создать нельзя: второй вызов getContext() молча возвращает
    // нерабочий контекст, и сцена остаётся пустой. Поэтому канвас создаём
    // здесь, а рендерер — нет.
    const canvas = document.createElement("canvas");
    canvas.className = "t3d-canvas";
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;";
    this.container.appendChild(canvas);
    this.canvas = canvas;
    this._reusedCanvas = false;
    this._externalHost = !!(this.model.manifest && this.model.manifest.host === "external");

    // Потеря/восстановление контекста отслеживается в обоих режимах.
    const onLost = (e) => {
      e.preventDefault();
      this.contextLost = true;
      this._setStatus("Потерян WebGL-контекст, ожидаю восстановления…");
    };
    const onRestored = () => {
      this.contextLost = false;
      this._setStatus("");
      this._needsRender = true;
    };
    canvas.addEventListener("webglcontextlost", onLost, false);
    canvas.addEventListener("webglcontextrestored", onRestored, false);
    this._listeners.push(() => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    });

    if (this._externalHost) {
      // Сцена и камера нужны карточке для служебных операций (raycast,
      // диагностика), но рисовать ими она не будет.
      this.renderer = null;
      this.scene = new T.Scene();
      this.camera = new T.PerspectiveCamera(45, 1, 0.1, 200);
      return;
    }

    const renderer = new T.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    if ("outputColorSpace" in renderer) renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.renderer = renderer;

    if (typeof ResizeObserver !== "undefined" && this.container instanceof Element) {
      this._ro = new ResizeObserver(() => this._resizeRenderer());
      this._ro.observe(this.container);
    }
    this._onWinResize = () => this._resizeRenderer();
    window.addEventListener("resize", this._onWinResize);
  }

  _setupScene() {
    const T = this.THREE;
    // Внешней модели общая сцена не нужна: у неё своя (см. _setupRenderer),
    // а объекты, добавленные в общую сцену, всё равно никто не отрисует.
    if (this._externalHost) return;

    const scene = new T.Scene();
    if (this.config.background) scene.background = new T.Color(this.config.background);
    this.scene = scene;

    this.envGroup = new T.Group();
    this.envGroup.name = "environment";
    scene.add(this.envGroup);

    const cam = this.config.camera;
    this.camera = new T.PerspectiveCamera(42, 1, 0.05, 400);
    this.camState = {
      target: new T.Vector3(...(cam.target || [0, 0, 0])),
      radius: numberOr(cam.radius, 5),
      phi: clamp(numberOr(cam.phi, 1.1), 0.05, Math.PI - 0.05),
      theta: numberOr(cam.theta, 0.7),
      min: numberOr(cam.minRadius, 1.2),
      max: numberOr(cam.maxRadius, 40),
      minPhi: numberOr(cam.minPhi, 0.12),
      maxPhi: numberOr(cam.maxPhi, Math.PI / 2 - 0.02),
      mode: cam.mode || "orbit",
      panoramic: cam.panoramic !== false,
      tilt: cam.tilt !== false,
    };
    this._homeCam = {
      target: this.camState.target.clone(),
      radius: this.camState.radius,
      phi: this.camState.phi,
      theta: this.camState.theta,
    };
    this._updateCamera();
  }

  _buildEnvironment() {
    const T = this.THREE;
    // Свет и пол — принадлежность общей сцены; у внешней модели своя.
    if (this._externalHost || !this.envGroup) return;
    const env = this.config.environment || {};
    const dark = isDarkTheme();

    this._hemi = new T.HemisphereLight(
      new T.Color(env.skyColor || (dark ? 0xbfd4ff : 0xffffff)),
      new T.Color(env.groundColor || (dark ? 0x141820 : 0x606060)),
      numberOr(env.hemiIntensity, dark ? 0.55 : 0.85)
    );
    this.envGroup.add(this._hemi);

    this._key = new T.DirectionalLight(0xffffff, numberOr(env.keyIntensity, 1.0));
    this._key.position.set(4, 8, 5);
    this._key.castShadow = !!env.shadows;
    if (env.shadows) {
      this._key.shadow.mapSize.set(1024, 1024);
      this._key.shadow.camera.near = 0.5;
      this._key.shadow.camera.far = 30;
      this._key.shadow.camera.left = -8;
      this._key.shadow.camera.right = 8;
      this._key.shadow.camera.top = 8;
      this._key.shadow.camera.bottom = -8;
    }
    this.envGroup.add(this._key);

    this._rim = new T.PointLight(0x3a72a8, numberOr(env.rimIntensity, 0.6), 30);
    this._rim.position.set(-5, 4, -3);
    this.envGroup.add(this._rim);

    this._applyEnvironment();
  }

  _applyEnvironment() {
    const T = this.THREE;
    if (this._externalHost || !this.envGroup) return;
    const env = this.config.environment || {};
    const kind = env.floor || "none";
    if (this._floor) {
      this.envGroup.remove(this._floor);
      disposeObject(this._floor);
      this._floor = null;
    }
    if (kind === "none") return;

    if (kind === "radial") {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 512;
      const g = canvas.getContext("2d");
      const grad = g.createRadialGradient(256, 256, 30, 256, 256, 260);
      grad.addColorStop(0, "rgba(90,120,160,0.55)");
      grad.addColorStop(0.65, "rgba(40,55,75,0.32)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 512, 512);
      g.globalAlpha = 0.18;
      g.strokeStyle = "#9fc8e8";
      g.lineWidth = 1;
      for (let i = 0; i < 8; i++) {
        const p = i * 64;
        g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 512); g.stroke();
        g.beginPath(); g.moveTo(0, p); g.lineTo(512, p); g.stroke();
      }
      const tex = new T.CanvasTexture(canvas);
      if ("colorSpace" in tex) tex.colorSpace = T.SRGBColorSpace;
      const mat = new T.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.95, metalness: 0.0 });
      const plane = new T.Mesh(new T.PlaneGeometry(16, 16), mat);
      plane.rotation.x = -Math.PI / 2;
      plane.receiveShadow = !!env.shadows;
      this._floor = plane;
    } else if (kind === "plane") {
      const mat = new T.MeshStandardMaterial({
        color: new T.Color(env.floorColor || (isDarkTheme() ? 0x1b2029 : 0xd8d8d8)),
        roughness: 0.95,
      });
      const plane = new T.Mesh(new T.PlaneGeometry(numberOr(env.floorSize, 40), numberOr(env.floorSize, 40)), mat);
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = numberOr(env.floorY, -0.001);
      plane.receiveShadow = !!env.shadows;
      this._floor = plane;
    } else if (kind === "grid") {
      const grid = new T.GridHelper(
        numberOr(env.gridSize, 20), numberOr(env.gridSize, 20),
        new T.Color(env.gridColor1 || 0x3a4150), new T.Color(env.gridColor2 || 0x262c37)
      );
      this._floor = grid;
    }
    if (this._floor) this.envGroup.add(this._floor);
    this._needsRender = true;
  }

  // ---- контекст для модели -------------------------------------------------

  _createModelContext() {
    const engine = this;
    const self = this;

    const ctx = {
      THREE: this.THREE,
      scene: this.scene,
      envGroup: this.envGroup,
      camera: this.camera,
      renderer: this.renderer,
      container: this.container,
      canvas: this.canvas,
      config: this.config,

      /** entity_id для ключа привязки. */
      entityId(key) { return self.config.entities[key] || null; },
      /** состояние сущности по ключу привязки. */
      state(key) { return self.bus.get(self.config.entities[key]); },
      /** значение привязки (по value.kind). */
      value(key) { return self._valueOf(key); },
      /** доступна ли сущность (не unavailable). */
      available(key) { return isAvailable(self.state_(key)); },
      /** состояние всех привязок: { key: {entity,state,value,available} }. */
      get bindings() { return self.bindingView(); },
      /** настройки модели (params). */
      get params() { return self.config.params; },

      /** Изменить параметр модели на лету. */
      setParam(key, value) {
        self.config.params[key] = value;
      },

      asset(relative) {
        // T-011: _sourceUrl — базовый URL для относительных путей спеки.
        // Базой служит только реальный URL (http(s)://, /, ./): у модели без
        // сетевого пути относительные пути разрешаются от страницы.
        const raw = (engine.model && engine.model._sourceUrl) || "";
        const base =
          /^https?:\/\//i.test(raw) || raw.startsWith("/") || raw.startsWith("./")
            ? raw
            : document.baseURI;
        try { return new URL(relative, base).href; } catch (e) { return relative; }
      },

      makeLabel: (text, o) => self.makeLabel(text, o),
      resolveColor,
      clamp,
      ease,

      /** Сообщить о проблеме — появится в диагностике карточки. */
      report(level, message) { self._report(level, message); },

      /** Пометить объект как интерактивный: клик откроет модалку сущности. */
      tag(object3d, key, opts) {
        const entity = (opts && opts.entity) || self.config.entities[key] || null;
        object3d.traverse((n) => {
          n.userData.t3d = { key, entity };
        });
        return object3d;
      },

      /** Пометить область сцены как кликабельную с произвольными действиями. */
      onPick(object3d, handler) {
        object3d.traverse((n) => { n.userData.t3dPick = handler; });
        return object3d;
      },

      requestRender() { self._needsRender = true; },
      onService(domain, service, data) { self.callService(domain, service, data); },
      openEntity(entityId) { self.openEntityModal(entityId); },
      setStatus(text) { self._setStatus(text); },

      /**
       * Модель может отдать движку собственный WebGLRenderer — например,
       * когда сцена строится готовым сторонним движком. Тогда карточка
       * использует один WebGL-контекст вместо двух.
       */
      setRenderer(renderer) {
        if (!renderer || renderer === self.renderer) return;
        self._sharedRenderer = renderer;
        self.renderer = renderer;
        if (self.camera) {
          const w = Math.max(1, self.container.clientWidth || 320);
          const h = Math.max(1, self.container.clientHeight || 240);
          self.camera.aspect = w / h;
          self.camera.updateProjectionMatrix();
          renderer.setSize(w, h, false);
        }
      },

      /**
       * Общий контрол камеры (createCameraControls): единственная реализация
       * жестов мыши и касаний. Канвас карточки и three.js уже подставлены —
       * передайте камеру (встроенная орбитальная математика) или функцию
       * apply(gesture) (своя математика: модуль пришлёт {type, dx, dy, factor}).
       *
       * Для host: "external" этот метод обычно не нужен: если модель вернула
       * camera в handle, карточка сама присоединяет контрол (T-003) —
       * двойное присоединение даст двойную обработку жестов.
       */
      controls(options) {
        return createCameraControls(Object.assign({ element: self.canvas, THREE: self.THREE }, options || {}));
      },
    };

    return ctx;
  }

  /** Значение привязки с учётом схемы (и переопределения атрибута из редактора). */
  _valueOf(key) {
    const binding = this.schema.bindings.find((b) => b.key === key);
    const state = this.state_(key);
    if (!binding) return state ? state.state : undefined;
    const override = this.config.params[`attr.${key}`];
    const effective = override
      ? Object.assign({}, binding, { value: Object.assign({}, binding.value, { param: override }) })
      : binding;
    return readValue(effective, state, this.config.params);
  }

  state_(key) {
    const id = this.config.entities[key];
    return id ? this.bus.get(id) : undefined;
  }

  /** Представление всех привязок для модели и диагностики. */
  bindingView() {
    const out = {};
    for (const b of this.schema.bindings) {
      const entity = this.config.entities[b.key] || null;
      const state = entity ? this.bus.get(entity) : undefined;
      out[b.key] = {
        key: b.key,
        name: b.name,
        entity,
        state,
        value: entity ? this._valueOf(b.key) : undefined,
        available: isAvailable(state),
      };
    }
    // привязки вне схемы (legacy-конфиги)
    for (const [key, entity] of Object.entries(this.config.entities)) {
      if (out[key]) continue;
      const state = this.bus.get(entity);
      out[key] = { key, name: key, entity, state, value: state ? state.state : undefined, available: isAvailable(state) };
    }
    return out;
  }

  // ---- состояния -----------------------------------------------------------

  /** Принять hass (или только hass.states). */
  applyHass(hass) {
    if (!hass) return false;
    this.hass = hass;
    return this.applyStates(hass.states);
  }

  applyStates(states) {
    const map = entityMap(this.config.entities, this.schema);
    const changed = this.bus.apply(states, map);
    if (changed) this._syncFromStates();
    return changed;
  }

  /** Точечное обновление (демо-режим, тесты). */
  setEntityState(entityId, state) {
    if (this.bus.setEntity(entityId, state)) this._syncFromStates();
  }

  /** Сменить привязки без пересоздания сцены. */
  setEntities(map) {
    Object.assign(this.config.entities, map || {});
    const em = entityMap(this.config.entities, this.schema);
    this.bus.watch(Object.values(em));
    this.bus.rebind(em);
    this._syncFromStates();
  }

  _syncFromStates(force = false) {
    if (!force && this._syncedVersion === this.bus.version) return;
    this._syncedVersion = this.bus.version;

    const handle = this._modelHandle;
    if (!handle) { this._needsRender = true; return; }

    const view = this.bindingView();
    // Порядок проверки важен: старый движок сцены умеет applyStates(states),
    // но модель обязана сообщить о себе через applyState(key, info).
    if (typeof handle.applyState === "function") {
      for (const [key, info] of Object.entries(view)) {
        try {
          handle.applyState(key, info, this.config);
        } catch (e) {
          this._reportError(`applyState(${key})`, e);
        }
      }
    } else if (typeof handle.applyStates === "function") {
      try {
        handle.applyStates(view, this.config);
      } catch (e) {
        this._reportError("applyStates", e);
      }
    }
    this._needsRender = true;
  }

  /** Представление состояния одной привязки для модели. */
  _bindingInfo(key) {
    const b = this.schema.bindings.find((x) => x.key === key);
    const entity = this.config.entities[key] || null;
    const state = entity ? this.bus.get(entity) : undefined;
    return {
      key,
      name: b ? b.name : key,
      entity,
      state,
      value: entity ? this._valueOf(key) : undefined,
      available: isAvailable(state),
    };
  }

  // ---- цикл рендера --------------------------------------------------------

  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this._lastT = 0;
    const loop = (t) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      if (this.contextLost) return;
      const dt = this._lastT ? clamp((t - this._lastT) / 1000, 0, 0.05) : 0;
      this._lastT = t;
      this._time += dt;
      this._frame(dt);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _setVisible(v) {
    this.visible = v;
    if (v && !this.running) this.start();
  }

  _frame(dt) {
    const handle = this._modelHandle;

    // Модель со своим циклом кадров и рендерером: камеру и рендер не трогаем.
    if (handle && handle.external) {
      if (typeof handle.frame === "function") {
        try { handle.frame(this.reducedMotion ? 0 : dt, this._time, this.config); } catch (e) { this._reportError("frame", e); }
      }
      return;
    }
    if (this._externalHost) {
      // Рендерер создаёт сама модель (manifest.host === "external"),
      // карточке рисовать нечем и не нужно.
      return;
    }

    if (handle && typeof handle.frame === "function") {
      try {
        handle.frame(this.reducedMotion ? 0 : dt, this._time, this.config);
      } catch (e) {
        this._reportError("frame", e);
      }
    }
    this._applyCameraDrift(dt);
    this._updateCamera();
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** Мягкое «дыхание» камеры, как в исходном баке (можно отключить). */
  _applyCameraDrift(dt) {
    if (this.reducedMotion) return;
    const drift = this.config.camera.drift;
    if (!drift || !this._camControls) return;
    // Состояние вида владеет контрол (см. _bindInput): drift идёт через
    // setView, иначе внутренняя математика модуля отстанет от camState и
    // камера подпрыгнет при следующем жесте.
    const view = this._camControls.getView();
    this._camControls.setView({ theta: view.theta + drift * dt * 0.05 });
  }

  _updateCamera() {
    const c = this.camState;
    const r = c.radius, p = c.phi, t = c.theta;
    const x = c.target.x + r * Math.sin(p) * Math.sin(t);
    const y = c.target.y + r * Math.cos(p);
    const z = c.target.z + r * Math.sin(p) * Math.cos(t);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(c.target);
  }

  /** Сбросить камеру к исходному виду. */
  resetView() {
    const h = this._homeCam;
    this.camState.target.copy(h.target);
    this.camState.radius = h.radius;
    this.camState.phi = h.phi;
    this.camState.theta = h.theta;
    this._updateCamera();
    this._needsRender = true;
  }

  /**
   * Текущий вид камеры — для сохранения при пересоздании сцены.
   *
   * Home Assistant в режиме предпросмотра (окно редактирования карточки)
   * пересоздаёт элемент карточки на каждое изменение конфигурации
   * (hui-card: `typeChanged || this.preview` → `_loadElement`), поэтому без
   * сохранения вида камера возвращалась бы к виду по умолчанию после каждого
   * символа, введённого в редакторе. Возвращается простой объект (без three.js),
   * чтобы его можно было передать между экземплярами сцены.
   */
  getView() {
    const v = this._camControls && typeof this._camControls.getView === "function"
      ? this._camControls.getView()
      : null;
    if (v && v.target) {
      return { target: [v.target.x, v.target.y, v.target.z], radius: v.radius, phi: v.phi, theta: v.theta };
    }
    const c = this.camState;
    return { target: [c.target.x, c.target.y, c.target.z], radius: c.radius, phi: c.phi, theta: c.theta };
  }

  /**
   * Восстановить вид камеры (после пересоздания сцены). Модель может
   * распоряжаться камерой сама — тогда спрашиваем её (handle.setView).
   * @returns {boolean} удалось ли применить вид
   */
  setView(view) {
    if (!view || !Array.isArray(view.target) || !this.THREE) return false;
    const hd = this._modelHandle;
    if (hd && typeof hd.setView === "function") {
      try { if (hd.setView(view) !== false) return true; } catch (e) { this._reportError("setView", e); }
    }
    if (this._camControls && typeof this._camControls.setView === "function") {
      this._camControls.setView({
        target: new this.THREE.Vector3(view.target[0] || 0, view.target[1] || 0, view.target[2] || 0),
        radius: view.radius,
        phi: view.phi,
        theta: view.theta,
      });
    }
    // camState — зеркало вида (его читают _applyCameraDrift и _updateCamera),
    // поэтому обновляем и его; у внешних моделей своей камерой распоряжается
    // движок модели, и трогать camState нельзя.
    if (!this._externalHost && this.camera && this.camState && this.camState.target) {
      const c = this.camState;
      c.target.set(view.target[0] || 0, view.target[1] || 0, view.target[2] || 0);
      if (Number.isFinite(view.radius)) c.radius = view.radius;
      if (Number.isFinite(view.phi)) c.phi = view.phi;
      if (Number.isFinite(view.theta)) c.theta = view.theta;
      this._updateCamera();
    }
    this._needsRender = true;
    return true;
  }

  resize() { this._resizeRenderer(); }

  _resizeRenderer() {
    const w = Math.max(1, this.container.clientWidth || 320);
    const h = Math.max(1, this.container.clientHeight || 240);
    // Внешней модели сообщаем размер всегда: собственным рендерером
    // распоряжается она сама.
    if (this.renderer) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    if (this._modelHandle && this._modelHandle.resize) {
      try { this._modelHandle.resize(w, h, this.config); } catch (e) { this._reportError("resize", e); }
    }
    // (T-018) при другой ширине заголовок HUD может перенестись на другую
    // строку — панель диагностики пересчитывает своё место.
    if (this._diagVisible) this._placeDiagnostics();
    this._needsRender = true;
  }

  // ---- управление камерой --------------------------------------------------

  /**
   * Жесты камеры — общий модуль createCameraControls
   * (src/core/camera-controls.js), единственная реализация: мышь и касания из
   * одного набора. Встроенная орбитальная математика модуля; состояние вида
   * зеркалится в this.camState в каждом onChange, чтобы движок (drift,
   * resetView, тесты) читал его с одного места.
   *
   * Для host: "external" карточка сама присоединяет модуль к камере модели
   * (T-003) — см. _bindExternalInput.
   */
  _bindInput() {
    if (this._externalHost) { this._bindExternalInput(); return; }
    const c = this.camState;
    this._camControls = createCameraControls({
      element: this.canvas,
      THREE: this.THREE,
      camera: this.camera,
      target: c.target,
      radius: c.radius,
      phi: c.phi,
      theta: c.theta,
      minRadius: c.min,
      maxRadius: c.max,
      minPhi: c.minPhi,
      maxPhi: c.maxPhi,
      panoramic: c.panoramic,
      tilt: c.tilt,
      onChange: (view) => {
        c.target.copy(view.target);
        c.radius = view.radius;
        c.phi = view.phi;
        c.theta = view.theta;
        this._updateCamera();
        this._needsRender = true;
      },
      onTap: (_x, _y, e) => this._pick(e),
      onReset: () => this.resetView(),
    });
  }

  /**
   * host: "external" (T-003): если модель вернула камеру в handle, карточка
   * присоединяет к ней общий модуль жестов — орбиту, панорамирование, зум,
   * сброс вида и одиночный тап из одного места, для мыши и касаний одинаково.
   * Модели больше не нужно слушать канвас.
   *
   * Математика камеры:
   *   * handle.apply(gesture) — у модели собственное сферическое состояние
   *     (готовые движки): карточка передаёт жесты «как есть», сама камеру
   *     не трогает;
   *   * иначе — встроенная математика модуля пишет в камеру напрямую;
   *     исходный вид — из handle.view (target, radius, phi, theta, пределы),
   *     а если его нет — выводится из camera.position, чтобы камера не
   *     прыгнула при присоединении.
   *
   * Модель, не вернувшая камеру, остаётся прежней: жесты — её забота,
   * карточка слушателей не вешает.
   */
  _bindExternalInput() {
    const h = this._modelHandle;
    const cam = h && h.camera;
    if (!cam || !this.canvas) return;
    const v = this._externalView(h);
    const hasApply = typeof h.apply === "function";
    this._camControls = createCameraControls({
      element: this.canvas,
      THREE: this.THREE,
      camera: cam,
      target: v.target,
      radius: v.radius,
      phi: v.phi,
      theta: v.theta,
      minRadius: v.minRadius,
      maxRadius: v.maxRadius,
      minPhi: v.minPhi,
      maxPhi: v.maxPhi,
      apply: hasApply ? h.apply : null,
      // В apply-режиме движок сообщает об изменениях сам; во встроенной
      // математике флаг нужен для перерисовки (внешняя модель рисует в
      // собственном цикле — флаг безвреден).
      onChange: () => { this._needsRender = true; },
      onTap: (_x, _y, e) => {
        if (typeof h.pick === "function") {
          try { h.pick(e); } catch (err) { this._reportError("pick", err); }
        }
      },
      onReset: () => {
        // В apply-режиме сброс уже доставлен через apply({ type: "reset" }) —
        // повторный вызов resetView был бы дублем.
        if (hasApply) return;
        if (typeof h.resetView === "function") {
          try { h.resetView(); } catch (err) { this._reportError("resetView", err); }
        }
      },
    });
    this._bindExternalResize();
  }

  /**
   * Исходный вид внешней камеры (T-003): из handle.view либо выведенный из
   * позиции камеры (ориентир — начало координат). Считается без обращений к
   * three.js, чтобы работать и с мок-камерами в тестах.
   */
  _externalView(h) {
    const cam = h.camera;
    const v = (h.view && typeof h.view === "object") ? h.view : {};
    const t = plainTarget(v.target);
    const p = (cam && cam.position && typeof cam.position === "object") ? cam.position : { x: 0, y: 0, z: 5 };
    const ox = (p.x || 0) - t.x;
    const oy = (p.y || 0) - t.y;
    const oz = (p.z || 0) - t.z;
    const len = Math.sqrt(ox * ox + oy * oy + oz * oz);
    return {
      target: t,
      radius: Number.isFinite(v.radius) ? v.radius : Math.max(len, 0.001),
      phi: Number.isFinite(v.phi) ? v.phi : (len > 1e-6 ? Math.acos(clamp(oy / len, -1, 1)) : 1.2),
      theta: Number.isFinite(v.theta) ? v.theta : Math.atan2(ox, oz),
      minRadius: v.minRadius,
      maxRadius: v.maxRadius,
      minPhi: v.minPhi,
      maxPhi: v.maxPhi,
    };
  }

  /**
   * host: "external" (T-003): _setupRenderer в этом режиме не создаёт
   * ResizeObserver карточки (своего рендерера нет), поэтому размер
   * карточки синхронизируется с камерой и рендерером модели: если у модели
   * есть handle.resize — делегируем ей, иначе синхронизируем сами.
   */
  _bindExternalResize() {
    if (typeof ResizeObserver === "undefined" || !(this.container instanceof Element)) return;
    this._ro = new ResizeObserver(() => this._resizeExternal());
    this._ro.observe(this.container);
  }

  /** Синхронизация внешней модели с размером контейнера (см. _bindExternalResize). */
  _resizeExternal() {
    const hd = this._modelHandle;
    if (!hd) return;
    const w = Math.max(1, this.container.clientWidth || 320);
    const h = Math.max(1, this.container.clientHeight || 240);
    if (typeof hd.resize === "function") {
      try { hd.resize(w, h, this.config); } catch (e) { this._reportError("resize", e); }
      return;
    }
    const cam = hd.camera;
    if (cam && "aspect" in cam) {
      cam.aspect = w / h;
      if (typeof cam.updateProjectionMatrix === "function") cam.updateProjectionMatrix();
    }
    if (this.renderer && typeof this.renderer.setSize === "function") {
      this.renderer.setPixelRatio && this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
      this.renderer.setSize(w, h, false);
    }
  }

  /** Выбор объекта лучом: модалка сущности или обработчик модели. */
  _pick(e) {
    const T = this.THREE;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new T.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new T.Raycaster();
    ray.setFromCamera(ndc, this.camera);

    const targets = [];
    if (this._modelHandle && this._modelHandle.pickTargets) targets.push(this._modelHandle.pickTargets());
    if (this._modelHandle && this._modelHandle.root) targets.push(this._modelHandle.root);
    const hits = ray.intersectObjects(targets.filter(Boolean), true);
    for (const hit of hits) {
      const pick = findUserData(hit.object, "t3dPick");
      if (pick) { pick(hit); return; }
      const tag = findUserData(hit.object, "t3d");
      if (tag) {
        if (tag.entity) this.openEntityModal(tag.entity, tag.key);
        else if (tag.key && this._modelHandle && this._modelHandle.onPickKey) this._modelHandle.onPickKey(tag.key);
        return;
      }
    }
    this.closeModal();
  }

  // ---- вызываемые сервисы --------------------------------------------------

  callService(domain, service, data) {
    if (this.onService) { this.onService(domain, service, data || {}); return; }
    if (this.hass && this.hass.callService) this.hass.callService(domain, service, data || {});
  }

  openEntityModal(entityId, key) {
    this.openKey = key || null;
    this.openEntity = entityId;
    this._renderModal();
  }

  // ---- HUD и модалка -------------------------------------------------------

  _buildOverlay() {
    const root = document.createElement("div");
    root.className = "t3d-overlay";

    const hud = document.createElement("div");
    hud.className = "t3d-hud";
    root.appendChild(hud);
    this._hud = hud;

    const hudSub = document.createElement("div");
    hudSub.className = "t3d-hud-sub";
    hud.appendChild(hudSub);
    this._hudSub = hudSub;

    const status = document.createElement("div");
    status.className = "t3d-status";
    root.appendChild(status);
    this._status = status;

    const actions = document.createElement("div");
    actions.className = "t3d-actions";
    root.appendChild(actions);
    this._actions = actions;

    const diag = document.createElement("div");
    diag.className = "t3d-diag";
    root.appendChild(diag);
    this._diag = diag;

    const modal = document.createElement("div");
    modal.className = "t3d-modal-backdrop";
    modal.style.display = "none";
    root.appendChild(modal);
    this._modal = modal;

    this.container.appendChild(root);
    this._overlay = root;
    this._updateHud();
    this._renderStatus();
    // (T-018) панель диагностики создаётся всегда, но показывается только по
    // флагу show_diagnostics: в скрытом состоянии от неё не остаётся пустого
    // прямоугольника поверх сцены.
    this._renderDiagnostics();
  }

  _updateHud() {
    if (!this._hud) return;
    const show = this.config.showHud;
    this._hud.style.display = show ? "" : "none";
    if (show) {
      if (!this._hudTitle) {
        this._hudTitle = document.createElement("div");
        this._hudTitle.className = "t3d-hud-title";
        this._hud.insertBefore(this._hudTitle, this._hudSub);
      }
      const title = this.config.title;
      this._hudTitle.textContent = title || "";
      this._hudTitle.style.display = title ? "" : "none";
    }
    // (T-018) заголовок мог стать длиннее (или HUD скрыли) — панель
    // диагностики пересчитывает своё место от новой высоты верхней полосы.
    if (this._diagVisible) this._placeDiagnostics();
  }

  /** Подпись под заголовком в HUD (используется моделями и демо-режимом). */
  setHudSub(text) {
    this._hudSubText = text;
    if (this._hudSub) this._hudSub.textContent = text || "";
  }

  /** Заголовок карточки (legacy-движки читают его у себя, см. ModelHost). */
  get title() {
    return this.config.title;
  }

  _setStatus(text) {
    this._statusText = text;
    this._renderStatus();
  }

  _renderStatus() {
    if (!this._status) return;
    const text = this._statusText || "";
    this._status.textContent = text;
    this._status.style.display = text ? "" : "none";
    if (text) this._status.classList.toggle("t3d-status-error", /ошиб|не удалось|недоступ/i.test(text));
  }

  /** Показать кнопки управления под сценой (кнопки модели). */
  setActions(buttons) {
    if (!this._actions) return;
    this._actions.innerHTML = "";
    const list = buttons || [];
    this._actions.style.display = list.length ? "" : "none";
    for (const b of list) {
      const btn = document.createElement("button");
      btn.className = "t3d-btn";
      btn.type = "button";
      btn.textContent = b.label;
      btn.title = b.title || b.label;
      btn.addEventListener("click", (e) => { e.stopPropagation(); b.onClick && b.onClick(); });
      this._actions.appendChild(btn);
    }
  }

  /** Отчёт о качестве привязок (диагностика). */
  diagnostics() {
    const { rows, errors, warnings } = validateBindings(this.config.entities, this.schema, this.hass && this.hass.states);
    const manifest = this.model ? this.model.manifest : { id: "(сцена освобождена)", name: "—" };
    return { rows, errors, warnings, log: this._log || [], model: manifest, version: CARD_VERSION };
  }

  setDiagnosticsVisible(v) {
    // Флаг хранится и тогда, когда панели ещё нет: оверлей строится в
    // _buildOverlay() и сразу получает нужное состояние (T-018).
    this._diagVisible = !!v;
    this._renderDiagnostics();
  }

  _renderDiagnostics() {
    if (!this._diag) return;
    if (!this._diagVisible) { this._diag.style.display = "none"; return; }
    const d = this.diagnostics();
    this._diag.style.display = "";
    // (T-018) панель показывается ниже надписей верхней полосы карточки.
    this._placeDiagnostics();
    const icon = d.errors.length ? "⛔" : d.warnings.length ? "⚠️" : "✅";
    this._diag.innerHTML =
      `<div class="t3d-diag-title">${icon} ${esc(d.model.name)} · v${esc(d.version)}</div>` +
      d.rows.map((r) => {
        const mark = r.level === "ok" ? "●" : r.level === "warn" ? "▲" : r.level === "error" ? "✕" : "○";
        return `<div class="t3d-diag-row t3d-diag-${r.level}">` +
          `<span class="t3d-diag-mark">${mark}</span>` +
          `<span class="t3d-diag-name">${esc(r.name)}</span>` +
          `<span class="t3d-diag-entity">${esc(r.entity || "—")}</span>` +
          `<span class="t3d-diag-msg">${esc(r.message)}</span></div>`;
      }).join("") +
      (d.log.length ? `<div class="t3d-diag-log">${d.log.map((l) => esc(l)).join("<br>")}</div>` : "");
  }

  /**
   * (T-018) Поставить панель диагностики ниже надписей верхней полосы карточки,
   * чтобы она никогда их не перекрывала: под ней не должно оставаться ни HUD
   * карточки, ни собственного HUD модели (у host: "external" он свой DOM-слой,
   * например подпись «— · 3 200 mV» у бака).
   *
   * Верх считается по измеренной нижней границе этих надписей; когда измерить
   * нечего (HUD скрыт, вёрстка ещё не посчитана, нет getBoundingClientRect),
   * остаётся CSS-значение `.t3d-diag { top: 12px }` — панель выше, но в этой
   * полосе надписей и нет.
   */
  _placeDiagnostics() {
    const diag = this._diag;
    if (!diag) return;
    const bottom = this._topStripBottom();
    if (!bottom) {
      diag.style.top = "";
      diag.style.maxHeight = "";
      return;
    }
    const top = Math.round(bottom + DIAG_GAP);
    diag.style.top = `${top}px`;
    // Низким карточкам оставляем снизу тот же отступ, что и в CSS (12px).
    const height = this.container.clientHeight || 0;
    diag.style.maxHeight = height ? `calc(100% - ${top + 12}px)` : "";
  }

  /**
   * Нижняя граница видимых надписей в верхней полосе контейнера (T-018):
   * берутся небольшие блоки, начинающиеся у верхней кромки, а полноэкранные
   * слои (канвас, `.t3d-overlay`, слои моделей) и сама панель пропускаются.
   * Возвращает 0, если измерить нечего.
   */
  _topStripBottom() {
    const container = this.container;
    const base = container && container.getBoundingClientRect ? container.getBoundingClientRect() : null;
    if (!base || !base.height) return 0;
    const nodes = container.querySelectorAll ? container.querySelectorAll("*") : [];
    let bottom = 0;
    for (const node of nodes) {
      if (node === this._diag || (this._diag && this._diag.contains && this._diag.contains(node))) continue;
      if (typeof node.getBoundingClientRect !== "function") continue;
      const rect = node.getBoundingClientRect();
      const height = rect.height || 0;
      if (!height || height > base.height / 2) continue;         // полноэкранные слои
      const top = (rect.top || 0) - (base.top || 0);
      if (top < 0 || top > DIAG_TOP_BAND) continue;              // не верхняя полоса
      bottom = Math.max(bottom, top + height);
    }
    return bottom;
  }

  _report(level, message) {
    this._log = this._log || [];
    const line = `${level}: ${message}`;
    if (this._log[this._log.length - 1] !== line) this._log.push(line);
    if (this._log.length > 40) this._log.shift();
    if (this._diagVisible) this._renderDiagnostics();
  }

  _reportError(where, e) {
    this._report("error", `${where}: ${e && e.message ? e.message : e}`);
    if (window.console && console.warn) console.warn(`[threejs-3d-card] ${where}`, e);
  }

  // ---- модальное окно сущности --------------------------------------------

  _renderModal() {
    const modal = this._modal;
    if (!modal) return;
    const entityId = this.openEntity;
    if (!entityId) { modal.style.display = "none"; modal.innerHTML = ""; return; }

    const state = this.hass && this.hass.states ? this.hass.states[entityId] : this.bus.get(entityId);
    const domain = entityId.split(".")[0];
    const binding = this.schema.bindings.find((b) => b.key === this.openKey);
    const rows = [];

    if (state) {
      rows.push(["Состояние", prettyState(state)]);
      if (state.attributes && state.attributes.unit_of_measurement) {
        rows.push(["Значение", stateWithUnit(state)]);
      }
      const skip = new Set(["friendly_name", "icon", "unit_of_measurement", "device_class", "editable", "supported_features"]);
      for (const [k, v] of Object.entries(state.attributes || {})) {
        if (skip.has(k) || v === null || v === undefined || v === "" || typeof v === "object") continue;
        rows.push([attrLabel(k), String(v)]);
      }
      rows.push(["Изменено", formatTime(state.last_changed)]);
    }

    const controls = this._modalControls(domain, entityId, state);

    modal.style.display = "";
    modal.innerHTML =
      `<div class="t3d-modal" role="dialog" aria-modal="true">` +
        `<div class="t3d-modal-head">` +
          `<div class="t3d-modal-title">${esc((state && state.attributes && state.attributes.friendly_name) || entityId)}</div>` +
          `<button class="t3d-modal-close" type="button" aria-label="Закрыть">✕</button>` +
        `</div>` +
        `<div class="t3d-modal-entity">${esc(entityId)}${binding ? ` · <span class="t3d-dim">${esc(binding.name)}</span>` : ""}</div>` +
        (domain ? `<div class="t3d-modal-domain">${esc(DOMAIN_LABELS[domain] || domain)}</div>` : "") +
        (state
          ? `<table class="t3d-modal-table">${rows.map(([k, v]) =>
              `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>`
          : `<div class="t3d-modal-missing">Сущность не найдена или недоступна. Проверьте привязку в настройках карточки.</div>`) +
        (controls.length ? `<div class="t3d-modal-actions">${controls.map((c) => c.html).join("")}</div>` : "") +
        `<div class="t3d-modal-foot">` +
          `<button class="t3d-btn t3d-btn-primary" data-act="open" type="button">Открыть в Home Assistant</button>` +
        `</div>` +
      `</div>`;

    modal.querySelector(".t3d-modal-close").addEventListener("click", () => this.closeModal());
    modal.addEventListener("click", (e) => { if (e.target === modal) this.closeModal(); });
    const open = modal.querySelector('[data-act="open"]');
    open && open.addEventListener("click", () => this.openInHomeAssistant(entityId));

    controls.forEach((c) => {
      const el = modal.querySelector(`[data-ctl="${c.id}"]`);
      if (!el) return;
      el.addEventListener("click", () => c.onClick && c.onClick(el));
      if (c.onInput) el.addEventListener("input", () => c.onInput(el));
      if (c.onChange) el.addEventListener("change", () => c.onChange(el));
    });
  }

  /** Кнопки управления сущностью внутри модалки (стандартные домены HA). */
  _modalControls(domain, entityId, state) {
    const out = [];
    const isOn = state && ["on", "open", "playing"].includes(String(state.state).toLowerCase());
    const svc = (d, s, data) => () => this.callService(d, s, Object.assign({ entity_id: entityId }, data || {}));

    if (["switch", "input_boolean", "fan", "light", "automation", "script", "siren", "humidifier"].includes(domain)) {
      if (domain === "script" || domain === "automation") {
        out.push({
          id: "run", html: `<button class="t3d-btn" data-ctl="run" type="button">Запустить</button>`,
          onClick: svc(domain, domain === "script" ? "turn_on" : "trigger"),
        });
        if (domain === "automation") {
          out.push({
            id: "toggle", html: `<button class="t3d-btn" data-ctl="toggle" type="button">${isOn ? "Выключить" : "Включить"}</button>`,
            onClick: svc("automation", isOn ? "turn_off" : "turn_on"),
          });
        }
      } else {
        out.push({
          id: "toggle",
          html: `<button class="t3d-btn ${isOn ? "" : "t3d-btn-primary"}" data-ctl="toggle" type="button">${isOn ? "Выключить" : "Включить"}</button>`,
          onClick: svc(domain, isOn ? "turn_off" : "turn_on"),
        });
        if (domain === "light" && isOn) {
          const pct = Math.round((((state.attributes || {}).brightness_pct) ?? 100));
          out.push({
            id: "brightness",
            html: `<label class="t3d-ctl-slider">Яркость <input type="range" min="1" max="100" value="${pct}" data-ctl="brightness"></label>`,
            onChange: (el) => this.callService("light", "turn_on", { entity_id: entityId, brightness_pct: Number(el.value) }),
          });
        }
      }
    }

    if (domain === "cover") {
      out.push({ id: "open", html: `<button class="t3d-btn" data-ctl="open" type="button">Открыть</button>`, onClick: svc("cover", "open_cover") });
      out.push({ id: "stop", html: `<button class="t3d-btn" data-ctl="stop" type="button">Стоп</button>`, onClick: svc("cover", "stop_cover") });
      out.push({ id: "close", html: `<button class="t3d-btn" data-ctl="close" type="button">Закрыть</button>`, onClick: svc("cover", "close_cover") });
    }

    if (domain === "lock") {
      out.push({ id: "unlock", html: `<button class="t3d-btn" data-ctl="unlock" type="button">Открыть</button>`, onClick: svc("lock", "unlock") });
      out.push({ id: "lock", html: `<button class="t3d-btn" data-ctl="lock" type="button">Заблокировать</button>`, onClick: svc("lock", "lock") });
    }

    if (domain === "climate" && state) {
      const modes = (state.attributes && state.attributes.hvac_modes) || [];
      const cur = String(state.state).toLowerCase();
      modes.slice(0, 6).forEach((m) => {
        out.push({
          id: `mode-${m}`,
          html: `<button class="t3d-btn ${m === cur ? "t3d-btn-primary" : ""}" data-ctl="mode-${m}" type="button">${esc(modeLabel(m))}</button>`,
          onClick: svc("climate", "set_hvac_mode", { hvac_mode: m }),
        });
      });
      const temp = (state.attributes || {}).temperature;
      if (Number.isFinite(temp)) {
        out.push({
          id: "temp-down",
          html: `<button class="t3d-btn" data-ctl="temp-down" type="button">−1°</button>`,
          onClick: svc("climate", "set_temperature", { temperature: Math.round((temp - 1) * 2) / 2 }),
        });
        out.push({
          id: "temp-up",
          html: `<button class="t3d-btn" data-ctl="temp-up" type="button">+1°</button>`,
          onClick: svc("climate", "set_temperature", { temperature: Math.round((temp + 1) * 2) / 2 }),
        });
      }
    }

    if (domain === "button") {
      out.push({ id: "press", html: `<button class="t3d-btn" data-ctl="press" type="button">Нажать</button>`, onClick: svc("button", "press") });
    }

    return out;
  }

  closeModal() {
    this.openEntity = null;
    this.openKey = null;
    if (this._modal) {
      this._modal.style.display = "none";
      this._modal.innerHTML = "";
    }
  }

  /** Перейти к сущности в интерфейсе Home Assistant. */
  openInHomeAssistant(entityId) {
    if (this.onDeepLink) { this.onDeepLink(entityId); return; }
    const ev = new CustomEvent("hass-more-info", {
      detail: { entityId },
      bubbles: true,
      composed: true,
    });
    this.container.dispatchEvent(ev);
  }

  async callServiceAsync(domain, service, data) {
    if (this.hass && this.hass.callService) {
      return this.hass.callService(domain, service, data || {});
    }
    if (this.onService) return this.onService(domain, service, data || {});
    throw new Error("callService недоступен: карточка не получила объект hass");
  }

  /** Универсальный конструктор спрайта-подписи (используется моделями). */
  makeLabel(text, o = {}) {
    const T = this.THREE;
    const canvas = document.createElement("canvas");
    const sprite = new T.Sprite(new T.SpriteMaterial({ depthTest: false, transparent: true }));
    sprite.userData.redraw = (txt) => this._drawLabel(canvas, sprite, txt, o);
    sprite.userData.redraw(text == null ? "" : String(text));
    sprite.renderOrder = 10;
    return sprite;
  }

  _drawLabel(canvas, sprite, text, o) {
    const T = this.THREE;
    const pad = 12;
    const fs = o.fontSize || 30;
    const font = `${o.weight || 600} ${fs}px ${o.font || "system-ui, sans-serif"}`;
    const measure = canvas.getContext("2d");
    measure.font = font;
    const w = Math.ceil(measure.measureText(text).width) + pad * 2;
    const h = Math.ceil(fs * 1.35) + pad;
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext("2d");
    c.clearRect(0, 0, w, h);
    if (o.background) {
      c.fillStyle = o.background;
      c.fillRect(0, 0, w, h);
    } else if (o.bg !== false) {
      c.fillStyle = o.bg || "rgba(8,12,18,0.68)";
      roundRectPath(c, 1, 1, w - 2, h - 2, 10);
      c.fill();
      c.strokeStyle = o.border || "rgba(120,160,210,0.35)";
      c.lineWidth = 2;
      c.stroke();
    }
    c.fillStyle = o.fg || "#e8f0fa";
    c.font = font;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, w / 2, h / 2 + 1);

    const tex = new T.CanvasTexture(canvas);
    if ("colorSpace" in tex) tex.colorSpace = T.SRGBColorSpace;
    if (sprite.material.map) sprite.material.map.dispose();
    sprite.material.map = tex;
    sprite.material.needsUpdate = true;
    const scale = o.scale || 0.0045;
    sprite.scale.set(w * scale, h * scale, 1);
  }

  // ---- освобождение --------------------------------------------------------

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    // Камерные жесты: модуль сам снимает все свои слушатели с канваса.
    if (this._camControls) {
      try { this._camControls.dispose(); } catch (e) { /* ignore */ }
      this._camControls = null;
    }
    const external = !!(this._modelHandle && this._modelHandle.external);
    try { if (this._io) this._io.disconnect(); } catch (e) { /* ignore */ }
    try { if (this._ro) this._ro.disconnect(); } catch (e) { /* ignore */ }
    window.removeEventListener("resize", this._onWinResize);
    if (this._onVis) document.removeEventListener("visibilitychange", this._onVis);
    for (const off of this._listeners) { try { off(); } catch (e) { /* ignore */ } }
    this._listeners = [];

    if (this._modelHandle && this._modelHandle.dispose) {
      try { this._modelHandle.dispose(); } catch (e) { this._reportError("dispose модели", e); }
    }
    if (this.scene) disposeObject(this.scene);

    // Рендерер освобождаем только если его создали мы сами: в external-режиме
    // он принадлежит модели (обычно готовому стороннему движку).
    if (!external && this.renderer) {
      try { this.renderer.dispose(); } catch (e) { /* ignore */ }
      // Контекст освобождаем сразу: канвас этой сцены больше не используется,
      // а браузер разрешает лишь несколько WebGL-контекстов на страницу.
      if (this.renderer.forceContextLoss) {
        try { this.renderer.forceContextLoss(); } catch (e) { /* ignore */ }
      }
    }
    this._modelHandle = null;
    this.scene = null;
    this.renderer = null;
    this.camera = null;
  }

  /** Полная очистка DOM (используется карточкой при отключении). */
  disposeDom() {
    if (this._overlay && this._overlay.parentNode) this._overlay.parentNode.removeChild(this._overlay);
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }
}

// ---- вспомогательное --------------------------------------------------------

function numberOr(v, fallback) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function findUserData(obj, field) {
  let cur = obj;
  while (cur) {
    if (cur.userData && cur.userData[field]) return cur.userData[field];
    cur = cur.parent;
  }
  return null;
}

function roundRectPath(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Освободить геометрии, материалы и текстуры поддерева. */
export function disposeObject(root) {
  if (!root || !root.traverse) return;
  const geoms = new Set();
  const mats = new Set();
  const texs = new Set();
  root.traverse((n) => {
    if (n.geometry) geoms.add(n.geometry);
    const list = Array.isArray(n.material) ? n.material : (n.material ? [n.material] : []);
    for (const m of list) {
      mats.add(m);
      for (const k of Object.keys(m)) {
        const v = m[k];
        if (v && v.isTexture) texs.add(v);
      }
    }
  });
  for (const t of texs) { try { t.dispose(); } catch (e) { /* ignore */ } }
  for (const m of mats) { try { m.dispose(); } catch (e) { /* ignore */ } }
  for (const g of geoms) { try { g.dispose(); } catch (e) { /* ignore */ } }
}

const ATTR_LABELS = {
  brightness: "Яркость",
  brightness_pct: "Яркость, %",
  color_temp: "Цветовая температура",
  color_temp_kelvin: "Цветовая температура, K",
  rgb_color: "Цвет RGB",
  current_temperature: "Текущая температура",
  temperature: "Целевая температура",
  target_temp_step: "Шаг температуры",
  hvac_action: "Текущее действие",
  hvac_modes: "Режимы",
  fan_mode: "Режим вентилятора",
  swing_mode: "Качание",
  battery_level: "Батарея",
  battery: "Батарея",
  device_class: "Класс устройства",
  state_class: "Класс состояния",
  last_reset: "Сброс",
  power: "Мощность",
  voltage: "Напряжение",
  current: "Ток",
  percentage: "Позиция, %",
  current_position: "Позиция, %",
  media_title: "Композиция",
  source: "Источник",
  volume_level: "Громкость",
  entity_picture: "Изображение",
  options: "Варианты",
  min: "Минимум",
  max: "Максимум",
  step: "Шаг",
  mode: "Режим",
  preset_mode: "Пресет",
};

function attrLabel(key) {
  return ATTR_LABELS[key] || key.replace(/_/g, " ");
}

function modeLabel(mode) {
  const map = {
    off: "Выкл", heat: "Нагрев", cool: "Охлажд.", heat_cool: "Авто", auto: "Авто",
    dry: "Осушение", fan_only: "Обдув", fan: "Обдув",
  };
  return map[String(mode).toLowerCase()] || mode;
}

function formatTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (e) {
    return String(iso);
  }
}
