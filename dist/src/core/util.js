// ============================================================================
//  Небольшие общие утилиты: математика, DOM, цвета темы HA, метки.
//  Без зависимостей — используется и ядром, и моделями.
// ============================================================================

export function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Экспоненциальное сглаживание, независимое от частоты кадров. */
export function ease(cur, target, rate, dt) {
  return lerp(cur, target, 1 - Math.exp(-rate * dt));
}

export function round(v, digits = 2) {
  const k = Math.pow(10, digits);
  return Math.round(v * k) / k;
}

/** Экранирование HTML. */
export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** Формат числа: 12.34 -> "12.3", 1200 -> "1 200". */
export function fmtNumber(v, digits = 1) {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1000) {
    return v.toLocaleString("ru-RU", { maximumFractionDigits: digits });
  }
  const r = Number(v.toFixed(digits));
  return String(r);
}

/**
 * Разрешить цвет: поддерживает CSS-переменные темы HA.
 *   resolveColor("var(--color-2)", "#2f9df4")
 *   resolveColor("#ff8800", …)  -> остается как есть
 */
export function resolveColor(spec, fallback = "#888888") {
  if (!spec) return fallback;
  const s = String(spec).trim();
  if (!s) return fallback;
  const m = s.match(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/);
  if (!m) return s;
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
    if (v) {
      // HA-темы часто содержат "R, G, B" — превращаем в rgb()
      if (/^\d+\s*,\s*\d+\s*,\s*\d+$/.test(v)) return `rgb(${v})`;
      return v;
    }
  } catch (e) {
    /* вне DOM — игнорируем */
  }
  return m[2] ? m[2].trim() : fallback;
}

/** Приблизительно ли «тёмная» тема (для подбора цвета текста в оверлеях). */
export function isDarkTheme() {
  try {
    const bg = getComputedStyle(document.documentElement)
      .getPropertyValue("--primary-background-color").trim();
    const m = bg.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return true;
    const lum = 0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3];
    return lum < 128;
  } catch (e) {
    return true;
  }
}

/** Скруглённый прямоугольник на canvas 2D (совместимость со старыми браузерами). */
export function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Наблюдать за видимостью элемента (для остановки рендера вне экрана). */
export function observeVisibility(el, onVisible) {
  if (typeof IntersectionObserver === "undefined") return null;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) onVisible(!!e.isIntersecting);
  }, { threshold: 0.01 });
  io.observe(el);
  return io;
}

/** Предпочитает ли пользователь уменьшенную анимацию. */
export function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {
    return false;
  }
}

/** Отличить указатель «палец» (мобильные) для упрощённого управления. */
export function isCoarsePointer() {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch (e) {
    return false;
  }
}

/** Глубокое слияние простых объектов (для config.params). */
export function deepMerge(base, patch) {
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base && typeof base[k] === "object" && base[k] !== null) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** Прочитать значение по пути "probe_levels.high". */
export function getPath(obj, path, fallback) {
  const parts = String(path).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
}

/** Записать значение по пути "probe_levels.high". */
export function setPath(obj, path, value) {
  const parts = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}
