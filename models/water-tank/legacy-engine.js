// ============================================================================
//  ВНИМАНИЕ: этот файл — перенесённый без изменений движок модели «бак»
//  из проекта water-tank-3d (tank-engine.js). Он используется как реализация
//  сцены через models/water-tank/scene.js.
//
//  Правки визуала вносятся ЗДЕСЬ, контракт карточки — в scene.js/manifest.js.
//  Класс WaterTankEngine доступен и как отдельный движок (legacy-режим).
// ============================================================================
// ============================================================================
//  WaterTankEngine — 3D-вид бака с водой (three.js).
//
//  Геометрия повторяет 2D-карточку (water_tank.svg): горизонтальный
//  «капсульный» бак, через стеклянную полосу на фронтальной стенке виден
//  уровень воды; справа — три зонда-датчика (высокий/средний/низкий),
//  слева — шкала 0–100% с индикатором текущего уровня.
//
//  Состояние объектов подаётся извне (Home Assistant или демо-симуляция).
//  Методы связи с "хостом" (выставляет внешний код):
//     engine.onService = (domain, service, data) => {}   // вызвать сервис HA
//     engine.onDeepLink = (entityId) => {}               // открыть сущность (more-info)
//     engine.onStatus   = (msg) => {}                    // сообщение в статус-бар
//  Внешние методы:
//     await engine.init()
//     engine.start() / engine.stop() / engine.dispose() / engine.resize()
//     engine.applyStates({ [entityId]: stateObject })    // пакетное обновление
//     engine.setEntityState(entityId, stateObject)       // одна сущность
//     engine.setEntities({ key: entity_id })             // смена привязки
//     engine.resetView()                                 // вернуть камеру
//     engine.setHudSub(text)                             // подзаголовок HUD
//
//  Ключи сущностей: level, liters, counter, high, medium, low
// ============================================================================

const DEFAULT_THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
const TANK_KEYS = ["level", "liters", "counter", "high", "medium", "low"];
const PROBE_KEYS = ["high", "medium", "low"];

// ---- утилиты ---------------------------------------------------------------
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
// экспоненциальное сглаживание, независимое от FPS
function ease(cur, target, rate, dt) { return lerp(cur, target, 1 - Math.exp(-rate * dt)); }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
// значение состояния (number) или NaN
function numState(st) { return st ? parseFloat(st.state) : NaN; }
function fmtNum(v, digits = 1) {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("ru-RU", { maximumFractionDigits: digits });
}
// поддерживает "var(--name)" и обычный CSS-цвет; иначе fallback
function resolveColor(spec, fallback) {
  if (!spec) return fallback;
  if (String(spec).startsWith("var(")) {
    const m = String(spec).match(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/);
    if (m) {
      try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
        if (v) return v;
        if (m[2]) return m[2].trim();
      } catch (e) { /* SSR/страница не готова */ }
    }
    return fallback;
  }
  return String(spec);
}

export class WaterTankEngine {
  constructor(container, config = {}, opts = {}) {
    this.container = container;
    this.config = Object.assign({
      title: "Бак чистой воды",
      entities: {},                       // key -> entity_id
      fullValue: 100,                     // значение уровня, соответствующее 100%
      maxLiters: 200,                     // объём, л (для оценки "≈ N л" без сущности liters)
      levelColor: "var(--color-2)",       // цвет воды (поддерживается var(--...))
      probeLevels: { high: 85, medium: 50, low: 25 },  // % уровня, на котором стоят датчики
      tankRadius: 0.55,                   // м
      tankLength: 1.7,                    // м, цилиндрическая часть
      wall: 0.05,                         // м, толщина стенки
      threeUrl: DEFAULT_THREE_URL,
    }, config);
    this.config.probeLevels = Object.assign({ high: 85, medium: 50, low: 25 }, config.probeLevels || {});
    this.opts = opts;

    this.state = {};            // entity_id -> {state, attributes}
    this.keyToEntity = {};      // key -> entity_id
    this.level = 0;             // текущее (сглаженное) значение 0..1
    this.targetLevel = 0;       // целевое 0..1
    this.levelValid = false;
    this.litersText = "";
    this.counterText = "";
    this.probeGlow = { high: 0, medium: 0, low: 0 };   // текущее свечение 0..1
    this.probeTarget = { high: 0, medium: 0, low: 0 }; // целевое
    this.openKey = null;
    this.running = false;
    this.disposed = false;
    this._raf = 0;
    this._lastT = 0;
    this._time = 0;
    this._hudSub = "";
    this._surfF = null;         // уровень, при котором построена поверхность воды
    this._surfPct = null;       // % для подписи
    this._waterColor = 0x2f9df4;

    this.onService = null;
    this.onDeepLink = null;
    this.onStatus = null;
  }

  // ---- инициализация -------------------------------------------------------
  async init() {
    const THREE = this.opts.THREE || await import(this.config.threeUrl);
    this.THREE = THREE;
    this._setupRenderer();
    this._buildScene();
    this._buildTank();
    this._buildWater();
    this._buildScale();
    this._buildProbes();
    this._buildLabels();
    this._buildOverlayDom();
    this._bindEvents();
    this._applyColor();
    this._syncFromStates();
    this.resize();
    return this;
  }

