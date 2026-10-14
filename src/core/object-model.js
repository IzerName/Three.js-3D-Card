// ============================================================================
//  createObjectModel — модель threejs-3d-card из декларативной спецификации.
//
//  Спецификация (обычно JSON или JS-объект) описывает:
//    * где взять файл модели (OBJ+MTL или glTF/GLB);
//    * какие объекты модели реагируют на какие сущности Home Assistant;
//    * что именно происходит: цвет, видимость, подсветка, вращение, дверь, текст.
//
//  Пример:
//    export default createObjectModel({
//      manifest: { id: "house", name: "Дом" },
//      source: { format: "obj", url: "/local/3d/house.obj", mtl: "/local/3d/house.mtl" },
//      bindings: [
//        { entity: "light.kitchen", target: "Lamp_Kitchen",
//          light: { lumens: 800 }, colors: { on: "#ffd9a0", off: "#3a3a3a" } },
//        { entity: "binary_sensor.front_door", target: "Door_Front",
//          door: { hinge: "left", degrees: 95, open: ["on"] } },
//      ],
//    });
// ============================================================================

import { loadGeometry, normalizeSource } from "./geometry.js";
import { createRuleEngine } from "./object-rules.js";
import { normalizeBindings, normalizeParams } from "./bindings.js";
import { clamp } from "./util.js";

/** Тип значения привязки по умолчанию: подсказка движку, как читать сущность. */
function defaultKindFor(domain, hint) {
  if (hint) return hint;
  switch (domain) {
    case "light": return "brightness";
    case "binary_sensor":
    case "switch":
    case "input_boolean":
    case "automation":
    case "script":
      return "boolean";
    case "cover":
    case "climate":
    case "sensor":
    case "input_number":
    case "number":
    case "fan":
    case "media_player":
      return "raw";
    default:
      return "raw";
  }
}

/**
 * Собрать описание модели для карточки.
 * @param {object} def
 *   def.manifest  — паспорт модели (id, name, camera, …)
 *   def.source    — источник геометрии
 *   def.bindings  — привязки сущностей к объектам (см. object-rules.js)
 *   def.entityConfig — переопределения полей привязок для редактора карточки
 *   def.params    — настройки модели (пробрасываются в редактор)
 *   def.options   — { autoFrame: true }
 */
