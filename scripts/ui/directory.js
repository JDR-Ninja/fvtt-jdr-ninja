/**
 * The module's shortcuts in the Actors and Scenes directories share one compact row, `div.jn-directory-actions`, after
 * Foundry's own header buttons. Each integration removes its own buttons before adding them again; a row left empty goes.
 */
export function removeShortcuts(root, selector) {
  root.querySelectorAll(selector).forEach(button => button.remove());
  root.querySelectorAll(".jn-directory-actions").forEach(row => { if (!row.childElementCount) row.remove(); });
}

/** The shared row: the one already rendered, or a new one at the end of the header actions. */
export function shortcutRow(root) {
  const host = root.querySelector(".header-actions") || root.querySelector(".directory-footer") || root;
  let row = host.querySelector(".jn-directory-actions");
  if (!row) {
    row = document.createElement("div");
    row.className = "jn-directory-actions";
    host.append(row);
  }
  return row;
}

/** A shortcut: an icon and a short visible label, with the window's full title as its tooltip and accessible name. */
export function shortcutButton({ className, icon, label, title, onClick }) {
  const button = document.createElement("button"), glyph = document.createElement("i"), caption = document.createElement("span");
  button.type = "button";
  button.className = `${className} jn-directory-button`;
  button.setAttribute("data-tooltip", title);
  button.setAttribute("aria-label", title);
  glyph.className = icon;
  glyph.setAttribute("aria-hidden", "true");
  caption.textContent = label;
  button.append(glyph, caption);
  button.addEventListener("click", onClick);
  return button;
}
