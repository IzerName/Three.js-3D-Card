// ============================================================================
//  <threejs-3d-card-editor> — визуальный редактор карточки.
//
//  Форма строится АВТОМАТИЧЕСКИ из описания модели:
//    * выбор модели — встроенная (registry) или импорт по URL;
//    * поля привязок (bindings) — штатный ha-entity-picker с фильтром
//      по домену/классу устройства/единице измерения;
//    * настройки параметров модели (params) — number/range/color/boolean/select;
//    * общие настройки: заголовок, высота, HUD, диагностика;
//    * проверка привязок «на живых данных» (hass.states).
//
//  Редактор ничего не знает про конкретную сцену: чтобы добавить новую
//  модель, достаточно описать её bindings/params.
// ============================================================================

import { registry, listBuiltin } from "./core/registry.js";
import {
  normalizeBindings, normalizeParams, groupBindings, validateBindings, readValue,
} from "./core/bindings.js";
import { prettyState, stateWithUnit, isAvailable } from "./core/state.js";
import { mergeEditorBindings } from "./core/gltf-extras.js";
import { esc } from "./core/util.js";
import { buildStubConfig } from "./core/stub.js";
import { CARD_VERSION, API_VERSION, THREE_MODE } from "./core/constants.js";

/** Элементы формы, которые HA создаёт сам. */
const HA_ENTITY_PICKER = "ha-entity-picker";

