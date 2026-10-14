// ============================================================================
//  Модель «Производственное помещение» — манифест.
//
//  Привязки те же, что были в проекте production-room-viewer, но теперь они
//  описаны декларативно: редактор карточки строит форму автоматически,
//  а пользователь выбирает устройства из списка ha-entity-picker.
// ============================================================================

export const productionRoomModel = {
  manifest: {
    id: "production-room",
    name: "Производственное помещение",
    description: "Вид сверху: ВРУ, станок, освещение, пожарная сигнализация, климат, дверь",
    icon: "mdi:factory",
    apiVersion: 1,
    // Сцену рисует собственный движок модели: карточка не создаёт свой рендерер.
    host: "external",
    author: "threejs-3d-card",
    camera: {
      mode: "orbit",
      target: [0, 0.4, 0],
      radius: 19,
      phi: 0.5,
      theta: 0,
      minRadius: 6,
      maxRadius: 40,
      panoramic: true,
      tilt: true,
      minPhi: 0.12,
      maxPhi: 1.45,
    },
    environment: { floor: "none" },
    size: { defaultHeight: 480, minHeight: 300, maxHeight: 900 },
  },

  bindings: [
    {
      key: "vru",
      name: "ВРУ (вводное распределительное)",
      group: "Электрика",
      domain: ["switch", "binary_sensor", "input_boolean"],
      hint: "Зелёный индикатор на шкафу",
    },
    {
      key: "water",
      name: "Счётчик воды",
      group: "Учёт",
      domain: ["sensor", "number", "input_number"],
      hint: "Показание на табло счётчика",
    },
    {
      key: "water_flow",
      name: "Расход воды (необязательно)",
      group: "Учёт",
      domain: ["sensor", "number", "input_number"],
      unit: ["l/min", "m³/h", "L/min"],
      hint: "При расходе вращается стрелка счётчика",
    },
    {
      key: "machine",
      name: "Станок (CNC-фрезер)",
      group: "Оборудование",
      domain: ["switch", "binary_sensor", "input_boolean"],
      hint: "Ротор вращается, светится пульт",
    },
    {
      key: "light1",
      name: "Освещение 1",
      group: "Освещение",
      domain: ["light", "switch", "input_boolean"],
      value: { kind: "brightness" },
      hint: "Плавное диммирование яркости сцены (нужна поддержка brightness)",
    },
    {
      key: "light2",
      name: "Освещение 2",
      group: "Освещение",
      domain: ["light", "switch", "input_boolean"],
      value: { kind: "brightness" },
    },
    {
      key: "fire",
      name: "Пожарная сигнализация",
      group: "Безопасность",
      domain: ["binary_sensor", "switch", "input_boolean"],
      value: { kind: "boolean" },
      hint: "Красная пульсация и мигающий свет",
    },
    {
      key: "heater",
      name: "Обогреватель",
      group: "Климат",
      domain: ["switch", "climate", "input_boolean"],
      hint: "Оранжевое свечение секций",
    },
    {
      key: "ac",
      name: "Кондиционер",
      group: "Климат",
      domain: ["climate", "switch"],
      hint: "Вращение вентилятора и режим на подписи",
    },
    {
      key: "door",
      name: "Датчик двери",
      group: "Безопасность",
      domain: ["binary_sensor", "input_boolean"],
      deviceClass: ["door", "opening", "garage_door", "window"],
      value: { kind: "boolean" },
      hint: "Дверь плавно распахивается",
    },
    {
      key: "lux",
      name: "Датчик освещённости",
      group: "Климат",
      domain: ["sensor", "number", "input_number"],
      deviceClass: ["illuminance"],
      unit: ["lx", "lm"],
      hint: "Свечение линзы по уровню освещённости",
    },
  ],

  params: [
    {
      key: "width",
      name: "Ширина помещения, м",
      type: "number",
      default: 12,
      min: 3,
      max: 40,
      step: 0.5,
      group: "Размеры помещения",
    },
    {
      key: "depth",
      name: "Глубина помещения, м",
      type: "number",
      default: 8,
      min: 3,
      max: 40,
      step: 0.5,
      group: "Размеры помещения",
    },
    {
      key: "height",
      name: "Высота помещения, м",
      type: "number",
      default: 3.2,
      min: 2,
      max: 12,
      step: 0.1,
      group: "Размеры помещения",
    },
  ],

  defaults: {
    config: {
      title: "Производственное помещение",
      show_hud: true,
      height: 480,
    },
  },

  async create(ctx) {
    const mod = await import("./scene.js");
    return mod.create(ctx);
  },
};

export default productionRoomModel;
