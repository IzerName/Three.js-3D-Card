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

import { loadGeometryEx, normalizeSource } from "./geometry.js";
import { createRuleEngine } from "./object-rules.js";
import { normalizeBindings, normalizeParams } from "./bindings.js";
import { clamp, prefersReducedMotion } from "./util.js";
import {
  readGltfExtras, extrasToBindings, collectUserDataMarks, mergeBindingsExtras,
} from "./gltf-extras.js";

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
  *   def.bindingsFrom — { gltfExtras: true }: дополнительно читать привязки
  *       из extras файла модели (T-012); приоритет у def.bindings
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
  // T-012: читать привязки из extras файла модели (кастомные свойства Blender).
  const extrasMode = !!(def.bindingsFrom && def.bindingsFrom.gltfExtras);

  // T-013: prefers-reduced-motion — карточка передаёт frame(0) (время не
  // идёт), а правилам play нужно знать об этом: вместо проигрывания клипа
  // ставить позу сразу на целевую точку. MediaQueryList кэшируем один раз
  // (matchMedia дёшев, но не каждый кадр); в среде без window — false.
  let motionQuery = null;
  try {
    if (typeof window !== "undefined" && window.matchMedia) {
      motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    }
  } catch (e) { motionQuery = null; }
  const isReducedMotion = () =>
    motionQuery ? motionQuery.matches : prefersReducedMotion();

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

  /**
   * T-012: прочитать привязки из extras файла модели ДО постройки сцены.
   *
   * Редактор вызывает это после resolve модели (см. src/editor.js): поля
   * привязок появляются в форме сразу, сущности с заданным в пометке
   * entity_id подставляются автоматически. Нечитаемый файл — НЕ ошибка и
   * не пустые поля без следа: возвращается предупреждение, которое
   * редактор показывает в блоке привязок.
   *
   * @param {object} [ctx] контекст: asset(), fetch (произвольная, для тестов).
   * @returns {Promise<{bindings: Array, warnings: Array}>}
   */
  async function discoverBindings(ctx = {}) {
    try {
      const source = normalizeSource(
        def.source,
        ctx.asset ? ctx.asset(".") : undefined,
      );
      if (source.format !== "gltf") {
        throw new Error("bindingsFrom.gltfExtras: доступны только для glTF/GLB-моделей");
      }
      const nodes = await readGltfExtras(source.url, ctx.fetch);
      const res = extrasToBindings(nodes);
      return {
        bindings: res.bindings.map((b, i) => toEditorExtrasBinding(b, i)),
        warnings: res.warnings,
      };
    } catch (e) {
      return { bindings: [], warnings: [e && e.message ? e.message : String(e)] };
    }
  }

  return {
    manifest,
    bindings: editorBindings,
    params: def.params || [],
    // Высоту карточки по умолчанию не задаём: без `height` она занимает всю
    // доступную область, а рекомендация для раскладки — manifest.size.
    defaults: def.defaults || { config: { title: manifest.name, show_hud: true } },
    // Источник геометрии из спека (для редактора: показать ожидаемый путь).
    // Реестр моделей своё поле .source перезаписывает маркером источника,
    // поэтому имя у нас другое.
    fileSource: def.source,
    ...(extrasMode ? { discoverBindings } : {}),

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
      const source = normalizeSource(
        def.source,
        ctx.asset ? ctx.asset(".") : undefined,
      );

      // T-013: вместе с клон-деревом получаем клипы glTF; миксер живёт на
      // дереве геометрии (без подписей и источников света) и ведёт время
      // клипов, а правила play задают ему цель.
      const { root: model, animations } = await loadGeometryEx(ctx, source);
      const group = new THREE.Group();
      group.name = manifest.id;
      group.add(model);
      const mixer = animations.length ? new THREE.AnimationMixer(model) : null;

      // Автоматическая установка камеры по габаритам модели: пользователю не
      // нужно подбирать радиус, а модель видно целиком сразу после установки.
      let bounds = null;
      try {
        bounds = new THREE.Box3().setFromObject(group);
      } catch (e) {
        ctx.report && ctx.report("warn", `не удалось определить габариты модели: ${e.message}`);
      }

      // T-012: привязки из extras файла модели. GLTFLoader уже положил
      // node.extras в userData — собираем пометки ДО разметки объектов
      // (ctx.tag перезаписывает userData.t3d на всё поддерево).
      let mergedBindings = bindingsSpec;
      if (extrasMode) {
        const marked = collectUserDataMarks(model);
        const res = extrasToBindings(marked);
        ctx.report && ctx.report("info",
          `файл модели: объектов с пометками t3d — ${res.markedCount}, привязок из extras — ${res.bindings.length}`);
        for (const w of res.warnings) ctx.report && ctx.report("warn", w);
        mergedBindings = mergeBindingsExtras(bindingsSpec, res.bindings,
          (m) => { ctx.report && ctx.report("warn", m); });
        // Без entity сущность выбирает пользователь в редакторе карточки.
        for (const b of mergedBindings) {
          if (b.entity) continue;
          const targets = Array.isArray(b.target) ? b.target : [b.target].filter(Boolean);
          ctx.report && ctx.report("info",
            `«${b.name}» (${targets.join(", ")}): сущность не задана — выберите её в редакторе карточки`);
        }
      }

      const ruleEngine = createRuleEngine(
        Object.assign({}, def, { bindings: mergedBindings }), ctx, group,
        { root: model, animations, mixer });

      // Привязки без действия, но с доменом — тоже поддерживаем: клик по
      // объекту покажет состояние сущности в модальном окне карточки.
      // T-012: размечаем ВСЕ привязки (спека и extras); у привязок спека
      // key отсутствует — старое поведение (клик просто откроет сущность).
      for (const b of mergedBindings) {
        if (!b.target) continue;
        const targets = Array.isArray(b.target) ? b.target : [b.target];
        for (const t of targets) tagObjectByTarget(group, t, b.entity, b.key, ctx);
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
          // Правила сначала (цели), потом миксер (T-013): применяет позу
          // клипа, которую play только что задала. reducedMotion —
          // правила не анимируют, а ставят позу сразу.
          ruleEngine.frame(dt, state.time, isReducedMotion());
          if (mixer) mixer.update(dt);
        },

        resize() { /* камера настраивается по габаритам, пересчёт не нужен */ },

        dispose() {
          ruleEngine.dispose();
          // T-013: миксер остановлен — действия сняты, позы объектов
          // возвращаются к исходным (engine.dispose делает то же, дубли
          // безвредны).
          if (mixer) mixer.stopAllAction();
          // Геометрии и текстуры — общие для всех сцен (кэш), их не трогаем;
          // освобождаем только собственные копии материалов и те геометрии,
          // которые правила завели себе сами (створка с петлёй — см.
          // prepareHinge: перенос необратим, поэтому копия обязана быть своей).
          group.traverse((n) => {
            if (n.isMesh && n.userData && n.userData._t3dOwnGeometry
                && n.geometry && n.geometry.dispose) {
              n.geometry.dispose();
            }
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
  if (b.play) parts.push("проигрывание клипа");
  for (const a of b.actions || []) if (a.action) parts.push(a.action);
  return parts.length && b.target ? `Объект модели: ${[].concat(b.target).join(", ")} — ${parts.join(", ")}` : "";
}

/**
 * Пометить объекты модели, чтобы клик по ним открывал сущность.
 * T-012: key — ключ привязки (у привязок спека отсутствует → null,
 * старое поведение; у extras — entity_id или имя объекта, и клик
 * подставляет сущность, выбранную пользователем в редакторе).
 */
function tagObjectByTarget(root, target, entityId, key, ctx) {
  const k = key || null;
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
    if (ctx.tag) ctx.tag(obj, k, { entity: entityId || null });
    else obj.userData.t3d = { key: k, entity: entityId || null };
  }
}

/**
 * T-012: extras-привязка → форма для редактора (совместима с
 * normalizeBindings из bindings.js). required: true — если пользователь
 * не выбрал сущность, normalizeConfig напишет «Не выбрана сущность…».
 * Поле entity — автозаполнение: редактор подставит его в конфиг, если
 * пользователь ничего не выбирал сам.
 */
function toEditorExtrasBinding(b, i) {
  const targets = [].concat(b.target || []);
  const domain = guessDomain(b.key);
  const actionNames = (b.actions || []).map((a) => a && a.action).filter(Boolean);
  return {
    key: b.key,
    name: b.name || b.key,
    group: "",
    domain: domain ? [domain] : [],
    value: { kind: defaultKindFor(domain, null) },
    entity: b.entity || "",
    hint: `Объект модели: ${targets.join(", ")} — ${actionNames.length ? actionNames.join(", ") : "без действий"}`,
    order: 100 + i,
    required: true,
  };
}
