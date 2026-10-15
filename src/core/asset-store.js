// ============================================================================
//  Хранилище файлов моделей в браузере (IndexedDB).
//
//  Загруженные пользователем файлы (OBJ/glTF/GLB/MTL) хранятся ТОЛЬКО в
//  браузере: на сервер Home Assistant ничего не отправляется. Конфигурация
//  карточки хранит только идентификаторы (model_assets: { "house.glb":
//  "t3d-asset-…" }); формат файла определяется по имени из ключа.
//
//  API (заморожено в T-010):
//    put(file)      → { id, name, type, size }
//    get(id)        → запись { id, name, type, size, createdAt } или null
//    list()         → [записи]
//    remove(id)     → true, если запись была удалена
//    objectUrl(id)  → { url, revoke() }  — URL, с которого загрузчик three.js
//                   читает файл; revoke() отзывает URL и сбрасывает кэш,
//                   повторный objectUrl(id) выдаст свежий URL.
//
//  Бэкенд передаётся в конструктор параметром: в браузере —
//  createIndexedDBBackend(), в тестах под Node — фейк (IndexedDB там нет).
// ============================================================================

const DB_NAME = "threejs-3d-card";
const STORE_NAME = "assets";
const ID_PREFIX = "t3d-asset-";

/** Сгенерировать id ассета: t3d-asset-<uuid>. */
function makeAssetId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return ID_PREFIX + crypto.randomUUID();
  }
  // Фолбэк для окружений без randomUUID (UUID v4 через Math.random).
  return ID_PREFIX + "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Собрать URL, с которого загрузчик three.js прочитает файл.
 * В Node-тестах URL.createObjectURL может отсутствовать (или blob фейковый) —
 * тогда выдаём псевдо-URL mem://, на который тест ставит собственный fetch.
 */
let memCounter = 0;

function makeObjectUrl(record) {
  if (record.blob && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    try {
      return URL.createObjectURL(record.blob);
    } catch (e) {
      /* переходим к mem:// */
    }
  }
  // Счётчик делает каждый URL уникальным: после revoke хранилище
  // обязано выдать свежий (проверяется в тестах Node без blob-URL).
  memCounter += 1;
  return `mem://${record.id}#${memCounter}`;
}

export class AssetStore {
  /**
   * @param {object} backend  { put(rec), get(id), all(), remove(id) } —
   *                          асинхронные методы поверх IndexedDB (или фейка).
   */
  constructor(backend) {
    if (!backend ||
        typeof backend.put !== "function" ||
        typeof backend.get !== "function" ||
        typeof backend.all !== "function" ||
        typeof backend.remove !== "function") {
      throw new Error("AssetStore: некорректный бэкенд (нужны put/get/all/remove)");
    }
    this._backend = backend;
    this._urlCache = new Map(); // id -> { url, revoked }
  }

  /** Сохранить файл. @returns {Promise<{id, name, type, size}>} */
  async put(file) {
    const name = file && file.name !== undefined && file.name !== null ? String(file.name) : "";
    if (!name) throw new Error("AssetStore: у файла нет имени");
    const record = {
      id: makeAssetId(),
      name,
      type: (file && file.type) || "",
      size: (file && file.size) || 0,
      blob: file,
      createdAt: Date.now(),
    };
    await this._backend.put(record);
    return { id: record.id, name: record.name, type: record.type, size: record.size };
  }

  /** @returns {Promise<object|null>} запись (без blob) или null. */
  async get(id) {
    const rec = await this._backend.get(id);
    if (!rec) return null;
    return {
      id: rec.id,
      name: rec.name,
      type: rec.type,
      size: rec.size,
      createdAt: rec.createdAt,
    };
  }

  /** @returns {Promise<Array>} список записей (без blob). */
  async list() {
    const all = (await this._backend.all()) || [];
    return all.map((rec) => ({
      id: rec.id,
      name: rec.name,
      type: rec.type,
      size: rec.size,
      createdAt: rec.createdAt,
    }));
  }

  /** Удалить ассет. @returns {Promise<boolean>} существовал ли ассет. */
  async remove(id) {
    // Если у удалённого ассета жив объект-URL — отзываем его: файл больше
    // не загрузится, а URL не должен занимать память браузера.
    const cached = this._urlCache.get(id);
    if (cached && !cached.revoked && /^blob:/.test(cached.url)) {
      try { URL.revokeObjectURL(cached.url); } catch (e) { /* ignore */ }
      cached.revoked = true;
    }
    this._urlCache.delete(id);
    const existed = await this.get(id);
    await this._backend.remove(id);
    return existed !== null;
  }

  /**
   * URL для загрузки файла загрузчиком three.js.
   * @returns {Promise<{url: string, revoke: () => void}>}
   * @throws если ассета нет в хранилище.
   */
  async objectUrl(id) {
    const cached = this._urlCache.get(id);
    if (cached && !cached.revoked) {
      return {
        url: cached.url,
        revoke: () => this._revokeUrl(id, cached.url),
      };
    }
    const rec = await this._backend.get(id);
    if (!rec) throw new Error(`Ассет ${id} не найден в хранилище браузера`);
    const url = makeObjectUrl(rec);
    const entry = { url, revoked: false };
    this._urlCache.set(id, entry);
    return {
      url,
      revoke: () => this._revokeUrl(id, url),
    };
  }

  /** Отзыв URL: глобально (браузер) и в кэше (следующий objectUrl — свежий). */
  _revokeUrl(id, url) {
    if (/^blob:/.test(url) && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      try { URL.revokeObjectURL(url); } catch (e) { /* уже отозван — не страшно */ }
    }
    const entry = this._urlCache.get(id);
    if (entry) {
      entry.revoked = true;
      this._urlCache.delete(id);
    }
  }
}

// ---- IndexedDB-бэкенд --------------------------------------------------------

/**
 * Бэкенд поверх IndexedDB (база threejs-3d-card, стор assets, keyPath id).
 * @throws если indexedDB в окружении недоступен.
 */
export function createIndexedDBBackend() {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB недоступен в этом окружении");
  }
  let dbPromise = null;
  const openDb = () => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: "id" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("IndexedDB: не удалось открыть базу"));
        req.onblocked = () => reject(new Error("IndexedDB: база заблокирована другой вкладкой"));
      });
    }
    return dbPromise;
  };

  const run = async (mode, fn) => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      let result;
      const req = fn(store);
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB: ошибка транзакции"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB: транзакция отменена"));
    });
  };

  return {
    put: (record) => run("readwrite", (s) => s.put(record)),
    get: (id) => run("readonly", (s) => s.get(id)),
    all: () => run("readonly", (s) => s.getAll()),
    remove: (id) => run("readwrite", (s) => s.delete(id)),
  };
}

// ---- общий экземпляр на страницу ----------------------------------------------
// Карточка (читает) и редактор (пишет) — разные кастомные элементы одного
// браузера: они должны видеть одни и те же файлы, поэтому экземпляр общий.

let shared = null;
let sharedTried = false;

/**
 * Общее хранилище страницы. Возвращает null, если IndexedDB недоступен
 * (например, Node-окружение тестов) — карточка и редактор продолжают
 * работать без файлов, как раньше.
 */
export function getSharedAssetStore() {
  if (shared) return shared;
  if (sharedTried) return null;
  sharedTried = true;
  try {
    shared = new AssetStore(createIndexedDBBackend());
  } catch (e) {
    shared = null;
  }
  return shared;
}

/** Заменить общее хранилище (тесты, дев-стенд). */
export function setSharedAssetStore(store) {
  shared = store || null;
  sharedTried = true;
}
