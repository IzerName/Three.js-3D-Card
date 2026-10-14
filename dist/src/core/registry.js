// ============================================================================
//  Реестр моделей: встроенные + импортируемые пользователем.
//
//  ВАЖНО про Home Assistant: страница Lovelace отдаётся с политикой
//  Content-Security-Policy, которая запрещает blob:-модули. Поэтому внешняя
//  модель НЕ загружается через import(blob:). Используется тот же путь,
//  которым HA грузит ресурсы дашборда — вставка <script type="module">
//  с того же origin (URL модели), плюс резервная схема через new Function.
//
//  Контракт внешней модели (см. docs/MODEL_API.md):
//      const { THREE, defineModel } = window.ThreeJS3DCard;
//      defineModel({ manifest, bindings, params, create, defaults });
// ============================================================================

import { API_VERSION } from "./constants.js";

/** Встроенные модели: id -> загрузчик (относительный путь в релизе). */
const BUILTIN = {
  "water-tank": () => import("../../models/water-tank/manifest.js"),
  "production-room": () => import("../../models/production-room/manifest.js"),
};

/** Ленивый список встроенных моделей для редактора и подсказок. */
let builtinPromise = null;
export function listBuiltin() {
  if (!builtinPromise) {
    builtinPromise = Promise.all(
      Object.entries(BUILTIN).map(async ([id, load]) => {
        try {
          const mod = await load();
          return (mod && (mod.default || mod.model)) || null;
        } catch (e) {
          console.warn(`[threejs-3d-card] встроенная модель «${id}» не загрузилась`, e);
          return null;
        }
      })
    ).then((list) => list.filter(Boolean));
  }
  return builtinPromise;
}

/** Псевдонимы id (совместимость с именами старых карточек). */
const ALIASES = {
  "custom:water-tank-card": "water-tank",
  "custom:production-room-card": "production-room",
  "water_tank": "water-tank",
  "production_room": "production-room",
  "room": "production-room",
  "tank": "water-tank",
};

export class ModelRegistry {
  constructor() {
    /** @type {Map<string, object>} id -> описание модели */
    this.models = new Map();
    /** @type {Map<string, Promise<object>>} в процессе загрузки (дедупликация) */
    this.pending = new Map();
    /** @type {string|null} id, который сейчас определяется (для defineModel) */
    this._current = null;
    /** Журнал загрузок для диагностики: [{source, ok, error, mode}] */
    this.log = [];
  }

  /** Все известные модели. */
  list() {
    return [...this.models.values()];
  }

  has(id) {
    return this.models.has(id);
  }

  /** Зарегистрировать готовое описание (встроенные модели идут этим путём). */
  register(definition, source = "builtin") {
    const def = this._validate(definition, source);
    def.source = source;
    this.models.set(def.manifest.id, def);
    return def;
  }

  /**
   * Разрешить модель по id или URL.
   * @param {string} idOrUrl
   * @param {{force?: boolean, allowExternal?: boolean}} [opts]
   */
  async resolve(idOrUrl, opts = {}) {
    const id = ALIASES[idOrUrl] || idOrUrl;
    if (!id) throw new Error("Не указана модель");
    // force означает «перечитать файл»: сбрасываем кэш и качаем заново
    if (opts.force && looksLikeUrl(id)) this.reload(id);
    if (!opts.force && this.models.has(id)) return this.models.get(id);
    if (this.pending.has(id)) return this.pending.get(id);

    const task = this._load(id, opts).finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }

  /** Забыть модель (принудительная перезагрузка по тому же URL). */
  reload(idOrUrl) {
    const id = ALIASES[idOrUrl] || idOrUrl;
    const target = stripQuery(id);
    for (const key of [...this.models.keys()]) {
      const m = this.models.get(key);
      const sameSource = m && m._sourceUrl && stripQuery(m._sourceUrl) === target;
      if (key === id || stripQuery(key) === target || sameSource) {
        this.models.delete(key);
      }
    }
    return this;
  }

