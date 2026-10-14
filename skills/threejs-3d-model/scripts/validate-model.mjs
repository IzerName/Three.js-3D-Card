#!/usr/bin/env node
// ============================================================================
//  Валидатор спецификации модели threejs-3d-card.
//
//  Запуск:
//     node scripts/validate-model.mjs <файл.json | файл.js | каталог> [ещё файлы…]
//
//  Проверяет то, что агент или человек чаще всего пишет неправильно:
//  опечатки в именах действий, пустые target/entity, несуществующие поля,
//  несовпадение entityConfig с привязками, «дверь со сдвигом и углом» и т.п.
//
//  Код возврата: 0 — ошибок нет, 1 — есть ошибки (предупреждения не влияют).
// ============================================================================

import { promises as fs } from "node:fs";
import path from "node:path";

// ---- словари допустимых значений (источник правды — reference/SPEC.md) ------

const TOP_KEYS = new Set(["manifest", "source", "bindings", "groups", "entityConfig", "params", "defaults", "options"]);
const MANIFEST_KEYS = new Set(["id", "name", "description", "apiVersion", "host", "author", "camera", "environment", "size", "icon"]);
const SOURCE_KEYS = new Set(["url", "format", "mtl", "scale", "fitSize", "center", "ground", "dracoPath", "normalize", "autoMtl", "reportBounds"]);
const BINDING_KEYS = new Set([
  "entity", "target", "name", "group", "actions", "rate",
  "colors", "color", "conditions", "scale", "restore",
  "hide", "showWhen", "hideWhen",
  "light", "rotate", "door", "text",
]);
const ACTION_NAMES = new Set(["color", "hide", "light", "rotate", "door", "text"]);

const ACTION_FIELDS = {
  color: new Set(["action", "colors", "color", "conditions", "scale", "restore", "rate", "target", "entity"]),
  hide: new Set(["action", "hide", "showWhen", "hideWhen", "rate", "target", "entity"]),
  light: new Set(["action", "lumens", "color", "distance", "decay", "useBrightness", "valueMax", "offset", "castShadow", "on", "rate", "target", "entity"]),
  rotate: new Set(["action", "axis", "round_per_second", "rps", "direction", "on", "valueMax", "rate", "target", "entity"]),
  door: new Set(["action", "slide", "hinge", "degrees", "axis", "span", "open", "valueMax", "rate", "target", "entity", "percentage"]),
  text: new Set(["action", "template", "prefix", "digits", "scale", "elevation", "offset", "fontSize", "target", "entity", "rate", "label_text"]),
};

const PARAM_TYPES = new Set(["number", "range", "boolean", "text", "theme-color", "color", "select"]);

// ---- разбор аргументов ------------------------------------------------------

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const quiet = process.argv.includes("--quiet");
const asJson = process.argv.includes("--json");

if (!args.length) {
  console.error("Укажите файл спецификации: node scripts/validate-model.mjs <model.json>");
  process.exit(2);
}

// ---- сбор файлов ------------------------------------------------------------

async function collect(target) {
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    const out = [];
    for (const f of await fs.readdir(target)) {
      if (f.endsWith(".json") && !f.startsWith("schema")) out.push(path.join(target, f));
    }
    return out;
  }
  return [target];
}

