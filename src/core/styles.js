// ============================================================================
//  Стили оверлея (HUD, статус, диагностика, модальное окно).
//  Используются CSS-переменные темы Home Assistant, поэтому карточка
//  автоматически подстраивается под светлую/тёмную тему и тему пользователя.
// ============================================================================

export const STYLE_ID = "t3d-styles";

const CSS = `
.t3d-root { position: relative; width: 100%; height: 100%; min-height: 120px; overflow: hidden;
  border-radius: var(--ha-card-border-radius, 12px); }
.t3d-canvas { border-radius: inherit; }
.t3d-overlay { position: absolute; inset: 0; pointer-events: none; z-index: 2;
  font-family: var(--ha-font-family-body, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  color: var(--primary-text-color, #dfe6ef); }
.t3d-overlay > * { pointer-events: none; }
.t3d-overlay button, .t3d-overlay input, .t3d-modal-backdrop { pointer-events: auto; }

.t3d-hud { position: absolute; left: 12px; top: 10px; max-width: calc(100% - 24px); }
.t3d-hud-title { font-size: 14px; font-weight: 650; letter-spacing: .2px;
  text-shadow: 0 1px 6px rgba(0,0,0,.55); }
.t3d-hud-sub { font-size: 11px; opacity: .75; margin-top: 2px; text-shadow: 0 1px 5px rgba(0,0,0,.5); }

.t3d-status { position: absolute; left: 12px; right: 12px; bottom: 10px; font-size: 11.5px;
  padding: 6px 10px; border-radius: 8px; background: rgba(10,14,20,.72);
  border: 1px solid var(--divider-color, rgba(120,140,170,.25)); backdrop-filter: blur(4px);
  word-break: break-word; }
.t3d-status-error { color: var(--error-color, #ff8b8b); border-color: var(--error-color, #ff8b8b); }

.t3d-actions { position: absolute; right: 10px; bottom: 10px; display: flex; gap: 6px; flex-wrap: wrap;
  justify-content: flex-end; max-width: calc(100% - 20px); }
.t3d-btn { cursor: pointer; font: inherit; font-size: 12px; padding: 6px 12px; border-radius: 9px;
  border: 1px solid var(--divider-color, rgba(130,150,180,.35));
  background: var(--card-background-color, rgba(20,26,34,.85)); color: var(--primary-text-color, #dfe6ef);
  transition: background .15s ease, border-color .15s ease; }
.t3d-btn:hover { background: var(--secondary-background-color, rgba(50,60,75,.9)); }
.t3d-btn-primary { background: var(--primary-color, #1f6feb); border-color: var(--primary-color, #1f6feb);
  color: var(--text-primary-color, #fff); }
.t3d-btn-primary:hover { filter: brightness(1.1); }

.t3d-diag { position: absolute; left: 12px; top: 12px; right: 12px; max-height: calc(100% - 24px); overflow: auto;
  background: var(--card-background-color, rgba(14,18,24,.94));
  border: 1px solid var(--divider-color, rgba(120,140,170,.3)); border-radius: 12px;
  padding: 12px 14px; font-size: 11.5px; backdrop-filter: blur(6px); pointer-events: auto; z-index: 5; }
.t3d-diag-title { font-weight: 650; font-size: 12.5px; margin-bottom: 8px; }
.t3d-diag-row { display: grid; grid-template-columns: 14px 1.1fr 1.4fr 1.2fr; gap: 6px; padding: 3px 0;
  border-top: 1px solid var(--divider-color, rgba(120,140,170,.16)); align-items: baseline; }
.t3d-diag-mark { text-align: center; }
.t3d-diag-ok .t3d-diag-mark { color: var(--success-color, #43a047); }
.t3d-diag-warn .t3d-diag-mark { color: var(--warning-color, #ffa600); }
.t3d-diag-error .t3d-diag-mark { color: var(--error-color, #e53935); }
.t3d-diag-name { font-weight: 550; }
.t3d-diag-entity { font-family: var(--code-font-family, ui-monospace, Consolas, monospace); opacity: .8;
  word-break: break-all; }
.t3d-diag-msg { opacity: .75; }
.t3d-diag-log { margin-top: 8px; padding-top: 8px; font-family: var(--code-font-family, ui-monospace, monospace);
  font-size: 10.5px; opacity: .7; border-top: 1px solid var(--divider-color, rgba(120,140,170,.2)); }

.t3d-modal-backdrop { position: absolute; inset: 0; z-index: 10; display: flex; align-items: center;
  justify-content: center; padding: 12px; background: rgba(4,7,11,.55); backdrop-filter: blur(2px); }
.t3d-modal { width: min(430px, 100%); max-height: 100%; overflow: auto;
  background: var(--card-background-color, #12161d); color: var(--primary-text-color, #dfe6ef);
  border: 1px solid var(--divider-color, rgba(120,140,170,.3)); border-radius: 14px;
  box-shadow: 0 18px 50px rgba(0,0,0,.5); padding: 14px 16px; }
.t3d-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.t3d-modal-title { font-size: 14.5px; font-weight: 650; }
.t3d-modal-close { cursor: pointer; border: none; background: none; color: inherit; font-size: 14px;
  opacity: .6; padding: 2px 6px; border-radius: 6px; }
.t3d-modal-close:hover { opacity: 1; background: var(--secondary-background-color, rgba(255,255,255,.08)); }
.t3d-modal-entity { font-family: var(--code-font-family, ui-monospace, monospace); font-size: 11px;
  opacity: .7; margin-top: 2px; word-break: break-all; }
.t3d-modal-domain { display: inline-block; margin-top: 6px; font-size: 10.5px; padding: 2px 8px; border-radius: 20px;
  border: 1px solid var(--divider-color, rgba(120,140,170,.35)); opacity: .8; }
.t3d-modal-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
.t3d-modal-table th { text-align: left; font-weight: 500; opacity: .65; padding: 4px 10px 4px 0;
  vertical-align: top; white-space: nowrap; }
.t3d-modal-table td { padding: 4px 0; word-break: break-word; }
.t3d-modal-table tr + tr th, .t3d-modal-table tr + tr td {
  border-top: 1px solid var(--divider-color, rgba(120,140,170,.14)); }
.t3d-modal-missing { margin-top: 10px; font-size: 12px; color: var(--warning-color, #ffa600); }
.t3d-modal-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
.t3d-modal-foot { margin-top: 14px; display: flex; justify-content: flex-end; gap: 8px; }
.t3d-ctl-slider { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.t3d-ctl-slider input { accent-color: var(--primary-color, #1f6feb); }
.t3d-dim { opacity: .6; }

.t3d-fallback { display: flex; align-items: center; justify-content: center; height: 100%; min-height: 160px;
  padding: 18px; text-align: center; font-size: 12.5px; line-height: 1.5;
  color: var(--secondary-text-color, #8b98a8); }
.t3d-fallback code { font-family: var(--code-font-family, ui-monospace, monospace); font-size: 11.5px;
  background: var(--secondary-background-color, rgba(255,255,255,.06)); padding: 1px 5px; border-radius: 4px; }
.t3d-fallback-error { color: var(--error-color, #ff8b8b); }

@media (max-width: 480px) {
  .t3d-diag-row { grid-template-columns: 14px 1fr; }
  .t3d-diag-entity, .t3d-diag-msg { grid-column: 2; }
}
`;

/** Вставить стили один раз на корень (shadow root или обычный DOM). */
export function ensureStyles(rootNode) {
  if (!rootNode) return;
  const host = rootNode === document ? document.head : rootNode;
  if (!host || !host.querySelector) return;
  if (host.querySelector(`#${STYLE_ID}`)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  host.appendChild(style);
}
