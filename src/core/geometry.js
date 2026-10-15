// ============================================================================
//  Загрузка файлов 3D-моделей: OBJ (+MTL) и glTF/GLB.
//
//  Используются официальные загрузчики three.js из релиза карточки
//  (vendor/three-addons). Они импортируют ту же копию three.js, что и
//  карточка, поэтому объекты сцены совместимы.
//
//  Всё, что нужно модели, — вызвать loadGeometry(ctx, source) или
//  loadGeometryEx(ctx, source) (то же + клипы glTF для действия play, T-013):
//    source = { format: "obj",  url: "/local/3d/models/house.obj", mtl: "…" }
//    source = { format: "gltf", url: "/local/3d/models/house.glb" }
// ============================================================================

/**
 * Путь к загрузчикам в многофайловой раскладке (dist/ или ручная установка).
 * Нужен только для необязательного DRACOLoader: основные загрузчики
 * подключаются литеральными спецификаторами — см. loadObj/loadGltf.
 */
const ADDONS_URL = new URL("../../vendor/three-addons/", import.meta.url).href;

/** Локальная копия three.js (в однофайловой сборке уже внутри файла). */
const VENDOR_THREE_URL = new URL("../../vendor/three.module.js", import.meta.url).href;

/** Собрана ли карточка в один файл (тогда vendor/ рядом не нужен). */
function isBundled() {
  return typeof window !== "undefined"
    && window.ThreeJS3DCard
    && window.ThreeJS3DCard.bundled === true;
}

/**
 * В однофайловой сборке загрузчики форматов и three.js уже внутри файла, поэтому
 * проверять доступность vendor/ не нужно. В многофайловой раскладке проверка
 * полезна: если каталог vendor/ не скопирован на сервер, первый же OBJ/GLB упадёт
 * с невнятной ошибкой импорта — лучше объяснить причину заранее.
 */
let addonCheckStarted = false;
async function checkAddonThree() {
  if (addonCheckStarted || typeof fetch !== "function" || isBundled()) return;
  addonCheckStarted = true;
  const url = VENDOR_THREE_URL;
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.warn(
      `[threejs-3d-card] three.js для загрузчиков форматов недоступен по ${url} (${e.message}). ` +
      "Проверьте, что каталог vendor/ из релиза установлен рядом с threejs-3d-card.js."
    );
  }
}

const cache = new Map();   // url -> Promise<{ object, animations }> (клон дерева — на каждый вызов)

/**
 * blob: URL ассетов и функции их отзыва. URL живёт, пока его используют
 * сцены; при dispose модели releaseAssetUrls() отзывает их через store,
 * чтобы следующий objectUrl(id) выдал свежий URL (T-010).
 */
const assetUrlRevokes = new Map(); // blob: URL -> () => void

/** Определить формат по расширению файла. */
export function detectFormat(url) {
  const ext = String(url).split("?")[0].split(".").pop().toLowerCase();
  if (ext === "obj") return "obj";
  if (ext === "glb" || ext === "gltf") return "gltf";
  return ext || "unknown";
}

/**
 * Найти ассет из model_assets по значению source.url / source.mtl.
 * Только точное совпадение (имя файла или путь из спека) либо явная
 * схема asset:<ключ> — нечёткого поиска нет.
 * @returns {{key: string, id: string} | null}
 */
export function matchAsset(raw, assets) {
  if (!assets || typeof assets !== "object" || raw === undefined || raw === null) return null;
  const s = String(raw);
  if (Object.prototype.hasOwnProperty.call(assets, s)) return { key: s, id: String(assets[s]) };
  if (s.startsWith("asset:")) {
    const k = s.slice("asset:".length);
    if (Object.prototype.hasOwnProperty.call(assets, k)) return { key: k, id: String(assets[k]) };
  }
  return null;
}

/**
 * Нормализовать описание источника геометрии.
 * @param {object|string} source  { format, url, mtl, … }
 * @param {string} [base]         базовый URL для относительных путей
 * @param {object|null} [assets]  model_assets из конфигурации карточки
 *                                (ключ — имя файла или путь из спека,
 *                                значение — id ассета в браузере). Если
 *                                null — поведение как раньше (только сеть).
 */
