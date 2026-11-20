/**
 * The content's stretch at the ends. Pulling past the top or the bottom of the scroller moves
 * the content with growing resistance (the iOS rubber-band curve) and springs it back on
 * release; the fixed bars never move. Touch only; horizontal drags (carousels) are left alone.
 *
 * Built to never cost a frame: every listener is passive (the scroller has
 * `overscroll-behavior: contain`, so at an end there is no native scroll to cancel and the
 * browser never waits on this script), the transform is written once per animation frame,
 * and the content is promoted to its own layer only while it is being pulled.
 */
const DAMPING = 0.55;

/** How far content follows a pull of `d` px, for a viewport `dim` tall: quick at first, then stiffer. */
const rubber = (d: number, dim: number) => (1 - 1 / ((d * DAMPING) / dim + 1)) * dim;

export interface PullOpts {
  /** While pulling down at the top: how far the content has moved (px). */
  onPull?: (offset: number) => void;
  /** Let go after pulling down at the top, with how far the content had moved. */
  onRelease?: (offset: number) => void;
}

export function rubberBand(scroller: HTMLElement, content: HTMLElement, pull: PullOpts = {}): { reset: () => void } {
  let startX = 0;
  let startY = 0;
  let lastY = 0;
  let base = 0;
  let edge: 0 | 1 | -1 = 0; // 1 pulling down at the top, -1 pulling up at the bottom
  let sideways = false;
  let offset = 0;
  let frame = 0;
  let settling = 0;

  const paint = () => {
    frame = 0;
    content.style.transform = offset ? `translate3d(0, ${offset.toFixed(1)}px, 0)` : "";
  };
  const write = (px: number) => {
    offset = px;
    frame ||= requestAnimationFrame(paint);
  };
  const promote = (on: boolean) => {
    content.style.willChange = on ? "transform" : "";
  };

  const settle = () => {
    if (!edge && !offset) return;
    if (edge === 1 && offset > 0) pull.onRelease?.(offset);
    pull.onPull?.(0);
    edge = 0;
    cancelAnimationFrame(frame);
    frame = 0;
    if (!offset) return promote(false);
    offset = 0;
    content.style.transition = "transform 480ms cubic-bezier(0.16, 1, 0.3, 1)";
    content.style.transform = "";
    clearTimeout(settling);
    settling = window.setTimeout(() => {
      content.style.transition = "";
      promote(false);
    }, 500);
  };

  scroller.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return settle();
      const t = e.touches[0]!;
      // The full-screen map is pinned to the screen: a transform here would pin it to the content.
      if (document.documentElement.classList.contains("full-map")) {
        sideways = true;
        return;
      }
      // A map pans under the finger; the page doesn't stretch around it.
      if ((e.target as Element | null)?.closest?.("[data-no-stretch]")) {
        sideways = true;
        return;
      }
      startX = t.clientX;
      startY = lastY = t.clientY;
      sideways = false;
      edge = 0;
      // Catch the content mid-spring and carry on from where it is.
      if (content.style.transition) {
        clearTimeout(settling);
        content.style.transition = "";
      }
    },
    { passive: true },
  );

  scroller.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length !== 1 || sideways) return;
      const t = e.touches[0]!;
      // A sideways drag belongs to whatever scrolls sideways.
      if (!edge && Math.abs(t.clientX - startX) > Math.abs(t.clientY - startY) + 6) {
        sideways = true;
        return;
      }
      const y = t.clientY;
      if (!edge) {
        const atTop = scroller.scrollTop <= 0;
        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
        // Reaching an end mid-gesture starts the stretch from where the finger is now.
        if (atTop && y > lastY) [edge, base] = [1, lastY];
        else if (atBottom && y < lastY) [edge, base] = [-1, lastY];
        if (edge) promote(true);
      }
      lastY = y;
      if (!edge) return;
      const d = (y - base) * edge;
      if (d <= 0) {
        // Pushed back past the end: normal scrolling takes over.
        edge = 0;
        write(0);
        return;
      }
      write(edge * rubber(d, scroller.clientHeight));
      if (edge === 1) pull.onPull?.(rubber(d, scroller.clientHeight));
    },
    { passive: true },
  );

  scroller.addEventListener("touchend", settle, { passive: true });
  scroller.addEventListener("touchcancel", settle, { passive: true });

  /**
   * Back to rest at once, with no spring. Called on every change of screen: a touch that ends on
   * a screen that has gone never reaches the scroller, and a transform left on the content
   * would pin a fixed screen (the route editor) to the content instead of the screen.
   */
  const reset = () => {
    pull.onPull?.(0);
    edge = 0;
    offset = 0;
    cancelAnimationFrame(frame);
    frame = 0;
    clearTimeout(settling);
    content.style.transition = "";
    content.style.transform = "";
    promote(false);
  };
  return { reset };
}