  _setupRenderer() {
    const T = this.THREE;
    this.scene = new T.Scene();
    this.scene.background = new T.Color(0x0a0d12);
    this.scene.fog = new T.Fog(0x0a0d12, 9, 26);

    const w = this.container.clientWidth || 640;
    const h = this.container.clientHeight || 480;
    this.camera = new T.PerspectiveCamera(48, w / h, 0.1, 100);

    // Canvas можно передать снаружи (см. models/water-tank/scene.js):
    // тогда карточка обходится одним WebGL-контекстом вместо двух.
    const provided = this.opts && this.opts.canvas;
    this.renderer = new T.WebGLRenderer(provided ? { antialias: true, canvas: provided } : { antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.localClippingEnabled = true; // нарезка воды плоскостью уровня
    if (!provided) {
      this.renderer.domElement.style.cssText = "position:absolute;inset:0;display:block;cursor:grab;";
      this.container.appendChild(this.renderer.domElement);
    }

    // камера: сферические координаты вокруг цели
    this.axisY = this.config.tankRadius + 0.16;
    this.camTarget = new T.Vector3(0, this.axisY * 0.82, 0);
    this.camPhi = 0.66;      // от вертикали (меньше — выше)
    this.camTheta = 0.42;    // поворот вокруг вертикали
    this.camRadius = 4.9;
    this._defCam = { phi: this.camPhi, theta: this.camTheta, radius: this.camRadius, target: this.camTarget.clone() };
    this._updateCamera();

    // свет
    this.scene.add(new T.AmbientLight(0xffffff, 0.34));
    const hemi = new T.HemisphereLight(0xbfd4ff, 0x141820, 0.55);
    this.scene.add(hemi);
    const key = new T.DirectionalLight(0xffffff, 1.05);
    key.position.set(3.2, 6.0, 4.2);
    this.scene.add(key);
    const rim = new T.PointLight(0x3a72a8, 0.7, 12);
    rim.position.set(-2.5, 2.2, -3.0);
    this.scene.add(rim);

    // пол
    const floor = new T.Mesh(
      new T.CircleGeometry(8, 72),
      new T.MeshStandardMaterial({ map: this._makeFloorTexture(), roughness: 0.95, metalness: 0.05 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
  }

  _makeFloorTexture() {
    const T = this.THREE;
    const c = document.createElement("canvas");
    c.width = c.height = 512;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(256, 256, 30, 256, 256, 260);
    grad.addColorStop(0, "#151c26");
    grad.addColorStop(1, "#0a0d12");
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);
    g.strokeStyle = "rgba(255,255,255,0.045)";
    g.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      const p = i * 64;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 512); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(512, p); g.stroke();
    }
    const t = new T.CanvasTexture(c);
    t.colorSpace = T.SRGBColorSpace;
    return t;
  }

  _mat(color, o = {}) {
    return new this.THREE.MeshStandardMaterial({
      color,
      metalness: o.metal ?? 0.1,
      roughness: o.rough ?? 0.6,
      emissive: o.emissive ?? 0x000000,
      emissiveIntensity: o.emissiveIntensity ?? 1,
      transparent: o.opacity !== undefined,
      opacity: o.opacity ?? 1,
      side: o.side ?? this.THREE.FrontSide,
      depthWrite: o.depthWrite ?? true,
    });
  }

  // ---- каркас бака ----------------------------------------------------------
  _buildScene() {
    this.tankGroup = new this.THREE.Group();
    this.scene.add(this.tankGroup);
  }

  _buildTank() {
    const T = this.THREE;
    const R = this.config.tankRadius, L = this.config.tankLength;
    const g = this.tankGroup;

    // основание
    const base = new T.Mesh(new T.CylinderGeometry(1.55, 1.7, 0.05, 72), this._mat(0x11161d, { metal: 0.3, rough: 0.8 }));
    base.position.y = 0.025;
    base.userData.key = "tank";
    g.add(base);

    // ножки
    [-0.62, 0.62].forEach((x) => {
      const foot = new T.Mesh(new T.BoxGeometry(0.2, 0.2, 0.74), this._mat(0x1b232e, { metal: 0.45, rough: 0.5 }));
      foot.position.set(x, 0.13, 0);
      foot.userData.key = "tank";
      g.add(foot);
    });

    // корпус: капсула (цилиндр + два полушария), тёмное полупрозрачное стекло
    const shellMat = this._mat(0x182230, {
      metal: 0.55, rough: 0.28, opacity: 0.42, side: T.DoubleSide, depthWrite: false,
    });
    shellMat.renderOrder = 20;

    const cylG = new T.CylinderGeometry(R, R, L, 72, 1, true);
    cylG.rotateZ(Math.PI / 2);
    const cyl = new T.Mesh(cylG, shellMat);
    cyl.position.y = this.axisY;
    cyl.userData.key = "tank";
    g.add(cyl);

    const capG = new T.SphereGeometry(R, 72, 36, 0, Math.PI * 2, 0, Math.PI / 2); // верхнее полушарие
    const capR = new T.Mesh(capG, shellMat);
    capR.rotation.z = -Math.PI / 2; // плоскость в x=+L/2, купол в +X
    capR.position.set(L / 2, this.axisY, 0);
    capR.userData.key = "tank";
    g.add(capR);
    const capL = new T.Mesh(capG, shellMat);
    capL.rotation.z = Math.PI / 2;
    capL.position.set(-L / 2, this.axisY, 0);
    capL.userData.key = "tank";
    g.add(capL);

    // верхний люк (декор)
    const hatch = new T.Mesh(new T.CylinderGeometry(0.13, 0.13, 0.05, 32), this._mat(0x2a3646, { metal: 0.6, rough: 0.35 }));
    hatch.position.set(0, this.axisY + R + 0.02, 0);
    hatch.userData.key = "tank";
    g.add(hatch);
    const hatchRing = new T.Mesh(new T.TorusGeometry(0.13, 0.014, 12, 40), this._mat(0x3a4a5e, { metal: 0.7, rough: 0.3 }));
    hatchRing.rotation.x = Math.PI / 2;
    hatchRing.position.copy(hatch.position).y += 0.028;
    g.add(hatchRing);

    // стеклянная полоса-окно на фронтальной стенке (как прозрачное окно в 2D)
    const bandMat = this._mat(0x9fc8e8, {
      metal: 0.1, rough: 0.12, opacity: 0.16, side: T.DoubleSide, depthWrite: false,
    });
    bandMat.renderOrder = 19;
    const bandG = new T.CylinderGeometry(R + 0.006, R + 0.006, L, 72, 1, true, -0.8, 1.6);
    bandG.rotateZ(Math.PI / 2);
    const band = new T.Mesh(bandG, bandMat);
    band.position.y = this.axisY;
    g.add(band);

    // кромки полосы
    const rimMat = this._mat(0x4a90c2, { metal: 0.4, rough: 0.4, emissive: 0x1d4d75, emissiveIntensity: 0.5 });
    const rimZ = Math.cos(0.8) * (R + 0.012), rimY = Math.sin(0.8) * (R + 0.012);
    [rimY, -rimY].forEach((y) => {
      const rim = new T.Mesh(new T.BoxGeometry(L, 0.014, 0.014), rimMat);
      rim.position.set(0, this.axisY + y, rimZ);
      g.add(rim);
    });
  }

  // ---- вода -----------------------------------------------------------------
  _buildWater() {
    const T = this.THREE;
    const Ri = this.config.tankRadius - this.config.wall, L = this.config.tankLength;

    this.waterGroup = new T.Group();
    this.waterGroup.position.y = this.axisY;
    this.scene.add(this.waterGroup);

    // плоскость отсечения: держим y <= уровня
    this._clipPlane = new T.Plane(new T.Vector3(0, 1, 0), 0);

    const waterMat = this._mat(0x2f9df4, {
      rough: 0.3, metal: 0.05, opacity: 0.92, side: T.DoubleSide,
      emissive: 0x114b77, emissiveIntensity: 0.35,
    });
    waterMat.clippingPlanes = [this._clipPlane];
    this.waterMat = waterMat;

    // тело: цилиндр (открытый по торцам) + два полушария
    const cylG = new T.CylinderGeometry(Ri, Ri, L, 72, 1, true);
    cylG.rotateZ(Math.PI / 2);
    this.waterGroup.add(new T.Mesh(cylG, waterMat));
    const capG = new T.SphereGeometry(Ri, 56, 28, 0, Math.PI * 2, 0, Math.PI / 2);
    const capR = new T.Mesh(capG, waterMat);
    capR.rotation.z = -Math.PI / 2;
    capR.position.x = L / 2;
    this.waterGroup.add(capR);
    const capL = new T.Mesh(capG, waterMat);
    capL.rotation.z = Math.PI / 2;
    capL.position.x = -L / 2;
    this.waterGroup.add(capL);

    // плоская поверхность воды (стадион: прямоугольник + два полукруга)
    const surfMat = this._mat(0x54b4f7, {
      rough: 0.22, metal: 0.05, opacity: 0.97, side: T.DoubleSide,
      emissive: 0x2f9df4, emissiveIntensity: 0.5,
    });
    surfMat.clippingPlanes = [this._clipPlane];
    this.surfMat = surfMat;
    this.surface = new T.Mesh(this._makeSurfaceGeometry(L, Ri * 0.001), surfMat);
    this.waterGroup.add(this.surface);

    this._Ri = Ri;
    this._rebuildSurface(this.level);
  }

  _makeSurfaceGeometry(L, r) {
    const T = this.THREE;
    r = Math.max(r, 0.0006);
    const s = new T.Shape();
    const hx = L / 2;
    s.moveTo(-hx, -r);
    s.lineTo(hx, -r);
    s.absarc(hx, 0, r, -Math.PI / 2, Math.PI / 2, false);
    s.lineTo(-hx, r);
    s.absarc(-hx, 0, r, Math.PI / 2, Math.PI * 1.5, false);
    s.closePath();
    const g = new T.ShapeGeometry(s, 28);
    g.rotateX(-Math.PI / 2); // в плоскость XZ, нормаль вверх
    return g;
  }

  _rebuildSurface(f) {
    const Ri = this._Ri;
    const d = -Ri + 2 * Ri * f;              // высота поверхности над осью (локально)
    const r = Math.sqrt(Math.max(Ri * Ri - d * d, 0)); // радиус поперечника
    const geom = this._makeSurfaceGeometry(this.config.tankLength, r);
    if (this.surface.geometry) this.surface.geometry.dispose();
    this.surface.geometry = geom;
    this.surface.position.y = d;
    this.surface.visible = r > 0.012;
    this._surfF = f;
  }

  _applyColor() {
    this._waterColor = resolveColor(this.config.levelColor, "#2f9df4");
    const c = new this.THREE.Color(this._waterColor);
    this.waterMat.color.copy(c);
    this.waterMat.emissive.copy(c).multiplyScalar(0.28);
    this.surfMat.color.copy(c).lerp(new this.THREE.Color(0xffffff), 0.18);
    this.surfMat.emissive.copy(c);
    if (this._indMat) { this._indMat.color.copy(c); this._indMat.emissive.copy(c); }
    if (this._pctSprite) this._pctColor = this._waterColor;
  }

  // ---- шкала и индикатор уровня ---------------------------------------------
  _buildScale() {
    const T = this.THREE;
    const R = this.config.tankRadius, L = this.config.tankLength;
    const g = this.tankGroup;
    const xTick = -L / 2 + 0.14;
    const ROut = R + 0.022;

    for (let i = 0; i <= 10; i++) {
      const f = i / 10;
      const a = Math.acos(clamp(1 - 2 * f, -1, 1)); // 0 = низ, PI = верх
      const major = i % 5 === 0;
      const tick = new T.Mesh(
        new T.BoxGeometry(major ? 0.02 : 0.012, major ? 0.026 : 0.016, 0.008),
        this._mat(major ? 0xd7e4f2 : 0x8fa3b8, { metal: 0.3, rough: 0.5, emissive: major ? 0x22303e : 0x101720, emissiveIntensity: 0.6 })
      );
      tick.position.set(xTick, this.axisY - ROut * Math.cos(a), ROut * Math.sin(a));
      tick.rotation.x = Math.PI / 2 - a;
      g.add(tick);
      if (major) {
        const sp = this._makeLabel(String(i * 10), { fg: "#c8d6e5", scale: 0.0026, bg: "rgba(10,14,20,0.62)" });
        sp.position.set(xTick - 0.1, this.axisY - (ROut + 0.09) * Math.cos(a), (ROut + 0.09) * Math.sin(a));
        g.add(sp);
        this._scaleLabels = this._scaleLabels || [];
        this._scaleLabels.push(sp);
      }
    }

    // индикатор уровня — светящаяся полоска на стекле
    const indMat = this._mat(0x2f9df4, {
      metal: 0.2, rough: 0.3, emissive: 0x2f9df4, emissiveIntensity: 1.6, opacity: 0.98,
    });
    this._indMat = indMat;
    this._indicator = new T.Mesh(new T.BoxGeometry(0.5, 0.016, 0.016), indMat);
    g.add(this._indicator);
  }

  // ---- зонды датчиков --------------------------------------------------------
  _buildProbes() {
    const T = this.THREE;
    const R = this.config.tankRadius, L = this.config.tankLength;
    const g = this.tankGroup;
    const x0 = L / 2 - 0.16;
    this.probes = {};

    PROBE_KEYS.forEach((key) => {
      const f = clamp((this.config.probeLevels[key] ?? 50) / 100, 0, 1);
      const a = Math.acos(clamp(1 - 2 * f, -1, 1));
      const oy = -Math.cos(a), oz = Math.sin(a); // наружная нормаль

      const holder = new T.Group();
      holder.position.set(x0, this.axisY + oy * (R + 0.08), oz * (R + 0.08));

      const pipe = new T.Mesh(new T.CylinderGeometry(0.016, 0.016, 0.17, 20), this._mat(0x39485c, { metal: 0.6, rough: 0.35 }));
      pipe.rotation.x = Math.PI - a; // ось вдоль нормали
      holder.add(pipe);

      const ledMat = this._mat(0x1a1d24, { metal: 0.3, rough: 0.35, emissive: 0x11141a, emissiveIntensity: 0.3 });
      const led = new T.Mesh(new T.SphereGeometry(0.032, 24, 16), ledMat);
      led.position.set(0, oy * 0.1, oz * 0.1);
      led.userData.key = key;
      holder.add(led);

      const light = new T.PointLight(0x57d364, 0, 1.1, 1.8);
      light.position.copy(led.position);
      holder.add(light);

      holder.traverse((n) => { n.userData.key = n.userData.key || key; });
      g.add(holder);
      this.probes[key] = { holder, ledMat, light, led };
    });
  }

  // ---- подписи ----------------------------------------------------------------
  _makeLabel(text, o = {}) {
    const T = this.THREE;
    const canvas = document.createElement("canvas");
    const sprite = new T.Sprite(new T.SpriteMaterial({ depthTest: false, transparent: true }));
    sprite.renderOrder = 999;
    const redraw = (txt) => this._drawLabel(canvas, sprite, txt, o);
    redraw(text);
    sprite.userData.redraw = redraw;
    return sprite;
  }
  _drawLabel(canvas, sprite, text, o) {
    const T = this.THREE;
    const pad = 10, fs = 28;
    const font = `600 ${fs}px system-ui, sans-serif`;
    const m = canvas.getContext("2d");
    m.font = font;
    const w = Math.ceil(m.measureText(text).width) + pad * 2;
    const h = fs + pad * 1.4;
    canvas.width = w; canvas.height = h;
    const c = canvas.getContext("2d");
    c.clearRect(0, 0, w, h);
    if (o.bg) { c.fillStyle = o.bg; roundRect(c, 0, 0, w, h, 9); c.fill(); }
    if (o.border) { c.strokeStyle = o.border; c.lineWidth = 2; roundRect(c, 1, 1, w - 2, h - 2, 8); c.stroke(); }
    c.fillStyle = o.fg || "#eef3fa"; c.font = font; c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(text, w / 2, h / 2 + 1);
    const tex = new T.CanvasTexture(canvas);
    tex.colorSpace = T.SRGBColorSpace;
    if (sprite.material.map) sprite.material.map.dispose();
    sprite.material.map = tex; sprite.material.needsUpdate = true;
    const s = o.scale || 0.0045;
    sprite.scale.set(w * s, h * s, 1);
  }

  _buildLabels() {
    // большая подпись уровня над баком: "42%" + литры
    const T = this.THREE;
    const canvas = document.createElement("canvas");
    this._pctSprite = new T.Sprite(new T.SpriteMaterial({ depthTest: false, transparent: true }));
    this._pctSprite.renderOrder = 999;
    this._pctCanvas = canvas;
    this._pctColor = this._waterColor;
    this._pctSprite.position.set(0, this.axisY + this.config.tankRadius + 0.52, 0);
    this.tankGroup.add(this._pctSprite);
    this._redrawPct();
  }

  _redrawPct() {
    const canvas = this._pctCanvas, sp = this._pctSprite;
    if (!canvas || !sp) return;
    const pct = this.levelValid ? Math.round(this.level * 100) : null;
    const line1 = pct === null ? "—" : pct + "%";
    const line2 = this.litersText || (this.levelValid ? "≈ " + fmtNum(this.level * this.config.maxLiters) + " л" : "");
    canvas.width = 360; canvas.height = 150;
    const c = canvas.getContext("2d");
    c.clearRect(0, 0, 360, 150);
    c.textAlign = "center";
    c.font = "700 84px system-ui, sans-serif";
    c.fillStyle = this._pctColor || "#2f9df4";
    c.shadowColor = "rgba(0,0,0,0.55)"; c.shadowBlur = 14;
    c.fillText(line1, 180, 74);
    if (line2) {
      c.font = "500 34px system-ui, sans-serif";
      c.fillStyle = "rgba(230,240,250,0.92)";
      c.fillText(line2, 180, 124);
    }
    c.shadowBlur = 0;
    const tex = new this.THREE.CanvasTexture(canvas);
    tex.colorSpace = this.THREE.SRGBColorSpace;
    if (sp.material.map) sp.material.map.dispose();
    sp.material.map = tex; sp.material.needsUpdate = true;
    sp.scale.set(1.5, 0.625, 1);
  }

  // ---- DOM-оверлеи (HUD, нижняя строка, модалка) ------------------------------
  _buildOverlayDom() {
    const root = document.createElement("div");
    root.className = "wt-root";
    root.style.cssText = "position:absolute;inset:0;pointer-events:none;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;";
    this.container.appendChild(root);

    const hud = document.createElement("div");
    hud.style.cssText = "position:absolute;left:12px;top:10px;color:#e8edf3;text-shadow:0 1px 4px rgba(0,0,0,.7);";
    hud.innerHTML = `<div style="font-size:13px;font-weight:600;opacity:.92"></div><div style="font-size:11px;opacity:.6;margin-top:2px"></div>`;
    root.appendChild(hud);
    this._hud = hud;

    const bottom = document.createElement("div");
    bottom.style.cssText = "position:absolute;left:50%;bottom:10px;transform:translateX(-50%);white-space:nowrap;" +
      "color:#e8edf3;font-size:12.5px;text-shadow:0 1px 4px rgba(0,0,0,.7);background:rgba(10,13,18,.55);" +
      "border:1px solid rgba(255,255,255,.09);border-radius:20px;padding:5px 16px;backdrop-filter:blur(4px);";
    bottom.innerHTML = `<span class="wt-counter" style="opacity:.85"></span><span style="opacity:.3;margin:0 8px">·</span><span class="wt-liters" style="opacity:.85"></span>`;
    root.appendChild(bottom);
    this._bottom = bottom;

    const tip = document.createElement("div");
    tip.style.cssText = "position:absolute;right:12px;bottom:10px;color:#8b98a8;font-size:11px;opacity:.75;text-shadow:0 1px 3px rgba(0,0,0,.6);";
    tip.textContent = "ЛКМ — вращение · ПКМ — сдвиг · колесо — зум · клик — детали";
    root.appendChild(tip);
    this._tip = tip;

    // модалка
    const ov = document.createElement("div");
    ov.style.cssText = "position:absolute;inset:0;display:none;align-items:center;justify-content:center;" +
      "background:rgba(4,7,11,.55);backdrop-filter:blur(3px);pointer-events:auto;z-index:40;";
    ov.innerHTML = `
      <div class="wt-modal" role="dialog" aria-modal="true" style="width:min(400px,92%);max-height:86%;overflow-y:auto;
        background:#141922;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.55);">
        <div style="display:flex;align-items:flex-start;gap:10px;padding:14px 16px 10px;border-bottom:1px solid rgba(255,255,255,.08)">
          <div style="flex:1;min-width:0">
            <div class="wt-m-title" style="font-size:14.5px;font-weight:600;color:#eef3fa"></div>
            <div class="wt-m-entity" style="font-size:11px;font-family:ui-monospace,Consolas,monospace;opacity:.55;margin-top:2px"></div>
          </div>
          <button class="wt-m-close" title="Закрыть" style="cursor:pointer;border:0;background:rgba(255,255,255,.07);color:#cfd8e3;
            width:26px;height:26px;border-radius:8px;font-size:13px;line-height:1">✕</button>
        </div>
        <div class="wt-m-body" style="padding:12px 16px;font-size:13px;color:#d5dde8"></div>
        <div class="wt-m-foot" style="padding:10px 16px 14px;border-top:1px solid rgba(255,255,255,.08);display:flex;gap:8px"></div>
      </div>`;
    root.appendChild(ov);
    this._overlay = ov;
    this._mTitle = ov.querySelector(".wt-m-title");
    this._mEntity = ov.querySelector(".wt-m-entity");
    this._mBody = ov.querySelector(".wt-m-body");
    this._mFoot = ov.querySelector(".wt-m-foot");
    ov.querySelector(".wt-m-close").addEventListener("click", (e) => { e.stopPropagation(); this._closeModal(); });
    ov.addEventListener("click", (e) => { if (e.target === ov) this._closeModal(); });
  }

  _setHud(title, sub) {
    if (!this._hud || !this._hud.children || this._hud.children.length < 2) return;
    this._hud.children[0].textContent = title || "";
    this._hud.children[1].textContent = sub || "";
  }
  setHudSub(s) { this._hudSub = s; this._updateHud(); }
  _updateHud() {
    this._setHud(this.config.title, this._hudSub || "");
  }

  // ---- состояние --------------------------------------------------------------
  applyStates(states) {
    for (const id in states) this.state[id] = states[id];
    this._syncFromStates();
  }
  setEntityState(id, st) {
    if (st && st.state === "unavailable") { delete this.state[id]; }
    else this.state[id] = st;
    this._syncFromStates();
    if (this.openKey && this.keyToEntity[this.openKey] === id) this._refreshModal();
  }
  // смена топиков (entity_id) без пересоздания сцены
  setEntities(map) {
    if (!map) return;
    for (const k in map) {
      this.config.entities[k] = map[k] || undefined;
      this.keyToEntity[k] = map[k] || null;
    }
    this._syncFromStates();
  }

  _st(key) { const e = this.keyToEntity[key]; return e ? this.state[e] : null; }

  _syncFromStates() {
    for (const k of TANK_KEYS) this.keyToEntity[k] = this.keyToEntity[k] ?? (this.config.entities[k] || null);

    // уровень
    const st = this._st("level");
    if (st && Number.isFinite(numState(st))) {
      const v = numState(st);
      this.targetLevel = clamp(v / (this.config.fullValue || 100), 0, 1);
      this.levelValid = true;
    } else {
      this.levelValid = false;
    }

    // литры
    const stL = this._st("liters");
    if (stL && Number.isFinite(numState(stL))) {
      const unit = (stL.attributes && stL.attributes.unit_of_measurement) || "л";
      this.litersText = fmtNum(numState(stL)) + " " + unit;
    } else {
      this.litersText = this.levelValid ? "≈ " + fmtNum(this.level * this.config.maxLiters) + " л" : "";
    }

    // счётчик
    const stC = this._st("counter");
    if (stC && Number.isFinite(numState(stC))) {
      const unit = (stC.attributes && stC.attributes.unit_of_measurement) || "";
      this.counterText = "Счётчик: " + fmtNum(numState(stC), 3) + (unit ? " " + unit : "");
    } else {
      this.counterText = "Счётчик: —";
    }

    // зонды
    for (const k of PROBE_KEYS) {
      const s = this._st(k);
      this.probeTarget[k] = (s && String(s.state).toLowerCase() === "on") ? 1 : 0;
    }

    // DOM
    if (this._bottom) {
      this._bottom.querySelector(".wt-counter").textContent = this.counterText;
      this._bottom.querySelector(".wt-liters").textContent = this.litersText;
    }
    const pct = this.levelValid ? Math.round(this.level * 100) + "%" : "—";
    this._updateHud();
    if (this._hudSub === "" && this._hud && this._hud.children && this._hud.children[1]) {
      this._hud.children[1].textContent = pct + (this.litersText ? " · " + this.litersText : "");
    }
    if (this._surfPct !== (this.levelValid ? Math.round(this.level * 100) : null) || this._pctDirty) {
      this._surfPct = this.levelValid ? Math.round(this.level * 100) : null;
      this._pctDirty = false;
      this._redrawPct();
    }
    if (this.openKey) this._refreshModal();
  }

  // ---- цикл ---------------------------------------------------------------------
  start() {
    if (this.running) return;
    this.running = true;
    this._lastT = performance.now();
    const loop = (t) => {
      if (!this.running || this.disposed) return;
      this._raf = requestAnimationFrame(loop);
      const dt = clamp((t - this._lastT) / 1000, 0, 0.05);
      this._lastT = t;
      this._time += dt;
      this._frame(dt);
      this._updateCamera();
      if (this.container.clientWidth > 0) this.renderer.render(this.scene, this.camera);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _frame(dt) {
    // сглаживание уровня
    const target = this.levelValid ? this.targetLevel : this.level;
    this.level = ease(this.level, target, 3.0, dt);

    const Ri = this._Ri;
    const d = -Ri + 2 * Ri * this.level;           // локальная y поверхности
    const bob = Math.sin(this._time * 1.1) * 0.0035 + Math.sin(this._time * 1.9) * 0.002;
    const yWorld = this.axisY + d + bob;
    this._clipPlane.constant = -yWorld;

    // перестроить стадионную поверхность, если уровень заметно сдвинулся
    if (this._surfF === null || Math.abs(this.level - this._surfF) > 0.0035) this._rebuildSurface(this.level);
    this.surface.position.y = d;
    this.surface.visible = (Ri * Ri - d * d) > (0.012 * 0.012);

    // индикатор на стекле
    if (this._indicator) {
      const a = Math.acos(clamp(1 - 2 * this.level, -1, 1));
      const RIn = this.config.tankRadius + 0.012;
      this._indicator.position.set(0, this.axisY - RIn * Math.cos(a), RIn * Math.sin(a));
      this._indicator.visible = this.levelValid;
    }

    // свечение зондов
    for (const k of PROBE_KEYS) {
      const p = this.probes[k];
      if (!p) continue;
      this.probeGlow[k] = ease(this.probeGlow[k], this.probeTarget[k], 9, dt);
      const gl = this.probeGlow[k];
      p.ledMat.emissive.setHex(gl > 0.5 ? 0x2f8f4e : 0x11141a);
      p.ledMat.emissiveIntensity = 0.25 + gl * 2.6;
      p.ledMat.color.setHex(0x1a1d24);
      p.light.intensity = gl * 1.5;
    }

    // подпись уровня — редrawing при смене целого %
    const pctNow = this.levelValid ? Math.round(this.level * 100) : null;
    if (pctNow !== this._surfPct) { this._surfPct = pctNow; this._redrawPct(); }

    // лёгкое "дыхание" воды
    if (this.waterMat) this.waterMat.emissiveIntensity = 0.32 + Math.sin(this._time * 0.7) * 0.05;
  }

  stop() { this.running = false; cancelAnimationFrame(this._raf); }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  resetView() {
    this.camTarget.copy(this._defCam.target);
    this.camPhi = this._defCam.phi;
    this.camTheta = this._defCam.theta;
    this.camRadius = this._defCam.radius;
    this._clampCam();
    this._updateCamera();
  }

  _clampCam() {
    this.camPhi = clamp(this.camPhi, 0.18, 1.5);
    this.camRadius = clamp(this.camRadius, 2.2, 14);
    this.camTarget.x = clamp(this.camTarget.x, -2.5, 2.5);
    this.camTarget.y = clamp(this.camTarget.y, 0.1, 2.5);
    this.camTarget.z = clamp(this.camTarget.z, -2.5, 2.5);
  }

  _updateCamera() {
    if (!this.camera) return;
    const t = this.camTheta, p = this.camPhi, r = this.camRadius;
    this.camera.position.set(
      this.camTarget.x + r * Math.sin(p) * Math.sin(t),
      this.camTarget.y + r * Math.cos(p),
      this.camTarget.z + r * Math.sin(p) * Math.cos(t)
    );
    this.camera.lookAt(this.camTarget);
  }

  // ---- события мыши ---------------------------------------------------------------
  _bindEvents() {
    const el = this.renderer.domElement;
    let dragBtn = -1, lastX = 0, lastY = 0, moved = 0;

    el.addEventListener("pointerdown", (e) => {
      dragBtn = e.button; lastX = e.clientX; lastY = e.clientY; moved = 0;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    });
    el.addEventListener("pointermove", (e) => {
      if (dragBtn < 0) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (dragBtn === 0) {           // вращение
        this.camTheta -= dx * 0.0052;
        this.camPhi -= dy * 0.0052;
        this._clampCam();
      } else if (dragBtn === 2) {    // сдвиг (панорама)
        const s = this.camRadius * 0.0011;
        const fwd = new this.THREE.Vector3(Math.sin(this.camTheta), 0, Math.cos(this.camTheta));
        const right = new this.THREE.Vector3(fwd.z, 0, -fwd.x);
        this.camTarget.addScaledVector(right, dx * s);
        this.camTarget.y += dy * s;
        this._clampCam();
      }
    });
    const up = (e) => {
      if (dragBtn >= 0 && moved < 6 && e.button === 0) this._pick(e);
      dragBtn = -1;
      el.style.cursor = "grab";
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.camRadius *= (1 + e.deltaY * 0.0011);
      this._clampCam();
    }, { passive: false });

    // Наблюдать можно только за настоящим элементом: в режиме адаптера
    // (models/water-tank/scene.js) контейнер — объект-обёртка без DOM.
    const domRoot = this.opts && this.opts.canvas ? this.opts.canvas.parentElement : this.container;
    if (domRoot && typeof Element !== "undefined" && domRoot instanceof Element) {
      this._resizeObs = new ResizeObserver(() => this.resize());
      this._resizeObs.observe(domRoot);
    }

    window.addEventListener("keydown", this._onKey = (e) => {
      if (e.key === "Escape") this._closeModal();
    });
  }

  _pick(e) {
    const T = this.THREE;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new T.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new T.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(this.tankGroup.children, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.key) o = o.parent;
      if (o && o.userData.key) { this._openModal(o.userData.key); return; }
    }
  }

  // ---- модалка ---------------------------------------------------------------------
  _entityOf(key) {
    return this.keyToEntity[key] || null;
  }
  _attrRows(st) {
    const a = (st && st.attributes) || {};
    const rows = [];
    const show = (k, label) => { if (a[k] !== undefined && a[k] !== null && a[k] !== "") rows.push([label, a[k]]); };
    show("friendly_name", "Имя");
    show("unit_of_measurement", "Единица");
    show("state_class", "Тип состояния");
    show("device_class", "device_class");
    show("icon", "Иконка");
    return rows;
  }
  _openModal(key) {
    this.openKey = key;
    this._refreshModal();
    if (this._overlay) this._overlay.style.display = "flex";
  }
  _refreshModal() {
    if (!this._overlay) return;
    const key = this.openKey;
    let title = "", entity = null, valueHtml = "", extra = [];

    if (key === "tank" || key === "level") {
      title = this.config.title;
      entity = this._entityOf("level");
      const st = this._st("level");
      const pct = this.levelValid ? Math.round(this.level * 100) : null;
      valueHtml = `<div style="font-size:30px;font-weight:700;color:${esc(this._waterColor)}">${pct === null ? "—" : pct + "%"}</div>
        <div style="font-size:12.5px;opacity:.75;margin-top:3px">${esc(this.litersText || "")}</div>`;
      extra = PROBE_KEYS.map((k) => {
        const s = this._st(k);
        const on = s && String(s.state).toLowerCase() === "on";
        const names = { high: "Высокий", medium: "Средний", low: "Низкий" };
        return `<tr><td style="padding:3px 10px 3px 0;opacity:.7">${names[k]} уровень</td>
          <td style="text-align:right;font-weight:600;color:${on ? "#57d364" : "#6b7684"}">${on ? "вкл" : "выкл"}</td></tr>`;
      }).join("");
      valueHtml += extra ? `<table style="width:100%;margin-top:12px;font-size:12.5px;border-collapse:collapse">${extra}</table>` : "";
    } else if (PROBE_KEYS.includes(key)) {
      const names = { high: "Высокий уровень", medium: "Средний уровень", low: "Низкий уровень" };
      title = "Датчик — " + names[key].toLowerCase();
      entity = this._entityOf(key);
      const s = this._st(key);
      const on = s && String(s.state).toLowerCase() === "on";
      valueHtml = `<div style="font-size:26px;font-weight:700;color:${on ? "#57d364" : "#6b7684"}">${on ? "вкл" : "выкл"}</div>
        <div style="font-size:12px;opacity:.6;margin-top:3px">номинальный уровень: ${this.config.probeLevels[key] ?? "—"}%</div>`;
    } else if (key === "liters") {
      title = "Уровень, литры";
      entity = this._entityOf("liters");
      valueHtml = `<div style="font-size:26px;font-weight:700;color:#d5dde8">${esc(this.litersText || "—")}</div>`;
    } else if (key === "counter") {
      title = "Счётчик чистой воды";
      entity = this._entityOf("counter");
      valueHtml = `<div style="font-size:26px;font-weight:700;color:#d5dde8">${esc(this.counterText.replace("Счётчик: ", ""))}</div>`;
    }

    const st = entity ? this.state[entity] : null;
    const rows = this._attrRows(st).map(([k, v]) =>
      `<tr><td style="padding:3px 10px 3px 0;opacity:.55;white-space:nowrap">${k}</td><td style="text-align:right;word-break:break-word">${esc(v)}</td></tr>`).join("");

    this._mTitle.textContent = title;
    this._mEntity.textContent = entity ? entity : "сущность не привязана";
    this._mBody.innerHTML = valueHtml + (rows ? `<table style="width:100%;margin-top:12px;font-size:12px;border-collapse:collapse">${rows}</table>` : "") +
      (!entity ? `<div style="margin-top:10px;font-size:12px;opacity:.55">Привяжите сущность в настройках, чтобы видеть данные.</div>` : "");

    this._mFoot.innerHTML = "";
    if (entity && this.onDeepLink) {
      const btn = document.createElement("button");
      btn.textContent = "Открыть в Home Assistant";
      btn.style.cssText = "cursor:pointer;font-size:12.5px;padding:7px 14px;border-radius:9px;border:1px solid #1f6feb;" +
        "background:#1f6feb;color:#fff;";
      btn.addEventListener("click", () => this.onDeepLink(entity));
      this._mFoot.appendChild(btn);
    }
    const close = document.createElement("button");
    close.textContent = "Закрыть";
    close.style.cssText = "cursor:pointer;font-size:12.5px;padding:7px 14px;border-radius:9px;border:1px solid rgba(255,255,255,.15);background:transparent;color:#cfd8e3;";
    close.addEventListener("click", () => this._closeModal());
    this._mFoot.appendChild(close);
  }
  _closeModal() {
    this.openKey = null;
    if (this._overlay) this._overlay.style.display = "none";
  }

  dispose() {
    this.disposed = true;
    this.stop();
    if (this._resizeObs) this._resizeObs.disconnect();
    if (this._onKey) window.removeEventListener("keydown", this._onKey);
    if (this.renderer) this.renderer.dispose();
    if (this.scene) this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const m = Array.isArray(o.material) ? o.material : [o.material];
        m.forEach((x) => { x.map && x.map.dispose(); x.dispose && x.dispose(); });
      }
    });
    if (this._overlay) this._overlay.remove();
    if (this._hud) this._hud.remove();
    if (this._bottom) this._bottom.remove();
    if (this._tip) this._tip.remove();
    if (this._pctSprite && this._pctSprite.parent) this._pctSprite.parent.remove(this._pctSprite);
    if (this.renderer && this.renderer.domElement && this.renderer.domElement.parentElement) {
      this.renderer.domElement.remove();
    }
  }
}

export default WaterTankEngine;