export function normalizeSource(source, base, assets) {
  if (!source) throw new Error("Не указан источник модели (source)");
  const src = typeof source === "string" ? { url: source } : Object.assign({}, source);
  if (!src.url) throw new Error("Не указан путь к файлу модели (source.url)");
  if (src.isAsset) {
    // Повторная нормализация уже подставленного ассета: ключ, id, формат
    // и mtl вычислены при первом проходе — меняем ничего.
    return src;
  }

  // Подстановка файлов из хранилища браузера (T-010).
  const aUrl = matchAsset(src.url, assets);
  if (aUrl) {
    src.url = aUrl.key;         // ключ не резолвим: формат идёт по его имени
    src.assetId = aUrl.id;
    src.isAsset = true;
  } else {
    src.url = resolveUrl(src.url, base);
  }
  if (src.mtl) {
    const aMtl = matchAsset(src.mtl, assets);
    if (aMtl) {
      src.mtl = aMtl.key;
      src.mtlAssetId = aMtl.id;
      src.mtlIsAsset = true;
    } else {
      src.mtl = resolveUrl(src.mtl, base);
    }
  }
  src.format = (src.format || detectFormat(src.url)).toLowerCase();
  if (src.format === "glb") src.format = "gltf";
  if (!["obj", "gltf"].includes(src.format)) {
    throw new Error(`Формат «${src.format}» не поддерживается: используйте OBJ (+MTL) или glTF/GLB`);
  }
  // Для OBJ, если MTL не указан, но рядом лежит одноимённый — берём его.
  // У ассета «рядом» — соседний ключ <имя>.mtl в model_assets.
  if (src.format === "obj" && !src.mtl && src.autoMtl !== false) {
    const siblingKey = String(src.url).replace(/\.obj(\?.*)?$/i, ".mtl$1");
    if (src.isAsset && matchAsset(siblingKey, assets)) {
      src.mtl = siblingKey;
      src.mtlAssetId = String(assets[siblingKey]);
      src.mtlIsAsset = true;
    } else if (!src.isAsset) {
      src.mtl = siblingKey;
    }
  }
  return src;
}

function resolveUrl(url, base) {
  try {
    return new URL(url, base || document.baseURI).href;
  } catch (e) {
    return url;
  }
}

/**
 * Загрузить геометрию модели вместе с клипами (T-013).
 *
 * Кэш общий по (формат, url, mtl): повторная загрузка одной модели —
 * мгновенно, каждый вызов получает своё клон-дерево. В кэш уходит
 * ИСХОДНОЕ дерево с glTF-клипами: треки клипов ссылаются на узлы по
 * имени (безымянный узел — по uuid), клон сохраняет имена, поэтому
 * клип привязывается к каждой копии модели одинаково.
 *
 * @param {object} ctx     контекст модели (нужны THREE и asset())
 * @param {object|string} source  { format, url, mtl, dracoPath, … }
 * @returns {Promise<{root: import('three').Object3D, animations: Array}>}
 *   root — корневой объект (клон при повторе), animations — клипы glTF
 *   (для OBJ — пустой массив).
 */
export async function loadGeometryEx(ctx, source) {
  checkAddonThree();
  // model_assets — из «сырой» конфигурации панели (см. scene.js):
  // без него null — поведение загрузки остаётся прежним.
  const assets = (ctx && ctx.modelAssets) || null;
  const src = normalizeSource(source, ctx.asset ? ctx.asset(".") : undefined, assets);
  // Для ассета ключ кэша — id файла (blob: URL меняется на каждой
  // загрузке и не должен плодить записи в кэше); для сети — путь, как раньше.
  const key = src.isAsset
    ? `${src.format}|asset:${src.assetId}|${src.mtlAssetId || ""}`
    : `${src.format}|${src.url}|${src.mtl || ""}`;

  if (!cache.has(key)) {
    cache.set(key, loadOnce(ctx, src).catch((e) => {
      cache.delete(key);   // неудачную попытку не кэшируем
      throw e;
    }));
  }
  const original = await cache.get(key);
  // Каждой сцене — свой экземпляр: у карточек на дашборде независимые модели.
  return { root: cloneObject(original.object, ctx.THREE), animations: original.animations || [] };
}

/**
 * Загрузить геометрию модели (обёртка над loadGeometryEx, T-013):
 * возвращается только клон — клипы здесь не нужны.
 * @returns {Promise<import('three').Object3D>} корневой объект (клон при повторе)
 */
