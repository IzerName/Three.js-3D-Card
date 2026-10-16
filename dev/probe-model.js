// ============================================================================
//  Внешняя модель для самопроверки (dev/probe.html).
//
//  Проверяет ровно тот путь, которым пользуется пользователь: файл лежит вне
//  карточки, подключается по URL из редактора и вызывает defineModel().
//  Никаких импортов — только window.ThreeJS3DCard.
// ============================================================================

(() => {
  const api = window.ThreeJS3DCard;

  api.defineModel({
    manifest: {
      id: "probe-external",
      name: "Внешняя модель (самопроверка)",
      description: "Проверка импорта модели по URL",
      apiVersion: 1,
      camera: { radius: 5, phi: 1.1, theta: 0.5, target: [0, 0.5, 0] },
      environment: { floor: "radial" },
      size: { defaultHeight: 300 },
    },

    bindings: [
      { key: "power", name: "Питание", domain: ["switch", "binary_sensor"], value: { kind: "boolean" } },
    ],

    params: [
      { key: "color", name: "Цвет", type: "theme-color", default: "var(--primary-color)" },
    ],

    defaults: { config: { title: "Внешняя модель" } },

    create(ctx) {
      // three.js всегда доступен через контекст — брать его на верхнем уровне файла нельзя
      const THREE = ctx.THREE;
      const group = new THREE.Group();
      const geometry = new THREE.TorusKnotGeometry(0.6, 0.2, 96, 16);
      const material = new THREE.MeshStandardMaterial({
        color: ctx.resolveColor(ctx.params.color, "#1f6feb"),
        metalness: 0.4,
        roughness: 0.35,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = 0.9;
      group.add(mesh);
      ctx.tag(mesh, "power");

      const label = ctx.makeLabel("Внешняя модель", { scale: 0.0045 });
      label.position.set(0, 2.1, 0);
      group.add(label);

      let spin = 0.4;
      ctx.report("info", "внешняя модель probe-external загружена");

      return {
        root: group,
        applyStates(view) {
          const on = view.power && view.power.value;
          spin = on ? 1.4 : 0.3;
          material.emissive.setHex(on ? 0x2ea043 : 0x000000);
          material.emissiveIntensity = on ? 0.5 : 0;
          label.userData.redraw(on ? "Питание: ВКЛ" : "Питание: ВЫКЛ");
          ctx.requestRender();
        },
        frame(dt) {
          mesh.rotation.y += dt * spin;
          mesh.rotation.x += dt * spin * 0.35;
        },
        dispose() {
          geometry.dispose();
          material.dispose();
        },
      };
    },
  });

  console.info("[probe-model] внешняя модель зарегистрирована");
})();