  async _load(id, opts) {
    const builtin = BUILTIN[id];
    if (builtin) {
      const mod = await builtin();
      const def = (mod && (mod.default || mod.model)) || null;
      if (!def) throw new Error(`Встроенная модель «${id}» не экспортирует описание модели`);
      return this.register(def, "builtin");
    }

    if (!looksLikeUrl(id)) {
      throw new Error(
        `Модель «${id}» не найдена. Доступны: ${Object.keys(BUILTIN).join(", ")}. ` +
        `Для своей модели укажите URL вида /local/3d-models/my-model.js`
      );
    }
    if (opts.allowExternal === false) throw new Error("Импорт внешних моделей отключён в конфигурации");
    return this._loadExternal(id, opts);
  }

  /** Загрузка модели по URL (обычно /local/3d-models/… или /hacsfiles/…). */
  async _loadExternal(url, opts = {}) {
    const src = opts.source || null;
    const bust = opts.force ? `?v=${Date.now()}` : "";
    const finalUrl = src ? src : absoluteUrl(url) + bust;

    let code = opts.code;
    if (!code) {
      const res = await fetch(finalUrl, { cache: opts.force ? "reload" : "default" });
      if (!res.ok) throw new Error(`Не удалось загрузить модель (${res.status} ${res.statusText}): ${finalUrl}`);
      code = await res.text();
    }

    const captured = [];
    const prevCapture = this.capture;
    this.capture = (def) => { captured.push(def); this.captured = def; };
    this.captured = null;

    let mode = "none";
    let error = null;
    try {
      mode = await this._evaluate(code, finalUrl);
    } catch (e) {
      error = e;
    } finally {
      this.capture = prevCapture;
      this.captured = null;
    }

    if (error) {
      this.log.push({ source: finalUrl, ok: false, error: String(error.message || error), mode });
      throw new Error(`Ошибка исполнения модели ${finalUrl}: ${error.message || error}`);
    }

    const def = captured[0];
    if (!def) {
      throw new Error(
        `Модель ${finalUrl} не вызвала defineModel(…). ` +
        `Проверьте, что файл — это модель threejs-3d-card (см. docs/MODEL_API.md).`
      );
    }

    // запомним URL как источник модели (для ctx.asset и повторных загрузок)
    def._sourceUrl = finalUrl;
    def._loadMode = mode;
    const registered = this.register(def, finalUrl);
    // Модель доступна и по manifest.id, и по URL, которым её запросили:
    // иначе повторный resolve(url) каждый раз качал бы файл заново.
    this.models.set(url, registered);
    this.models.set(stripQuery(url), registered);
    this.log.push({ source: finalUrl, ok: true, id: registered.manifest.id, mode });
    return registered;
  }

