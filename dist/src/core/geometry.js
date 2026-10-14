// ============================================================================
//  Загрузка файлов 3D-моделей: OBJ (+MTL) и glTF/GLB.
//
//  Используются официальные загрузчики three.js из релиза карточки
//  (vendor/three-addons). Они импортируют ту же копию three.js, что и
//  карточка, поэтому объекты сцены совместимы.
//
//  Всё, что нужно модели, — вызвать loadGeometry(ctx, source):
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

const cache = new Map();   // url -> Promise<Object3D> (клонируется на каждый вызов)

/** Определить формат по расширению файла. */
export function detectFormat(url) {
  const ext = String(url).split("?")[0].split(".").pop().toLowerCase();
  if (ext === "obj") return "obj";
  if (ext === "glb" || ext === "gltf") return "gltf";
  return ext || "unknown";
}

/** Нормализовать описание источника геометрии. */
export function normalizeSource(source, base) {
  if (!source) throw new Error("Не указан источник модели (source)");
  const src = typeof source === "string" ? { url: source } : Object.assign({}, source);
  if (!src.url) throw new Error("Не указан путь к файлу модели (source.url)");
  src.url = resolveUrl(src.url, base);
  if (src.mtl) src.mtl = resolveUrl(src.mtl, base);
  src.format = (src.format || detectFormat(src.url)).toLowerCase();
  if (src.format === "glb") src.format = "gltf";
  if (!["obj", "gltf"].includes(src.format)) {
    throw new Error(`Формат «${src.format}» не поддерживается: используйте OBJ (+MTL) или glTF/GLB`);
  }
  // Для OBJ, если MTL не указан, но рядом лежит одноимённый — берём его.
  if (src.format === "obj" && !src.mtl && src.autoMtl !== false) {
    src.mtl = src.url.replace(/\.obj(\?.*)?$/i, ".mtl$1");
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
 * Загрузить геометрию модели.
 * @param {object} ctx     контекст модели (нужны THREE и asset())
 * @param {object|string} source  { format, url, mtl, dracoPath, … }
 * @returns {Promise<import('three').Object3D>} корневой объект (клон при повторе)
 */
export async function loadGeometry(ctx, source) {
  checkAddonThree();
  const src = normalizeSource(source, ctx.asset ? ctx.asset(".") : undefined);
  const key = `${src.format}|${src.url}|${src.mtl || ""}`;

  if (!cache.has(key)) {
    cache.set(key, loadOnce(ctx, src).catch((e) => {
      cache.delete(key);   // неудачную попытку не кэшируем
      throw e;
    }));
  }
  const original = await cache.get(key);
  // Каждой сцене — свой экземпляр: у карточек на дашборде независимые модели.
  return cloneObject(original, ctx.THREE);
}

async function loadOnce(ctx, src) {
  if (src.format === "obj") return loadObj(ctx, src);
  return loadGltf(ctx, src);
}

// ---- OBJ + MTL --------------------------------------------------------------

async function loadObj(ctx, src) {
  // Спецификаторы ЛИТЕРАЛЬНЫЕ намеренно: в однофайловой сборке
  // (threejs-3d-card.js в корне репозитория) сборщик подставляет сюда код
  // загрузчиков, и в релизе они уже внутри файла; в раскладке dist/ и при
  // ручной установке те же пути ведут в vendor/three-addons.
  const { OBJLoader } = await import("../../vendor/three-addons/loaders/OBJLoader.js");
  const loader = new OBJLoader();

  if (src.mtl) {
    try {
      const { MTLLoader } = await import("../../vendor/three-addons/loaders/MTLLoader.js");
      const mtlLoader = new MTLLoader();
      if (ctx.THREE) mtlLoader.setResourcePath(resourcePath(src.url));
      const materials = await mtlLoader.loadAsync(src.mtl);
      materials.preload();
      loader.setMaterials(materials);
    } catch (e) {
      // Без MTL модель загрузится с материалом по умолчанию — это не ошибка,
      // но пользователю полезно знать, почему нет текстур и цветов.
      if (ctx.report) ctx.report("warn", `MTL не загружен (${src.mtl}): ${e.message}. Использую стандартный материал.`);
    }
  }

  const object = await loader.loadAsync(src.url);
  object.name = object.name || "obj-root";
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

  const gltf = await loader.loadAsync(src.url);
  const scene = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (!scene) throw new Error(`В файле ${src.url} нет сцены glTF`);
  scene.name = scene.name || "gltf-root";
  if (gltf.animations && gltf.animations.length && ctx.report) {
    ctx.report("info", `В модели ${gltf.animations.length} встроенных анимаций glTF (не используются)`);
  }
  if (src.normalize !== false) centerAndScale(ctx, scene, src);
  return scene;
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

/** Сбросить кэш загруженных моделей (используется в тестах и при перезагрузке). */
export function clearGeometryCache() {
  cache.clear();
}
