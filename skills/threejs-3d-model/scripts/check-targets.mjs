#!/usr/bin/env node
// ============================================================================
//  check-targets.mjs — сверка `target` спецификации с реальным файлом модели.
//
//  Запуск:
//     node scripts/check-targets.mjs <спецификация.json | спецификация.js> […]
//                                    [--model путь/к/файлу.obj|.glb|.gltf]
//                                    [--root каталог-поиска]… [--json] [--quiet]
//
//  Зачем: валидатор (validate-model.mjs) проверяет только саму спецификацию —
//  опечатка в имени объекта (`Door_Fron` вместо `Door_Front`) проходит молча,
//  и карточка просто показывает пустоту. Этот скрипт идёт дальше: читает файл
//  модели, который грузит карточка, и сверяет с ним каждый target.
//
//  Имена объектов берутся так же, как их видит three.js:
//    * OBJ  — группы `o <Имя>` и `g <Имя>`;
//    * GLB  — имена узлов (nodes[].name) из JSON-чанка контейнера;
//    * glTF — имена узлов из JSON.
//
//  Поддерживаются все формы адресации target (семантика — как в карточке,
//  src/core/object-rules.js → resolveTarget):
//    "Lamp_Kitchen"   точное имя (регистр не важен)
//    ["A", "B"]       массив
//    "Lamp_*", "Lamp?" шаблон (* — любые символы, ? — один)
//    "/^Lamp_/"       регулярное выражение (регистр не важен)
//    "@lamps"         группа из блока groups (в т.ч. вложенные шаблоны)
//
//  Печатает, сколько объектов модели управляется привязками и сколько
//  осталось статичными. Код возврата: 0 — все target найдены, 1 — есть битые
//  target, пустые группы или файл модели не найден/не читается.
// ============================================================================

import { promises as fs } from "node:fs";
import path from "node:path";

// ---- разбор аргументов ------------------------------------------------------

const argv = process.argv.slice(2);
const quiet = argv.includes("--quiet");
const asJson = argv.includes("--json");

const optValues = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) { if (argv[i + 1]) out.push(argv[i + 1]); }
    else if (argv[i].startsWith(name + "=")) out.push(argv[i].slice(name.length + 1));
  }
  return out;
};

const modelOverride = optValues("--model")[0] || null;
const extraRoots = optValues("--root");

// позиционные аргументы — спецификации (всё, что не флаг и не значение флага)
const flagWithValue = new Set(["--model", "--root"]);
const specs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (flagWithValue.has(a)) { i++; continue; }
  if (a.startsWith("--model=") || a.startsWith("--root=")) continue;
  if (a.startsWith("-")) continue;
  specs.push(a);
}

if (!specs.length) {
  console.error("Укажите спецификацию: node scripts/check-targets.mjs <model.json> [--model файл-модели]");
  process.exit(2);
}

// ---- чтение спецификации (как в validate-model.mjs) --------------------------

async function readSpec(file) {
  const text = await fs.readFile(file, "utf8");
  if (file.endsWith(".json")) return JSON.parse(text);

  const patterns = [
    /createObjectModel\s*\(\s*(\{[\s\S]*?\})\s*\)/,
    /export\s+default\s+(\{[\s\S]*?\});?\s*$/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      try {
        // eslint-disable-next-line no-new-func
        return new Function(`return (${m[1]});`)();
      } catch (e) {
        throw new Error(`не удалось разобрать объект в ${file}: ${e.message}`);
      }
    }
  }
  throw new Error(`${file}: не найден объект спецификации (createObjectModel({…}) или export default {…})`);
}

// ---- поиск файла модели ------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".git", ".npm-cache", ".tmp-research", "dist", "vendor", "coverage"]);

async function isFile(p) {
  try { return (await fs.stat(p)).isFile(); } catch (e) { return false; }
}

/** Поиск файла по имени под каталогом (BFS, ограничение по глубине). */
async function searchByName(root, name, maxDepth) {
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of entries) {
        if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return path.join(dir, e.name);
        if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) next.push(path.join(dir, e.name));
      }
    }
    level = next;
  }
  return null;
}

