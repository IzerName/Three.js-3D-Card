// ============================================================================
//  T-012: привязки модели из glTF extras (кастомные свойства Blender).
//
//  Автор модели при экспорте в .gltf/.glb помечает узлы пространством
//  «t3d»:
//    * вложенная пометка: extras.t3d = { entity, action, name, lumens, on,
//      off, degrees, hinge, axis, round_per_second, template, hide, open }
//    * плоская пометка (совместимость): t3d_entity, t3d_action, t3d_name, …
//  Вложенная пометка приоритетнее плоской (накладывается поверх).
//
//  В рантайме пометки уже в сцене: GLTFLoader three.js копирует node.extras
//  прямо в userData (assignExtrasToUserData), поэтому после загрузки
//  достаточно обходить дерево (collectUserDataMarks).
//  Для редактора (чтобы поля привязок появились ДО постройки сцены) файл
//  читается здесь напрямую: только JSON-часть, без бинарных буферов,
//  мешей и без three.js:
//    * .gltf — файл целиком JSON;
//    * .glb  — заголовок 12 байт {magic, version, length} + список чанков
//              {length, type}; JSON-чанк имеет type 0x4E4F534A ("JSON").
//              JSON в чанке может быть дополнен 0x00 или 0x20 до кратной
//              4 границы — оба варианта отрезаются.
//
//  Пространство имён «t3d» не пересекается с пользовательскими extras и
//  внутренними полями загрузчика (например, extras.targetNames).
// ============================================================================

// ==== константы ==============================================================

// Действия, известные движку правил (T-012 + T-013). «play» —
// проигрывание glTF-клипа по состоянию сущности. Остальные пометки
// помечаются rejectedDeclared и превращаются в предупреждение, а сцена
// не ломается.
const KNOWN_ACTIONS = ["light", "color", "hide", "rotate", "door", "text", "play"];

// ==== утилиты =================================================================

/** Число или null; числовые строки ("800") тоже принимаются. */
function isNum(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function decodeUtf8(u8) {
  return new TextDecoder("utf-8").decode(u8);
}

/** JSON-чанк GLB: обход чанков до type "JSON", обрезка padding'а. */
function glbJsonChunk(u8, dv) {
  const total = Math.min(dv.getUint32(8, true), u8.length);
  let off = 12;
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    off += 8;
    if (off + len > total) break;
    if (type === 0x4e4f534a) {
      let end = off + len;
      // GLB-спека требует padding 0x00, на практике встречаются 0x20 —
      // обрезаем оба.
      while (end > off && (u8[end - 1] === 0x00 || u8[end - 1] === 0x20)) end--;
      return decodeUtf8(u8.subarray(off, end));
    }
    off += len;
  }
  throw new Error("в GLB не найден JSON-чанк");
}

/**
 * glTF-JSON из ArrayBuffer: magic "glTF" (0x46546c67, little-endian) —
 * это GLB, ищем JSON-чанк; иначе декодируем весь буфер как UTF-8.
 */
function gltfJsonFromBuffer(buffer) {
  const u8 = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (u8.length < 4) throw new Error("файл слишком мал, чтобы быть glTF");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) === 0x46546c67) {
    if (u8.length < 12) throw new Error("битый GLB: короткий заголовок");
    return JSON.parse(glbJsonChunk(u8, dv));
  }
  return JSON.parse(decodeUtf8(u8));
}

// ==== чтение файла ===========================================================

/**
 * Прочитать именованные узлы и их extras из glTF/GLB-файла.
 *
 * @param {string} url URL файла.
 * @param {Function} [fetchFn] свой fetch (в тестах); по умолчанию глобальный.
 * @returns {Promise<Array<{name: string, extras: object|null}>>}
 * @throws {Error} файл не читается (сеть, битый JSON, не glTF).
 */
export async function readGltfExtras(url, fetchFn) {
  const doFetch = fetchFn || globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("fetch недоступен — файл модели прочитать нельзя");
  const res = await doFetch(url);
  if (!res || !res.ok) {
    const code = res && res.status ? ` (${res.status})` : "";
    throw new Error(`не удалось прочитать файл модели${code}: ${url}`);
  }
  const gltf = gltfJsonFromBuffer(await res.arrayBuffer());
  const out = [];
  for (const n of (gltf && gltf.nodes) || []) {
    if (!n || !n.name) continue;
    out.push({
      name: String(n.name),
      extras: (n.extras && typeof n.extras === "object") ? n.extras : null,
    });
  }
  return out;
}

// ==== разбор пометок =========================================================

/**
 * extras одного узла → «пометка»: плоские t3d_* поля + вложенный t3d
 * (вложенный поверх плоского). Пометки нет → null.
 *
 * Вложенный t3d с полем «key» — это ВЕТКА карточки (ctx.tag на объектах
 * сцены), а не пометка автора: её игнорируем, чтобы тег не принимался
 * за пустую пометку.
 */
