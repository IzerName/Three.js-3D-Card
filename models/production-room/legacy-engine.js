// ============================================================================
//  ВНИМАНИЕ: перенесённый без изменений движок модели «производственное
//  помещение» из проекта production-room-viewer (room-engine.js).
//  Контракт карточки — в models/production-room/scene.js и manifest.js.
// ============================================================================
// ============================================================================
//  ProductionRoomEngine — интерактивный 3D-вид производственного помещения
//  (вид сверху, three.js). Состояние объектов подаётся извне (Home Assistant
//  или демо-симуляция). Методы связи с "хостом" (выставляет внешний код):
//     engine.onService = (domain, service, data) => {}   // вызвать сервис HA
//     engine.onDeepLink = (entityId) => {}               // открыть сущность в HA
//     engine.onStatus   = (msg) => {}                    // сообщение в статус-бар
//  Внешние методы:
//     await engine.init()
//     engine.start() / engine.stop() / engine.dispose() / engine.resize()
//     engine.applyStates({ [entityId]: stateObject })    // пакетное обновление
//     engine.setEntityState(entityId, stateObject)       // одна сущность
// ============================================================================

const DEFAULT_THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

// ---- утилиты ---------------------------------------------------------------
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
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
// экспоненциальное сглаживание, независимое от FPS
function ease(cur, target, rate, dt) { return lerp(cur, target, 1 - Math.exp(-rate * dt)); }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

const STATE_RU = {
  on: "вкл", off: "выкл", open: "открыто", closed: "закрыто",
  idle: "ожидание", cooling: "охлаждение", heating: "обогрев",
  cool: "охлаждение", heat: "обогрев", auto: "авто", dry: "осушение",
  fan: "вентиляция", fire: "ПОЖАР", trigger: "срабатывание", clear: "норма",
};
function prettyState(st) {
  if (!st) return "—";
  return STATE_RU[String(st.state).toLowerCase()] || st.state;
}

export class ProductionRoomEngine {
  constructor(container, config = {}, opts = {}) {
    this.container = container;
    this.config = Object.assign({
      width: 12, depth: 8, height: 3.2,
      entities: {},      // key -> entity_id
      positions: {},     // key -> {x, z}
      names: {},         // key -> человекочитаемое имя
      threeUrl: DEFAULT_THREE_URL,
      title: "Производственное помещение",
    }, config);
    this.opts = opts;

    this.state = {};          // entity_id -> {state, attributes, last_changed}
    this.objs = {};           // key -> {group, set(st), frame(dt), ...}
    this.keyToEntity = {};    // key -> entity_id
    this.openKey = null;
    this.running = false;
    this.disposed = false;
    this._raf = 0;
    this._lastT = 0;
    this._hudSub = "";
    this._propFrames = [];    // анимации "мебельных" деталей (часы и т.п.)

    this.onService = null;
    this.onDeepLink = null;
    this.onStatus = null;

    this._styleInjected = false;
  }

  // ---- инициализация -------------------------------------------------------
  async init() {
    const THREE = this.opts.THREE || await import(this.config.threeUrl);
    this.THREE = THREE;
    this._injectStyle();
    this._setupRenderer();
    this._buildScene();
    this._buildObjects();
    this._buildModalDom();
    this._bindEvents();
    this.resize();
    return this;
  }

  _injectStyle() {
    if (this._styleInjected || typeof document === "undefined") return;
    this._styleInjected = true;
    const css = `
    .pr-root{position:relative;width:100%;height:100%;overflow:hidden;background:#0d1015;
      font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8edf3;}
    .pr-root canvas{display:block;width:100%;height:100%;}
    .pr-hud{position:absolute;left:12px;top:12px;z-index:5;pointer-events:none;
      background:rgba(15,19,26,.72);border:1px solid rgba(255,255,255,.08);
      border-radius:10px;padding:8px 12px;backdrop-filter:blur(6px);max-width:340px;}
    .pr-hud .t{font-size:13px;font-weight:600;letter-spacing:.2px;}
    .pr-hud .s{font-size:11px;opacity:.7;margin-top:2px;}
    .pr-tip{position:absolute;right:12px;bottom:12px;z-index:5;pointer-events:none;
      font-size:11px;opacity:.55;background:rgba(15,19,26,.6);padding:4px 8px;border-radius:8px;}
    .pr-overlay{position:absolute;inset:0;z-index:20;display:none;align-items:center;justify-content:center;
      background:rgba(5,7,10,.55);backdrop-filter:blur(3px);}
    .pr-overlay.open{display:flex;}
    .pr-modal{width:min(420px,92%);max-height:86%;overflow:auto;background:#141922;
      border:1px solid rgba(255,255,255,.1);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.5);}
    .pr-head{display:flex;align-items:center;justify-content:space-between;
      padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08);}
    .pr-head .pr-title{font-size:15px;font-weight:600;}
    .pr-head .pr-entity{font-size:11px;opacity:.6;font-family:ui-monospace,monospace;}
    .pr-close{cursor:pointer;border:none;background:rgba(255,255,255,.08);color:#e8edf3;
      width:28px;height:28px;border-radius:8px;font-size:14px;line-height:1;}
    .pr-close:hover{background:rgba(255,255,255,.16);}
    .pr-body{padding:14px 16px;font-size:13px;}
    .pr-state-line{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
    .pr-dot{width:10px;height:10px;border-radius:50%;background:#888;flex:0 0 auto;}
    .pr-state-val{font-size:16px;font-weight:600;}
    .pr-attrs{margin-top:8px;border-top:1px solid rgba(255,255,255,.07);padding-top:8px;}
    .pr-attrs table{width:100%;border-collapse:collapse;font-size:12px;}
    .pr-attrs td{padding:3px 6px;vertical-align:top;}
    .pr-attrs td:first-child{opacity:.6;white-space:nowrap;width:42%;}
    .pr-ctrl{margin-top:12px;display:flex;flex-direction:column;gap:10px;}
    .pr-row{display:flex;align-items:center;justify-content:space-between;gap:10px;}
    .pr-row .lbl{font-size:12px;opacity:.8;white-space:nowrap;}
    .pr-val{font-size:12px;opacity:.9;font-variant-numeric:tabular-nums;min-width:52px;text-align:right;}
    .pr-btn{cursor:pointer;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);
      color:#e8edf3;border-radius:8px;padding:6px 12px;font-size:12px;}
    .pr-btn:hover{background:rgba(255,255,255,.12);}
    .pr-btn.on{background:#1f6feb;border-color:#1f6feb;color:#fff;}
    .pr-btn.active{background:#2ea043;border-color:#2ea043;color:#fff;}
    input[type=range].pr-range{flex:1;accent-color:#1f6feb;height:4px;}
    .pr-modes{display:flex;flex-wrap:wrap;gap:6px;}
    .pr-muted{opacity:.55;font-size:12px;}
    .pr-foot{padding:12px 16px;border-top:1px solid rgba(255,255,255,.08);display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
    .pr-link{cursor:pointer;color:#79b8ff;text-decoration:none;font-size:12px;}
    `;
    const el = document.createElement("style");
    el.setAttribute("data-production-room", "1");
    el.textContent = css;
    document.head.appendChild(el);
  }

  _setupRenderer() {
    const T = this.THREE;
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 500;

    // Canvas можно передать снаружи (см. models/production-room/scene.js):
    // тогда карточка обходится одним WebGL-контекстом вместо двух.
    const provided = this.opts && this.opts.canvas;
    this.renderer = new T.WebGLRenderer(
      provided ? { antialias: true, alpha: false, canvas: provided } : { antialias: true, alpha: false }
    );
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    // комната с крышей — рендеринг теней выключен
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.container.classList.add("pr-root");
    if (!provided) this.container.appendChild(this.renderer.domElement);

    this.scene = new T.Scene();
    this.scene.background = new T.Color(0x0d1015);
    this.scene.fog = new T.Fog(0x0d1015, 45, 90);

    this.camera = new T.PerspectiveCamera(50, w / h, 0.1, 250);

    this.scene.add(new T.AmbientLight(0xffffff, 0.35));
    this.scene.add(new T.HemisphereLight(0xbfd4ff, 0x20242b, 0.5));
    const dir = new T.DirectionalLight(0xffffff, 0.9);
    dir.position.set(6, 18, 8);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.near = 1; dir.shadow.camera.far = 60;
    dir.shadow.camera.left = -14; dir.shadow.camera.right = 14;
    dir.shadow.camera.top = 14; dir.shadow.camera.bottom = -14;
    this.scene.add(dir);

    // "вид сверху": сферические параметры камеры
    this.camTarget = new T.Vector3(0, 0.4, 0);
    this.camPhi = 0.5;        // от вертикали (меньше = ближе к виду сверху)
    this.camTheta = 0;        // азимут
    this.camRadius = 19;      // дистанция
    this._clampCam();
    this._updateCamera();
  }

  _clampCam() {
    this.camPhi = clamp(this.camPhi, 0.22, 1.15);
    this.camRadius = clamp(this.camRadius, 7, 45);
    const m = 1.5;
    this.camTarget.x = clamp(this.camTarget.x, -this.config.width / 2 - m, this.config.width / 2 + m);
    this.camTarget.z = clamp(this.camTarget.z, -this.config.depth / 2 - m, this.config.depth / 2 + m);
  }
  _updateCamera() {
    const r = this.camRadius, p = this.camPhi, t = this.camTheta;
    this.camera.position.set(
      this.camTarget.x + r * Math.sin(p) * Math.sin(t),
      this.camTarget.y + r * Math.cos(p),
      this.camTarget.z + r * Math.sin(p) * Math.cos(t)
    );
    this.camera.lookAt(this.camTarget);
  }

