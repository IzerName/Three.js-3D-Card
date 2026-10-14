// ============================================================================
//  Сборка релиза threejs-3d-card.
//
//  Что делает:
//    1. собирает three.js из node_modules (terser, minify) в vendor/;
//    2. копирует src/ и models/ в dist/ без изменений — структура каталогов
//       сохраняется, поэтому относительные import в браузере работают как есть;
//    3. переписывает импорты three.js внутри аддонов на относительный путь;
//    4. подчищает мёртвые импорты (простая, но безопасная проверка);
//    5. печатает отчёт о размерах и проверяет, что все import разрешаются.
//
//  Почему релизный слой — dist/, и почему он закоммичен:
//    HACS для Dashboard-плагина ищет файл из hacs.json (filename) сначала в
//    корне репозитория, а если его там нет — в dist/. Наш плагин многофайловый
//    (ядро + модели + three.js), а из корня HACS скачал бы только корневые .js,
//    поэтому точка входа обязана лежать в dist/: тогда HACS забирает содержимое
//    dist/ целиком и кладёт его в config/www/community/<имя-репозитория>/.
//    Значит dist/ должен быть в git на теге — его обновляют перед релизом.
//
//  Почему без esbuild/rollup: сборка должна работать в любом окружении, где
//  есть только Node.js (в том числе внутри ограниченной песочницы, где
//  сторонние бинарники не запускаются). Готовый релиз — это обычные ES-модули,
//  которые Home Assistant отдаёт как статику из config/www/community/.
// ============================================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const SRC = path.join(ROOT, "src");
const MODELS = path.join(ROOT, "models");
const VENDOR = path.join(DIST, "vendor");

const THREE_SRC = path.join(ROOT, "node_modules", "three", "build", "three.module.js");

/**
 * Спецификатор three.js внутри аддонов.
 *
 * Аддоны лежат в vendor/three-addons/<loaders|utils>/, библиотека — в
 * vendor/three.module.js, то есть ровно на два уровня выше. Относительный
 * спецификатор браузер разрешает относительно URL самого аддона, поэтому
 * карточка работает под любым префиксом установки.
 *
 * Почему не абсолютный /hacsfiles/…: HACS отдаёт плагин по имени репозитория
 * (/hacsfiles/Three.js-3D-Card/), а при ручной установке префикс другой
 * (/local/…). Почему не псевдоним вида "@card/three": браузер разрешает
 * спецификаторы ДО загрузки, перехватить такой импорт через fetch нельзя.
 */
const ADDON_THREE = "../../three.module.js";

async function main() {
  const t0 = Date.now();
  // Флаг --no-minify отключает сжатие (например, для отладки three.js).
  const minify = !process.argv.includes("--no-minify");

  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });
  await fs.mkdir(VENDOR, { recursive: true });

  // --- 1. three.js ---
  const threeInfo = await buildThree(minify);

  // --- 1b. загрузчики форматов (аддоны three.js) ---
  const addons = await buildAddons(minify);

  // --- 2. точка входа релиза ---
  // В hacs.json указан filename: threejs-3d-card.js — это файл, который HACS
  // подключает ресурсом Lovelace. Он лишь реэкспортирует src/card.js, поэтому
  // исходники остаются единственным источником правды.
  const entry = path.join(DIST, "threejs-3d-card.js");
  await fs.writeFile(entry, ENTRY_SHIM, "utf8");

  // --- 3. исходники и модели ---
  const files = [];
  const entryStat = await fs.stat(entry);
  const vstat = await fs.stat(path.join(VENDOR, "three.module.js"));
  files.push({ rel: "threejs-3d-card.js", size: entryStat.size });
  files.push({ rel: "vendor/three.module.js", size: vstat.size });
  for (const a of addons) files.push(a);
  await copyTree(SRC, path.join(DIST, "src"), files);
  await copyTree(MODELS, path.join(DIST, "models"), files);

  // --- 4. проверка импортов ---
  const problems = await checkImports(DIST);
  const vendorProblems = await verifyVendor();
  problems.push(...vendorProblems);

  // --- 5. отчёт ---
  const relSize = (n) => `${(n / 1024).toFixed(0)} КБ`;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  console.log("");
  console.log("  threejs-3d-card — сборка готова");
  console.log("  ------------------------------------------------------------");
  console.log(`  threejs-3d-card.js       ${relSize(files[0].size).padStart(9)}  (ресурс Lovelace)`);
  console.log(`  vendor/three.module.js   ${relSize(vstat.size).padStart(9)}  (three.js r${threeInfo.revision}${threeInfo.minified ? ", minified" : ""})`);
  const addonSize = addons.reduce((s, a) => s + a.size, 0);
  console.log(`  vendor/three-addons/     ${relSize(addonSize).padStart(9)}  (${addons.length} загрузчика: OBJ, MTL, glTF)`);
  const byDir = new Map();
  for (const f of files) {
    const top = f.rel.includes("/") ? f.rel.split("/")[0] : "(корень)";
    byDir.set(top, (byDir.get(top) || 0) + f.size);
  }
  for (const [dir, size] of [...byDir.entries()].sort()) {
    if (dir === "(корень)" || dir === "vendor") continue;
    const count = files.filter((f) => f.rel.startsWith(dir + "/")).length;
    console.log(`  ${(dir + "/").padEnd(24)} ${relSize(size).padStart(9)}  (${count} файлов)`);
  }
  console.log("  ------------------------------------------------------------");
  console.log(`  всего                    ${relSize(total).padStart(9)}`);
  console.log(`  файлов в релизе: ${files.length}`);
  if (problems.length) {
    console.log("");
    console.log("  ! Проблемы с импортами:");
    for (const p of problems) console.log(`    - ${p}`);
    process.exitCode = 1;
  } else {
    console.log("  все import/export в релизе разрешаются корректно");
  }
  console.log(`  время сборки: ${Date.now() - t0} мс`);
  console.log("");

  if (process.argv.includes("--watch")) await watch();
}