export async function loadGeometry(ctx, source) {
  const { root } = await loadGeometryEx(ctx, source);
  return root;
}

async function loadOnce(ctx, src) {
  if (src.format === "obj") return { object: await loadObj(ctx, src), animations: [] };
  return loadGltf(ctx, src);
}

// ---- OBJ + MTL --------------------------------------------------------------

/**
 * Взять файл ассета из хранилища браузера (T-010).
 * @returns {Promise<{url: string, revoke: () => void}>}
 * @throws  с понятным сообщением, если ассета в этом браузере нет.
 */
async function resolveAssetFile(ctx, id, name) {
  let file = null;
  if (typeof ctx.assetFile === "function") {
    try {
      file = await ctx.assetFile(id);
    } catch (e) {
      file = null;
    }
  }
  if (!file) {
    const msg = `файл модели «${name}» загружен в другом браузере — загрузите его снова в редакторе`;
    if (ctx.report) ctx.report("error", msg);
    throw new Error(msg);
  }
  return file;
}

/** Запомнить blob: URL на объекте и в реестре отзыва (T-010). */
function markAssetUrls(object, files) {
  if (!files.length) return;
  const urls = files.map((f) => f.url);
  object.userData._t3dAssetUrls = urls;
  for (const f of files) {
    assetUrlRevokes.set(f.url, typeof f.revoke === "function" ? f.revoke : null);
  }
}

async function loadObj(ctx, src) {
  // Спецификаторы ЛИТЕРАЛЬНЫЕ намеренно: в однофайловой сборке
  // (threejs-3d-card.js в корне репозитория) сборщик подставляет сюда код
  // загрузчиков, и в релизе они уже внутри файла; в раскладке dist/ и при
  // ручной установке те же пути ведут в vendor/three-addons.
  const { OBJLoader } = await import("../../vendor/three-addons/loaders/OBJLoader.js");
  const loader = new OBJLoader();

  // Ассеты из хранилища браузера загрузчик читает с blob: URL, а не с пути.
  const assetFiles = [];
  let objUrl = src.url;
  let mtlUrl = src.mtl || null;
  if (src.isAsset) {
    const f = await resolveAssetFile(ctx, src.assetId, src.url);
    objUrl = f.url;
    assetFiles.push(f);
  }
  if (mtlUrl && src.mtlIsAsset) {
    const f = await resolveAssetFile(ctx, src.mtlAssetId, src.mtl);
    mtlUrl = f.url;
    assetFiles.push(f);
  }

  if (mtlUrl) {
    try {
      const { MTLLoader } = await import("../../vendor/three-addons/loaders/MTLLoader.js");
      const mtlLoader = new MTLLoader();
      if (ctx.THREE) mtlLoader.setResourcePath(resourcePath(objUrl));
      const materials = await mtlLoader.loadAsync(mtlUrl);
      materials.preload();
      loader.setMaterials(materials);
    } catch (e) {
      // Без MTL модель загрузится с материалом по умолчанию — это не ошибка,
      // но пользователю полезно знать, почему нет текстур и цветов.
      if (ctx.report) ctx.report("warn", `MTL не загружен (${src.mtl}): ${e.message}. Использую стандартный материал.`);
    }
  }

  const object = await loader.loadAsync(objUrl);
  object.name = object.name || "obj-root";
  markAssetUrls(object, assetFiles);
  if (src.normalize !== false) centerAndScale(ctx, object, src);
  return object;
}

function resourcePath(url) {
  return url.slice(0, url.lastIndexOf("/") + 1);
}

// ---- glTF / GLB -------------------------------------------------------------