function parseMark(extras) {
  if (!extras || typeof extras !== "object") return null;
  const m = {};
  for (const [k, v] of Object.entries(extras)) {
    if (k.startsWith("t3d_")) m[k.slice(4)] = v;
  }
  const nested = extras.t3d;
  if (nested && typeof nested === "object" && nested.key === undefined) {
    Object.assign(m, nested);
  }
  return Object.keys(m).length ? m : null;
}

/** hide → предикат состояния (в предразобранном виде для правила). */
function parseHideStates(hide) {
  if (hide === true) return { states: ["off", "closed", "unavailable", "unknown"], invert: true };
  if (hide === false) return null;
  const list = Array.isArray(hide) ? hide : [hide];
  const states = list.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  return states.length ? { states, invert: false } : null;
}

/**
 * Действия пометки: объявленные (t3d_action: "light, door" или ["rotate"])
 * плюс выведенные по параметрам (lumens → light, on/off → color и т.п.).
 * Неизвестные действия и пометки без действий — в warnings; сцену не ломаем.
 */
function markActions(mark, name, warnings) {
  const declared = [];
  let rejectedDeclared = false;
  const raw = mark.action;
  if (raw !== undefined && raw !== null) {
    const parts = Array.isArray(raw) ? raw : String(raw).split(/[\s,;]+/);
    for (const p of parts) {
      const a = String(p).trim().toLowerCase();
      if (!a) continue;
      if (!KNOWN_ACTIONS.includes(a)) {
        // Причина уже сообщена отдельным предупреждением — «без действий»
        // к ней не добавляем, чтобы не дублировать.
        rejectedDeclared = true;
        if (warnings) warnings.push(`объект «${name}»: неизвестное действие «${a}» — пропускается`);
        continue;
      }
      if (!declared.includes(a)) declared.push(a);
    }
  }
  const inferred = [];
  if (isNum(mark.lumens) !== null || mark.color !== undefined) inferred.push("light");
  if (mark.on !== undefined || mark.off !== undefined) inferred.push("color");
  if (mark.degrees !== undefined || mark.hinge !== undefined || mark.open !== undefined) inferred.push("door");
  if (mark.axis !== undefined || mark.round_per_second !== undefined) inferred.push("rotate");
  if (mark.template !== undefined) inferred.push("text");
  // play выводится только по clip: speed/on/mode/loop сами по себе не
  // делают из пометки проигрывание клипа (on — поле цвета из T-012).
  if (mark.clip !== undefined && mark.clip !== null && mark.clip !== "") inferred.push("play");
  if (mark.hide !== undefined && mark.hide !== null && mark.hide !== false) inferred.push("hide");
  const out = declared.concat(inferred.filter((a) => !declared.includes(a)));
  if (out.length === 0 && !rejectedDeclared && warnings) {
    warnings.push(`объект «${name}»: пометка t3d без действий — сущность появится в редакторе, но ничего происходить не будет`);
  }
  return out;
}

/** Ввод данных одного действия (явный элемент массива actions правила). */
function actionEntry(mark, action) {
  switch (action) {
    case "light": {
      const e = { action: "light" };
      const lumens = isNum(mark.lumens);
      if (lumens !== null) e.lumens = lumens;
      if (mark.color !== undefined && mark.color !== null) e.color = mark.color;
      return e;
    }
    case "color": {
      const colors = {};
      if (mark.on !== undefined && mark.on !== null) colors.on = mark.on;
      if (mark.off !== undefined && mark.off !== null) colors.off = mark.off;
      return Object.keys(colors).length ? { action: "color", colors } : null;
    }
    case "door": {
      const e = { action: "door" };
      if (mark.hinge !== undefined && mark.hinge !== null) e.hinge = String(mark.hinge).trim().toLowerCase();
      const degrees = isNum(mark.degrees);
      if (degrees !== null) e.degrees = degrees;
      if (mark.open !== undefined && mark.open !== null) e.open = mark.open;
      return e;
    }
    case "rotate": {
      const e = { action: "rotate" };
      if (mark.axis !== undefined && mark.axis !== null) e.axis = String(mark.axis).trim().toLowerCase();
      const rps = isNum(mark.round_per_second);
      if (rps !== null) e.round_per_second = rps;
      return e;
    }
    case "text":
      return mark.template !== undefined ? { action: "text", template: String(mark.template) } : null;
    case "hide": {
      const hidden = parseHideStates(mark.hide);
      return hidden ? { action: "hide", hidden } : null;
    }
    case "play": {
      // clip обязателен: без имени клипа действие play не создаётся
      // (preparePlayRule напишет предупреждение «play без клипа»).
      if (mark.clip === undefined || mark.clip === null || mark.clip === "") return null;
      const e = { action: "play", clip: String(mark.clip).trim() };
      if (mark.mode !== undefined && mark.mode !== null) e.mode = String(mark.mode).trim().toLowerCase();
      if (mark.loop !== undefined && mark.loop !== null) e.loop = String(mark.loop).trim().toLowerCase();
      const speed = isNum(mark.speed);
      if (speed !== null) e.speed = speed;
      if (mark.reverse !== undefined && mark.reverse !== null) {
        e.reverse = mark.reverse === true || String(mark.reverse).trim().toLowerCase() === "true";
      }
      // on/valueMax из extras не читаем: поле on в T-012 — это цвет
      // (t3d_on), а play-список состояний живёт только в спеке правил;
      // по умолчанию играет при state "on".
      return e;
    }
    default:
      return null;
  }
}

