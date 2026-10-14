# Конфигурация карточки `custom:threejs-3d-card`

Полная справка по параметрам. Краткая версия — в [README.md](../README.md).

---

## Верхний уровень

```yaml
type: custom:threejs-3d-card
model: water-tank
model_url: /local/3d-models/my-model.js
reload_model: false
allow_external_models: true
title: Бак чистой воды
show_hud: true
height: 400
show_diagnostics: false
entities: { … }
params: { … }
camera: { … }
environment: { … }
```

| Параметр | Тип | По умолчанию | Описание |
|---|---|---|---|
| `type` | string | — | Всегда `custom:threejs-3d-card`. |
| `model` | string | `water-tank` | `id` встроенной модели (`water-tank`, `production-room`) либо URL файла модели (`/local/…`, `/hacsfiles/…`, абсолютный). |
| `model_url` | string | — | URL внешней модели. Заполняется редактором; при наличии `model` имеет приоритет только как источник для перезагрузки. |
| `reload_model` | boolean | `false` | Добавляет к URL модели параметр с отметкой времени — обход кэша браузера. |
| `allow_external_models` | boolean | `true` | `false` — запретить загрузку моделей не из встроенного реестра (безопасность). |
| `title` | string | из модели | Заголовок в HUD. Пустая строка `""` скрывает его. |
| `show_hud` | boolean | `true` | Показывать HUD-заголовок. |
| `height` | number | из модели | Высота сцены в пикселях (минимум 120). |
| `show_diagnostics` | boolean | `false` | Панель диагностики привязок поверх сцены. |

## `entities` — привязки к сущностям

Ключи задаёт модель (`bindings` в её описании). Значение — `entity_id`.

```yaml
entities:
  level: sensor.water_level
  high: binary_sensor.water_high
```

Правила:

* незаполненные ключи просто не используются — ошибкой это не считается,
  кроме привязок с `required: true`;
* ключи, которых нет в описании модели, сохраняются и передаются модели
  (совместимость со старыми конфигурациями);
* значения `unavailable`/`unknown` не превращаются в числа: сцена получает
  признак недоступности и должна показать это визуально.

## `params` — настройки модели

Ключи и типы объявляет модель. **Ключи хранятся плоско**, как объявлены, в том
числе с точкой:

```yaml
params:
  full_value: 1000
  max_liters: 500
  level_color: var(--color-2)
  tank_radius: 0.8
  probe_levels.high: 90
  probe_levels.medium: 50
  probe_levels.low: 10
```

Допускается и вложенная запись (`probe_levels: { high: 90 }`) — она читается
как эквивалент.

Типы полей в редакторе: `number`, `range`, `boolean`, `text`, `theme-color`,
`color`, `select`. Цвета поддерживают переменные темы Home Assistant
(`var(--primary-color)`, `var(--color-2)` и т. д.).

## `camera` — переопределение камеры

Значения по умолчанию задаёт модель; здесь можно поправить вид под свой
дашборд.

```yaml
camera:
  target: [0, 0.5, 0]   # точка взгляда
  radius: 5             # дистанция
  phi: 1.15             # наклон от вертикали, радианы
  theta: 0.7            # поворот вокруг оси Y
  minRadius: 2          # пределы зума
  maxRadius: 12
  minPhi: 0.15
  maxPhi: 1.45
  panoramic: true       # разрешить вращение
  tilt: true            # разрешить наклон
  drift: 0              # медленное авто-вращение (0 — выключено)
```

Управление в сцене: **ЛКМ** — вращение, **ПКМ** (или Shift+ЛКМ) — сдвиг,
**колесо** — зум, **двойной клик** — вернуть исходный вид. На тач-экранах:
один палец — вращение, два — зум.

## `environment` — окружение

```yaml
environment:
  floor: radial         # none | radial | plane | grid
  background: "#0a0d12" # фон сцены (поддерживает var(--…))
  shadows: false        # тени (дороже по производительности)
  hemiIntensity: 0.55
  keyIntensity: 1.05
  rimIntensity: 0.7
```

| `floor` | Что рисуется |
|---|---|
| `none` | Ничего (модель сама создаёт пол). |
| `radial` | Мягкое радиальное пятно с сеткой — «студийная» подложка. |
| `plane` | Плоскость одного цвета (`floorColor`, `floorSize`, `floorY`). |
| `grid` | Штатная сетка three.js (`gridSize`, `gridColor1`, `gridColor2`). |

---

## Полный пример: бак

```yaml
type: custom:threejs-3d-card
model: water-tank
title: Бак чистой воды
height: 420
entities:
  level: sensor.water_preparation_level_clean_percentage
  liters: sensor.water_preparation_level_clean_liters
  counter: sensor.water_preparation_counter_clean_water
  high: binary_sensor.water_preparation_clean_high_sensor
  medium: binary_sensor.water_preparation_clean_medium_sensor
  low: binary_sensor.water_preparation_clean_low_sensor
params:
  full_value: 100
  max_liters: 200
  level_color: var(--color-2)
  tank_radius: 0.55
  tank_length: 1.7
  probe_levels.high: 85
  probe_levels.medium: 50
  probe_levels.low: 25
camera:
  radius: 4.6
  phi: 1.19
  theta: 0.62
```

## Полный пример: цех

```yaml
type: custom:threejs-3d-card
model: production-room
title: Производственный цех
height: 480
entities:
  vru: switch.vru
  water: sensor.water_total
  water_flow: sensor.water_flow
  machine: switch.machine
  light1: light.light_1
  light2: light.light_2
  fire: binary_sensor.fire_alarm
  heater: switch.heater
  ac: climate.ac
  door: binary_sensor.door_opening
  lux: sensor.illuminance
params:
  width: 12
  depth: 8
  height: 3.2
```

---

## Совместимость со старыми конфигурациями

Карточка принимает конфигурации прежних проектов без изменений:

```yaml
type: custom:water-tank-card          # → модель water-tank
entities:
  level: sensor.water_level
full_value: 100
max_liters: 200
level_color: var(--color-2)
probe_levels:
  high: 85
```

```yaml
type: custom:production-room-card     # → модель production-room
width: 12
depth: 8
height: 3.2
entities:
  machine: switch.machine
```

Плоские параметры (`full_value`, `max_liters`, `level_color`, `width`, `depth`,
`height`, `probe_levels`) читаются наравне с `params`. Если в конфигурации
указаны обе формы — приоритет у `params`.
