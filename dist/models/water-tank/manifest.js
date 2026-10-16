// ============================================================================
//  Модель «Бак чистой воды» — манифест.
//
//  Здесь описано ВСЁ, что видит пользователь в редакторе карточки:
//  метаданные, привязки к сущностям Home Assistant (bindings) и параметры
//  внешнего вида (params). Сама сцена — в scene.js.
//
//  Файл намеренно не тянет three.js: редактор карточки должен показывать
//  форму, даже если сцена ещё не создана.
// ============================================================================

export const waterTankModel = {
  manifest: {
    id: "water-tank",
    name: "Бак чистой воды",
    description: "Горизонтальный бак с водой, датчиками уровня и счётчиком",
    icon: "mdi:water",
    apiVersion: 1,
    // Сцену рисует собственный движок модели: карточка не создаёт свой рендерер.
    host: "external",
    author: "threejs-3d-card",
    camera: {
      mode: "orbit",
      target: [0, 0.06, 0],
      radius: 4.6,
      phi: 1.19,
      theta: 0.62,
      minRadius: 2.2,
      maxRadius: 11,
      panoramic: true,
      tilt: true,
    },
    environment: {
      floor: "radial",
      hemiIntensity: 0.55,
      keyIntensity: 1.05,
      rimIntensity: 0.7,
    },
    size: { defaultHeight: 400, minHeight: 260, maxHeight: 900 },
  },

  // --------------------------------------------------------------------------
  //  Привязки: из этого списка редактор строит поля выбора устройств.
  // --------------------------------------------------------------------------
  bindings: [
    {
      key: "level",
      name: "Уровень воды, %",
      group: "Уровень",
      required: true,
      domain: ["sensor", "input_number", "number"],
      unit: ["%"],
      value: { kind: "number" },
      hint: "Основной датчик: управляет заполнением бака. Значение делится на «Значение, равное 100 %»",
    },
    {
      key: "liters",
      name: "Объём, л",
      group: "Уровень",
      domain: ["sensor", "input_number", "number"],
      hint: "Необязательно: точный объём для подписи. Без него объём оценивается по max_liters",
    },
    {
      key: "counter",
      name: "Счётчик чистой воды",
      group: "Учёт",
      domain: ["sensor", "input_number", "number"],
      hint: "Необязательно: накопительный счётчик, показывается внизу сцены",
    },

    {
      key: "high",
      name: "Датчик высокого уровня",
      group: "Датчики на баке",
      domain: ["binary_sensor", "input_boolean", "switch"],
      value: { kind: "boolean" },
      hint: "Светодиод на баке загорается при срабатывании",
    },
    {
      key: "medium",
      name: "Датчик среднего уровня",
      group: "Датчики на баке",
      domain: ["binary_sensor", "input_boolean", "switch"],
      value: { kind: "boolean" },
    },
    {
      key: "low",
      name: "Датчик низкого уровня",
      group: "Датчики на баке",
      domain: ["binary_sensor", "input_boolean", "switch"],
      value: { kind: "boolean" },
    },
  ],

  // --------------------------------------------------------------------------
  //  Параметры внешнего вида: значения по умолчанию и типы полей.
  // --------------------------------------------------------------------------
  params: [
    {
      key: "full_value",
      name: "Значение, равное 100 %",
      type: "number",
      default: 100,
      min: 1,
      description: "Например, если датчик отдаёт 0…1000 — укажите 1000",
    },
    {
      key: "max_liters",
      name: "Объём бака, л",
      type: "number",
      default: 200,
      min: 1,
      description: "Используется для оценки «≈ N л», если не привязана сущность объёма",
    },
    {
      key: "level_color",
      name: "Цвет воды",
      type: "theme-color",
      default: "var(--color-2)",
      description: "Поддерживаются переменные темы Home Assistant, например var(--color-2)",
    },
    {
      key: "tank_radius",
      name: "Радиус бака, м",
      type: "number",
      default: 0.55,
      min: 0.1,
      step: 0.05,
      group: "Геометрия",
    },
    {
      key: "tank_length",
      name: "Длина бака, м",
      type: "number",
      default: 1.7,
      min: 0.2,
      step: 0.05,
      group: "Геометрия",
    },
    {
      key: "wall",
      name: "Толщина стенки, м",
      type: "number",
      default: 0.05,
      min: 0.005,
      step: 0.005,
      group: "Геометрия",
    },

    {
      key: "probe_levels.high",
      name: "Датчик «высокий», % уровня",
      type: "range",
      default: 85,
      min: 0,
      max: 100,
      step: 1,
      group: "Расположение датчиков",
    },
    {
      key: "probe_levels.medium",
      name: "Датчик «средний», % уровня",
      type: "range",
      default: 50,
      min: 0,
      max: 100,
      step: 1,
      group: "Расположение датчиков",
    },
    {
      key: "probe_levels.low",
      name: "Датчик «низкий», % уровня",
      type: "range",
      default: 25,
      min: 0,
      max: 100,
      step: 1,
      group: "Расположение датчиков",
    },
  ],

  defaults: {
    config: {
      title: "Бак чистой воды",
      show_hud: true,
      // Высоту карточки не задаём: без `height` она занимает доступную
      // область, а рекомендация для раскладки — manifest.size.defaultHeight.
    },
  },

  /** Ленивая загрузка сцены: three.js грузится только когда карточка на экране. */
  async create(ctx) {
    const mod = await import("./scene.js");
    return mod.create(ctx);
  },
};

export default waterTankModel;
