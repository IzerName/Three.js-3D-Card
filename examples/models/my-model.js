// ============================================================================
//  Пример собственной модели для threejs-3d-card.
//
//  Куда положить файл:
//     config/www/3d-models/my-model.js
//  Как подключить:
//     в редакторе карточки: Модель -> «Импортировать модель по URL…»
//                            -> /local/3d-models/my-model.js
//     либо в YAML: model: /local/3d-models/my-model.js
//
//  Файл не требует сборки и импортов: всё нужное лежит в
//  window.ThreeJS3DCard, а three.js приходит в create(ctx) как ctx.THREE.
//  Полное описание контракта — docs/MODEL_API.md.
// ============================================================================

(() => {
  const api = window.ThreeJS3DCard;
  if (!api) {
    console.error("[my-model] window.ThreeJS3DCard не найден: карточка threejs-3d-card не загружена");
    return;
  }

  api.defineModel({
    // ---- паспорт модели ---------------------------------------------------
    manifest: {
      id: "my-model",
      name: "Моя модель",
      description: "Пример: вращающийся куб, цвет и подсветка зависят от сущностей",
      apiVersion: 1,
      icon: "mdi:cube-outline",
      camera: {
        target: [0, 0.6, 0],
        radius: 5.5,
        phi: 1.15,
        theta: 0.6,
        minRadius: 2.5,
        maxRadius: 14,
      },
      environment: { floor: "radial", shadows: false },
      size: { defaultHeight: 380, minHeight: 240, maxHeight: 800 },
    },

    // ---- переменные модели: из них редактор строит поля выбора ------------
    bindings: [
      {
        key: "power",
        name: "Питание",
        group: "Управление",
        domain: ["switch", "input_boolean", "binary_sensor"],
        value: { kind: "boolean" },
        hint: "Куб подсвечивается и начинает вращаться",
      },
      {
        key: "speed",
        name: "Скорость вращения",
        group: "Управление",
        domain: ["sensor", "input_number", "number"],
        hint: "Числовое значение: 0…100 условных единиц",
        value: {
          kind: "number",
          scale: { from: { min: 0, max: 100 }, to: { min: 0, max: 2 } },
        },
      },
      {
        key: "alarm",
        name: "Авария",
        group: "Контроль",
        domain: ["binary_sensor"],
        value: { kind: "boolean" },
        hint: "Куб становится красным и пульсирует",
      },
    ],

    // ---- настройки внешнего вида ------------------------------------------
    params: [
      { key: "color", name: "Цвет куба", type: "theme-color", default: "var(--primary-color)" },
      { key: "size", name: "Размер куба, м", type: "range", default: 1, min: 0.3, max: 2, step: 0.1 },
      { key: "label", name: "Подпись", type: "text", default: "Моя модель" },
    ],

    defaults: {
      // Высоту карточки не задаём: без `height` она занимает доступную область,
      // а рекомендация для раскладки — manifest.size.defaultHeight.
      config: { title: "Моя модель", show_hud: true },
    },

    // ---- построение сцены -------------------------------------------------
    create(ctx) {
      // three.js всегда берём из контекста: на верхнем уровне файла его ещё нет.
      const THREE = ctx.THREE;

      const group = new THREE.Group();

      // Материал и геометрию создаём один раз: в frame() их менять нельзя.
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const material = new THREE.MeshStandardMaterial({
        color: ctx.resolveColor(ctx.params.color, "#1f6feb"),
        metalness: 0.35,
        roughness: 0.45,
      });
      const cube = new THREE.Mesh(geometry, material);
      cube.position.y = 0.6;
      group.add(cube);

      // Подпись-спрайт читается при любом масштабе.
      const label = ctx.makeLabel(ctx.params.label || "Моя модель", { scale: 0.0042 });
      label.position.set(0, 1.75, 0);
      group.add(label);

      // Клик по кубу откроет модальное окно сущности привязки "power".
      ctx.tag(cube, "power");

      // Текущее состояние модели
      const state = { on: false, alarm: false, speed: 0.4, pulse: 0 };
      const baseColor = new THREE.Color(ctx.resolveColor(ctx.params.color, "#1f6feb"));
      const alarmColor = new THREE.Color("#e53935");

      function applyVisual() {
        const target = state.alarm ? alarmColor : baseColor;
        material.color.copy(target);
        material.emissive.copy(target);
        material.emissiveIntensity = state.alarm ? 0.85 : (state.on ? 0.35 : 0);
      }
      applyVisual();

      return {
        root: group,

        /** Состояния всех привязок: { key: {entity, state, value, available} } */
        applyStates(view) {
          const power = view.power || {};
          const speed = view.speed || {};
          const alarm = view.alarm || {};

          state.on = !!power.value;
          state.alarm = !!alarm.value;
          state.speed = Number.isFinite(speed.value) ? speed.value : 0.4;

          // Недоступная сущность — сообщаем в диагностику карточки
          if (power.entity && !power.available) ctx.report("warn", `Питание недоступно: ${power.entity}`);

          label.userData.redraw(
            `${ctx.params.label || "Моя модель"}: ${state.on ? "ВКЛ" : "ВЫКЛ"}`
          );
          applyVisual();
          ctx.requestRender();
        },

        /** Изменения настроек из редактора — без пересоздания сцены. */
        applyConfig(config) {
          const p = config.params || {};
          const s = Number.isFinite(p.size) ? p.size : 1;
          cube.scale.setScalar(s);
          cube.position.y = 0.6 * s;
          baseColor.set(ctx.resolveColor(p.color, "#1f6feb"));
          if (p.label) label.userData.redraw(String(p.label));
          applyVisual();
        },

        /** Анимация: dt в секундах (0 при «уменьшенной анимации» в системе). */
        frame(dt) {
          if (!state.on && !state.alarm) return;
          cube.rotation.y += dt * state.speed;
          if (state.alarm) {
            state.pulse += dt * 4;
            material.emissiveIntensity = 0.4 + 0.5 * Math.abs(Math.sin(state.pulse));
          }
        },

        /** Освобождаем всё, что создали. */
        dispose() {
          geometry.dispose();
          material.dispose();
        },
      };
    },
  });

  console.info("[my-model] модель зарегистрирована");
})();
