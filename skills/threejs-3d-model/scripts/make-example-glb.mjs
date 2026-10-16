#!/usr/bin/env node
// ============================================================================
//  make-example-glb.mjs — пересобирает examples/hinged-door.glb.
//
//  Зачем: скиллу нужен образец структуры glTF/GLB, в котором карточка работает
//  так, как задумано:
//    * каждый управляемый объект — отдельный узел (nodes[].name = target);
//    * у каждого узла своё `translation`, а вершины — ЛОКАЛЬНЫЕ (в отличие от
//      OBJ, где позиция у всех объектов нулевая, а вершины мировые);
//    * части створки двери — дочерние узлы створки ( `Door_Handle` внутри
//      `Door_Leaf`), поэтому едут вместе с ней.
//
//  Запуск:  node skills/threejs-3d-model/scripts/make-example-glb.mjs
//  Пишет:   skills/threejs-3d-model/examples/hinged-door.glb
//
//  Скрипт — только генератор образца; самой карточке и валидаторам он не нужен.
//  Никаких зависимостей: GLB собирается вручную (заголовок + JSON-чанк + BIN).
// ============================================================================

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "examples", "hinged-door.glb");

// ---- буфер и bufferView/accessor --------------------------------------------

const parts = [];          // куски BIN-чанка
const bufferViews = [];
const accessors = [];
let totalLen = 0;

function pushView(typedArray, target) {
  const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  const pad = (4 - (totalLen % 4)) % 4;
  if (pad) { parts.push(new Uint8Array(pad)); totalLen += pad; }
  bufferViews.push({ buffer: 0, byteOffset: totalLen, byteLength: bytes.byteLength, target });
  parts.push(bytes);
  totalLen += bytes.byteLength;
  return bufferViews.length - 1;
}

function pushAccessor(typedArray, { type, componentType, target, minMax = false }) {
  const count = typedArray.length / (type === "VEC3" ? 3 : 1);
  const view = pushView(typedArray, target);
  const accessor = { bufferView: view, componentType, count, type };
  if (minMax) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < typedArray.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], typedArray[i + k]);
        max[k] = Math.max(max[k], typedArray[i + k]);
      }
    }
    accessor.min = min;
    accessor.max = max;
  }
  accessors.push(accessor);
  return accessors.length - 1;
}

// ---- геометрия: параллелепипед ----------------------------------------------
// Вершины каждой грани — против часовой стрелки снаружи (лицевая сторона glTF).
// `center` — смещение вершин ВНУТРИ узла (у створки оно ненулевое: начало узла
// стоит на линии петель, а не в центре створки).

function box(w, h, d, center = [0, 0, 0]) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const faces = [
    { n: [1, 0, 0], v: [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]] },
    { n: [-1, 0, 0], v: [[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]] },
    { n: [0, 1, 0], v: [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]] },
    { n: [0, -1, 0], v: [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]] },
    { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
  ];
  const positions = [];
  const normals = [];
  const indices = [];
  faces.forEach((f, fi) => {
    for (const v of f.v) {
      positions.push(v[0] + center[0], v[1] + center[1], v[2] + center[2]);
      normals.push(f.n[0], f.n[1], f.n[2]);
    }
    const o = fi * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  };
}

function hexToRgb(hex) {
  const s = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
}

// ---- описание образца --------------------------------------------------------

const NODES = [
  { name: "Floor", translation: [0, 0, 0], box: [6, 0.04, 4, [0, -0.02, 0]], color: "#6f7175" },
  { name: "Wall_Back", translation: [0, 0, -2], box: [6, 2.6, 0.1, [0, 1.3, 0]], color: "#d9d5cd" },
  {
    // Створка: начало узла — на линии петель (x = 0 локально), поэтому поворот
    // вокруг Y крутит дверь по петле, а не вокруг её центра.
    name: "Door_Leaf", translation: [-1.45, 0, -1.9], box: [0.9, 2.05, 0.04, [0.45, 1.025, 0]], color: "#8a5a2b",
    children: [
      // Ручка — дочерний узел створки: уезжает и поворачивается вместе с ней.
      { name: "Door_Handle", translation: [0.78, 1.0, 0.05], box: [0.14, 0.03, 0.03], color: "#c9ccd2" },
    ],
  },
  // Вентилятор: вершины локальные, узел стоит на стене — `rotate` крутит его
  // вокруг собственной оси (в OBJ такая привязка вращала бы вокруг начала сцены).
  { name: "Fan_Bathroom", translation: [-2.1, 2.0, -1.87], box: [0.6, 0.6, 0.06], color: "#b8bec7" },
  { name: "Lamp_Ceiling", translation: [0, 2.52, 0], box: [0.6, 0.15, 0.6], color: "#3a3a3e" },
  { name: "Sensor_Panel", translation: [-2.85, 1.2, -1.9], box: [0.08, 0.3, 0.5], color: "#f0f0f0" },
];