  /**
   * Исполнить код модели. Поддерживаются оба стиля:
   *   1) ES-модуль: `export default createObjectModel(spec)` — основной для
   *      моделей объектов (загружается динамическим import по URL, поэтому
   *      относительные пути внутри модуля работают как в браузере);
   *   2) скрипт, вызывающий `window.ThreeJS3DCard.defineModel({…})` — так
   *      пишутся простые модели без импортов.
   *
   *  Порядок попыток: defineModel через <script type="module"> → default-экспорт
   *  через import() → исполнение как функции (для IIFE/CommonJS-кода).
   */
  async _evaluate(code, url) {
    // 1. defineModel через тег <script type="module"> — работает и в HA (CSP).
    let scriptError = null;
    try {
      await injectModuleScript(url);
      if (await waitFor(() => this.captured, 8000)) return "script-module";
    } catch (e) {
      scriptError = e;
    }

    // 2. ES-модуль с default-экспортом.
    try {
      const mod = await import(/* @vite-ignore */ url);
      const def = mod && (mod.default || mod.model || (mod.manifest ? mod : null));
      if (def && def.manifest && (def.create || def.attach)) {
        this.capture(def);
        return "esm-default";
      }
    } catch (e) {
      scriptError = scriptError || e;
    }

    // 3. Код в стиле IIFE/CommonJS: исполняем как функцию.
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        "window", "document", "console", "defineModel", "ThreeJS3DCard", "module", "exports",
        `"use strict";\n${code}\n//# sourceURL=${url}`
      );
      const api = window.ThreeJS3DCard || {};
      fn(window, document, console, (d) => this._captureDefinition(d, url), api, undefined, undefined);
      if (!this.captured) throw new Error("код выполнен, но модель не создана");
      return "function";
    } catch (e2) {
      const reason = scriptError && scriptError.message ? scriptError.message : "модуль не выполнился";
      throw new Error(
        `модель не зарегистрирована (${reason}). Ожидается ES-модуль с ` +
        `export default createObjectModel(spec) либо вызов window.ThreeJS3DCard.defineModel({…}); ` +
        `последняя ошибка: ${e2.message || e2}`
      );
    }
  }

  _captureDefinition(def, url) {
    if (this.capture) this.capture(def);
  }

  /** Проверка и нормализация описания модели. */
  _validate(def, source) {
    if (!def || typeof def !== "object") throw new Error(`Модель (${source}) не является объектом`);
    const manifest = Object.assign({}, def.manifest || {});
    if (!manifest.id) throw new Error(`Модель (${source}) не указала manifest.id`);
    if (!manifest.name) manifest.name = manifest.id;
    if (manifest.apiVersion === undefined) manifest.apiVersion = API_VERSION;
    if (manifest.apiVersion > API_VERSION) {
      throw new Error(
        `Модель «${manifest.id}» требует API v${manifest.apiVersion}, ` +
        `а карточка поддерживает v${API_VERSION}. Обновите карточку.`
      );
    }
    const hasScene = typeof def.create === "function";
    const hasLegacy = typeof def.attach === "function";
    if (!hasScene && !hasLegacy) {
      throw new Error(`Модель «${manifest.id}»: нужен create(ctx) или attach(ctx)`);
    }
    // Описание модели может нести дополнительные методы (например,
    // defaultEntities() у объектных моделей). Раньше здесь переносились только
    // известные поля, и такие методы молча терялись — карточка не получала
    // значений привязок по умолчанию. Поэтому копируем всё, а известные поля
    // приводим к нужному виду.
    const normalized = Object.assign({}, def, {
      manifest,
      bindings: def.bindings || [],
      params: def.params || [],
      create: def.create || null,
      attach: def.attach || null,
      defaults: def.defaults || {},
      helpers: def.helpers || {},
      _raw: def,
    });
    return normalized;
  }
}

// ---- глобальные точки входа для внешних моделей ----------------------------

/** Глобальный реестр (один на страницу). */
export const registry = new ModelRegistry();

/**
 * Функция, которой пользуется внешняя модель:
 *   window.ThreeJS3DCard.defineModel({ manifest, bindings, params, create });
 */
export function defineModel(definition) {
  if (registry.capture) {
    registry.capture(definition);
  } else {
    // defineModel вызвали вне процесса загрузки — регистрируем напрямую
    registry.register(definition, "defineModel");
  }
  return definition;
}

/** Внедрить <script type="module"> и дождаться его исполнения. */
function injectModuleScript(url) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.type = "module";
    el.src = url;
    el.async = true;
    const cleanup = () => {
      el.removeEventListener("load", onLoad);
      el.removeEventListener("error", onError);
    };
    const onLoad = () => { cleanup(); resolve(); };
    const onError = () => {
      cleanup();
      el.remove();
      reject(new Error(`Не удалось исполнить модуль ${url} (CSP, MIME-тип или отсутствие файла)`));
    };
    el.addEventListener("load", onLoad);
    el.addEventListener("error", onError);
    document.head.appendChild(el);
  });
}

export function looksLikeUrl(v) {
  return /^(https?:)?\/\//.test(v) || v.startsWith("/") || v.startsWith("./") || v.endsWith(".js");
}

export function absoluteUrl(v) {
  try {
    return new URL(v, document.baseURI).href;
  } catch (e) {
    return v;
  }
}

/** URL без строки запроса (для сопоставления закэшированных моделей). */
function stripQuery(v) {
  return String(v).split("?")[0];
}

/** Список встроенных id — для подсказок в редакторе. */
export function builtinIds() {
  return Object.keys(BUILTIN);
}

/** Дождаться, пока условие станет истинным (простой опрос без таймеров-цепочек). */
function waitFor(cond, timeoutMs, stepMs = 25) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = !!cond(); } catch (e) { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(tick, stepMs);
    };
    tick();
  });
}
