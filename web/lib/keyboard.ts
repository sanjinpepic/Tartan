/**
 * The on-screen keyboard. While it is up (a text field has focus and the visible height
 * dropped), <html> gets `kb-open` (phones hide the tab bar so the field sits right on the
 * keyboard) and `--kb` holds how much of the page it covers when the WebView doesn't resize.
 * A "keyboard" event on window tells views when it opens, closes or changes height.
 */
const TEXT = /^(textarea|input)$/i;
const typing = () => {
  const a = document.activeElement as HTMLInputElement | null;
  return !!a && TEXT.test(a.tagName) && !/^(checkbox|radio|button|submit|range|color|file)$/i.test(a.type ?? "") && !a.readOnly;
};

export function watchKeyboard(): void {
  const vv = window.visualViewport;
  let full = window.innerHeight;
  let width = window.innerWidth;
  let state = "";
  const update = () => {
    // A rotation (or window resize) starts over; otherwise the tallest height seen is "no keyboard".
    if (window.innerWidth !== width) {
      width = window.innerWidth;
      full = window.innerHeight;
    }
    const visible = vv?.height ?? window.innerHeight;
    if (!typing()) full = Math.max(window.innerHeight, visible);
    else full = Math.max(full, window.innerHeight);
    const open = typing() && full - visible > 120;
    // Covered part of the page: only when the keyboard overlays it instead of resizing it.
    const covered = open && vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
    const next = `${open}:${covered}:${Math.round(visible)}`;
    if (next === state) return;
    state = next;
    document.documentElement.classList.toggle("kb-open", open);
    document.documentElement.style.setProperty("--kb", `${covered}px`);
    window.dispatchEvent(new CustomEvent("keyboard", { detail: { open, covered } }));
  };
  vv?.addEventListener("resize", update);
  window.addEventListener("resize", update);
  document.addEventListener("focusin", () => setTimeout(update, 0));
  // Focus moving between two fields passes through "nothing focused" for a moment.
  document.addEventListener("focusout", () => setTimeout(update, 60));
  update();
}