const ENTRY_SHIM = `// ============================================================================
//  threejs-3d-card — точка входа для Home Assistant.
//
//  Этот файл подключается как ресурс Lovelace (Настройки → Панели → Ресурсы,
//  тип «JavaScript module»). Он регистрирует элементы:
//     <threejs-3d-card>          — карточка
//     <threejs-3d-card-editor>   — редактор конфигурации
//  и публикует window.ThreeJS3DCard — API для внешних моделей.
//
//  Файл сгенерирован сборкой: правьте src/card.js, а не этот файл.
// ============================================================================
export * from "./src/card.js";
import "./src/card.js";
`;

// ---- three.js ---------------------------------------------------------------

async function buildThree(minify) {
  let code;
  try {
    code = await fs.readFile(THREE_SRC, "utf8");
  } catch (e) {
    throw new Error(
      `Не найден ${THREE_SRC}. Выполните: npm install (в каталоге ${ROOT})`
    );
  }

  const revision = (code.match(/const REVISION\s*=\s*'([^']+)'/) || [])[1] || "?";
  let minified = false;

  if (minify) {
    try {
      const { minify: terserMinify } = await import("terser");
      const result = await terserMinify(code, {
        module: true,
        ecma: 2020,
        compress: {
          passes: 1,
          // Осторожный режим: three.js активно использует свойства классов
          // и динамические обращения, агрессивные преобразования ломают шейдеры.
          unsafe: false,
          unsafe_arrows: false,
          unsafe_methods: false,
          pure_getters: false,
          keep_classnames: true,
          keep_fnames: false,
        },
        mangle: { keep_classnames: true, keep_fnames: false },
        format: { comments: false, ascii_only: false },
      });
      if (result && result.code) {
        code = result.code;
        minified = true;
      }
    } catch (e) {
      console.warn(`  ! terser недоступен (${e.message}); three.js копируется как есть`);
    }
  }

  const out = path.join(VENDOR, "three.module.js");
  await fs.writeFile(out, `${BANNER}\n${code}\n`, "utf8");
  const stat = await fs.stat(out);
  return { size: stat.size, revision, minified };
}

const BANNER = `// three.js (r160) — поставляется вместе с threejs-3d-card для работы без интернета.
// Лицензия MIT, © three.js authors — https://threejs.org`;

// ---- аддоны three.js (загрузчики форматов) ---------------------------------

/**
 * Загрузчики OBJ/MTL и glTF/GLB — это официальные аддоны three.js из
 * examples/jsm. Они импортируют three по имени пакета, а браузер такой импорт
 * не понимает, поэтому сборка:
 *   * копирует только нужные файлы (весь каталог examples/jsm — 20 МБ);
 *   * переписывает `from 'three'` на путь к нашему vendor/three.module.js,
 *     чтобы у карточки и загрузчиков была ОДНА библиотека;
 *   * подтягивает зависимости аддонов между собой (BufferGeometryUtils).
 */