export class ThreeDModelCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._model = null;
    this._modelLoading = false;
    this._rows = [];
    this._builtin = [];
    this._root = null;
    this._rendered = false;
    this._renderedKey = "";
    this._schemaVersion = 0;
    this._manualEntity = new Set(); // ключи, для которых включён ручной ввод
  }

  // ---- входные данные ------------------------------------------------------

  setConfig(config) {
    const next = Object.assign({}, config || {});
    if (!next.model) next.model = "water-tank";
    this._config = next;
    // Форму перерисовываем ТОЛЬКО если изменилось то, что она показывает.
    // HA присылает редактору назад его же конфиг после каждого
    // config-changed (и при каждом обновлении hass): полная перерисовка
    // (innerHTML = "") уничтожала поле вместе с фокусом — ввод срывался
    // после первого же символа.
    this._renderIfNeeded();
    this._loadModel();
  }

  get config() {
    return this._config;
  }

  // HA передаёт hass в элемент конфигурации карточки автоматически,
  // если у него объявлен этот сеттер — именно это даёт ha-entity-picker
  // список сущностей пользователя.
  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      // Без hass не создать ha-entity-picker — форму собираем заново.
      this._renderIfNeeded(true);
    } else {
      this._refreshStates();
    }
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    if (!this._root) this._renderIfNeeded(true);
    this._loadBuiltin();
  }

  // ---- загрузка моделей ----------------------------------------------------

  async _loadBuiltin() {
    if (this._builtin.length) return;
    try {
      this._builtin = await listBuiltin();
      this._renderIfNeeded();
    } catch (e) {
      console.warn("[threejs-3d-card] список встроенных моделей недоступен", e);
    }
  }

  async _loadModel() {
    const id = this._config.model;
    if (!id) return;
    if (this._model && this._model.manifest.id === id) return;
    this._modelLoading = true;
    this._discovering = false;
    this._extrasNotes = null;
    this._renderIfNeeded(true);
    try {
      this._model = await registry.resolve(id, {
        force: !!this._config.reload_model,
        allowExternal: this._config.allow_external_models !== false,
      });
      this._modelError = null;
      // У модели другая схема привязок и параметров — форма строится заново.
      this._schemaVersion = (this._schemaVersion || 0) + 1;
      // T-012: у модели привязки из extras файла — читаем файл ДО показа
      // формы (без сцены, без three.js). Нечитаемый файл — предупреждение
      // в блоке привязок, а не молча пустые поля.
      if (this._model && typeof this._model.discoverBindings === "function") {
        this._discovering = true;
        this._renderIfNeeded(true);
        let disc = { bindings: [], warnings: [] };
        try {
          disc = await this._model.discoverBindings(this._discoverCtx());
        } catch (e) {
          disc = { bindings: [], warnings: [e && e.message ? e.message : String(e)] };
        }
        this._extrasNotes = (disc.warnings && disc.warnings.length) ? disc.warnings : null;
        if (disc.bindings && disc.bindings.length) {
          this._model.bindings = mergeEditorBindings(this._model.bindings, disc.bindings);
          // Автозаполнение: пометка объявила entity_id, а пользователь
          // ничего не выбирал — подставляем; его выбор всегда приоритетнее.
          const cur = Object.assign({}, this._config.entities || {});
          let changed = false;
          for (const b of disc.bindings) {
            if (b.entity && !cur[b.key]) { cur[b.key] = b.entity; changed = true; }
          }
          if (changed) this._patch({ entities: cur });
        }
      }
    } catch (e) {
      this._model = null;
      this._modelError = e && e.message ? e.message : String(e);
    }
    this._modelLoading = false;
    this._discovering = false;
    // Модель загружена (или не загрузилась) — показываем форму целиком.
    this._renderIfNeeded(true);
    this._refreshStates();
  }

  /**
   * T-012: ctx для discoverBindings — тот же контракт, что контекст сцены
   * (см. src/core/scene.js): asset().
   */
  _discoverCtx() {
    return {
      asset: (rel) => {
        const raw = (this._model && this._model._sourceUrl) || "";
        const base = /^https?:\/\//i.test(raw) || raw.startsWith("/") || raw.startsWith("./")
          ? raw
          : (typeof document !== "undefined" ? document.baseURI : undefined);
        try { return new URL(rel, base).href; } catch (e) { return rel; }
      },
      fetch: undefined,
    };
  }

  // ---- рендер --------------------------------------------------------------

  /**
   * Отпечаток того, ЧТО показывает форма (значения полей).
   *
   * Home Assistant присылает редактору назад тот же конфиг, который тот только
   * что отдал (hui-element-editor: `_handleUIConfigChanged` → `value` →
   * `setConfig`), и делает это на каждое изменение и на каждое обновление hass.
   * Редактор обязан быть идемпотентным: полная перерисовка (`innerHTML = ""`)
   * уничтожает поле вместе с фокусом, поэтому при неизменном отпечатке форму
   * не трогаем — иначе после первого же символа ввод срывается.
   */
  _formKey(cfg) {
    const c = cfg || {};
    return canonicalJson({
      model: c.model,
      model_url: c.model_url,
      reload_model: c.reload_model,
      title: c.title,
      height: c.height,
      show_hud: c.show_hud,
      show_diagnostics: c.show_diagnostics,
      allow_external_models: c.allow_external_models,
      entities: c.entities || {},
      params: c.params || {},
      camera: c.camera,
    });
  }

  /** Отпечаток того, КАКИЕ поля есть в форме (структура, а не значения). */
  _structureKey() {
    const c = this._config || {};
    return [
      c.model || "",
      this._schemaVersion || 0,
      this._modelLoading ? "loading" : "",
      this._discovering ? "discovering" : "",
      this._modelError || "",
      (this._extrasNotes || []).join("|"),
      this._builtin.map((m) => (m.manifest ? m.manifest.id : "")).join(","),
      isUrl(c.model) ? "url" : "",
      [...this._manualEntity].sort().join(","),
    ].join("§");
  }

  /**
   * Перерисовать форму, только если изменилось то, что она показывает.
   * @param {boolean} [force] перерисовать безусловно (новое hass, смена модели)
   * @returns {boolean} рисовали ли заново
   */
  _renderIfNeeded(force = false) {
    if (!this._config) return false;
    const key = this._key();
    if (!force && this._rendered && key === this._renderedKey) return false;
    const drew = this._render();
    if (drew) this._renderedKey = this._key();
    return drew;
  }

  /** Текущий отпечаток формы (структура + значения). */
  _key() {
    return `${this._structureKey()}§${this._formKey(this._config)}`;
  }

  _render() {
    // connectedCallback вызывает _render() до setConfig — рисовать нечего.
    if (!this._config) return false;
    if (!this.isConnected && this._rendered) return false;
    const shadow = this.shadowRoot || (this.attachShadow ? this.attachShadow({ mode: "open" }) : null);
    this._shadow = shadow;
    const host = shadow || this;
    if (!this._root) {
      if (shadow) {
        const style = document.createElement("style");
        style.textContent = EDITOR_CSS;
        shadow.appendChild(style);
      }
      this._root = document.createElement("div");
      this._root.className = "t3d-editor";
      host.appendChild(this._root);
    }
    this._rendered = true;

    const c = this._config;
    const root = this._root;
    root.innerHTML = "";

    // --- блок модели ---
    const modelBlock = el("div", "t3d-ed-block");
    modelBlock.appendChild(el("div", "t3d-ed-h", "Модель 3D-сцены"));

    const select = document.createElement("select");
    select.className = "t3d-ed-input";
    const options = this._builtin.length ? this._builtin.map((m) => m.manifest) : [];
    const known = new Set(options.map((o) => o.id));
    if (c.model && !known.has(c.model) && !isUrl(c.model)) {
      options.push({ id: c.model, name: `${c.model} (не найдена)` });
    }
    if (isUrl(c.model)) {
      options.push({ id: c.model, name: `${shortUrl(c.model)} (внешняя)` });
    }
    for (const m of options) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.name || m.id;
      if (m.id === c.model) o.selected = true;
      select.appendChild(o);
    }
    const urlOption = document.createElement("option");
    urlOption.value = "__url__";
    urlOption.textContent = "Импортировать модель по URL…";
    if (isUrl(c.model)) urlOption.selected = true;
    select.appendChild(urlOption);

    select.addEventListener("change", () => {
      if (select.value === "__url__") {
        this._patch({ model: this._config.model_url || "/local/3d-models/my-model.js", model_url: this._config.model_url || "/local/3d-models/my-model.js" });
        this._loadModel();
        return;
      }
      this._patch({ model: select.value, model_url: undefined, reload_model: undefined });
      this._model = null;
      this._loadModel();
    });
    modelBlock.appendChild(field("Модель", select, this._model ? modelDesc(this._model) : null));

    // --- поле URL внешней модели ---
    if (isUrl(c.model) || select.value === "__url__") {
      const urlInput = input("text", c.model_url || (isUrl(c.model) ? c.model : ""), "/local/3d-models/my-model.js", true);
      const loadBtn = document.createElement("button");
      loadBtn.className = "t3d-ed-btn";
      loadBtn.type = "button";
      loadBtn.textContent = "Загрузить";
      const applyUrl = () => {
        const url = urlInput.value.trim();
        if (!url) return;
        this._patch({ model: url, model_url: url, reload_model: true });
        this._model = null;
        this._loadModel();
      };
      loadBtn.addEventListener("click", applyUrl);
      urlInput.addEventListener("change", applyUrl);
      const box = el("div", "t3d-ed-row-inline");
      box.appendChild(urlInput);
      box.appendChild(loadBtn);
      modelBlock.appendChild(field(
        "URL модели",
        box,
        "Файлы моделей лежат на сервере Home Assistant в config/www/3d-models " +
        "(URL — /local/3d-models/, положить файлы можно через Samba, File editor, SSH " +
        "или Studio Code Server). В поле указывается путь к коду модели .js — он должен " +
        "вызвать window.ThreeJS3DCard.defineModel({…}), см. docs/MODEL_API.md — либо к " +
        "спецификации .json. Геометрия (.glb/.gltf, .obj + .mtl, текстуры) кладётся рядом " +
        "и прописывается внутри спецификации относительным путём: напрямую .glb/.obj в " +
        "этом поле не поддерживается — файл без расширения .json исполняется как код."
      ));
    }

    if (this._modelLoading) {
      modelBlock.appendChild(el("div", "t3d-ed-note",
        this._discovering ? "Модель загружена — читаю привязки из файла модели…" : "Загрузка модели…"));
    } else if (this._modelError) {
      modelBlock.appendChild(el("div", "t3d-ed-note t3d-ed-error", `Не удалось загрузить модель: ${this._modelError}`));
    } else if (this._model) {
      const m = this._model.manifest;
      modelBlock.appendChild(el("div", "t3d-ed-note",
        `${m.name} · ${m.id} · API v${m.apiVersion}${m.description ? " · " + m.description : ""}`));
    }
    root.appendChild(modelBlock);

    // --- общие настройки ---
    const baseBlock = el("div", "t3d-ed-block");
    baseBlock.appendChild(el("div", "t3d-ed-h", "Оформление и поведение"));

    const titleInput = input("text", c.title || "", (this._model && this._model.manifest.name) || "3D-сцена", false);
    titleInput.addEventListener("input", () => this._patch({ title: titleInput.value }));
    baseBlock.appendChild(field("Заголовок (пусто — скрыть)", titleInput));

    const heightInput = input("number", c.height !== undefined ? c.height : "", "авто");
    heightInput.type = "number";
    heightInput.min = "140";
    heightInput.step = "20";
    heightInput.addEventListener("input", () => {
      const v = parseFloat(heightInput.value);
      this._patch({ height: Number.isFinite(v) ? v : undefined });
    });
    baseBlock.appendChild(field("Высота, px", heightInput,
      "Пусто — карточка занимает всю доступную высоту (рекомендуется): в разделе — клетку сетки, "
      + "в «кирпичной» раскладке — рекомендованную моделью высоту. Число задаёт фиксированную высоту в пикселях."));

    const checks = el("div", "t3d-ed-checks");
    checks.appendChild(checkbox("Показывать заголовок (HUD)", c.show_hud !== false, (v) => this._patch({ show_hud: v })));
    checks.appendChild(checkbox("Диагностика привязок", !!c.show_diagnostics, (v) => this._patch({ show_diagnostics: v })));
    checks.appendChild(checkbox("Разрешить импорт внешних моделей", c.allow_external_models !== false,
      (v) => this._patch({ allow_external_models: v })));
    baseBlock.appendChild(checks);
    root.appendChild(baseBlock);

    // --- привязки сущностей ---
    if (this._model) {
      const schema = {
        bindings: normalizeBindings(this._model.bindings),
        params: normalizeParams(this._model.params),
      };
      this._schema = schema;
      this._entities = Object.assign({}, c.entities || {});
      this._params = Object.assign({}, c.params || {});

      const bindBlock = el("div", "t3d-ed-block");
      bindBlock.appendChild(el("div", "t3d-ed-h", "Устройства и параметры"));
      bindBlock.appendChild(el("div", "t3d-ed-sub",
        "Каждое поле — переменная модели. Выберите сущность Home Assistant; в скобках указан ожидаемый домен."));

      const groups = groupBindings(schema.bindings);
      for (const g of groups) {
        if (g.name) bindBlock.appendChild(el("div", "t3d-ed-group", g.name));
        for (const b of g.items) bindBlock.appendChild(this._bindingRow(b));
      }

      // T-012: замечания о привязках из extras файла модели (неизвестные
      // действия, пометки без действий, проблемы с чтением файла).
      for (const w of this._extrasNotes || []) {
        bindBlock.appendChild(el("div", "t3d-ed-note", w));
      }

      // Внешний вид камеры/окружения — только если модель это поддерживает
      const camBlock = this._cameraBlock();
      if (camBlock) bindBlock.appendChild(camBlock);

      root.appendChild(bindBlock);

      // --- параметры модели ---
      if (schema.params.length) {
        const paramBlock = el("div", "t3d-ed-block");
        paramBlock.appendChild(el("div", "t3d-ed-h", "Настройки модели"));
        for (const p of schema.params) paramBlock.appendChild(this._paramRow(p));
        root.appendChild(paramBlock);
      }

      // --- сводка привязок ---
      const summary = el("div", "t3d-ed-block");
      summary.appendChild(el("div", "t3d-ed-h", "Проверка привязок"));
      this._summaryEl = el("div", "t3d-ed-summary");
      summary.appendChild(this._summaryEl);
      root.appendChild(summary);
    } else if (!this._modelLoading) {
      const note = el("div", "t3d-ed-block");
      note.appendChild(el("div", "t3d-ed-sub", "Выберите модель, чтобы настроить привязки устройств."));
      root.appendChild(note);
    }

    const foot = el("div", "t3d-ed-foot",
      `threejs-3d-card v${CARD_VERSION} · API модели v${API_VERSION} · three.js: ${THREE_MODE === "bundled" ? "локально" : "CDN"}`);
    root.appendChild(foot);

    this._refreshStates();
    return true;
  }

  /** Строка привязки: ha-entity-picker + (опционально) ручной ввод. */
  _bindingRow(binding) {
    const wrap = el("div", "t3d-ed-field");
    const label = el("label", "t3d-ed-label");
    label.innerHTML = `${esc(binding.name)}${binding.required ? ' <span class="t3d-ed-req">обязательно</span>' : ""}`;
    wrap.appendChild(label);

    const current = this._entities[binding.key] || "";
    const manual = this._manualEntity.has(binding.key);
    const picker = this._makePicker(binding, current, manual);
    wrap.appendChild(picker);

    if (binding.hint || binding.domain.length) {
      const meta = [];
      if (binding.domain.length) meta.push(`домен: ${binding.domain.join(", ")}`);
      if (binding.deviceClass.length) meta.push(`класс: ${binding.deviceClass.join(", ")}`);
      if (binding.unit.length) meta.push(`единица: ${binding.unit.join(", ")}`);
      wrap.appendChild(el("div", "t3d-ed-hint", [binding.hint, meta.join(" · ")].filter(Boolean).join(" — ")));
    }

    const stateLine = el("div", "t3d-ed-state");
    stateLine.dataset.key = binding.key;
    wrap.appendChild(stateLine);

    // Дополнительно: выбор конкретного атрибута
    if (binding.value && binding.value.kind === "attribute") {
      const attrInput = input("text", (binding.value && binding.value.param) || "", "например battery_level", true);
      attrInput.addEventListener("change", () => {
        this._setBindingValueParam(binding.key, attrInput.value.trim());
      });
      wrap.appendChild(field("Атрибут сущности", attrInput));
    }
    return wrap;
  }

  /** Создать ha-entity-picker (нативный компонент HA) или резервный input. */
  _makePicker(binding, value, manual) {
    const domains = binding.domain || [];
    const pickerOpts = binding.picker || {};

    if (manual || !customElements.get(HA_ENTITY_PICKER)) {
      // Резерв: обычное поле ввода (старые версии HA или ручной режим)
      const box = el("div", "t3d-ed-row-inline");
      const i = input("text", value, "sensor.example", true);
      i.addEventListener("change", () => this._setEntity(binding.key, i.value.trim()));
      box.appendChild(i);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "t3d-ed-btn";
      toggle.textContent = "Список";
      toggle.title = "Выбирать из списка сущностей";
      toggle.addEventListener("click", () => {
        this._manualEntity.delete(binding.key);
        this._renderIfNeeded(true);
      });
      if (customElements.get(HA_ENTITY_PICKER)) box.appendChild(toggle);
      return box;
    }

    const picker = document.createElement(HA_ENTITY_PICKER);
    picker.hass = this._hass;
    picker.value = value || "";
    picker.label = "";
    if (domains.length) picker.includeDomains = domains;
    if (pickerOpts.allowCustomEntity !== undefined) picker.allowCustomEntity = pickerOpts.allowCustomEntity;
    if (binding.deviceClass.length || binding.unit.length) {
      // ha-entity-picker поддерживает entityFilter (state -> boolean)
      picker.entityFilter = (state) => {
        if (!state) return true;
        const a = state.attributes || {};
        if (binding.deviceClass.length && a.device_class !== undefined) {
          if (!partialMatch(a.device_class, binding.deviceClass)) return false;
        }
        if (binding.unit.length && a.unit_of_measurement !== undefined) {
          if (!partialMatch(a.unit_of_measurement, binding.unit)) return false;
        }
        return true;
      };
    }
    picker.addEventListener("value-changed", (e) => {
      e.stopPropagation();
      this._setEntity(binding.key, picker.value || "");
    });
    picker.addEventListener("change", (e) => {
      e.stopPropagation();
      this._setEntity(binding.key, picker.value || "");
    });
    return picker;
  }

  /** Строка настройки параметра модели. */
  _paramRow(param) {
    const value = this._params[param.key] !== undefined ? this._params[param.key] : param.default;
    const p = param;
    let control;
    switch (p.type) {
      case "boolean":
        control = checkbox(p.name, !!value, (v) => this._setParam(p.key, v));
        break;
      case "range":
        control = slider(value, p, (v) => this._setParam(p.key, v));
        break;
      case "number":
        control = input("number", value, p.default, false);
        control.min = p.min !== undefined ? p.min : "";
        control.max = p.max !== undefined ? p.max : "";
        control.step = p.step !== undefined ? p.step : "any";
        control.addEventListener("input", () => {
          const v = parseFloat(control.value);
          this._setParam(p.key, Number.isFinite(v) ? v : undefined);
        });
        break;
      case "select": {
        control = document.createElement("select");
        control.className = "t3d-ed-input";
        for (const o of p.options || []) {
          const opt = document.createElement("option");
          opt.value = o.value;
          opt.textContent = o.label || o.value;
          if (o.value === value) opt.selected = true;
          control.appendChild(opt);
        }
        control.addEventListener("change", () => this._setParam(p.key, control.value));
        break;
      }
      case "color":
      case "theme-color":
        control = colorField(value, p, (v) => this._setParam(p.key, v));
        break;
      default:
        control = input("text", value, p.default, false);
        control.addEventListener("input", () => this._setParam(p.key, control.value));
    }
    if (p.type === "boolean") return field(p.name, control, p.description);
    return field(p.name, control, p.description);
  }

  /** Блок настроек камеры (необязательный). */
  _cameraBlock() {
    const meta = (this._model && this._model.manifest) || {};
    if (!meta.camera) return null;
    const details = document.createElement("details");
    details.className = "t3d-ed-details";
    const sum = document.createElement("summary");
    sum.textContent = "Вид камеры (необязательно)";
    details.appendChild(sum);

    const cam = Object.assign({}, meta.camera, this._config.camera || {});
    const grid = el("div", "t3d-ed-grid3");
    const numField = (label, key) => {
      const i = input("number", cam[key], "", false);
      i.step = "0.05";
      i.addEventListener("input", () => {
        const v = parseFloat(i.value);
        const camera = Object.assign({}, this._config.camera || {});
        if (Number.isFinite(v)) camera[key] = v; else delete camera[key];
        this._patch({ camera: Object.keys(camera).length ? camera : undefined });
      });
      grid.appendChild(field(label, i));
    };
    numField("Дистанция", "radius");
    numField("Наклон (phi)", "phi");
    numField("Поворот (theta)", "theta");
    numField("Мин. дистанция", "minRadius");
    numField("Макс. дистанция", "maxRadius");
    details.appendChild(grid);

    const target = input("text", Array.isArray(cam.target) ? cam.target.join(", ") : "", "0, 0, 0", true);
    target.addEventListener("change", () => {
      const arr = target.value.split(/[,;\s]+/).map(Number).filter((n) => Number.isFinite(n));
      const camera = Object.assign({}, this._config.camera || {});
      if (arr.length === 3) camera.target = arr; else delete camera.target;
      this._patch({ camera: Object.keys(camera).length ? camera : undefined });
    });
    details.appendChild(field("Точка взгляда (x, y, z)", target));

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "t3d-ed-btn";
    reset.textContent = "Сбросить вид к значениям модели";
    reset.addEventListener("click", () => this._patch({ camera: undefined }));
    details.appendChild(reset);
    return details;
  }

  // ---- изменения конфигурации ---------------------------------------------

  _setEntity(key, value) {
    const entities = Object.assign({}, this._entities || {});
    if (value) entities[key] = value;
    else delete entities[key];
    this._entities = entities;
    this._patch({ entities: Object.keys(entities).length ? entities : undefined });
    this._refreshStates();
  }

  _setBindingValueParam(key, attr) {
    // Атрибут — часть схемы модели, но допускаем переопределение в конфиге
    const params = Object.assign({}, this._params || {});
    if (attr) params[`attr.${key}`] = attr;
    else delete params[`attr.${key}`];
    this._params = params;
    this._patch({ params: Object.keys(params).length ? params : undefined });
  }

  _setParam(key, value) {
    const params = Object.assign({}, this._params || {});
    if (value === undefined || value === null || value === "") delete params[key];
    else params[key] = value;
    this._params = params;
    this._patch({ params: Object.keys(params).length ? params : undefined });
  }

  _patch(patch) {
    const next = Object.assign({}, this._config);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    // Ничего не изменилось (поле вернуло то же значение) — лишний
    // config-changed только заставляет Lovelace перерисовать диалог.
    // reload_model — исключение: это команда «перечитать файл модели».
    if (!patch.reload_model && canonicalJson(next) === canonicalJson(this._config)) return;
    this._config = next;
    // DOM уже показывает новое значение (его поставил сам пользователь),
    // поэтому отпечаток формы обновляем сразу: иначе эхо от HA (setConfig с тем
    // же конфигом) сочтёт форму устаревшей и перерисует её, забрав фокус.
    this._renderedKey = this._key();
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: next },
      bubbles: true,
      composed: true,
    }));
  }

  // ---- живая проверка ------------------------------------------------------

  _refreshStates() {
    if (!this._root || !this._schema) return;
    const states = this._hass && this._hass.states;
    const lines = this._root.querySelectorAll(".t3d-ed-state");
    const byKey = new Map();
    for (const b of this._schema.bindings) byKey.set(b.key, b);

    for (const line of lines) {
      const key = line.dataset.key;
      const b = byKey.get(key);
      const entity = (this._entities || {})[key];
      if (!entity) {
        line.textContent = b && b.required ? "Обязательная привязка не заполнена" : "Не используется";
        line.className = "t3d-ed-state t3d-ed-empty";
        continue;
      }
      if (!states) {
        line.textContent = "Нет данных от Home Assistant";
        line.className = "t3d-ed-state";
        continue;
      }
      const st = states[entity];
      if (!st) {
        line.textContent = `${entity} — сущность не найдена`;
        line.className = "t3d-ed-state t3d-ed-error";
        continue;
      }
      if (!isAvailable(st)) {
        line.textContent = `${prettyState(st)} · ${entity}`;
        line.className = "t3d-ed-state t3d-ed-warn";
        continue;
      }
      let extra = "";
      if (b && b.value) {
        if (b.value.kind === "attribute") {
          const attr = (this._params && this._params[`attr.${key}`]) || b.value.param;
          const v = (st.attributes || {})[attr];
          extra = v === undefined ? ` · атрибут ${attr} отсутствует` : ` → ${String(v)}`;
        } else {
          const override = this._params && this._params[`attr.${key}`];
          const effective = override
            ? Object.assign({}, b, { value: Object.assign({}, b.value, { param: override }) })
            : b;
          const v = readValue(effective, st, this._params || {});
          if (typeof v === "number") extra = ` → ${Number.isFinite(v) ? v : "не число"}`;
          else if (typeof v === "boolean") extra = ` → ${v ? "да" : "нет"}`;
        }
      }
      line.textContent = `${stateWithUnit(st)} · ${entity}${extra}`;
      line.className = "t3d-ed-state t3d-ed-ok";
    }

    if (this._summaryEl) {
      const { rows, errors, warnings } = validateBindings(this._entities || {}, this._schema, states);
      const used = rows.filter((r) => r.entity).length;
      const cls = errors.length ? "t3d-ed-error" : warnings.length ? "t3d-ed-warn" : "t3d-ed-ok";
      const head = errors.length
        ? `⛔ Проблемы: ${errors.length}`
        : warnings.length
          ? `⚠️ Предупреждения: ${warnings.length}`
          : `✅ Все привязки в порядке (${used} из ${rows.length})`;
      const list = [...errors, ...warnings].map((t) => `<li>${esc(t)}</li>`).join("");
      this._summaryEl.className = `t3d-ed-summary ${cls}`;
      this._summaryEl.innerHTML = `<div>${esc(head)}</div>${list ? `<ul>${list}</ul>` : ""}`;
    }
  }

  // ---- статический помощник для getStubConfig ------------------------------

  /**
   * Конфигурация по умолчанию: подставляет реальные подходящие сущности,
   * чтобы карточка сразу что-то показывала (как в исходных проектах).
   */
  static buildStubConfig(model, hass, entities) {
    return buildStubConfig(model, hass, entities);
  }
}