/**
 * Найти файл модели, который грузит карточка.
 * Порядок: --model → источники из source.url (прямые пути рядом со
 * спецификацией и в --root/текущем каталоге) → поиск по имени файла вниз.
 */
async function findModel(spec, specFile) {
  const url = modelOverride || (spec.source && spec.source.url);
  if (!url) return { error: "в спецификации нет source.url (и не задан --model)" };

  if (modelOverride) {
    const p = path.resolve(modelOverride);
    return await isFile(p)
      ? { file: p, how: "указан флагом --model", url: String(url) }
      : { error: `файл модели «${modelOverride}» (--model) не найден` };
  }

  const raw = String(url);
  let name;
  let rel = null;
  if (raw.startsWith("asset:")) {
    name = path.basename(raw.slice("asset:".length));
  } else {
    const clean = raw.split("?")[0].split("#")[0];
    name = path.basename(clean);
    if (!clean.startsWith("/") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) rel = clean;
  }

  const roots = [
    path.dirname(path.resolve(specFile)),
    process.cwd(),
    ...extraRoots.map((r) => path.resolve(r)),
  ];
  const tried = [];
  for (const root of roots) {
    for (const cand of [name, rel].filter(Boolean)) {
      const p = path.resolve(root, cand);
      if (tried.includes(p)) continue;
      tried.push(p);
      if (await isFile(p)) return { file: p, how: raw.startsWith("asset:") ? "рядом со спецификацией (asset:)" : "рядом со спецификацией", url: raw };
    }
  }
  for (const root of roots) {
    const found = await searchByName(root, name, 4);
    if (found) return { file: found, how: `найден поиском в ${path.relative(process.cwd(), root) || "."}`, url: raw };
  }
  return { error: `файл модели «${name}» не найден`, tried, url: raw };
}

// ---- имена объектов из файла модели -----------------------------------------

/** OBJ: управляемые объекты — группы `o <Имя>` и `g <Имя>`. */
function objNames(text) {
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:o|g)\s+(\S.*?)\s*$/i);
    if (m) names.push(m[1]);
  }
  return names;
}

/** GLB: JSON-чанк контейнера (magic «glTF», chunks: JSON 0x4E4F534A). */
function glbJson(buf) {
  if (buf.length < 12) throw new Error("файл короче заголовка GLB");
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("нет подписи «glTF» — это не GLB");
  const version = buf.readUInt32LE(4);
  let off = 12;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) {
      const text = buf.subarray(off + 8, off + 8 + len).toString("utf8");
      return { json: JSON.parse(text), version };
    }
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  throw new Error("в GLB нет JSON-чанка");
}

/** glTF/GLB: имена узлов (то, что карточка адресует через target). */
function nodeNames(json) {
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  return nodes.map((n) => (n && typeof n.name === "string" ? n.name.trim() : "")).filter(Boolean);
}

async function readObjectNames(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".obj") {
    const text = await fs.readFile(file, "utf8");
    return { format: "obj", names: objNames(text) };
  }
  if (ext === ".glb") {
    const buf = await fs.readFile(file);
    const { json, version } = glbJson(buf);
    return { format: `glb v${version}`, names: nodeNames(json) };
  }
  if (ext === ".gltf") {
    const json = JSON.parse(await fs.readFile(file, "utf8"));
    return { format: "gltf", names: nodeNames(json) };
  }
  throw new Error(`формат «${ext}» не поддерживается (нужен .obj, .glb или .gltf)`);
}

// ---- адресация объектов (семантика карточки) --------------------------------

function makeIndex(names) {
  const all = names.map((name, i) => ({ name, i }));
  const byName = new Map();
  const byLower = new Map();
  for (const o of all) {
    if (!byName.has(o.name)) byName.set(o.name, o.i);
    const lower = o.name.toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, o.i);
  }
  return { all, byName, byLower, groups: new Map() };
}

function regexError(t) {
  if (!(t.length > 2 && t.startsWith("/") && t.endsWith("/"))) return null;
  try { new RegExp(t.slice(1, -1), "i"); return null; } catch (e) { return e.message; }
}

