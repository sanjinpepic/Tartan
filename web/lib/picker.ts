/**
 * In-app dropdowns. A native <select> opens the system picker, which on Android's WebView is
 * the old full-screen dialog. Every select gets a field-styled button and an anchored menu
 * in the app's own look instead; the select stays in the DOM (visually hidden) and remains
 * the source of truth, so views keep reading `.value` and listening for `change`.
 */
import { el, icon } from "./dom.ts";

const DONE = new WeakSet<HTMLSelectElement>();
let open: { close: (focus?: boolean) => void } | null = null;
let menus = 0;

/** Enhance every select under `root` now and whenever one is added later. */
export function enhanceSelects(root: HTMLElement = document.body): void {
  const run = (node: ParentNode) => node.querySelectorAll("select").forEach(enhance);
  run(root);
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement) (n instanceof HTMLSelectElement ? enhance(n) : run(n));
  }).observe(root, { childList: true, subtree: true });
}

function enhance(select: HTMLSelectElement): void {
  if (DONE.has(select) || select.multiple) return;
  DONE.add(select);
  const value = el("span", { class: "picker-value" });
  const sub = el("span", { class: "picker-sub" });
  const button = el(
    "button",
    { type: "button", class: "picker", "aria-haspopup": "listbox", "aria-expanded": "false" },
    el("span", { class: "picker-text" }, value, sub),
    icon("chevron", "ic sm picker-chev"),
  );
  // The button comes first, so a wrapping <label> names and targets it, not the hidden select.
  select.before(button);
  select.classList.add("picker-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  const name = select.getAttribute("aria-label");
  if (name) button.setAttribute("aria-label", name);
  for (const label of select.labels) {
    if (label.contains(button)) continue;
    label.id ||= `lbl-${Math.random().toString(36).slice(2, 8)}`;
    button.setAttribute("aria-labelledby", label.id);
    label.addEventListener("click", (e) => { e.preventDefault(); button.focus(); });
  }

  const sync = () => {
    const opt = select.selectedOptions[0];
    value.textContent = opt?.textContent ?? "";
    sub.textContent = opt?.dataset.sub ?? "";
    sub.hidden = !sub.textContent;
    button.disabled = select.disabled;
  };
  sync();
  select.addEventListener("change", sync);
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });

  const choose = (opt: HTMLOptionElement) => {
    if (opt.value !== select.value || !opt.selected) {
      select.value = opt.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    sync();
  };

  button.addEventListener("click", () => (button.getAttribute("aria-expanded") === "true" ? open?.close(true) : openMenu(select, button, choose)));
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openMenu(select, button, choose);
    }
  });
}

function openMenu(select: HTMLSelectElement, button: HTMLButtonElement, choose: (o: HTMLOptionElement) => void): void {
  open?.close();
  const options = [...select.options].filter((o) => !o.hidden);
  const menu = el("div", { class: "picker-menu", role: "listbox", tabindex: "-1" });
  const uid = `pick${++menus}`;
  const label = button.getAttribute("aria-label") ?? (button.getAttribute("aria-labelledby") && document.getElementById(button.getAttribute("aria-labelledby")!)?.textContent);
  if (label) menu.setAttribute("aria-label", label);
  const items = options.map((o, i) => {
    const item = el(
      "div",
      { class: "picker-option", role: "option", id: `${uid}-${i}`, "aria-selected": String(o.selected), "aria-disabled": o.disabled ? "true" : undefined },
      el("span", { class: "picker-text" }, el("span", { class: "picker-value" }, o.textContent ?? ""), o.dataset.sub ? el("span", { class: "picker-sub" }, o.dataset.sub) : null),
      o.selected ? icon("check", "ic sm picker-check") : null,
    );
    item.addEventListener("click", () => {
      if (o.disabled) return;
      choose(o);
      close(true);
    });
    item.addEventListener("pointermove", () => setActive(i));
    return item;
  });
  menu.append(...items);
  // Inside an open dialog the menu must join it in the top layer.
  (button.closest("dialog") ?? document.body).append(menu);

  let active = Math.max(0, options.findIndex((o) => o.selected));
  function setActive(i: number) {
    active = (i + items.length) % items.length;
    items.forEach((it, k) => it.classList.toggle("active", k === active));
    menu.setAttribute("aria-activedescendant", items[active]!.id);
  }
  setActive(active);

  const place = () => {
    const r = button.getBoundingClientRect();
    const vh = window.innerHeight;
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 220 && above > below;
    menu.style.left = `${Math.max(8, r.left)}px`;
    menu.style.width = `${Math.min(r.width, window.innerWidth - 16)}px`;
    menu.style.maxHeight = `${Math.min(360, up ? above : below) - 6}px`;
    menu.style.top = up ? "" : `${r.bottom + 6}px`;
    menu.style.bottom = up ? `${vh - r.top + 6}px` : "";
    menu.classList.toggle("up", up);
  };
  place();
  items[active]?.scrollIntoView({ block: "nearest" });
  button.setAttribute("aria-expanded", "true");
  menu.focus({ preventScroll: true });

  const outside = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node) && !button.contains(e.target as Node)) close();
  };
  // The page may still be gliding (smooth scroll, momentum): follow the button, and close
  // only once it has left the screen.
  const onScroll = (e: Event) => {
    if (menu.contains(e.target as Node)) return;
    const r = button.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) close();
    else place();
  };
  menu.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") setActive(active + 1);
    else if (e.key === "ArrowUp") setActive(active - 1);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(items.length - 1);
    else if (e.key === "Enter" || e.key === " ") items[active]?.click();
    else if (e.key === "Escape" || e.key === "Tab") return close(e.key === "Escape");
    else return;
    e.preventDefault();
    items[active]?.scrollIntoView({ block: "nearest" });
  });
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", place);

  function close(focus = false) {
    if (open !== handle) return;
    open = null;
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", place);
    button.setAttribute("aria-expanded", "false");
    // Gone for assistive tech at once; the fade-out is only for the eye.
    menu.setAttribute("aria-hidden", "true");
    menu.classList.add("closing");
    setTimeout(() => menu.remove(), 140);
    if (focus) button.focus();
  }
  const handle = { close };
  open = handle;
}