// ---- помощники разметки -----------------------------------------------------

function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function field(labelText, control, hint) {
  const wrap = el("div", "t3d-ed-field");
  if (labelText) {
    const l = el("label", "t3d-ed-label", labelText);
    wrap.appendChild(l);
  }
  wrap.appendChild(control);
  if (hint) wrap.appendChild(el("div", "t3d-ed-hint", hint));
  return wrap;
}

function input(type, value, placeholder, mono) {
  const i = document.createElement("input");
  i.type = type;
  i.className = "t3d-ed-input" + (mono ? " t3d-ed-mono" : "");
  i.value = value === undefined || value === null ? "" : value;
  if (placeholder) i.placeholder = placeholder;
  return i;
}

function checkbox(label, checked, onChange) {
  const wrap = el("label", "t3d-ed-check");
  const i = document.createElement("input");
  i.type = "checkbox";
  i.checked = !!checked;
  i.addEventListener("change", () => onChange(i.checked));
  wrap.appendChild(i);
  wrap.appendChild(el("span", null, label));
  return wrap;
}

function slider(value, param, onChange) {
  const wrap = el("div", "t3d-ed-slider");
  const i = document.createElement("input");
  i.type = "range";
  i.min = param.min !== undefined ? param.min : 0;
  i.max = param.max !== undefined ? param.max : 100;
  i.step = param.step !== undefined ? param.step : 1;
  i.value = value !== undefined && value !== null ? value : param.min || 0;
  const out = el("span", "t3d-ed-slider-val", String(i.value));
  i.addEventListener("input", () => {
    out.textContent = i.value;
    onChange(parseFloat(i.value));
  });
  wrap.appendChild(i);
  wrap.appendChild(out);
  return wrap;
}