function resolveTarget(target, index, spec, seen = new Set()) {
  const t = String(target);

  if (t.startsWith("@")) {
    const key = t.slice(1);
    if (index.groups.has(key)) return index.groups.get(key).slice();
    if (seen.has(key)) return [];
    const def = spec.groups ? spec.groups[key] : undefined;
    if (def === undefined) return [];
    seen.add(key);
    const out = [];
    for (const m of (Array.isArray(def) ? def : [def])) {
      out.push(...resolveTarget(m, index, spec, seen));
    }
    const uniq = [...new Set(out)];
    index.groups.set(key, uniq);
    return uniq;
  }

  if (index.byName.has(t)) return [index.byName.get(t)];
  const lower = t.toLowerCase();
  if (index.byLower.has(lower)) return [index.byLower.get(lower)];

  if (t.length > 2 && t.startsWith("/") && t.endsWith("/")) {
    try {
      const re = new RegExp(t.slice(1, -1), "i");
      return index.all.filter((o) => re.test(o.name)).map((o) => o.i);
    } catch (e) { return []; }
  }
  if (t.includes("*") || t.includes("?")) {
    const re = new RegExp("^" + t.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
    return index.all.filter((o) => re.test(o.name)).map((o) => o.i);
  }
  return [];
}

const MAX_LISTED = 4;
function listNames(index, ids) {
  const names = ids.map((i) => index.all[i].name);
  if (names.length <= MAX_LISTED) return names.join(", ");
  return names.slice(0, MAX_LISTED).join(", ") + ` …и ещё ${names.length - MAX_LISTED}`;
}

/** Все записи target у привязки: краткая запись и actions[] — это один target. */
function bindingTargets(b) {
  const raw = b.target;
  return (Array.isArray(raw) ? raw : [raw]).filter((t) => typeof t === "string" && t.trim());
}

// ---- проверка одной спецификации --------------------------------------------

async function checkSpec(specFile) {
  const result = { file: path.relative(process.cwd(), specFile), errors: [], lines: [], details: [], stats: null };
  const error = (m) => { result.errors.push(m); };
  const line = (m) => { result.lines.push(m); };

  let spec;
  try {
    spec = await readSpec(specFile);
  } catch (e) {
    error(e.message);
    return result;
  }

  const found = await findModel(spec, specFile);
  if (found.error) {
    error(found.error + (found.tried && found.tried.length ? ` (искали: ${found.tried.slice(0, 3).join(", ")})` : ""));
    return result;
  }

  let parsed;
  try {
    parsed = await readObjectNames(found.file);
  } catch (e) {
    error(`файл модели ${path.relative(process.cwd(), found.file)}: ${e.message}`);
    return result;
  }

  const index = makeIndex(parsed.names);
  line(`файл модели: ${found.url} → ${path.relative(process.cwd(), found.file) || found.file} (${parsed.format}, объектов: ${index.all.length}; ${found.how})`);
  if (!index.all.length) {
    line("  в файле нет именованных объектов — адресовать нечего");
  }

  // группы: пустая группа = битый target, карточка тоже предупреждает
  const groupNames = Object.keys(spec.groups || {});
  for (const name of groupNames) {
    const ids = resolveTarget("@" + name, index, spec);
    if (!ids.length) error(`groups.${name}: не находит ни одного объекта модели`);
  }

  const bindings = Array.isArray(spec.bindings) ? spec.bindings : [];
  const managed = new Set();
  let targetCount = 0;

  bindings.forEach((b, i) => {
    if (!b || typeof b !== "object") return;
    const entity = b.entity || `bindings[${i}]`;
    const targets = bindingTargets(b);
    if (!targets.length) {
      error(`${entity} (bindings[${i}]): не задан target`);
      return;
    }
    for (const t of targets) {
      targetCount++;
      const bad = regexError(t);
      if (bad) {
        error(`${entity} → «${t}»: некорректная регулярка (${bad})`);
        line(`  ✖ ${entity} → ${t}: некорректная регулярка`);
        continue;
      }
      const ids = resolveTarget(t, index, spec);
      for (const id of ids) managed.add(id);
      if (ids.length) {
        line(`  ✔ ${entity} → ${t}: ${ids.length} ${ids.length === 1 ? "объект" : "объектов"} (${listNames(index, ids)})`);
      } else {
        const hint = t.startsWith("@") && !(spec.groups && spec.groups[t.slice(1)])
          ? " — такой группы нет в groups"
          : index.all.length ? "" : " — в файле модели нет именованных объектов";
        error(`${entity} → «${t}»: не найдено ни одного объекта модели${hint}`);
        line(`  ✖ ${entity} → ${t}: не найдено ни одного объекта${hint}`);
      }
    }
  });

  const staticIds = index.all.filter((o) => !managed.has(o.i)).map((o) => o.i);
  result.stats = {
    model: path.relative(process.cwd(), found.file) || found.file,
    format: parsed.format,
    objects: index.all.length,
    managed: managed.size,
    static: staticIds.length,
    staticNames: staticIds.map((i) => index.all[i].name),
    bindings: bindings.length,
    targets: targetCount,
    groups: groupNames.length,
  };
  line(`  объектов в модели: ${index.all.length}, управляется привязками: ${managed.size}, статично: ${staticIds.length}` +
    (staticIds.length ? ` (${listNames(index, staticIds)})` : ""));
  result.details = [...managed].map((i) => index.all[i].name);
  return result;
}

// ---- прогон -----------------------------------------------------------------

/** Каталог разворачивается в список спецификаций — как в validate-model.mjs. */
async function collect(arg) {
  let st;
  try {
    st = await fs.stat(arg);
  } catch (e) {
    return { files: [], error: e.message };
  }
  if (!st.isDirectory()) return { files: [arg] };
  const files = (await fs.readdir(arg))
    .filter((f) => f.endsWith(".json") && !f.startsWith("schema"))
    .sort()
    .map((f) => path.join(arg, f));
  return files.length ? { files } : { files: [], error: `в каталоге нет *.json со спецификациями` };
}

const specFiles = [];
for (const arg of specs) {
  const { files, error: collectError } = await collect(arg);
  if (collectError) {
    console.error(`✖ ${arg}: ${collectError}`);
    continue;
  }
  specFiles.push(...files);
}

const reports = [];
let totalErrors = 0;
let totalBindings = 0;
let totalTargets = 0;

if (!specFiles.length) {
  console.error("Не найдено ни одной спецификации для проверки.");
  process.exit(1);
}

for (const specFile of specFiles) {
  const res = await checkSpec(specFile);
  reports.push(res);
  totalErrors += res.errors.length;
  if (res.stats) { totalBindings += res.stats.bindings; totalTargets += res.stats.targets; }

  if (!quiet) {
    console.log(`${res.errors.length ? "✖" : "✔"} ${res.file}`);
    for (const l of res.lines) console.log(`    ${l}`);
    for (const e of res.errors) console.log(`    ошибка: ${e}`);
  }
}

const stats = reports.map((r) => r.stats).filter(Boolean);
const managed = stats.reduce((s, r) => s + r.managed, 0);
const objects = stats.reduce((s, r) => s + r.objects, 0);
const staticCount = stats.reduce((s, r) => s + r.static, 0);

if (asJson) {
  console.log(JSON.stringify({
    ok: totalErrors === 0,
    errors: totalErrors,
    specs: reports.map((r) => ({ file: r.file, errors: r.errors, stats: r.stats })),
    total: { objects, managed, static: staticCount, bindings: totalBindings, targets: totalTargets },
  }, null, 2));
} else {
  console.log("");
  console.log(`  спецификаций: ${reports.length}, привязок: ${totalBindings}, target-выражений: ${totalTargets}, ошибок: ${totalErrors}`);
  if (totalErrors) {
    console.log("  есть target, которые не находят объекты, пустые группы или файл модели не найден — исправьте имена или спецификацию");
  } else {
    console.log(`  все target найдены: управляется ${managed} из ${objects} объектов, статично ${staticCount}`);
  }
}

process.exit(totalErrors ? 1 : 0);