const ADDONS = [
  { from: "examples/jsm/loaders/OBJLoader.js", to: "OBJLoader.js" },
  { from: "examples/jsm/loaders/MTLLoader.js", to: "MTLLoader.js" },
  { from: "examples/jsm/loaders/GLTFLoader.js", to: "GLTFLoader.js" },
  { from: "examples/jsm/utils/BufferGeometryUtils.js", to: "BufferGeometryUtils.js" },
];

async function buildAddons(minify) {
  const threeDir = path.join(ROOT, "node_modules", "three");
  const outDir = path.join(VENDOR, "three-addons");
  await fs.mkdir(outDir, { recursive: true });

  const built = [];
  for (const addon of ADDONS) {
    const src = path.join(threeDir, addon.from);
    let code;
    try {
      code = await fs.readFile(src, "utf8");
    } catch (e) {
      throw new Error(`Не найден аддон three.js: ${addon.from}. Выполните npm install.`);
    }

    // 1. Импорт three.js в аддонах заменяем на относительный путь.
    code = code.replace(/(\bfrom\s*["'])three(["'])/g, `$1${ADDON_THREE}$2`);
    code = code.replace(/(import\s*\(\s*["'])three(["']\s*\))/g, `$1${ADDON_THREE}$2`);

    // 2. Зависимости между аддонами: структура каталогов повторяет
    //    examples/jsm, поэтому пути ../utils/… и ../loaders/… сходятся.
    //
    //    ВАЖНО: аддоны НЕ минифицируются. Опыт показал, что terser на этих
    //    файлах выдаёт код, который браузер отказывается разбирать как модуль
    //    («Failed to fetch dynamically imported module»); баланс скобок это
    //    подтверждает. Экономия ~90 КБ не стоит риска сломать загрузчики,
    //    которые к тому же грузятся по требованию.
    const isLoader = addon.from.includes("/loaders/");
    const targetDir = path.join(outDir, isLoader ? "loaders" : "utils");
    await fs.mkdir(targetDir, { recursive: true });
    const target = path.join(targetDir, addon.to);
    await fs.writeFile(target, `${ADDON_BANNER(addon.from)}\n${code}\n`, "utf8");
    const stat = await fs.stat(target);
    built.push({ rel: `vendor/three-addons/${isLoader ? "loaders" : "utils"}/${addon.to}`, size: stat.size });
  }
  return built;
}

const ADDON_BANNER = (from) => `// three.js addon: ${from} (MIT, © three.js authors).
// Поставляется с threejs-3d-card; импорт three переписан на локальную копию.`;

// ---- копирование ------------------------------------------------------------

async function copyTree(from, to, acc) {
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const e of entries) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) {
      await fs.mkdir(dst, { recursive: true });
      await copyTree(src, dst, acc);
    } else if (e.isFile()) {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
      const stat = await fs.stat(dst);
      acc.push({
        rel: path.relative(DIST, dst).split(path.sep).join("/"),
        size: stat.size,
      });
    }
  }
}

// ---- проверка импортов ------------------------------------------------------

/**
 * Простая, но полезная проверка: каждый относительный import в dist/
 * должен указывать на существующий файл, а все импортируемые имена —
 * быть экспортированы целевым модулем.
 */
/**
 * Проверка импортов НАШЕГО кода.
 *
 * Каталог vendor/ исключён намеренно: это сторонние файлы three.js, которые
 * копируются как есть. Их импорты могут быть минифицированы (`}from"../…"`),
 * и разбор регулярным выражением даёт ложные срабатывания. Вместо этого
 * наличие самих файлов в vendor проверяется отдельно (см. verifyVendor).
 */
/**
 * Проверить, что все файлы vendor на месте и что аддоны ссылаются на
 * НАШУ копию three.js (иначе на странице окажутся две библиотеки, и объекты
 * одной не будут пониматься другой).
 */
async function verifyVendor() {
  const problems = [];
  const required = [
    "vendor/three.module.js",
    "vendor/three-addons/loaders/OBJLoader.js",
    "vendor/three-addons/loaders/MTLLoader.js",
    "vendor/three-addons/loaders/GLTFLoader.js",
    "vendor/three-addons/utils/BufferGeometryUtils.js",
  ];
  for (const rel of required) {
    try {
      await fs.access(path.join(DIST, rel));
    } catch (e) {
      problems.push(`в релизе нет обязательного файла ${rel}`);
    }
  }

  // Аддоны должны запрашивать three относительным путём на два уровня вверх —
  // vendor/three.module.js. Абсолютный путь здесь был бы ошибкой: каталог
  // установки зависит от имени репозитория в HACS и от способа установки.
  for (const rel of required.slice(1)) {
    try {
      const code = await fs.readFile(path.join(DIST, rel), "utf8");
      if (!/["']\.\.\/\.\.\/three\.module\.js["']/.test(code)) {
        problems.push(`${rel}: импорт three не заменён на относительный ../../three.module.js`);
      }
      if (/(from|import)\s*\(?\s*["']three["']/.test(code)) {
        problems.push(`${rel}: остался импорт по имени пакета «three» — браузер его не разрешит`);
      }
      if (/["']\.\.\/three\.module\.js["']/.test(code)) {
        problems.push(`${rel}: путь ../three.module.js ведёт в three-addons/, а не в vendor/`);
      }
      if (/["']\/hacsfiles\//.test(code)) {
        problems.push(`${rel}: остался абсолютный путь /hacsfiles/… — он ломается при другом имени каталога`);
      }
      // Незакрытая кавычка/битый литерал в минифицированном файле ломает
      // динамический import в браузере, поэтому проверяем и баланс скобок.
      const balance = countBalance(code);
      if (balance !== 0) {
        problems.push(`${rel}: несбалансированные скобки (${balance}) — файл повреждён при сборке`);
      }
    } catch (e) {
      problems.push(`${rel}: не читается (${e.message})`);
    }
  }
  return problems;
}

/** Баланс фигурных скобок вне строк и комментариев (грубая, но полезная проверка). */
function countBalance(code) {
  let depth = 0;
  let i = 0;
  let state = null;   // null | "'" | '"' | "`" | "//" | "/*"
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (state === null) {
      if (c === "/" && n === "/") { state = "//"; i += 2; continue; }
      if (c === "/" && n === "*") { state = "/*"; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") { state = c; i++; continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
    } else if (state === "//") {
      if (c === "\n") state = null;
    } else if (state === "/*") {
      if (c === "*" && n === "/") { state = null; i += 2; continue; }
    } else {
      if (c === "\\") { i += 2; continue; }
      if (c === state) state = null;
    }
    i++;
  }
  return depth;
}

async function checkImports(dir) {
  const problems = [];
  const files = (await listJs(dir)).filter((f) => !f.includes(`${path.sep}vendor${path.sep}`));

  for (const file of files) {
    const code = await fs.readFile(file, "utf8");
    const re = /import\s+(?:([\w*\s{},$]+?)\s+from\s+)?["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(code))) {
      const spec = m[2];
      if (!spec.startsWith(".")) continue; // bare/URL — не наша забота
      const target = path.resolve(path.dirname(file), spec.split("?")[0]);
      if (!files.includes(target)) {
        problems.push(`${path.relative(DIST, file)}: не найден модуль ${spec}`);
        continue;
      }
      if (!m[1]) continue; // import "./x.js";
      const names = parseImportNames(m[1]);
      if (!names.length) continue;
      const targetCode = await fs.readFile(target, "utf8");
      const exported = collectExports(targetCode);
      for (const n of names) {
        if (!exported.has(n)) {
          problems.push(`${path.relative(DIST, file)}: «${n}» не экспортируется из ${spec}`);
        }
      }
    }
  }
  return problems;
}

function parseImportNames(clause) {
  const s = clause.trim();
  if (!s || s.startsWith("*")) return [];
  const inner = s.replace(/^\{/, "").replace(/\}$/, "");
  return inner
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.split(/\s+as\s+/)[0].trim());
}

function collectExports(code) {
  const set = new Set();
  const declRe = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  const listRe = /export\s*\{([^}]*)\}/g;
  let m;
  while ((m = declRe.exec(code))) set.add(m[1]);
  while ((m = listRe.exec(code))) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) set.add(name);
    }
  }
  if (/export\s+default/.test(code)) set.add("default");
  return set;
}

async function listJs(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listJs(p)));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

// ---- режим наблюдения -------------------------------------------------------

async function watch() {
  console.log("  наблюдение за src/ и models/ (Ctrl+C — выход)…");
  let timer = null;
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await main();
      } catch (e) {
        console.error("  ошибка сборки:", e.message);
      }
    }, 200);
  };
  const { watch: fsWatch } = await import("node:fs");
  const watchers = [SRC, MODELS].map((dir) => fsWatch(dir, { recursive: true }, trigger));
  await new Promise((resolve) => {
    for (const w of watchers) w.on("error", (e) => console.error("  watcher:", e.message));
    process.on("SIGINT", () => {
      for (const w of watchers) w.close();
      resolve();
    });
  });
}

main().catch((e) => {
  console.error("");
  console.error("  Сборка не удалась:", e.message);
  console.error("");
  process.exitCode = 1;
});
