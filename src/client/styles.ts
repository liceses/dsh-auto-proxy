/**
 * dsh-auto-proxy — browser half styles (settings card).
 * Mirrors the official plugin-card chrome (dsw alias tokens): bordered card
 * with a disclosure header (name/description/chevron), body, footer actions.
 */

export const CARD_CSS = `
.apx-card {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  border-radius: 12px;
  list-style: none;
  transition: border-color .16s, background .16s;
}
.apx-card:hover {
  border-color: var(--dsw-alias-label-dimmed);
}
.apx-card:has(.apx-header[aria-expanded="true"]) {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
.apx-header {
  appearance: none;
  width: 100%;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 12px;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  display: flex;
}
.apx-header:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.apx-headText {
  flex-direction: column;
  flex: 1;
  gap: 4px;
  min-width: 0;
  display: flex;
}
.apx-name {
  color: var(--dsw-alias-label-primary);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
}
.apx-description {
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 1.5;
}
.apx-chevron {
  color: var(--dsw-alias-label-tertiary);
  flex: none;
  transition: transform .16s;
}
.apx-chevronOpen {
  transform: rotate(180deg);
}
.apx-pending {
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  border-radius: 999px;
  flex: none;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
}
.apx-body {
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin: 0 16px;
  padding-bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 12px;
}
.apx-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.apx-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  line-height: 1.5;
}
.apx-select, .apx-input {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  height: 34px;
  font: inherit;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 0 12px;
}
.apx-select:focus-visible, .apx-input:focus-visible {
  border-color: var(--dsw-alias-brand-primary);
  outline: none;
}
.apx-select:disabled, .apx-input:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.apx-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
  line-height: 1.5;
  cursor: pointer;
}
.apx-check input {
  accent-color: var(--dsw-alias-brand-primary);
}
.apx-status {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}
.apx-status code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-primary);
  word-break: break-all;
}
.apx-ready {
  color: var(--dsw-alias-label-success, #3fb950);
  font-weight: 600;
}
.apx-fail {
  color: var(--dsw-alias-label-error);
  font-weight: 600;
}
.apx-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.apx-button {
  appearance: none;
  font: inherit;
  cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  border-radius: 8px;
  padding: 5px 14px;
  font-size: 13px;
  line-height: 1.5;
}
.apx-button:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
.apx-button:disabled {
  opacity: 0.4;
  cursor: default;
}
.apx-buttonPrimary {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
  border-color: transparent;
}
.apx-buttonPrimary:hover:not(:disabled) {
  color: var(--dsw-alias-bg-layer-3);
  border-color: transparent;
}
.apx-testNote {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  line-height: 1.5;
}
.apx-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  padding-top: 12px;
}
.apx-footerNote {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.apx-footerNoteError {
  color: var(--dsw-alias-label-error);
}
`