/**
 * Привязки из пометок: объекты группируются по entity (без entity — по
 * имени объекта, ключ = имя, сущность выберет пользователь в редакторе).
 * Действия берутся из всех пометок группы; один объект может давать
 * несколько правил (lamp + цвета → actions: [light, color]).
 *
 * @returns {{bindings: Array, warnings: Array, markedCount: number}}
 *   bindings — элементы вида { key, entity, name, target, actions,
 *   _source: "extras" } — готовы и для движка правил (collectBindings),
 *   и для редактора (нужно только преобразовать в editor-форму).
 */
export function extrasToBindings(nodes) {
  const warnings = [];
  const groups = new Map();
  let markedCount = 0;

  for (const node of nodes || []) {
    if (!node || !node.name) continue;
    const mark = parseMark(node.extras);
    if (!mark) continue;
    markedCount++;
    const name = node.name;
    const entity = mark.entity !== undefined && mark.entity !== null && String(mark.entity).trim()
      ? String(mark.entity).trim()
      : null;
    const key = entity || name;
    const actions = markActions(mark, name, warnings);

    let g = groups.get(key);
    if (!g) {
      // Подпись для редактора: авторское имя из пометки (t3d.name), иначе
      // имя объекта. entity_id — не подпись, он в b.entity.
      const label = mark.name !== undefined && String(mark.name).trim()
        ? String(mark.name).trim()
        : name;
      g = { key, entity, label, names: [], marks: [], actions: [] };
      groups.set(key, g);
    }
    if (!g.names.includes(name)) g.names.push(name);
    if (entity && !g.entity) g.entity = entity;
    for (const a of actions) if (!g.actions.includes(a)) g.actions.push(a);
    g.marks.push(mark);
  }

  const bindings = [];
  for (const g of groups.values()) {
    const actions = [];
    for (const a of g.actions) {
      let entry = null;
      for (const mark of g.marks) {
        if (markActions(mark, null, null).includes(a)) {
          entry = actionEntry(mark, a);
          if (entry) break;
        }
      }
      if (entry) actions.push(entry);
    }
    bindings.push({
      key: g.key,
      entity: g.entity || "",
      name: g.label,
      target: g.names.length > 1 ? g.names : g.names[0],
      actions,
      _source: "extras",
    });
  }
  return { bindings, warnings, markedCount };
}

/**
 * Пометки из загруженной сцены (путь рантайма): GLTFLoader уже положил
 * node.extras в userData. Тег карточки (userData.t3d с полем «key»)
 * parseMark отфильтрует.
 *
 * @param {import("three").Object3D} root корень модели (до ветвления).
 * @returns {Array<{name: string, extras: object}>}
 */
export function collectUserDataMarks(root) {
  const out = [];
  if (!root || typeof root.traverse !== "function") return out;
  root.traverse((n) => {
    if (!n || !n.name) return;
    const ud = n.userData;
    if (!ud || typeof ud !== "object") return;
    // parseMark — единственный источник истины: тег карточки (t3d с «key»)
    // и посторонние extras мимо.
    if (parseMark(ud)) out.push({ name: n.name, extras: ud });
  });
  return out;
}

// ==== слияние =================================================================

/**
 * Спека-привязки + extras-привязки: приоритет у спецификации, конфликт —
 * предупреждение (не ошибка).
 *
 * @param {Array} specList   bindings из модели (def.bindings).
 * @param {Array} extrasList результат extrasToBindings().bindings.
 * @param {Function} [report] (message) — куда слать предупреждение.
 */
export function mergeBindingsExtras(specList, extrasList, report) {
  const out = [];
  const seen = new Set();
  for (const b of specList || []) {
    if (!b) continue;
    out.push(b);
    if (b.entity) seen.add(String(b.entity));
    if (b.key) seen.add(String(b.key)); // editor-форма: сущность ещё не выбрана
  }
  for (const e of extrasList || []) {
    if (!e) continue;
    if (seen.has(e.key)) {
      if (report) report(`конфликт привязок: «${e.key}» задана и в спецификации модели, и в extras — приоритет у спецификации`);
      continue;
    }
    seen.add(e.key);
    out.push(e);
  }
  return out;
}

/**
 * Списки привязок РЕДАКТОРА (editor-форма): дубль ключей недопустим
 * (normalizeBindings бросает исключение), поэтому существующие записи
 * побеждают, extras-привязки добавляются только со свободным ключом.
 */
export function mergeEditorBindings(specList, extrasList) {
  const out = [];
  const seen = new Set();
  for (const b of specList || []) {
    if (!b || !b.key) continue;
    out.push(b);
    seen.add(b.key);
  }
  for (const b of extrasList || []) {
    if (!b || !b.key || seen.has(b.key)) continue;
    seen.add(b.key);
    out.push(b);
  }
  return out;
}