// ---- сборка glTF -------------------------------------------------------------

const nodes = [];
const meshes = [];
const materials = [];
const sceneNodes = [];
let vertexCount = 0;

function addNode(def) {
  const geom = box(...def.box);
  vertexCount += geom.positions.length / 3;
  const position = pushAccessor(geom.positions, { type: "VEC3", componentType: 5126, target: 34962, minMax: true });
  const normal = pushAccessor(geom.normals, { type: "VEC3", componentType: 5126, target: 34962 });
  const indices = pushAccessor(geom.indices, { type: "SCALAR", componentType: 5123, target: 34963 });

  materials.push({
    name: def.name,
    pbrMetallicRoughness: { baseColorFactor: [...hexToRgb(def.color), 1], metallicFactor: 0.1, roughnessFactor: 0.8 },
  });
  meshes.push({ name: def.name, primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices, material: materials.length - 1 }] });

  const node = { name: def.name, mesh: meshes.length - 1 };
  if (def.translation) node.translation = def.translation;
  const childIds = (def.children || []).map(addNode);
  if (childIds.length) node.children = childIds;

  nodes.push(node);
  return nodes.length - 1;
}

for (const def of NODES) sceneNodes.push(addNode(def));

const binLength = totalLen;
const bin = Buffer.concat(parts.map((p) => Buffer.from(p)), binLength);

const json = {
  asset: {
    version: "2.0",
    generator: "threejs-3d-card / skills/threejs-3d-model/scripts/make-example-glb.mjs",
    extras: {
      note: "Образец структуры: узел на объект, у каждого узла свой translation, вершины локальные; части створки — дочерние узлы Door_Leaf.",
    },
  },
  scene: 0,
  scenes: [{ name: "hinged-door", nodes: sceneNodes }],
  nodes,
  meshes,
  materials,
  accessors,
  bufferViews,
  buffers: [{ byteLength: binLength }],
};

// ---- контейнер GLB -----------------------------------------------------------
// 12 байт заголовка + JSON-чанк (добивается пробелами) + BIN-чанк (нулями).

function padTo4(buf, padByte) {
  const pad = (4 - (buf.length % 4)) % 4;
  return pad ? Buffer.concat([buf, Buffer.alloc(pad, padByte)]) : buf;
}

const jsonChunk = padTo4(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
const binChunk = padTo4(bin, 0x00);
const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;

const glb = Buffer.alloc(total);
glb.writeUInt32LE(0x46546c67, 0); // «glTF»
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(total, 8);
glb.writeUInt32LE(jsonChunk.length, 12);
glb.writeUInt32LE(0x4e4f534a, 16); // JSON
jsonChunk.copy(glb, 20);
glb.writeUInt32LE(binChunk.length, 20 + jsonChunk.length);
glb.writeUInt32LE(0x004e4942, 24 + jsonChunk.length); // BIN
binChunk.copy(glb, 28 + jsonChunk.length);

await fs.writeFile(OUT, glb);

const rel = path.relative(process.cwd(), OUT);
console.log(`✔ ${rel} — ${(total / 1024).toFixed(1)} КБ`);
console.log(`  узлы (target для привязок): ${nodes.map((n) => n.name).join(", ")}`);
console.log(`  мешей: ${meshes.length}, материалов: ${materials.length}, вершин: ${vertexCount}`);