export function createObjectModel(def) {
  if (!def || !def.source) throw new Error("createObjectModel: не указан source (файл модели)");
  const manifest = Object.assign({
    apiVersion: 1,
    // Модель отдаёт карточке готовое дерево объектов (root) и НЕ управляет
    // рендерером: рисует карточка своим WebGLRenderer. Поэтому здесь нет
    // host: "external" — иначе карточка решит, что рендерер создаёт модель,
    // и на холсте не будет ни одного вызова отрисовки.
  }, def.manifest || {});
  if (!manifest.id) throw new Error("createObjectModel: не указан manifest.id");

  const bindingsSpec = def.bindings || [];
  const entityConfig = def.entityConfig || {};

  // Привязки для редактора карточки: из спецификации объектов получаем
  // осмысленные поля, чтобы пользователь выбирал устройства из списка.
  // ВАЖНО: одна сущность может управлять несколькими объектами (например,
  // лампа и подпись к ней). В редакторе это ОДНО поле, поэтому привязки
  // объединяются по entity_id — иначе карточка отвергнет дубликат ключа.
  const editorBindings = [];
  const byEntity = new Map();
  bindingsSpec.forEach((b, i) => {
    if (!b || !b.entity) return;
    const custom = entityConfig[b.entity] || {};
    const domain = custom.domain || guessDomain(b.entity);
    if (byEntity.has(b.entity)) {
      const existing = byEntity.get(b.entity);
      // Подсказку собираем со всех правил: пользователю полезно видеть,
      // что одна сущность управляет несколькими объектами.
      const extra = describeActions(b);
      if (extra) existing.hint = existing.hint ? `${existing.hint}; ${extra}` : extra;
      return;
    }
    const binding = Object.assign({
      key: b.entity,
      name: custom.name || b.name || b.entity,
      group: custom.group || b.group || "",
      domain: domain ? [domain] : [],
      value: { kind: defaultKindFor(domain, custom.kind) },
      hint: custom.hint || describeActions(b),
      order: i,
    }, custom.overrides || {});
    byEntity.set(b.entity, binding);
    editorBindings.push(binding);
  });

  return {
    manifest,
    bindings: editorBindings,
    params: def.params || [],
    defaults: def.defaults || { config: { title: manifest.name, show_hud: true, height: 460 } },

    /**
     * Значения привязок по умолчанию.
     *
     * В спецификации `entity` — это ожидаемый entity_id Home Assistant. Чтобы
     * модель работала сразу после установки (без ручного заполнения карточки),
     * карточка подставляет `entity_id` → `entity_id` для всех привязок.
     * Пользователь может заменить любое значение в редакторе; его выбор
     * приоритетнее (см. src/core/bindings.js, normalizeConfig).
     */
    defaultEntities() {
      if (def.autoEntities === false) return {};
      const out = {};
      for (const b of bindingsSpec) {
        if (!b || !b.entity) continue;
        const custom = entityConfig[b.entity] || {};
        out[b.entity] = custom.defaultEntity || b.entity;
      }
      return out;
    },

    async create(ctx) {
      const THREE = ctx.THREE;
      const source = normalizeSource(def.source, ctx.asset ? ctx.asset(".") : undefined);

      const model = await loadGeometry(ctx, source);
      const group = new THREE.Group();
      group.name = manifest.id;
      group.add(model);

      // Автоматическая установка камеры по габаритам модели: пользователю не
      // нужно подбирать радиус, а модель видно целиком сразу после установки.
      let bounds = null;
      try {
        bounds = new THREE.Box3().setFromObject(group);
      } catch (e) {
        ctx.report && ctx.report("warn", `не удалось определить габариты модели: ${e.message}`);
      }

      const ruleEngine = createRuleEngine(def, ctx, group);

      // Привязки без действия, но с доменом — тоже поддерживаем: клик по
      // объекту покажет состояние сущности в модальном окне карточки.
      for (const b of bindingsSpec) {
        if (!b.target) continue;
        const targets = Array.isArray(b.target) ? b.target : [b.target];
        for (const t of targets) tagObjectByTarget(group, t, b.entity, ctx);
      }

      ctx.report && ctx.report("info", `модель ${manifest.id} загружена, объектов: ${ruleEngine.objectNames().length}`);

      const state = { time: 0 };
      const lastStates = {};

      return {
        root: group,
        // Карточка рисует сцену сама: у неё уже есть рендерер, свет и камера,
        // а также автоустановка камеры по габаритам модели. Флага external
        // здесь быть не должно — с ним карточка не вызывает render().
        external: false,

        /** Движок карточки передаёт состояния по одной привязке. */
        applyState(key, info) {
          if (!info) return;
          // Отладочная выборка последних состояний: видно, дошли ли данные
          // и в каком виде (используется диагностикой и тестами).
          lastStates[key] = { state: info.state ? String(info.state.state) : null, value: info.value };
          ruleEngine.setEntity(key, info);
        },

        /** Пакетное обновление (демо-страница, тесты). */
        applyStates(view, config) {
          for (const [key, info] of Object.entries(view || {})) ruleEngine.setEntity(key, info);
        },

        frame(dt) {
          state.time += dt;
          ruleEngine.frame(dt, state.time);
        },

        resize() { /* камера настраивается по габаритам, пересчёт не нужен */ },

        dispose() {
          ruleEngine.dispose();
          // Геометрии и текстуры — общие для всех сцен (кэш), их не трогаем;
          // освобождаем только собственные копии материалов.
          group.traverse((n) => {
            if (n.isMesh && n.material) {
              const list = Array.isArray(n.material) ? n.material : [n.material];
              for (const m of list) {
                if (m.userData && m.userData._ownMaterial && m.dispose) m.dispose();
              }
            }
          });
        },

        /** Доступ для диагностики и тестов. */
        ruleEngine,
        bounds,
        lastStates,
      };
    },
  };
}

/** Домен из entity_id: "light.kitchen" -> "light". */
function guessDomain(entityId) {
  const m = String(entityId || "").match(/^([a-z_]+)\./);
  return m ? m[1] : "";
}

/** Человекочитаемое описание того, что делает привязка (подсказка в редакторе). */
function describeActions(b) {
  const parts = [];
  if (b.colors || b.color) parts.push("цвет по состоянию");
  if (b.hide !== undefined) parts.push("скрытие");
  if (b.light) parts.push("подсветка");
  if (b.rotate) parts.push("вращение");
  if (b.door) parts.push("открывание");
  if (b.text) parts.push("текст состояния");
  for (const a of b.actions || []) if (a.action) parts.push(a.action);
  return parts.length && b.target ? `Объект модели: ${[].concat(b.target).join(", ")} — ${parts.join(", ")}` : "";
}

/** Пометить объекты модели, чтобы клик по ним открывал сущность. */
function tagObjectByTarget(root, target, entityId, ctx) {
  const matched = [];
  const t = String(target);
  const re = t.includes("*")
    ? new RegExp("^" + t.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i")
    : null;
  root.traverse((n) => {
    if (!n.name) return;
    if (re ? re.test(n.name) : n.name.toLowerCase() === t.toLowerCase()) matched.push(n);
  });
  for (const obj of matched) {
    if (ctx.tag) ctx.tag(obj, null, { entity: entityId });
    else obj.userData.t3d = { key: null, entity: entityId };
  }
}