/** Прочитать спецификацию: JSON напрямую, из .js — вытащить объект. */
async function readSpec(file) {
  const text = await fs.readFile(file, "utf8");
  if (file.endsWith(".json")) return JSON.parse(text);

  // JS-обёртка: ищем createObjectModel({...}) или export default {...}
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

// ---- проверки ---------------------------------------------------------------

function validate(spec, file) {
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);

  if (!spec || typeof spec !== "object") {
    E("спецификация не является объектом");
    return { errors, warnings };
  }

  for (const k of Object.keys(spec)) {
    if (!TOP_KEYS.has(k)) W(`неизвестное поле верхнего уровня «${k}» — будет проигнорировано; может быть, вы имели в виду bindings/entityConfig?`);
  }

  // manifest
  const m = spec.manifest;
  if (!m || typeof m !== "object") {
    E("нет блока manifest с полем id");
  } else {
    if (!m.id) E("manifest.id не задан — карточка не сможет зарегистрировать модель");
    else if (!/^[a-zA-Z0-9_-]+$/.test(m.id)) W(`manifest.id «${m.id}»: лучше только латиница, цифры, _ и -`);
    if (!m.name) W("manifest.name не задан — в редакторе модель будет без названия");
    for (const k of Object.keys(m)) if (!MANIFEST_KEYS.has(k)) W(`manifest.${k}: неизвестное поле`);
    if (m.host && m.host !== "external") W(`manifest.host «${m.host}»: поддерживается только "external"`);
  }

  // source
  const s = spec.source;
  if (!s || typeof s !== "object") {
    E("нет блока source — неизвестно, какой файл модели загружать");
  } else {
    if (!s.url) E("source.url не задан — укажите путь к OBJ/GLB, например /local/3d/house.obj");
    else {
      const ext = String(s.url).split("?")[0].split(".").pop().toLowerCase();
      if (!["obj", "glb", "gltf"].includes(ext)) {
        E(`source.url: расширение «.${ext}» не поддерживается (нужен .obj, .glb или .gltf)`);
      }
      if (s.format) {
        const f = String(s.format).toLowerCase();
        if (!["obj", "gltf", "glb"].includes(f)) E(`source.format «${s.format}»: допустимы obj или gltf/glb`);
      }
      if (ext === "obj" && !s.mtl) W("source.mtl не задан — материалы (цвета и текстуры) из MTL применены не будут");
      if (ext !== "obj" && s.mtl) W("source.mtl указан, но модель не OBJ — поле не используется");
    }
    if (s.scale !== undefined && s.fitSize !== undefined) W("заданы и scale, и fitSize: применяется scale");
    if (s.scale !== undefined && !(Number(s.scale) > 0)) E("source.scale должен быть положительным числом");
    if (s.fitSize !== undefined && !(Number(s.fitSize) > 0)) E("source.fitSize должен быть положительным числом");
    for (const k of Object.keys(s)) if (!SOURCE_KEYS.has(k)) W(`source.${k}: неизвестное поле`);
  }

  // groups
  if (spec.groups) {
    if (typeof spec.groups !== "object" || Array.isArray(spec.groups)) E("groups должен быть объектом { \"имя\": [\"Объект\"] }");
    else {
      for (const [name, val] of Object.entries(spec.groups)) {
        const list = Array.isArray(val) ? val : [val];
        if (!list.length) E(`groups.${name}: пустой список объектов`);
        for (const t of list) if (typeof t !== "string" || !t) E(`groups.${name}: элемент «${t}» не строка`);
      }
    }
  }

  // bindings
  if (!Array.isArray(spec.bindings)) {
    E("bindings должен быть массивом (даже если пустым)");
  } else {
    const seen = new Map();
    spec.bindings.forEach((b, i) => {
      const at = `bindings[${i}]`;
      if (!b || typeof b !== "object") { E(`${at}: должен быть объектом`); return; }
      if (!b.entity) E(`${at}: не задан entity (entity_id Home Assistant)`);
      else {
        if (seen.has(b.entity)) {
          // Одна сущность на несколько объектов — обычный приём (например,
          // лампа: объект + подпись). Предупреждаем только о полном дубле.
          const prev = seen.get(b.entity);
          const sameTarget = JSON.stringify(prev) === JSON.stringify(b.target);
          if (sameTarget) W(`${at}: сущность ${b.entity} с тем же target уже привязана выше — это дубль`);
        }
        seen.set(b.entity, b.target);
        if (!/^[a-z_]+\.[a-z0-9_]+$/.test(b.entity)) W(`${at}.entity «${b.entity}» не похож на entity_id (пример: light.kitchen)`);
      }
      if (!b.target) E(`${at}: не задан target (имя объекта модели)`);
      else {
        const list = Array.isArray(b.target) ? b.target : [b.target];
        for (const t of list) {
          if (typeof t !== "string" || !t.trim()) E(`${at}.target: пустое имя объекта`);
          else if (t.startsWith("@") && !(spec.groups && spec.groups[t.slice(1)])) {
            E(`${at}.target «${t}» ссылается на группу, которой нет в groups`);
          }
        }
      }

      const hasShort = ["colors", "color", "hide", "light", "rotate", "door", "text"].some((k) => b[k] !== undefined);
      const hasFull = Array.isArray(b.actions) && b.actions.length > 0;
      if (!hasShort && !hasFull) {
        W(`${at}: нет ни одного действия (colors/hide/light/rotate/door/text или actions) — привязка ничего не делает`);
      }
      if (hasShort && hasFull) W(`${at}: смешаны краткая запись и actions — поддерживаются обе, но лучше выбрать одну`);

      for (const k of Object.keys(b)) if (!BINDING_KEYS.has(k)) W(`${at}.${k}: неизвестное поле`);

      // проверки отдельных действий
      if (b.colors !== undefined && (typeof b.colors !== "object" || Array.isArray(b.colors))) {
        E(`${at}.colors должен быть объектом { \"on\": \"#ffd9a0\" }`);
      }
      if (b.scale !== undefined && !b.scale.colors) W(`${at}.scale без colors — градиент не построить`);
      if (b.hide !== undefined && typeof b.hide === "string") {
        // допустимо: строка = одно состояние
      }
      if (b.door) checkDoor(b.door, `${at}.door`, E, W);
      if (b.rotate) checkAxis(b.rotate.axis, `${at}.rotate.axis`, E);
      if (b.text && b.text.template && !/\{/.test(b.text.template)) {
        W(`${at}.text.template без подстановок ({state}, {value}, {unit}) — подпись будет статичной`);
      }
      if (b.light && b.light.distance === 0) W(`${at}.light.distance = 0: свет без ограничения радиуса может «засветить» всю сцену`);

      if (Array.isArray(b.actions)) {
        b.actions.forEach((a, j) => {
          const aat = `${at}.actions[${j}]`;
          if (!a || typeof a !== "object") { E(`${aat}: должен быть объектом`); return; }
          if (!a.action) { E(`${aat}: не задан action`); return; }
          if (!ACTION_NAMES.has(a.action)) {
            E(`${aat}.action «${a.action}»: допустимы ${[...ACTION_NAMES].join(", ")}`);
            return;
          }
          for (const k of Object.keys(a)) {
            if (!ACTION_FIELDS[a.action].has(k)) W(`${aat}.${k}: неизвестное поле для действия «${a.action}»`);
          }
          if (a.action === "door") checkDoor(a, aat, E, W);
          if (a.action === "rotate") checkAxis(a.axis, `${aat}.axis`, E);
        });
      }
    });
  }

  // entityConfig
  if (spec.entityConfig) {
    if (typeof spec.entityConfig !== "object" || Array.isArray(spec.entityConfig)) {
      E("entityConfig должен быть объектом { \"entity_id\": { … } }");
    } else {
      const known = new Set((spec.bindings || []).map((b) => b && b.entity).filter(Boolean));
      for (const [key, cfg] of Object.entries(spec.entityConfig)) {
        if (!known.has(key)) W(`entityConfig.${key}: такой сущности нет среди bindings — блок не будет применён`);
        if (cfg && cfg.kind && !["raw", "number", "boolean", "brightness", "attribute"].includes(cfg.kind)) {
          E(`entityConfig.${key}.kind «${cfg.kind}»: допустимы raw, number, boolean, brightness, attribute`);
        }
      }
    }
  }

  // params
  if (spec.params) {
    if (!Array.isArray(spec.params)) E("params должен быть массивом");
    else spec.params.forEach((p, i) => {
      if (!p || !p.key) E(`params[${i}]: не задан key`);
      if (p && p.type && !PARAM_TYPES.has(p.type)) E(`params[${i}].type «${p.type}»: допустимы ${[...PARAM_TYPES].join(", ")}`);
      if (p && p.type === "select" && !Array.isArray(p.options)) E(`params[${i}]: для type select нужен options: [{value,label}]`);
    });
  }

  return { errors, warnings };
}

function checkDoor(door, at, E, W) {
  if (door.slide) {
    if (door.degrees !== undefined) W(`${at}: при slide: true поле degrees не используется (нужен span)`);
    if (door.hinge !== undefined) W(`${at}: при slide: true поле hinge не используется`);
    if (door.span === undefined) W(`${at}: для сдвига укажите span (величина сдвига в метрах)`);
  } else {
    if (!door.hinge) W(`${at}: не задан hinge (left/right/top/bottom) — дверь будет вращаться вокруг своего центра`);
    if (door.span !== undefined) W(`${at}: поле span используется только при slide: true`);
    checkAxis(door.axis, `${at}.axis`, E);
  }
  if (door.degrees !== undefined && !(Number(door.degrees) > 0)) E(`${at}.degrees должен быть больше нуля`);
}

function checkAxis(axis, at, E) {
  if (axis === undefined) return;
  if (!["x", "y", "z"].includes(String(axis).toLowerCase())) E(`${at} «${axis}»: допустимы x, y, z`);
}

// ---- прогон -----------------------------------------------------------------

let totalErrors = 0;
let totalWarnings = 0;
const report = [];

for (const target of args) {
  let files;
  try {
    files = await collect(target);
  } catch (e) {
    console.error(`✖ ${target}: ${e.message}`);
    totalErrors++;
    continue;
  }
  if (!files.length) {
    console.error(`✖ ${target}: не найдено файлов спецификации`);
    totalErrors++;
    continue;
  }

  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    let spec;
    try {
      spec = await readSpec(file);
    } catch (e) {
      console.error(`✖ ${rel}: ${e.message}`);
      totalErrors++;
      continue;
    }
    const { errors, warnings } = validate(spec, file);
    totalErrors += errors.length;
    totalWarnings += warnings.length;
    report.push({ file: rel, errors, warnings });

    if (!quiet) {
      const mark = errors.length ? "✖" : warnings.length ? "▲" : "✔";
      console.log(`${mark} ${rel}`);
      for (const e of errors) console.log(`    ошибка: ${e}`);
      for (const w of warnings) console.log(`    предупреждение: ${w}`);
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ ok: totalErrors === 0, errors: totalErrors, warnings: totalWarnings, files: report }, null, 2));
} else {
  console.log("");
  console.log(`  файлов: ${report.length}, ошибок: ${totalErrors}, предупреждений: ${totalWarnings}`);
  console.log(totalErrors ? "  спецификация не готова — исправьте ошибки" : "  спецификация корректна");
}

process.exit(totalErrors ? 1 : 0);