async function loadGltf(ctx, src) {
  const { GLTFLoader } = await import("../../vendor/three-addons/loaders/GLTFLoader.js");
  const loader = new GLTFLoader();

  // Draco-сжатие: декодер не входит в поставку (это ~1 МБ бинарных файлов).
  // Если модель сжата, пользователь указывает путь к декодеру. Сам загрузчик
  // DRACOLoader есть только в многофайловой раскладке, поэтому спецификатор
  // здесь вычисляемый: в однофайловой сборке попытка просто не удастся и
  // пользователь получит понятное предупреждение.
  if (src.dracoPath) {
    try {
      const { DRACOLoader } = await import(`${ADDONS_URL}loaders/DRACOLoader.js`);
      const draco = new DRACOLoader();
      draco.setDecoderPath(src.dracoPath);
      loader.setDRACOLoader(draco);
    } catch (e) {
      if (ctx.report) ctx.report("warn", `Декодер Draco недоступен: ${e.message}`);
    }
  }

  // Ассеты из хранилища браузера: GLB — единый файл, текстуры уже внутри;
  // внешний .gltf (отдельный .bin/картинки) из хранилища не читается.
  const assetFiles = [];
  let gltfUrl = src.url;
  if (src.isAsset) {
    const f = await resolveAssetFile(ctx, src.assetId, src.url);
    gltfUrl = f.url;
    assetFiles.push(f);
  }

  const gltf = await loader.loadAsync(gltfUrl);
  const scene = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (!scene) throw new Error(`В файле ${src.url} нет сцены glTF`);
  scene.name = scene.name || "gltf-root";
  markAssetUrls(scene, assetFiles);
  // Клипы glTF отдаём дальше (T-013): действие play привязывает их к
  // состоянию сущности. Они хранятся в кэше вместе с исходным деревом.
  if (src.normalize !== false) centerAndScale(ctx, scene, src);
  return { object: scene, animations: gltf.animations || [] };
}

// ---- общие операции ---------------------------------------------------------

/**
 * Привести модель к удобному виду: поставить на пол (y = 0) и отмасштабировать
 * до заданного размера. Модели из Sweet Home 3D/Blender приходят в разных
 * единицах и с разным положением нуля, из-за чего сцена выглядит пустой.
 */
function centerAndScale(ctx, object, src) {
  const THREE = ctx.THREE;
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  if (src.center !== false) {
    object.position.x -= center.x;
    object.position.z -= center.z;
  }
  if (src.ground !== false) {
    object.position.y -= box.min.y;
  }
  if (Number.isFinite(src.scale)) {
    object.scale.setScalar(src.scale);
  } else if (Number.isFinite(src.fitSize) && src.fitSize > 0) {
    const maxSide = Math.max(size.x, size.y, size.z) || 1;
    object.scale.setScalar(src.fitSize / maxSide);
  }
  if (ctx.report && src.reportBounds !== false) {
    ctx.report("info", `модель: ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)} (до масштабирования)`);
  }
}

/**
 * Копия дерева объектов. Геометрии и материалы общие (экономия памяти),
 * а трансформации и userData — свои у каждой сцены.
 */
function cloneObject(object, THREE) {
  const copy = object.clone(true);
  copy.traverse((node) => {
    if (node.isMesh || node.isLine || node.isPoints) {
      // Материал копируем: правила меняют цвет и прозрачность, и это не должно
      // затрагивать другие карточки на том же дашборде.
      node.material = Array.isArray(node.material)
        ? node.material.map((m) => m.clone())
        : node.material.clone();
      node.userData._baseMaterial = Array.isArray(node.material) ? node.material[0] : node.material;
      if (node.material && node.material.color) {
        node.userData._baseColor = node.material.color.clone();
      }
    }
  });
  return copy;
}

/**
 * Отозвать blob: URL ассетов поддерева (T-010). Вызывается при dispose
 * модели: после разбора файла загрузчик больше не обращается к URL, а
 * отзыв через store сбрасывает его кэш, чтобы следующая загрузка (в новой
 * сцене или после сброса кэша геометрии) получила свежий URL.
 */
export function releaseAssetUrls(root) {
  if (!root || typeof root.traverse !== "function") return;
  const urls = new Set();
  root.traverse((n) => {
    if (n.userData && Array.isArray(n.userData._t3dAssetUrls)) {
      for (const u of n.userData._t3dAssetUrls) {
        if (typeof u === "string" && u.length) urls.add(u);
      }
    }
  });
  for (const u of urls) {
    const revoke = assetUrlRevokes.get(u);
    if (revoke) {
      // Через store: отзовётся и глобальный URL, и запись в его кэше.
      assetUrlRevokes.delete(u);
      try { revoke(); } catch (e) { /* ignore */ }
    } else if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function" && u.startsWith("blob:")) {
      assetUrlRevokes.delete(u);
      try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ }
    }
  }
}

/** Сбросить кэш загруженных моделей (используется в тестах и при перезагрузке). */
export function clearGeometryCache() {
  cache.clear();
}