  // ---- сцена ---------------------------------------------------------------
  _buildScene() {
    const T = this.THREE;
    const { width: W, depth: D, height: H } = this.config;
    const th = 0.18;              // толщина стен
    const innerZ = D / 2 - th;    // внутренняя плоскость передней/задней стены

    // ---- пол ----
    const floor = new T.Mesh(
      new T.PlaneGeometry(W, D),
      new T.MeshStandardMaterial({ map: this._makeFloorTexture(), roughness: 0.95, metalness: 0.02 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new T.GridHelper(Math.max(W, D), Math.max(W, D), 0x3a4150, 0x262c37);
    grid.position.y = 0.01;
    grid.material.transparent = true; grid.material.opacity = 0.22;
    this.scene.add(grid);

    // ---- стены (передняя — с проёмом двери) ----
    const wallMat = new T.MeshStandardMaterial({ color: 0x8b93a1, roughness: 0.85, metalness: 0.05 });
    const mkWall = (w, h, d, x, y, z) => {
      const wall = new T.Mesh(new T.BoxGeometry(w, h, d), wallMat);
      wall.position.set(x, y, z);
      wall.castShadow = true; wall.receiveShadow = true;
      this.scene.add(wall);
      return wall;
    };
    const doorL = 2.45, doorR = 3.95; // проём двери в передней стене
    mkWall(W, H, th, 0, H / 2, -D / 2);                    // задняя
    mkWall(doorL + W / 2, H, th, (-W / 2 + doorL) / 2, H / 2, D / 2);  // передняя левая
    mkWall(W / 2 - doorR, H, th, (W / 2 + doorR) / 2, H / 2, D / 2);   // передняя правая
    mkWall(th, H, D, -W / 2, H / 2, 0);                    // левая
    mkWall(th, H, D, W / 2, H / 2, 0);                     // правая
    // верхняя перемычка над проёмом двери
    mkWall(doorR - doorL, H - 2.25, th, (doorL + doorR) / 2, 2.25 + (H - 2.25) / 2, D / 2);

    // ---- крыша (потолок) ----
    const ceiling = new T.Mesh(
      new T.PlaneGeometry(W, D),
      new T.MeshStandardMaterial({ color: 0x9aa2b0, roughness: 0.9, metalness: 0.05 })
    );
    ceiling.rotation.x = Math.PI / 2; // лицевая сторона вниз: в виде сверху не мешает, при наклоне камеры закрывает комнату
    ceiling.position.y = H;
    this.scene.add(ceiling);

    // ---- потолочные балки ----
    const beamMat = new T.MeshStandardMaterial({ color: 0x5a6270, roughness: 0.8, metalness: 0.2 });
    for (const bx of [-3.2, 0, 3.2]) {
      const beam = new T.Mesh(new T.BoxGeometry(0.2, 0.26, D - 2 * th), beamMat);
      beam.position.set(bx, H - 0.13, 0);
      beam.castShadow = true;
      this.scene.add(beam);
    }
    // кабель-канал вдоль задней стены
    const conduit = new T.Mesh(new T.BoxGeometry(W - 0.6, 0.09, 0.09),
      new T.MeshStandardMaterial({ color: 0xc7cdd6, roughness: 0.6, metalness: 0.3 }));
    conduit.position.set(0, 2.72, -D / 2 + th + 0.05);
    this.scene.add(conduit);

    // ---- зона безопасности вокруг станка (жёлтая разметка) ----
    const zone = new T.Mesh(
      new T.PlaneGeometry(4.9, 2.6),
      new T.MeshBasicMaterial({ map: this._makeHazardTexture(), transparent: true, depthWrite: false })
    );
    zone.rotation.x = -Math.PI / 2;
    zone.position.set(3.2, 0.02, -2.5);
    zone.renderOrder = 2;
    this.scene.add(zone);

    // ---- "мебель" (не кликабельна) ----
    this._buildProps();

    this.objectsGroup = new T.Group();
    this.scene.add(this.objectsGroup);

    const hud = document.createElement("div");
    hud.className = "pr-hud";
    hud.innerHTML = `<div class="t"></div><div class="s"></div>`;
    this.container.appendChild(hud);
    this._hud = hud;
    this._setHud(this.config.title, "подключение…");

    const tip = document.createElement("div");
    tip.className = "pr-tip";
    tip.textContent = "ЛКМ — орбита · ПКМ — панорама · Колесо — зум · Клик — детали";
    this.container.appendChild(tip);
    this._tip = tip;
  }

  // ---- декоративная мебель: часы, паллеты, шкаф, ящики ---------------------
  _buildProps() {
    const T = this.THREE;
    const { width: W, depth: D } = this.config;
    const g = new T.Group();

    // настенные часы на левой стене (стрелки идут)
    const clock = new T.Group();
    clock.position.set(-W / 2 + 0.1, 2.35, 0);
    const face = new T.Mesh(new T.CylinderGeometry(0.24, 0.24, 0.04, 28),
      new T.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.4 }));
    face.rotation.z = Math.PI / 2;
    const rim = new T.Mesh(new T.TorusGeometry(0.24, 0.02, 10, 28),
      new T.MeshStandardMaterial({ color: 0x2b3140, roughness: 0.5, metalness: 0.4 }));
    rim.rotation.y = Math.PI / 2;
    clock.add(face, rim);
    const mkHand = (len, wdt, color) => {
      const h = new T.Mesh(new T.BoxGeometry(0.015, wdt, len), new T.MeshStandardMaterial({ color, roughness: 0.4 }));
      h.position.z = len / 2;
      const pivot = new T.Group();
      pivot.add(h);
      return pivot;
    };
    const hourHand = mkHand(0.12, 0.025, 0x20242b);
    const minHand = mkHand(0.19, 0.018, 0x20242b);
    const center = new T.Mesh(new T.CylinderGeometry(0.02, 0.02, 0.05, 12),
      new T.MeshStandardMaterial({ color: 0xcc3333 }));
    center.rotation.z = Math.PI / 2;
    clock.add(hourHand, minHand, center);
    g.add(clock);
    // время: 1 реальная секунда = 40 "комнатных" секунд
    let simT = 0;
    this._propFrames.push((dt) => {
      simT += dt * 40;
      minHand.rotation.x = -(simT / 60) * Math.PI * 2;
      hourHand.rotation.x = -(simT / 3600) * Math.PI * 2;
    });

    // паллета с ящиками (передний левый угол)
    const pallet = new T.Group();
    const woodMat = new T.MeshStandardMaterial({ color: 0xa07a4a, roughness: 0.9 });
    const woodMat2 = new T.MeshStandardMaterial({ color: 0x8a683f, roughness: 0.9 });
    for (let i = 0; i < 3; i++) {
      const board = new T.Mesh(new T.BoxGeometry(1.2, 0.05, 0.14), woodMat);
      board.position.set(0, 0.11, -0.5 + i * 0.5);
      board.castShadow = true;
      pallet.add(board);
    }
    for (let i = 0; i < 3; i++) {
      const foot = new T.Mesh(new T.BoxGeometry(1.2, 0.11, 0.16), woodMat2);
      foot.position.set(0, 0.055, -0.5 + i * 0.5);
      pallet.add(foot);
    }
    const mkCrate = (s, x, z, ry) => {
      const c = new T.Group();
      const box = new T.Mesh(new T.BoxGeometry(s, s * 0.8, s), new T.MeshStandardMaterial({ color: 0xb08a52, roughness: 0.95 }));
      box.position.y = s * 0.4; box.castShadow = true; box.receiveShadow = true;
      c.add(box);
      const edgeMat = new T.MeshStandardMaterial({ color: 0x7c5c34, roughness: 0.9 });
      for (const [ex, ey, ez, sx, sy, sz] of [[0, s * 0.8, 0, s, 0.06, s], [0, s * 0.12, 0, s, 0.06, s], [s / 2, s * 0.46, 0, 0.06, s * 0.8, s], [-s / 2, s * 0.46, 0, 0.06, s * 0.8, s]]) {
        const e = new T.Mesh(new T.BoxGeometry(sx, sy, sz), edgeMat);
        e.position.set(ex, ey, ez);
        c.add(e);
      }
      c.position.set(x, 0.16, z);
      c.rotation.y = ry;
      return c;
    };
    pallet.add(mkCrate(0.55, -0.28, -0.18, 0.2));
    pallet.add(mkCrate(0.55, 0.3, 0.2, -0.15));
    const c3 = mkCrate(0.42, -0.28, -0.18, 0.5); // ящик, поставленный на первый
    c3.position.y = 0.16 + 0.55 * 0.8;
    pallet.add(c3);
    pallet.position.set(-W / 2 + 1.0, 0, D / 2 - 1.1);
    g.add(pallet);

    // красный инструментальный шкаф у задней стены
    const cab = new T.Group();
    const cabBody = new T.Mesh(new T.BoxGeometry(0.75, 1.15, 0.5),
      new T.MeshStandardMaterial({ color: 0xb03030, roughness: 0.55, metalness: 0.25 }));
    cabBody.position.y = 0.575; cabBody.castShadow = true;
    cab.add(cabBody);
    const drawerMat = new T.MeshStandardMaterial({ color: 0x8c2626, roughness: 0.6, metalness: 0.2 });
    for (let i = 0; i < 3; i++) {
      const dw = new T.Mesh(new T.BoxGeometry(0.66, 0.26, 0.02), drawerMat);
      dw.position.set(0, 0.3 + i * 0.33, 0.26);
      cab.add(dw);
      const hdl = new T.Mesh(new T.BoxGeometry(0.2, 0.03, 0.02),
        new T.MeshStandardMaterial({ color: 0xd7dbe2, metalness: 0.7, roughness: 0.3 }));
      hdl.position.set(0, 0.3 + i * 0.33 + 0.08, 0.28);
      cab.add(hdl);
    }
    cab.position.set(-1.4, 0, -D / 2 + 0.45);
    g.add(cab);

    // ящик с инструментом на полу у станка
    const toolBox = new T.Mesh(new T.BoxGeometry(0.5, 0.28, 0.35),
      new T.MeshStandardMaterial({ color: 0x2f6f8f, roughness: 0.6, metalness: 0.3 }));
    toolBox.position.set(2.1, 0.14, -1.5);
    toolBox.rotation.y = 0.4;
    toolBox.castShadow = true;
    g.add(toolBox);
    const lid = new T.Mesh(new T.BoxGeometry(0.52, 0.05, 0.37),
      new T.MeshStandardMaterial({ color: 0x25566b, roughness: 0.6, metalness: 0.3 }));
    lid.position.set(2.1, 0.3, -1.5);
    lid.rotation.y = 0.4;
    g.add(lid);

    this.scene.add(g);
  }

  // ---- текстуры -------------------------------------------------------------
  _makeFloorTexture() {
    const T = this.THREE;
    const { width: W, depth: D } = this.config;
    const S = 1024;
    const c = document.createElement("canvas");
    c.width = S; c.height = Math.round(S * D / W);
    const g = c.getContext("2d");
    g.fillStyle = "#b9bdc4"; g.fillRect(0, 0, c.width, c.height);
    // шум бетона
    for (let i = 0; i < 4000; i++) {
      const x = Math.random() * c.width, y = Math.random() * c.height;
      g.fillStyle = `rgba(40,44,52,${Math.random() * 0.05})`;
      g.fillRect(x, y, 2, 2);
    }
    // пятна износа
    for (let i = 0; i < 6; i++) {
      const x = Math.random() * c.width, y = Math.random() * c.height, r = 40 + Math.random() * 90;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(70,74,84,${0.05 + Math.random() * 0.07})`);
      grad.addColorStop(1, "rgba(70,74,84,0)");
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    const sx = c.width / W, sy = c.height / D;
    g.strokeStyle = "rgba(70,76,88,0.35)"; g.lineWidth = 1;
    for (let x = 0; x <= W; x++) { g.beginPath(); g.moveTo(x * sx, 0); g.lineTo(x * sx, c.height); g.stroke(); }
    for (let z = 0; z <= D; z++) { g.beginPath(); g.moveTo(0, z * sy); g.lineTo(c.width, z * sy); g.stroke(); }
    // жёлтая линия безопасности перед дверью (полотно: v=0 → передняя стена)
    g.fillStyle = "rgba(224,180,0,0.7)";
    g.fillRect(2.35 * sx, (D / 2 - 3.45) * sy, (3.95 - 2.35) * sx, 10);

    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  _makeHazardTexture() {
    const T = this.THREE;
    const c = document.createElement("canvas");
    c.width = 512; c.height = 430;
    const g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    // лёгкая подсветка зоны
    g.fillStyle = "rgba(224,180,0,0.07)";
    g.fillRect(0, 0, c.width, c.height);
    // рамка-штриховка
    const b = 26;
    g.save();
    g.beginPath();
    g.rect(0, 0, c.width, c.height);
    g.rect(b, b, c.width - 2 * b, c.height - 2 * b);
    g.clip("evenodd");
    g.fillStyle = "rgba(224,180,0,0.85)";
    g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = "rgba(20,22,26,0.8)"; g.lineWidth = 10;
    for (let d = -c.height; d < c.width + c.height; d += 34) {
      g.beginPath(); g.moveTo(d, c.height); g.lineTo(d + c.height, 0); g.stroke();
    }
    g.restore();
    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    return tex;
  }

  // мягкие "сгустки" для потока воздуха кондиционера
  _makeFlowTexture() {
    const T = this.THREE;
    const c = document.createElement("canvas");
    c.width = 64; c.height = 256;
    const g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    for (let i = 0; i < 16; i++) {
      const y = Math.random() * 256, r = 14 + Math.random() * 26, a = 0.10 + Math.random() * 0.22;
      const grad = g.createRadialGradient(32, y, 0, 32, y, r);
      grad.addColorStop(0, `rgba(255,255,255,${a})`);
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.beginPath(); g.arc(32, y, r, 0, 7); g.fill();
    }
    const t = new T.CanvasTexture(c);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.repeat.set(2, 1);
    return t;
  }

  // жёлтый треугольник предупреждения для ВРУ
  _makeWarningTexture() {
    const T = this.THREE;
    const c = document.createElement("canvas");
    c.width = 64; c.height = 64;
    const g = c.getContext("2d");
    g.clearRect(0, 0, 64, 64);
    g.fillStyle = "#e0b400";
    g.strokeStyle = "#14161a";
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(32, 6); g.lineTo(60, 56); g.lineTo(4, 56); g.closePath();
    g.fill(); g.stroke();
    g.fillStyle = "#14161a";
    g.fillRect(29, 22, 6, 18);
    g.fillRect(29, 44, 6, 6);
    const t = new T.CanvasTexture(c);
    t.colorSpace = T.SRGBColorSpace;
    return t;
  }

  // ---- примитивы -----------------------------------------------------------
  _mat(color, o = {}) {
    return new this.THREE.MeshStandardMaterial({
      color, roughness: o.rough ?? 0.7, metalness: o.metal ?? 0.15,
      emissive: o.emissive ?? 0x000000, emissiveIntensity: o.emissiveIntensity ?? 1,
      transparent: !!o.opacity, opacity: o.opacity ?? 1,
    });
  }
  _box(w, h, d, color, o = {}) {
    const m = new this.THREE.Mesh(new this.THREE.BoxGeometry(w, h, d), this._mat(color, o));
    m.castShadow = true; m.receiveShadow = true; return m;
  }
  _cyl(rt, rb, h, color, o = {}, seg = 24) {
    const m = new this.THREE.Mesh(new this.THREE.CylinderGeometry(rt, rb, h, seg), this._mat(color, o));
    m.castShadow = true; m.receiveShadow = true; return m;
  }

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
    const pad = 12, fs = 30;
    const font = `600 ${fs}px system-ui, sans-serif`;
    const measure = canvas.getContext("2d");
    measure.font = font;
    const w = Math.ceil(measure.measureText(text).width) + pad * 2;
    const h = fs + pad * 1.5;
    canvas.width = w; canvas.height = h;
    const c = canvas.getContext("2d");
    c.clearRect(0, 0, w, h);
    c.fillStyle = o.bg || "rgba(16,20,27,0.8)";
    roundRect(c, 0, 0, w, h, 10); c.fill();
    c.strokeStyle = o.border || "rgba(255,255,255,0.14)"; c.lineWidth = 2;
    roundRect(c, 1, 1, w - 2, h - 2, 9); c.stroke();
    c.fillStyle = o.fg || "#eef3fa"; c.font = font; c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(text, w / 2, h / 2 + 1);
    const tex = new T.CanvasTexture(canvas);
    tex.colorSpace = T.SRGBColorSpace;
    if (sprite.material.map) sprite.material.map.dispose();
    sprite.material.map = tex; sprite.material.needsUpdate = true;
    const s = o.scale || 0.0045;
    sprite.scale.set(w * s, h * s, 1);
  }
  _setLabel(sprite, text) { if (sprite && sprite.userData.redraw) sprite.userData.redraw(text); }

  // ---- объекты -------------------------------------------------------------
  _tagGroup(group, key) { group.traverse((n) => { n.userData.key = key; }); }

  _buildObjects() {
    const E = this.config.entities;
    const { width: W, depth: D } = this.config;
    const backZ = -D / 2 + 0.18;  // внутренняя плоскость задней стены
    const frontZ = D / 2 - 0.18;  // внутренняя плоскость передней стены
    const rightX = W / 2 - 0.18;  // внутренняя плоскость правой стены
    const defs = [
      { key: "vru",     name: "ВРУ (вводное распределительное)", entity: E.vru,     pos: { x: -4.6, z: backZ + 0.16 } },
      { key: "water",   name: "Счётчик воды",                     entity: E.water,   pos: { x: -3.2, z: backZ + 0.42 } },
      { key: "machine", name: "Станок (CNC-фрезер)",              entity: E.machine, pos: { x: 3.2, z: -2.6 } },
      { key: "light1",  name: "Освещение 1",                      entity: E.light1,  pos: { x: -2.4, z: -1.2 } },
      { key: "light2",  name: "Освещение 2",                      entity: E.light2,  pos: { x: 1.6, z: 1.5 } },
      { key: "fire",    name: "Пожарная сигнализация",            entity: E.fire,    pos: { x: 0.4, z: -0.5 } },
      { key: "heater",  name: "Обогреватель",                     entity: E.heater,  pos: { x: -(rightX - 0.22), z: 0.2 } },
      { key: "ac",      name: "Кондиционер",                      entity: E.ac,      pos: { x: rightX - 0.17, z: 2.1 } },
      { key: "door",    name: "Дверь (датчик открытия)",          entity: E.door,    pos: { x: 3.88, z: frontZ + 0.05 } },
      { key: "lux",     name: "Датчик освещённости",              entity: E.lux,     pos: { x: -4.6, z: frontZ - 0.9 } },
    ];
    defs.forEach((d) => {
      d.name = this.config.names[d.key] || d.name;
      this.keyToEntity[d.key] = d.entity || null;
      const p = Object.assign({}, d.pos, this.config.positions[d.key] || {});
      const built = this["_build_" + d.key]();
      built.group.position.set(p.x, built.y || 0, p.z);
      this._tagGroup(built.group, d.key);
      this.objectsGroup.add(built.group);
      this.objs[d.key] = Object.assign({ key: d.key, name: d.name, entity: d.entity, group: built.group }, built);
    });
    this._syncFromStates();
  }

  // ---- ВРУ: шкаф с дверью, автоматами, кабеленесущим лотком -----------------
  _build_vru() {
    const key = "vru";
    const T = this.THREE;
    const g = new T.Group();
    const body = this._box(0.95, 1.45, 0.3, 0x3f6ea5, { metal: 0.4, rough: 0.5 });
    const doorPanel = this._box(0.82, 1.3, 0.03, 0x5585bd, { metal: 0.4, rough: 0.45 });
    doorPanel.position.set(0, 0, 0.165);
    const handle = this._box(0.05, 0.3, 0.05, 0xd7dbe2, { metal: 0.7, rough: 0.3 });
    handle.position.set(0.3, 0, 0.19);
    // амбразур
    const peep = this._cyl(0.045, 0.045, 0.01, 0x1a2733, { metal: 0.2, rough: 0.2 });
    peep.rotation.x = Math.PI / 2; peep.position.set(-0.15, 0.42, 0.19);
    g.add(body, doorPanel, handle, peep);
    // два ряда автоматов, видны через "просвет" — просто на лицевой панели
    const brkMat = new T.MeshStandardMaterial({ color: 0x22262e, roughness: 0.5, metalness: 0.2 });
    const leverOn = new T.MeshStandardMaterial({ color: 0xd7dbe2, emissive: 0x2ea043, emissiveIntensity: 0.25, roughness: 0.4 });
    const leverOff = new T.MeshStandardMaterial({ color: 0x8a92a0, roughness: 0.4 });
    const breakers = [];
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 5; i++) {
        const b = new T.Mesh(new T.BoxGeometry(0.09, 0.14, 0.03), brkMat);
        b.position.set(-0.28 + i * 0.14, 0.12 - row * 0.34, 0.19);
        const lev = new T.Mesh(new T.BoxGeometry(0.03, 0.05, 0.015), (row * 5 + i) % 3 === 2 ? leverOff : leverOn);
        lev.position.set(-0.28 + i * 0.14, 0.12 - row * 0.34 + 0.04, 0.21);
        g.add(b, lev);
        breakers.push({ lev, on: (row * 5 + i) % 3 !== 2 });
      }
    }
    // знак "Опасно, напряжение"
    const warn = new T.Mesh(new T.PlaneGeometry(0.2, 0.2),
      new T.MeshBasicMaterial({ map: this._makeWarningTexture(), transparent: true }));
    warn.position.set(-0.15, -0.42, 0.19);
    g.add(warn);
    // кабельный лоток вниз к полу
    const tray = this._box(0.16, 0.62, 0.16, 0x5a6270, { metal: 0.3, rough: 0.6 });
    tray.position.set(0, -1.03, 0);
    g.add(tray);
    // статусный индикатор
    const led = this._cyl(0.035, 0.035, 0.02, 0x112233, { emissive: 0x2ea043, emissiveIntensity: 0 });
    led.position.set(0.3, 0.62, 0.19);
    g.add(led);
    const label = this._makeLabel("ВРУ"); label.position.set(0, 1.05, 0); g.add(label);
    return { group: g, y: 1.4,
      set: (st) => {
        const on = st && st.state === "on";
        led.material.emissiveIntensity = on ? 1.6 : 0;
        breakers.forEach((b) => { b.lev.material = on ? leverOn : leverOff; });
        this._setLabel(label, on ? "ВРУ · под напряжением" : "ВРУ · обесточено");
      },
      frame: () => {} };
  }

  // ---- Счётчик воды: стояк, фланцы, маховик вентиля, циферблат --------------
  _build_water() {
    const key = "water";
    const T = this.THREE;
    const g = new T.Group();
    const pipeMat = { metal: 0.65, rough: 0.35 };
    const pipeBot = this._cyl(0.06, 0.06, 0.5, 0x8a92a0, pipeMat);
    pipeBot.position.y = 0.25;
    const flange1 = this._cyl(0.1, 0.1, 0.04, 0x6b7280, pipeMat);
    flange1.position.y = 0.5;
    const pipeMid = this._cyl(0.06, 0.06, 0.5, 0x8a92a0, pipeMat);
    pipeMid.position.y = 0.75;
    // маховик вентиля
    const valveBody = this._cyl(0.12, 0.14, 0.16, 0x556070, { metal: 0.5, rough: 0.5 });
    valveBody.position.y = 1.06;
    const wheel = new T.Group();
    wheel.position.y = 1.22;
    const torus = new T.Mesh(new T.TorusGeometry(0.13, 0.02, 10, 24),
      new T.MeshStandardMaterial({ color: 0xcc3333, roughness: 0.5, metalness: 0.2 }));
    torus.rotation.x = Math.PI / 2;
    wheel.add(torus);
    for (let i = 0; i < 3; i++) {
      const sp = this._box(0.03, 0.03, 0.26, 0xcc3333);
      sp.rotation.y = (i * Math.PI) / 3;
      wheel.add(sp);
    }
    const axle = this._cyl(0.02, 0.02, 0.14, 0x556070, pipeMat);
    axle.position.y = 1.16;
    // корпус счётчика
    const body = this._box(0.4, 0.36, 0.34, 0x2f6f8f, { metal: 0.3, rough: 0.5 });
    body.position.y = 1.45;
    const dial = this._cyl(0.11, 0.11, 0.02, 0xf2f4f7, { rough: 0.4 });
    dial.rotation.x = Math.PI / 2; dial.position.set(0, 1.48, 0.18);
    const drum = new T.Group(); drum.position.set(0, 1.48, 0.195);
    for (let i = 0; i < 4; i++) {
      const seg = this._box(0.07, 0.1, 0.012, 0x22262e);
      seg.position.x = -0.081 + i * 0.054;
      drum.add(seg);
    }
    const led = this._cyl(0.025, 0.025, 0.015, 0x112233, { emissive: 0x2ea043, emissiveIntensity: 0 });
    led.rotation.x = Math.PI / 2; led.position.set(0.14, 1.32, 0.18);
    const flange2 = this._cyl(0.1, 0.1, 0.04, 0x6b7280, pipeMat);
    flange2.position.y = 1.0;
    g.add(pipeBot, flange1, pipeMid, flange2, valveBody, axle, wheel, body, dial, drum, led);
    const label = this._makeLabel("Вода", { scale: 0.0038 }); label.position.set(0, 2.0, 0); g.add(label);
    let flowGlow = 0;
    return { group: g, y: 0,
      set: (st) => {
        const v = st ? st.state : "?";
        const u = st && st.attributes.unit_of_measurement ? " " + st.attributes.unit_of_measurement : "";
        this._setLabel(label, `Вода ${v}${u}`);
      },
      frame: (dt) => {
        const flow = this._flowActive();
        if (flow) { wheel.rotation.y += dt * 1.6; drum.children.forEach((s) => { s.position.y = Math.sin(performance.now() / 200 + s.position.x * 20) * 0.004; }); }
        flowGlow = ease(flowGlow, flow ? 1 : 0, 4, dt);
        led.material.emissiveIntensity = flowGlow * 1.8;
      } };
  }

  // ---- Станок: CNC-фрезер, много движущихся деталей --------------------------
  _build_machine() {
    const key = "machine";
    const T = this.THREE;
    const g = new T.Group();

    // ---- рама-основание (широкая, ~4.9 м) ----
    const skid = this._box(4.9, 0.16, 1.9, 0x23272e, { metal: 0.3, rough: 0.6 });
    skid.position.y = 0.08;
    g.add(skid);
    for (const [fx, fz] of [[-2.3, -0.8], [-1.15, -0.8], [0, -0.8], [1.15, -0.8], [2.3, -0.8], [-2.3, 0.8], [0, 0.8], [2.3, 0.8]]) {
      const foot = this._cyl(0.07, 0.09, 0.06, 0xe0b400, { rough: 0.5 });
      foot.position.set(fx, 0.02, fz);
      g.add(foot);
    }
    // предупреждающая полоса на переднем краю
    const stripe = new T.Mesh(new T.PlaneGeometry(4.9, 0.07),
      new T.MeshBasicMaterial({ map: this._makeHazardTexture(), transparent: true }));
    stripe.position.set(0, 0.1, 0.955);
    g.add(stripe);

    // ---- корпус: нижнее основание и верхний ярус, рабочая зона открыта ----
    const baseBody = this._box(3.9, 0.9, 1.7, 0x39544a, { metal: 0.25, rough: 0.6 });
    baseBody.position.y = 0.61;
    const upperBody = this._box(3.9, 0.34, 1.7, 0x4a5560, { metal: 0.3, rough: 0.5 });
    upperBody.position.y = 2.33;
    const topPlate = this._box(4.0, 0.06, 1.8, 0x5a6270, { metal: 0.3, rough: 0.5 });
    topPlate.position.y = 2.53;
    const brand = this._box(1.4, 0.12, 0.02, 0xd7dbe2, { rough: 0.4 });
    brand.position.set(0, 2.4, 0.86);
    g.add(baseBody, upperBody, topPlate, brand);

    // ---- защитная стенка: стекло на всю ширину, сзади (перед открыт — видно внутрь) ----
    const guardFrame = this._box(3.6, 1.3, 0.08, 0x2b3140, { metal: 0.4, rough: 0.5 });
    guardFrame.position.set(0, 1.6, -0.87);
    const glass = new T.Mesh(new T.PlaneGeometry(3.4, 1.14),
      new T.MeshStandardMaterial({ color: 0x274a5a, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.45 }));
    glass.position.set(0, 1.6, -0.83);
    const statusStrip = this._box(3.5, 0.05, 0.03, 0x112233, { emissive: 0x2ea043, emissiveIntensity: 0 });
    statusStrip.position.set(0, 2.28, 0.87);
    g.add(guardFrame, glass, statusStrip);

    // ---- рабочая зона (видна через стекло) ----
    const railMat = { metal: 0.6, rough: 0.3 };
    for (const rz of [0.45, -0.45]) {
      const rail = this._box(3.4, 0.05, 0.08, 0x9aa2ad, railMat);
      rail.position.set(0, 1.1, rz);
      g.add(rail);
    }
    // станина (едет по X почти на всю ширину)
    const table = new T.Group();
    const tablePlate = this._box(1.4, 0.12, 1.1, 0x6b7280, railMat);
    tablePlate.position.y = 1.2;
    table.add(tablePlate);
    for (const sz of [-0.3, 0, 0.3]) { // Т-пазы
      const slot = this._box(1.34, 0.012, 0.05, 0x3a4048, { metal: 0.4, rough: 0.5 });
      slot.position.set(0, 1.266, sz);
      table.add(slot);
    }
    const viseBase = this._box(0.62, 0.08, 0.5, 0x2f3540, railMat);
    viseBase.position.y = 1.31;
    const viseL = this._box(0.12, 0.14, 0.46, 0x2f3540, railMat);
    viseL.position.set(-0.24, 1.38, 0);
    const viseR = this._box(0.12, 0.14, 0.46, 0x2f3540, railMat);
    viseR.position.set(0.24, 1.38, 0);
    const workpiece = this._box(0.44, 0.16, 0.36, 0xc98a2b, { metal: 0.7, rough: 0.35 });
    workpiece.position.y = 1.41;
    table.add(viseBase, viseL, viseR, workpiece);
    g.add(table);

    // портал (мостовая балка)
    const bridge = this._box(3.5, 0.2, 0.2, 0x5a6270, { metal: 0.4, rough: 0.5 });
    bridge.position.set(0, 2.0, 0);
    g.add(bridge);

    // каретка-шпиндель (слева): шпиндель крутится, головка подрабатывает по Y
    const headL = new T.Group();
    const headBoxL = this._box(0.55, 0.32, 0.42, 0x39404c, { metal: 0.4, rough: 0.45 });
    headBoxL.position.y = 1.8;
    const spindle = new T.Group();
    const spindleMotor = this._cyl(0.09, 0.09, 0.2, 0x22262e, { metal: 0.6, rough: 0.35 });
    const spindleNose = this._cyl(0.055, 0.055, 0.16, 0x9aa2ad, { metal: 0.7, rough: 0.25 });
    spindleNose.position.y = -0.17;
    const tool = new T.Mesh(new T.ConeGeometry(0.03, 0.14, 12),
      new T.MeshStandardMaterial({ color: 0xd7dbe2, metalness: 0.85, roughness: 0.2 }));
    tool.rotation.x = Math.PI; tool.position.y = -0.33;
    spindle.add(spindleMotor, spindleNose, tool);
    spindle.position.y = 1.89;
    headL.add(headBoxL, spindle);
    headL.position.x = -0.9;
    g.add(headL);
    // светильник обработки на портале
    const workLamp = this._box(0.14, 0.08, 0.14, 0x2b3140, { metal: 0.4, rough: 0.5 });
    workLamp.position.set(-0.9, 1.94, 0.1);
    const workLens = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, 0.02, 16),
      new T.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xffe9a8, emissiveIntensity: 0 }));
    workLens.position.set(-0.9, 1.88, 0.1);
    g.add(workLamp, workLens);

    // магазин инструмента (справа): вращающийся барабан-карусель
    const atc = new T.Group();
    const atcDisc = this._cyl(0.22, 0.22, 0.05, 0x2f3540, { metal: 0.5, rough: 0.4 });
    atcDisc.rotation.x = Math.PI / 2;
    atc.add(atcDisc);
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI * 2) / 6;
      const hx = Math.sin(a) * 0.14, hy = Math.cos(a) * 0.14;
      const holder = this._box(0.05, 0.09, 0.04, 0x5a6270, { metal: 0.5, rough: 0.4 });
      holder.position.set(hx, hy, 0.03);
      holder.rotation.z = a;
      const miniTool = this._cyl(0.012, 0.02, 0.07, 0xd7dbe2, { metal: 0.8, rough: 0.3 });
      miniTool.rotation.x = Math.PI / 2;
      miniTool.position.set(hx, hy, 0.075);
      atc.add(holder, miniTool);
    }
    const atcHub = this._cyl(0.04, 0.04, 0.07, 0x9aa2ad, { metal: 0.7, rough: 0.3 });
    atcHub.rotation.x = Math.PI / 2;
    atc.add(atcHub);
    atc.position.set(1.75, 1.8, 0.32);
    g.add(atc);

    // шланг СОЖ с портала к шпинделю
    const hose1 = this._cyl(0.025, 0.025, 0.3, 0x22262e, { rough: 0.6 });
    hose1.position.set(-0.68, 1.72, 0.12);
    const hose2 = this._cyl(0.025, 0.025, 0.2, 0x22262e, { rough: 0.6 });
    hose2.rotation.z = Math.PI / 2;
    hose2.position.set(-0.75, 1.9, 0.12);
    g.add(hose1, hose2);

    // ---- конвейер стружки (левый торец, движущиеся сегменты) ----
    const conv = new T.Group();
    const convTray = this._box(0.42, 0.24, 1.7, 0x2b3140, { metal: 0.4, rough: 0.5 });
    convTray.position.set(-2.15, 0.4, 0);
    const convLip1 = this._box(0.04, 0.1, 1.7, 0x39404c, { metal: 0.4, rough: 0.5 });
    convLip1.position.set(-1.97, 0.5, 0);
    const convLip2 = this._box(0.04, 0.1, 1.7, 0x39404c, { metal: 0.4, rough: 0.5 });
    convLip2.position.set(-2.33, 0.5, 0);
    conv.add(convTray, convLip1, convLip2);
    const convSegs = [];
    const segMat = new T.MeshStandardMaterial({ color: 0x5a6270, metalness: 0.5, roughness: 0.4 });
    for (let i = 0; i < 8; i++) {
      const s = new T.Mesh(new T.BoxGeometry(0.3, 0.05, 0.09), segMat);
      s.position.set(-2.15, 0.55, -0.83 + i * 0.22);
      conv.add(s);
      convSegs.push({ mesh: s, base: -0.83 + i * 0.22 });
    }
    g.add(conv);

    // ---- щит управления (правый угол): экран, кнопки, аварийный стоп, вентилятор ----
    const cabinet = this._box(0.55, 1.35, 0.6, 0x39404c, { metal: 0.35, rough: 0.5 });
    cabinet.position.set(2.15, 0.84, 0.62);
    const cabScreen = this._box(0.4, 0.26, 0.02, 0x0a2233, { emissive: 0x2fd0ff, emissiveIntensity: 0 });
    cabScreen.position.set(2.15, 1.22, 0.935);
    g.add(cabinet, cabScreen);
    [0xcc3333, 0x2ea043, 0xe0b400].forEach((bc, i) => {
      const b = this._cyl(0.025, 0.025, 0.02, bc, { emissive: bc, emissiveIntensity: 0.15, rough: 0.4 });
      b.rotation.x = Math.PI / 2;
      b.position.set(2.0 + i * 0.15, 1.0, 0.935);
      g.add(b);
    });
    // аварийный стоп (красная кнопка на жёлтом диске)
    const estopDisc = this._cyl(0.07, 0.07, 0.02, 0xe0b400, { rough: 0.5 });
    estopDisc.rotation.x = Math.PI / 2;
    estopDisc.position.set(2.33, 0.72, 0.935);
    const estopBtn = this._cyl(0.035, 0.045, 0.04, 0xd92626, { emissive: 0xff3b30, emissiveIntensity: 0.15, rough: 0.4 });
    estopBtn.rotation.x = Math.PI / 2;
    estopBtn.position.set(2.33, 0.72, 0.96);
    g.add(estopDisc, estopBtn);
    // вентилятор охлаждения щита (боковая сетка, крутится)
    const cabFan = new T.Group();
    const cabFanRing = new T.Mesh(new T.TorusGeometry(0.13, 0.015, 8, 20),
      new T.MeshStandardMaterial({ color: 0x22262e, metalness: 0.5, roughness: 0.4 }));
    cabFanRing.rotation.y = Math.PI / 2;
    cabFan.add(cabFanRing);
    for (let i = 0; i < 4; i++) {
      const blade = this._box(0.01, 0.1, 0.05, 0x5a6270, { metal: 0.5, rough: 0.4 });
      blade.position.y = 0.06;
      const arm = new T.Group();
      arm.add(blade);
      arm.rotation.x = (i * Math.PI) / 2;
      cabFan.add(arm);
    }
    cabFan.position.set(2.43, 1.35, 0.62);
    g.add(cabFan);

    // ---- бак СОЖ (правый задний угол) с насосом и смотровым стеклом ----
    const tank = this._box(0.55, 0.6, 0.7, 0x39544a, { metal: 0.3, rough: 0.55 });
    tank.position.set(2.15, 0.44, -0.55);
    const tankLid = this._box(0.57, 0.04, 0.72, 0x2b3140, { metal: 0.4, rough: 0.5 });
    tankLid.position.set(2.15, 0.76, -0.55);
    const pump = this._cyl(0.08, 0.08, 0.2, 0x22262e, { metal: 0.5, rough: 0.4 });
    pump.position.set(2.15, 0.88, -0.55);
    const sight = this._box(0.03, 0.42, 0.02, 0x0a2233, { emissive: 0x35c9dd, emissiveIntensity: 0.35, rough: 0.4 });
    sight.position.set(2.32, 0.45, -0.19);
    g.add(tank, tankLid, pump, sight);

    // ---- подвесной пульт (перед стеклом) ----
    const pendArm = this._box(0.4, 0.05, 0.05, 0x39404c, { metal: 0.4, rough: 0.5 });
    pendArm.position.set(1.75, 1.55, 0.95);
    const pendBox = this._box(0.5, 0.36, 0.1, 0x2b3140, { metal: 0.35, rough: 0.5 });
    pendBox.position.set(1.6, 1.35, 0.95);
    const screen = this._box(0.34, 0.2, 0.02, 0x0a2233, { emissive: 0x2fd0ff, emissiveIntensity: 0 });
    screen.position.set(1.6, 1.38, 1.01);
    g.add(pendArm, pendBox, screen);
    // кнопки пульта
    const btnColors = [0xcc3333, 0x2ea043, 0xe0b400];
    btnColors.forEach((bc, i) => {
      const b = this._cyl(0.028, 0.028, 0.02, bc, { emissive: bc, emissiveIntensity: 0.15, rough: 0.4 });
      b.rotation.x = Math.PI / 2;
      b.position.set(1.48 + i * 0.12, 1.24, 1.01);
      g.add(b);
    });

    // ---- светофор (три секции: красный/жёлтый/зелёный) ----
    const towerBase = this._cyl(0.04, 0.05, 0.1, 0x22262e, { metal: 0.5, rough: 0.4 });
    towerBase.position.set(1.5, 2.61, -0.5);
    g.add(towerBase);
    const mkLamp = (ly, c, e) => {
      const m = new T.Mesh(new T.CylinderGeometry(0.055, 0.055, 0.075, 16),
        new T.MeshStandardMaterial({ color: c, emissive: e, emissiveIntensity: 0, roughness: 0.3 }));
      m.position.set(1.5, ly, -0.5);
      g.add(m);
      return m;
    };
    const lampR = mkLamp(2.72, 0x7a1f1a, 0xff3b30);
    const lampY = mkLamp(2.81, 0x7a6a1a, 0xffcc00);
    const lampG = mkLamp(2.90, 0x1a5a2a, 0x2ea043);

    // ---- маячок (вращающийся, оранжевый) ----
    const beacon = new T.Group();
    const beaconBase = this._cyl(0.05, 0.07, 0.06, 0x22262e, { metal: 0.5, rough: 0.4 });
    beaconBase.position.y = 0;
    const beaconLight = new T.Mesh(new T.CylinderGeometry(0.085, 0.085, 0.15, 20),
      new T.MeshStandardMaterial({ color: 0xff8a1a, emissive: 0xff7a00, emissiveIntensity: 0, roughness: 0.3 }));
    beaconLight.position.y = 0.11;
    beacon.add(beaconBase, beaconLight);
    beacon.position.set(-1.5, 2.56, -0.5);
    g.add(beacon);

    // ---- вентилятор охлаждения на крыше (вращающийся) ----
    const topFan = new T.Group();
    const fanRing = new T.Mesh(new T.TorusGeometry(0.22, 0.02, 8, 24),
      new T.MeshStandardMaterial({ color: 0x22262e, metalness: 0.5, roughness: 0.4 }));
    fanRing.rotation.x = Math.PI / 2;
    topFan.add(fanRing);
    for (let i = 0; i < 5; i++) {
      const blade = this._box(0.18, 0.015, 0.05, 0x5a6270, { metal: 0.5, rough: 0.4 });
      blade.position.x = 0.12;
      const arm = new T.Group();
      arm.add(blade);
      arm.rotation.y = (i * Math.PI * 2) / 5;
      topFan.add(arm);
    }
    topFan.position.set(0, 2.58, 0);
    g.add(topFan);

    const label = this._makeLabel("Станок");
    label.position.set(0, 3.15, 0.3);
    g.add(label);

    let spin = 0, atcA = 0, glow = 0, t = 0;
    return { group: g, y: 0,
      set: (st) => {
        const on = st && st.state === "on";
        this._setLabel(label, on ? "Станок · обработка" : "Станок · остановлен");
      },
      frame: (dt) => {
        const on = this._entityActive(key);
        glow = ease(glow, on ? 1 : 0, 2.5, dt);
        if (glow > 0.001) t += dt * glow;
        if (glow > 0.01) {
          spin += dt * 14 * glow; // шпиндель
          atcA += dt * (1.1 + 3.2 * Math.max(0, Math.sin(t * 0.27))) * glow; // магазин: перебор инструмента
          beacon.rotation.y += dt * 7 * glow;
          topFan.rotation.y += dt * 2.5 * glow;
          cabFan.rotation.x += dt * 5 * glow;
        }
        spindle.rotation.y = spin;
        atc.rotation.z = atcA;
        // станина на всю ширину — деталь проходит под шпинделем
        table.position.x = Math.sin(t * 0.55) * 1.25;
        headL.position.y = Math.sin(t * 0.9 + 0.5) * 0.06;
        // конвейер стружки
        convSegs.forEach((s) => {
          const span = 1.66;
          let z = (s.base + t * 0.5) % span;
          if (z < 0) z += span;
          s.mesh.position.z = -span / 2 + z;
          s.mesh.visible = glow > 0.05;
        });
        // свет
        beaconLight.material.emissiveIntensity = glow * (0.7 + 0.3 * Math.sin(t * 9));
        screen.material.emissiveIntensity = glow * (0.85 + 0.15 * Math.sin(t * 13));
        cabScreen.material.emissiveIntensity = glow * (0.85 + 0.15 * Math.sin(t * 9 + 2));
        statusStrip.material.emissiveIntensity = glow * 1.5;
        workLens.material.emissiveIntensity = glow * 1.2;
        // светофор: зелёный мигает, жёлтый горит, красный — нет
        lampG.material.emissiveIntensity = glow * (0.5 + 0.5 * Math.sin(t * 6));
        lampY.material.emissiveIntensity = glow * 0.9;
        lampR.material.emissiveIntensity = 0;
      } };
  }

  // ---- Потолочный светильник (диммируемый) ----------------------------------
  _buildLight() {
    const T = this.THREE;
    const g = new T.Group();
    const mount = this._box(0.14, 0.05, 0.14, 0x2b3140, { metal: 0.5, rough: 0.4 });
    mount.position.y = -0.02;
    const housing = this._box(0.8, 0.1, 0.8, 0xd7dbe2, { metal: 0.3, rough: 0.5 });
    housing.position.y = -0.1;
    const housingEdge = this._box(0.84, 0.03, 0.84, 0x2b3140, { metal: 0.4, rough: 0.5 });
    housingEdge.position.y = -0.05;
    const lensMat = new T.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xffe6a3, emissiveIntensity: 0.1, roughness: 0.4 });
    const lens = new T.Mesh(new T.CylinderGeometry(0.3, 0.34, 0.06, 24), lensMat);
    lens.position.y = -0.16;
    const pl = new T.PointLight(0xffe6a3, 0, 11, 2);
    pl.position.y = -0.7;
    g.add(mount, housingEdge, housing, lens, pl);
    const label = this._makeLabel("Свет", { scale: 0.0038 }); label.position.set(0, 0.5, 0); g.add(label);
    let cur = 0, target = 0;
    return { group: g, y: this.config.height - 0.03,
      set: (st) => {
        const on = st && st.state === "on";
        const br = st && st.attributes.brightness != null ? st.attributes.brightness : (on ? 255 : 0);
        target = on ? br / 255 : 0;
        this._setLabel(label, `Свет ${Math.round(target * 100)}%`);
      },
      frame: (dt) => {
        cur = ease(cur, target, 4, dt); // плавное диммирование
        lensMat.emissiveIntensity = 0.05 + cur * 3.6;
        pl.intensity = cur * 30;
      } };
  }
  _build_light1() { const o = this._buildLight(); o.key = "light1"; return o; }
  _build_light2() { const o = this._buildLight(); o.key = "light2"; return o; }

  // ---- Пожарный извещатель (анимация тревоги) --------------------------------
  _build_fire() {
    const key = "fire";
    const T = this.THREE;
    const g = new T.Group();
    const baseRing = new T.Mesh(new T.TorusGeometry(0.2, 0.018, 8, 28),
      new T.MeshStandardMaterial({ color: 0xb8bec7, roughness: 0.5, metalness: 0.2 }));
    baseRing.rotation.x = Math.PI / 2; baseRing.position.y = -0.07;
    const body = this._cyl(0.22, 0.22, 0.14, 0xe8edf3, { rough: 0.5 });
    // вентиляционные щели (тёмное кольцо)
    const slots = new T.Mesh(new T.CylinderGeometry(0.19, 0.19, 0.05, 24),
      new T.MeshStandardMaterial({ color: 0x3a4150, roughness: 0.8 }));
    slots.position.y = 0.02;
    const lensMat = new T.MeshStandardMaterial({ color: 0x5a1010, emissive: 0xff2a2a, emissiveIntensity: 0.15, roughness: 0.4 });
    const lens = new T.Mesh(new T.CylinderGeometry(0.1, 0.12, 0.05, 20), lensMat);
    lens.position.y = -0.085;
    // тест-кнопка и зелёный статус
    const btn = this._cyl(0.035, 0.035, 0.02, 0x22262e, { rough: 0.5 });
    btn.position.set(0.1, 0.095, 0);
    const okLed = this._cyl(0.02, 0.02, 0.015, 0x112233, { emissive: 0x2ea043, emissiveIntensity: 0.8 });
    okLed.position.set(-0.1, 0.095, 0);
    const ring = new T.Mesh(
      new T.RingGeometry(0.22, 0.3, 32),
      new T.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0, side: T.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = -0.1;
    const pl = new T.PointLight(0xff2a2a, 0, 8, 2); pl.position.y = -0.5;
    g.add(baseRing, body, slots, lens, btn, okLed, ring, pl);
    const label = this._makeLabel("Пожар", { scale: 0.0038, fg: "#ffd7d7", border: "rgba(255,80,80,.4)" });
    label.position.set(0, 0.55, 0); g.add(label);
    let phase = 0, alarm = 0, active = false;
    return { group: g, y: this.config.height - 0.08,
      set: (st) => {
        active = st && ["on", "fire", "trigger", "true", "1"].includes(String(st.state).toLowerCase());
        this._setLabel(label, active ? "⚠ ПОЖАР" : "Пожар · норма");
      },
      frame: (dt) => {
        phase += dt * 5;
        alarm = ease(alarm, active ? 1 : 0, 6, dt);
        const pulse = 0.5 + 0.5 * Math.sin(phase);
        lensMat.emissiveIntensity = 0.15 + alarm * (0.4 + pulse * 2.8);
        okLed.material.emissiveIntensity = (1 - alarm) * 0.8;
        pl.intensity = alarm * (6 + pulse * 26);
        if (alarm > 0.05) {
          const rp = (phase * 0.35) % 1;
          const s = 1 + rp * 3.4;
          ring.scale.set(s, s, s);
          ring.material.opacity = (1 - rp) * 0.75 * alarm;
        } else ring.material.opacity = 0;
      } };
  }

  // ---- Обогреватель (конвектор с решёткой) -----------------------------------
  _build_heater() {
    const key = "heater";
    const T = this.THREE;
    const g = new T.Group();
    // корпус конвектора (перед — в сторону -X локально)
    const cab = this._box(0.42, 1.0, 1.8, 0xd7dbe2, { rough: 0.5, metal: 0.2 });
    cab.position.y = 0.65;
    g.add(cab);
    g.rotation.y = Math.PI; // на левой стене: перед смотрит в комнату (+X)
    // ножки
    for (const fz of [-0.75, 0.75]) {
      const leg = this._box(0.36, 0.15, 0.08, 0x2b3140, { metal: 0.4, rough: 0.5 });
      leg.position.set(0, 0.075, fz);
      g.add(leg);
    }
    // решётка сверху: прорези + светящиеся секции за ними
    const grilleBase = this._box(0.4, 0.04, 1.7, 0x39404c, { metal: 0.3, rough: 0.6 });
    grilleBase.position.set(-0.01, 1.17, 0);
    g.add(grilleBase);
    const slatMat = new T.MeshStandardMaterial({ color: 0x2b3140, metalness: 0.3, roughness: 0.6 });
    const finMats = [];
    for (let i = 0; i < 9; i++) {
      const slat = new T.Mesh(new T.BoxGeometry(0.36, 0.03, 0.06), slatMat);
      slat.position.set(-0.01, 1.2, -0.72 + i * 0.18);
      g.add(slat);
      const fin = new T.Mesh(new T.BoxGeometry(0.3, 0.05, 0.09),
        new T.MeshStandardMaterial({ color: 0x443322, emissive: 0xff7a1a, emissiveIntensity: 0 }));
      fin.position.set(-0.01, 1.17, -0.72 + i * 0.18);
      g.add(fin);
      finMats.push(fin.material);
    }
    // термостат (цилиндр с указателем)
    const thermo = this._cyl(0.05, 0.05, 0.04, 0x22262e, { rough: 0.5 });
    thermo.rotation.z = Math.PI / 2; thermo.position.set(-0.23, 0.85, 0.7);
    const pointer = this._box(0.01, 0.07, 0.02, 0xd7dbe2, { rough: 0.4 });
    pointer.position.set(-0.25, 0.88, 0.7);
    g.add(thermo, pointer);
    // индикатор
    const led = this._cyl(0.02, 0.02, 0.015, 0x112233, { emissive: 0xff7a1a, emissiveIntensity: 0 });
    led.rotation.z = Math.PI / 2; led.position.set(-0.23, 0.75, 0.7);
    g.add(led);
    const label = this._makeLabel("Обогреватель", { scale: 0.0036 }); label.position.set(-0.55, 1.6, 0); g.add(label);
    let glow = 0, t = 0;
    return { group: g, y: 0,
      set: (st) => {
        const on = st && st.state === "on";
        this._setLabel(label, on ? "Обогрев · вкл" : "Обогрев · выкл");
      },
      frame: (dt) => {
        const on = this._entityActive(key);
        glow = ease(glow, on ? 1 : 0, 2.2, dt);
        if (glow > 0.001) t += dt;
        const pulse = 0.85 + 0.15 * Math.sin(t * 3);
        finMats.forEach((m, i) => { m.emissiveIntensity = glow * pulse * (0.9 + 0.2 * Math.sin(i * 1.7 + t * 2)); });
        led.material.emissiveIntensity = glow * 1.6;
      } };
  }

  // ---- Кондиционер (сплит-система: створка жалюзи + цветной поток воздуха) ---
  _build_ac() {
    const key = "ac";
    const T = this.THREE;
    const g = new T.Group();
    // корпус (сплошная стена, перед — в сторону -X)
    const body = this._box(0.3, 0.44, 1.25, 0xf2f4f7, { rough: 0.35, metal: 0.05 });
    body.position.y = 0;
    const brandStrip = this._box(0.02, 0.05, 0.5, 0x2b3140, { rough: 0.4 });
    brandStrip.position.set(-0.155, 0.14, -0.35);
    const display = this._box(0.015, 0.07, 0.22, 0x0a2233, { emissive: 0x9fd8ff, emissiveIntensity: 0.4 });
    display.position.set(-0.155, 0.14, 0.35);
    // жалюзи — одна створка снизу, как у сплитов: при работе отклоняется наружу-вниз
    const louverPivot = new T.Group();
    louverPivot.position.set(-0.16, -0.18, 0); // шарнир по верхней кромке
    const louver = this._box(0.02, 0.08, 1.1, 0xe8ecf1, { rough: 0.45, metal: 0.1 });
    louver.position.y = -0.04;
    louverPivot.add(louver);
    // тёмная щель-выход над створкой
    const ventGap = this._box(0.024, 0.035, 1.08, 0x1b1f26, { rough: 0.8 });
    ventGap.position.set(-0.155, -0.17, 0);
    g.add(ventGap);
    // на фасаде — только жалюзи-створка и поток (крыльчатка убрана)
    g.add(body, brandStrip, display, louverPivot);
    // LED статуса
    const led = this._box(0.01, 0.02, 0.06, 0x112233, { emissive: 0x1f6feb, emissiveIntensity: 0 });
    led.position.set(-0.16, 0.165, 0.52);
    g.add(led);

    // ---- поток воздуха (конус, цвет по режиму, текстура бегёт) ----
    const flowTex = this._makeFlowTexture();
    const flowMat = new T.MeshBasicMaterial({
      map: flowTex, color: 0x4dd2ff, transparent: true, opacity: 0,
      blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide,
    });
    const flow = new T.Mesh(new T.CylinderGeometry(0.95, 0.22, 3.1, 20, 1, true), flowMat);
    // ось конуса: от жалюзи вниз-внутрь комнаты (направление ~(-0.87, -0.49, 0))
    flow.rotation.z = 2.09;
    flow.position.set(-1.62, -0.97, 0);
    flow.renderOrder = 10;
    g.add(flow);

    const label = this._makeLabel("Кондиционер", { scale: 0.0036 }); label.position.set(-0.5, 0.65, 0); g.add(label);

    let fanSpeed = 0, glow = 0, t = 0, flowOpacity = 0;
    const modeColor = { cool: 0x4dd2ff, cooling: 0x4dd2ff, heat: 0xff8a3d, heating: 0xff8a3d, auto: 0xa8e6c8, dry: 0xcfe3ff, fan: 0xbfc8d4 };
    return { group: g, y: 2.5,
      set: (st) => {
        if (!st) return;
        const on = st.state !== "off" && st.state !== "idle";
        const mode = STATE_RU[st.state] || st.state;
        const temp = st.attributes.temperature;
        flowMat.color.setHex(modeColor[st.state] ?? 0x9fb8c8);
        this._setLabel(label, on ? `Конд · ${mode}${temp ? " " + temp + "°" : ""}` : "Конд · выкл");
      },
      frame: (dt) => {
        const on = this._entityActive(key);
        glow = ease(glow, on ? 1 : 0, 3, dt);
        if (glow > 0.001) t += dt;
        // разгон/торможение скорости потока
        fanSpeed = ease(fanSpeed, on ? 1 : 0, 1.8, dt);
        // нижняя створка жалюзи отклоняется наружу-вниз
        louverPivot.rotation.z = ease(louverPivot.rotation.z, on ? -0.75 + 0.04 * Math.sin(t * 1.1) : 0.02, 3, dt);
        // поток воздуха
        flowOpacity = ease(flowOpacity, on ? 0.34 : 0, 2.5, dt);
        flowMat.opacity = flowOpacity * (0.8 + 0.2 * Math.sin(t * 2.1));
        flowTex.offset.y = (flowTex.offset.y - dt * 0.55 * fanSpeed) % 1; // поток разгоняется от блока к широкому концу конуса
        display.material.emissiveIntensity = 0.25 + glow * 0.75;
        led.material.emissiveIntensity = glow * 1.6;
      } };
  }

  // ---- Дверь в проёме передней стены (витраж, петли, датчик) -----------------
  _build_door() {
    const key = "door";
    const T = this.THREE;
    const g = new T.Group(); // origin = петля (правый край проёма)
    const W = 1.42, H = 2.1;
    // коробка
    const frameMat = new T.MeshStandardMaterial({ color: 0x4a5260, metalness: 0.4, roughness: 0.5 });
    const colL = new T.Mesh(new T.BoxGeometry(0.14, 2.3, 0.3), frameMat);
    colL.position.set(-1.5, 1.15, -0.03); colL.castShadow = true;
    const colR = new T.Mesh(new T.BoxGeometry(0.14, 2.3, 0.3), frameMat);
    colR.position.set(0.07, 1.15, -0.03); colR.castShadow = true;
    const lintel = new T.Mesh(new T.BoxGeometry(1.72, 0.14, 0.3), frameMat);
    lintel.position.set(-0.71, 2.35, -0.03); lintel.castShadow = true;
    g.add(colL, colR, lintel);
    // створка (группа на петле)
    const pivot = new T.Group();
    pivot.position.set(0, 0, 0);
    const leaf = this._box(W, H, 0.07, 0x8a5a34, { rough: 0.6 });
    leaf.position.set(-W / 2, H / 2, 0);
    const edgeFrame = this._box(W + 0.04, H + 0.04, 0.045, 0x4a5260, { metal: 0.3, rough: 0.5 });
    edgeFrame.position.set(-W / 2, H / 2, 0);
    const glass = new T.Mesh(new T.PlaneGeometry(0.62, 0.85),
      new T.MeshStandardMaterial({ color: 0x9fc7d8, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.4, side: T.DoubleSide }));
    glass.position.set(-W / 2, 1.55, -0.04); // на стороне комнаты
    const handle = this._box(0.14, 0.04, 0.04, 0xd7dbe2, { metal: 0.75, rough: 0.25 });
    handle.position.set(-W + 0.14, 1.05, -0.06);
    const plate = this._cyl(0.035, 0.035, 0.02, 0xd7dbe2, { metal: 0.7, rough: 0.3 });
    plate.rotation.x = Math.PI / 2; plate.position.set(-W + 0.14, 1.05, -0.045);
    pivot.add(leaf, edgeFrame, glass, handle, plate);
    // петли
    for (const hy of [0.35, 1.75]) {
      const hinge = this._cyl(0.025, 0.025, 0.16, 0xb8bec7, { metal: 0.6, rough: 0.35 }, 10);
      hinge.position.set(0.0, hy, 0.05);
      g.add(hinge);
    }
    g.add(pivot);
    // датчик открытия на левой стойке (со стороны комнаты)
    const sensor = this._box(0.07, 0.2, 0.12, 0x112233, { emissive: 0x2ea043, emissiveIntensity: 1.4 });
    sensor.position.set(-1.5, 2.0, -0.2);
    const sensorLed = this._cyl(0.015, 0.015, 0.012, 0x112233, { emissive: 0x2ea043, emissiveIntensity: 1.6 });
    sensorLed.rotation.x = Math.PI / 2;
    sensorLed.position.set(-1.5, 2.12, -0.2);
    g.add(sensor, sensorLed);
    const label = this._makeLabel("Дверь", { scale: 0.0038 }); label.position.set(-0.7, 2.8, 0); g.add(label);
    let ang = 0, open = false;
    return { group: g, y: 0,
      set: (st) => {
        open = st && ["open", "on", "true", "1"].includes(String(st.state).toLowerCase());
        this._setLabel(label, open ? "Дверь · открыта" : "Дверь · закрыта");
      },
      frame: (dt) => {
        ang = ease(ang, open ? -1.85 : 0, 3, dt);
        pivot.rotation.y = ang; // распахивается внутрь помещения
        sensor.material.emissive.setHex(open ? 0xff3b3b : 0x2ea043);
        sensorLed.material.emissive.setHex(open ? 0xff3b3b : 0x2ea043);
      } };
  }

  // ---- Датчик освещённости (потолочный) --------------------------------------
  _build_lux() {
    const key = "lux";
    const T = this.THREE;
    const g = new T.Group();
    const body = this._cyl(0.17, 0.17, 0.09, 0xe8edf3, { rough: 0.5 });
    const rim = new T.Mesh(new T.TorusGeometry(0.15, 0.012, 8, 24),
      new T.MeshStandardMaterial({ color: 0xb8bec7, roughness: 0.5, metalness: 0.2 }));
    rim.rotation.x = Math.PI / 2; rim.position.y = -0.04;
    const lensMat = new T.MeshStandardMaterial({ color: 0x0a1a2a, emissive: 0x8fd0ff, emissiveIntensity: 0.2, roughness: 0.4 });
    const lens = new T.Mesh(new T.CylinderGeometry(0.09, 0.11, 0.03, 20), lensMat);
    lens.position.y = -0.055;
    const led = this._cyl(0.015, 0.015, 0.01, 0x112233, { emissive: 0x1f6feb, emissiveIntensity: 0.6 });
    led.position.set(0.1, 0.05, 0);
    g.add(body, rim, lens, led);
    const label = this._makeLabel("Люкс", { scale: 0.0038 }); label.position.set(0, 0.45, 0); g.add(label);
    let cur = 0.2, luxVal = 0;
    return { group: g, y: this.config.height - 0.05,
      set: (st) => {
        luxVal = st ? parseFloat(st.state) : 0;
        const u = st && st.attributes.unit_of_measurement ? " " + st.attributes.unit_of_measurement : " лк";
        this._setLabel(label, `Свет ${isFinite(luxVal) ? Math.round(luxVal) : "?"}${u}`);
      },
      frame: (dt) => {
        const target = clamp(Math.log10(1 + (luxVal || 0)) / 3.2, 0, 1);
        cur = ease(cur, target, 3, dt);
        lensMat.emissiveIntensity = 0.1 + cur * 2.6;
      } };
  }

  // ---- вспомогательные по состоянию ----------------------------------------
  _entityActive(key) {
    const e = this.keyToEntity[key];
    const st = e && this.state[e];
    if (!st) return false;
    const s = String(st.state).toLowerCase();
    return ["on", "open", "true", "1", "cooling", "heating", "cool", "heat", "auto", "dry", "fan"].includes(s);
  }
  _flowActive() {
    const e = this.config.entities.water_flow;
    const st = e && this.state[e];
    return !!st && parseFloat(st.state) > 0;
  }

  // ---- состояние -----------------------------------------------------------
  applyStates(states) {
    for (const id in states) this.state[id] = states[id];
    this._syncFromStates();
  }
  setEntityState(id, st) {
    this.state[id] = st;
    this._syncFromStates();
    if (this.openKey && this.keyToEntity[this.openKey] === id) this._refreshModal();
  }
  // смена топиков (entity_id) без пересоздания сцены
  setEntities(map) {
    if (!map) return;
    for (const k in map) {
      this.config.entities[k] = map[k];
      this.keyToEntity[k] = map[k] || null;
      if (this.objs[k]) this.objs[k].entity = map[k] || null;
    }
    this._syncFromStates();
  }
  _syncFromStates() {
    for (const key in this.objs) {
      const e = this.keyToEntity[key];
      const st = e ? this.state[e] : null;
      if (this.objs[key].set) this.objs[key].set(st);
    }
    this._updateHud();
  }
  _updateHud() {
    const n = Object.keys(this.state).length;
    this._setHud(this.config.title, this._hudSub || `привязано сущностей: ${n}`);
  }
  _setHud(title, sub) {
    if (!this._hud) return;
    this._hud.querySelector(".t").textContent = title;
    this._hud.querySelector(".s").textContent = sub;
  }
  setHudSub(s) { this._hudSub = s; this._updateHud(); }

  // ---- цикл ----------------------------------------------------------------
  start() {
    if (this.running) return;
    this.running = true;
    this._lastT = performance.now();
    const loop = (t) => {
      if (!this.running || this.disposed) return;
      this._raf = requestAnimationFrame(loop);
      const dt = clamp((t - this._lastT) / 1000, 0, 0.05);
      this._lastT = t;
      for (const key in this.objs) if (this.objs[key].frame) this.objs[key].frame(dt);
      for (const f of this._propFrames) f(dt);
      this._updateCamera();
      if (this.container.clientWidth > 0) this.renderer.render(this.scene, this.camera);
    };
    this._raf = requestAnimationFrame(loop);
  }
  stop() { this.running = false; cancelAnimationFrame(this._raf); }
  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
  resetView() {
    this.camTarget.set(0, 0.4, 0);
    this.camPhi = 0.5; this.camTheta = 0; this.camRadius = 19;
    this._clampCam();
    this._updateCamera();
  }
  dispose() {
    this.disposed = true; this.stop();
    this._resizeObs && this._resizeObs.disconnect();
    // disposeRenderer === false означает, что рендерер принадлежит не нам
    // (карточка передала общий canvas и контекст): уничтожать его нельзя,
    // иначе следующая сцена на том же canvas останется пустой.
    if (this.renderer && this.disposeRenderer !== false) this.renderer.dispose();
    if (this.scene) this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { const m = Array.isArray(o.material) ? o.material : [o.material]; m.forEach((x) => { x.map && x.map.dispose(); x.dispose && x.dispose(); }); }
    });
    this._overlay && this._overlay.remove();
    this._hud && this._hud.remove();
    this._tip && this._tip.remove();
  }

  // ---- события --------------------------------------------------------------
  // (T-003) Жесты камеры больше не идут через движок: карточка сама
  // присоединяет к камере движка общий модуль createCameraControls и передаёт
  // жесты через applyGesture(). Движок слушает только размер окна (ресайз сцены).
  _bindEvents() {
    if (typeof ResizeObserver !== "undefined") {
      // Наблюдать можно только за настоящим элементом: в режиме адаптера
      // (models/production-room/scene.js) контейнер — объект-обёртка без DOM.
      const domRoot = this.opts && this.opts.canvas ? this.opts.canvas.parentElement : this.container;
      if (domRoot && typeof Element !== "undefined" && domRoot instanceof Element) {
        this._resizeObs = new ResizeObserver(() => this.resize());
        this._resizeObs.observe(domRoot);
      }
    }
  }

  /**
   * Жест камеры от общего модуля карточки (createCameraControls, T-003):
   *   orbit — вращение вокруг цели,
   *   pan   — панорамирование,
   *   zoom  — factor: >1 отдалить, <1 приблизить (колесо / щипок),
   *   reset — возврат к исходному виду.
   */
  applyGesture(g) {
    if (!g || !g.type) return;
    if (g.type === "orbit") this._orbit(g.dx || 0, g.dy || 0);
    else if (g.type === "pan") this._pan(g.dx || 0, g.dy || 0);
    else if (g.type === "zoom") { this.camRadius *= g.factor || 1; this._clampCam(); }
    else if (g.type === "reset") this.resetView();
  }
  _orbit(dx, dy) {
    // орбита: вращаем камеру вокруг цели по азимуту и углу наклона
    this.camTheta -= dx * 0.005;
    this.camPhi -= dy * 0.005;
    this._clampCam();
  }
  _pan(dx, dy) {
    const T = this.THREE;
    const fwd = new T.Vector3().subVectors(this.camTarget, this.camera.position); fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize();
    const right = new T.Vector3().crossVectors(fwd, new T.Vector3(0, 1, 0)).normalize();
    const scale = this.camRadius * 0.0016;
    this.camTarget.addScaledVector(right, -dx * scale);
    this.camTarget.addScaledVector(fwd, dy * scale);
    this._clampCam();
  }
  _click(e) {
    const T = this.THREE;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new T.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new T.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const hits = rc.intersectObjects(this.objectsGroup.children, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.key) o = o.parent;
      if (o && o.userData.key && this.objs[o.userData.key]) { this._openModal(o.userData.key); return; }
    }
  }

  // ---- модальное окно ------------------------------------------------------
  _buildModalDom() {
    const ov = document.createElement("div");
    ov.className = "pr-overlay";
    ov.innerHTML = `
      <div class="pr-modal" role="dialog" aria-modal="true">
        <div class="pr-head">
          <div>
            <div class="pr-title"></div>
            <div class="pr-entity"></div>
          </div>
          <button class="pr-close" title="Закрыть">✕</button>
        </div>
        <div class="pr-body"></div>
        <div class="pr-foot"></div>
      </div>`;
    ov.querySelector(".pr-close").addEventListener("click", () => this._closeModal());
    ov.addEventListener("click", (e) => { if (e.target === ov) this._closeModal(); });
    this.container.appendChild(ov);
    this._overlay = ov;
    this._modalTitle = ov.querySelector(".pr-title");
    this._modalEntity = ov.querySelector(".pr-entity");
    this._modalBody = ov.querySelector(".pr-body");
    this._modalFoot = ov.querySelector(".pr-foot");
  }

  _openModal(key) {
    this.openKey = key;
    this._refreshModal();
    this._overlay.classList.add("open");
  }
  _closeModal() { this.openKey = null; this._overlay && this._overlay.classList.remove("open"); }

  _refreshModal() {
    if (!this.openKey) return;
    const o = this.objs[this.openKey];
    const e = o.entity;
    const st = e ? this.state[e] : null;
    this._modalTitle.textContent = o.name;
    this._modalEntity.textContent = e || "не привязано к сущности HA";

    const dotColor = this._dotColor(o, st);
    let html = `<div class="pr-state-line">
        <span class="pr-dot" style="background:${dotColor}"></span>
        <span class="pr-state-val">${st ? prettyState(st) : "нет данных"}</span>
      </div>`;
    if (st) {
      if (st.attributes && Object.keys(st.attributes).length) {
        html += `<div class="pr-attrs"><table>`;
        for (const k in st.attributes) {
          if (k === "friendly_name") continue;
          html += `<tr><td>${esc(k)}</td><td>${esc(st.attributes[k])}</td></tr>`;
        }
        html += `</table></div>`;
      } else if (st.state !== undefined) {
        const unit = st.attributes && st.attributes.unit_of_measurement ? ` (${st.attributes.unit_of_measurement})` : "";
        html += `<div class="pr-attrs">Значение: <b>${esc(st.state)}</b>${esc(unit)}</div>`;
      }
      if (st.last_changed) html += `<div class="pr-muted" style="margin-top:8px">Изменено: ${new Date(st.last_changed).toLocaleString()}</div>`;
    } else {
      html += `<div class="pr-muted" style="margin-top:8px">Сущность не найдена. Проверьте конфигурацию и подключение к HA.</div>`;
    }
    this._modalBody.innerHTML = html;

    this._modalFoot.innerHTML = "";
    if (e && this.onService) {
      this._modalFoot.appendChild(this._buildControls(e, st));
      const link = document.createElement("a");
      link.className = "pr-link"; link.textContent = "Открыть в Home Assistant →";
      link.addEventListener("click", () => this.onDeepLink && this.onDeepLink(e));
      this._modalFoot.appendChild(link);
    } else {
      const m = document.createElement("div"); m.className = "pr-muted";
      m.textContent = this.onService ? "Для этой сущности нет контрольных сервисов." : "Управление недоступно.";
      this._modalFoot.appendChild(m);
    }
  }

  _dotColor(o, st) {
    if (!st) return "#888";
    const s = String(st.state).toLowerCase();
    if (o.key === "fire" && ["on", "fire", "trigger", "true", "1"].includes(s)) return "#ff3b3b";
    if (["on", "open", "cooling", "heating", "cool", "heat"].includes(s)) return "#2ea043";
    if (["off", "closed", "idle"].includes(s)) return "#8b93a1";
    return "#e0b400";
  }

  _el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  _buildControls(entity, st) {
    const domain = entity.split(".")[0];
    const wrap = this._el("div", "pr-ctrl");
    if (!st) { wrap.appendChild(this._el("div", "pr-muted", "Нет данных.")); return wrap; }

    if (domain === "light") {
      const on = st.state === "on";
      wrap.appendChild(this._toggleRow("Питание", on, (v) => this.onService("light", v ? "turn_on" : "turn_off", { entity_id: entity })));
      const br = st.attributes.brightness != null ? st.attributes.brightness : (on ? 255 : 0);
      wrap.appendChild(this._rangeRow("Яркость (диммер)", Math.round((br / 255) * 100), 0, 100, "%", (v) => {
        if (v <= 0) this.onService("light", "turn_off", { entity_id: entity });
        else this.onService("light", "turn_on", { entity_id: entity, brightness: Math.max(1, Math.round((v / 100) * 255)) });
      }));
    } else if (domain === "switch") {
      wrap.appendChild(this._toggleRow("Питание", st.state === "on", (v) => this.onService("switch", v ? "turn_on" : "turn_off", { entity_id: entity })));
    } else if (domain === "climate") {
      const min = st.attributes.min_temp ?? 7, max = st.attributes.max_temp ?? 35;
      wrap.appendChild(this._rangeRow("Температура", st.attributes.temperature ?? 20, min, max, "°C", (v) => this.onService("climate", "set_temperature", { entity_id: entity, temperature: v })));
      const modes = st.attributes.hvac_modes || [];
      if (modes.length) wrap.appendChild(this._modeRow("Режим", modes, st.state, (m) => this.onService("climate", "set_hvac_mode", { entity_id: entity, hvac_mode: m })));
    } else if (domain === "number") {
      wrap.appendChild(this._rangeRow("Значение", +st.state, st.attributes.min ?? 0, st.attributes.max ?? 100, st.attributes.unit_of_measurement || "", (v) => this.onService("number", "set_value", { entity_id: entity, value: v })));
    } else if (domain === "binary_sensor") {
      wrap.appendChild(this._el("div", "pr-muted", "Датчик (только чтение). Состояние: " + prettyState(st)));
    } else if (domain === "sensor") {
      wrap.appendChild(this._el("div", "pr-muted", "Датчик (только чтение). Значение: " + st.state + " " + (st.attributes.unit_of_measurement || "")));
    } else {
      wrap.appendChild(this._el("div", "pr-muted", "Состояние: " + st.state));
    }
    return wrap;
  }

  _toggleRow(label, on, cb) {
    const row = this._el("div", "pr-row");
    row.appendChild(this._el("span", "lbl", label));
    const btn = this._el("button", "pr-btn" + (on ? " on" : ""), on ? "Вкл" : "Выкл");
    btn.addEventListener("click", () => { cb(!on); btn.className = "pr-btn" + (!on ? " on" : ""); btn.textContent = !on ? "Вкл" : "Выкл"; });
    row.appendChild(btn);
    return row;
  }
  _rangeRow(label, value, min, max, unit, cb) {
    const row = this._el("div", "pr-row");
    row.appendChild(this._el("span", "lbl", label));
    const inp = document.createElement("input");
    inp.type = "range"; inp.className = "pr-range"; inp.min = min; inp.max = max; inp.value = value; inp.step = (max - min > 20 ? 1 : 0.5);
    const val = this._el("span", "pr-val", value + (unit ? " " + unit : ""));
    inp.addEventListener("input", () => { val.textContent = inp.value + (unit ? " " + unit : ""); });
    inp.addEventListener("change", () => cb(parseFloat(inp.value)));
    row.appendChild(inp); row.appendChild(val);
    return row;
  }
  _modeRow(label, modes, active, cb) {
    const row = this._el("div", "pr-row");
    row.appendChild(this._el("span", "lbl", label));
    const box = this._el("div", "pr-modes");
    modes.forEach((m) => {
      const b = this._el("button", "pr-btn" + (m === active ? " active" : ""), STATE_RU[m] || m);
      b.addEventListener("click", () => cb(m));
      box.appendChild(b);
    });
    row.appendChild(box);
    return row;
  }
}