function colorField(value, param, onChange) {
  const wrap = el("div", "t3d-ed-row-inline");
  const text = input("text", value, param.default, true);
  text.addEventListener("input", () => onChange(text.value));
  wrap.appendChild(text);
  if (param.type === "color") {
    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.value = /^#[0-9a-f]{6}$/i.test(String(value)) ? value : "#2f9df4";
    swatch.addEventListener("input", () => {
      text.value = swatch.value;
      onChange(swatch.value);
    });
    wrap.appendChild(swatch);
  }
  return wrap;
}

function modelDesc(model) {
  const m = model.manifest;
  return m.description || `${m.name} · API v${m.apiVersion}`;
}

/**
 * Канонический JSON: порядок ключей не важен.
 *
 * Конфиг приходит редактору то из YAML, то из формы, и порядок ключей в нём
 * может отличаться — сравнивать значения обычным JSON.stringify нельзя, иначе
 * форма будет перерисовываться «на пустом месте» и забирать фокус.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return String(JSON.stringify(value));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function isUrl(v) {
  return typeof v === "string" && (/^(https?:)?\/\//.test(v) || v.startsWith("/") || v.endsWith(".js"));
}

function shortUrl(v) {
  const s = String(v);
  return s.length > 34 ? "…" + s.slice(-33) : s;
}

function partialMatch(value, needles) {
  const s = String(value).toLowerCase();
  return needles.some((n) => s.includes(String(n).toLowerCase()));
}

const EDITOR_CSS = `
:host { display: block; }
.t3d-editor { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 8px;
  font-family: var(--ha-font-family-body, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  color: var(--primary-text-color, #dfe6ef); }
.t3d-ed-block { display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--divider-color, rgba(130,150,180,.25)); border-radius: 12px; padding: 12px 14px; }
.t3d-ed-h { font-size: 13px; font-weight: 650; }
.t3d-ed-sub { font-size: 11.5px; opacity: .7; line-height: 1.45; }
.t3d-ed-group { font-size: 11.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .4px;
  opacity: .65; margin-top: 6px; }
.t3d-ed-field { display: flex; flex-direction: column; gap: 4px; }
.t3d-ed-label { font-size: 11.5px; opacity: .8; }
.t3d-ed-req { color: var(--warning-color, #ffa600); font-size: 10.5px; }
.t3d-ed-hint { font-size: 10.5px; opacity: .6; line-height: 1.4; }
.t3d-ed-input { width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px; padding: 7px 10px;
  border-radius: 8px; color: var(--primary-text-color, #dfe6ef);
  background: var(--secondary-background-color, rgba(255,255,255,.05));
  border: 1px solid var(--divider-color, rgba(130,150,180,.3)); }
.t3d-ed-input:focus { outline: none; border-color: var(--primary-color, #1f6feb); }
.t3d-ed-mono { font-family: var(--code-font-family, ui-monospace, Consolas, monospace); font-size: 11.5px; }
.t3d-ed-row-inline { display: flex; gap: 6px; align-items: stretch; }
.t3d-ed-row-inline > * { flex: 1; }
.t3d-ed-btn { cursor: pointer; font: inherit; font-size: 12px; padding: 6px 12px; border-radius: 8px;
  border: 1px solid var(--divider-color, rgba(130,150,180,.35));
  background: var(--secondary-background-color, rgba(255,255,255,.06)); color: inherit; flex: 0 0 auto; }
.t3d-ed-btn:hover { filter: brightness(1.15); }
.t3d-ed-check { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.t3d-ed-check input { accent-color: var(--primary-color, #1f6feb); }
.t3d-ed-checks { display: flex; flex-direction: column; gap: 6px; }
.t3d-ed-slider { display: flex; align-items: center; gap: 10px; }
.t3d-ed-slider input { flex: 1; accent-color: var(--primary-color, #1f6feb); }
.t3d-ed-slider-val { font-family: var(--code-font-family, ui-monospace, monospace); font-size: 11.5px;
  min-width: 34px; text-align: right; opacity: .8; }
.t3d-ed-state { font-size: 11px; font-family: var(--code-font-family, ui-monospace, Consolas, monospace);
  opacity: .75; word-break: break-all; }
.t3d-ed-ok { color: var(--success-color, #43a047); opacity: .95; }
.t3d-ed-warn { color: var(--warning-color, #ffa600); opacity: .95; }
.t3d-ed-error { color: var(--error-color, #e53935); opacity: .95; }
.t3d-ed-empty { opacity: .5; }
.t3d-ed-summary { font-size: 11.5px; line-height: 1.5; }
.t3d-ed-summary ul { margin: 4px 0 0; padding-left: 18px; }
.t3d-ed-note { font-size: 11.5px; opacity: .7; }
.t3d-ed-foot { font-size: 10.5px; opacity: .5; text-align: center; padding-top: 4px; }
.t3d-ed-details { border-top: 1px solid var(--divider-color, rgba(130,150,180,.2)); padding-top: 8px; margin-top: 4px; }
.t3d-ed-details summary { cursor: pointer; font-size: 12px; opacity: .8; margin-bottom: 8px; }
.t3d-ed-grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 8px; }
@media (max-width: 520px) { .t3d-ed-grid3 { grid-template-columns: 1fr 1fr; } }
`;

export default ThreeDModelCardEditor;
