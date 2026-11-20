/**
 * Motion: springs, count-ups, view transitions and chart draw-ins. One grammar for the
 * whole app; everything collapses to an instant change under prefers-reduced-motion.
 */

export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Run a DOM update as a view transition when the browser supports it. */
export async function transition(update: () => void | Promise<void>, kind = "nav"): Promise<void> {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void | Promise<void>) => { finished: Promise<void>; ready: Promise<void>; updateCallbackDone: Promise<void> };
  };
  if (!doc.startViewTransition || reduced()) {
    await update();
    return;
  }
  document.documentElement.dataset.vt = kind;
  try {
    const vt = doc.startViewTransition(update);
    // The browser skips a transition when, say, the viewport resizes mid-way (keyboard, system
    // bars). That rejects `ready`; the update still applies, so it's not an error.
    vt.ready.catch(() => {});
    await vt.updateCallbackDone.catch(() => {});
    await vt.finished;
  } catch {
    // an interrupted transition still applied the update
  } finally {
    delete document.documentElement.dataset.vt;
  }
}

/** Count a number up from 0 (or its previous value) with an exponential ease-out. */
export function countUp(node: HTMLElement, to: number, format: (n: number) => string, ms = 700): void {
  const from = Number(node.dataset.value ?? 0);
  node.dataset.value = String(to);
  if (reduced() || from === to) {
    node.textContent = format(to);
    return;
  }
  const t0 = performance.now();
  const step = (t: number) => {
    const p = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(2, -10 * p);
    node.textContent = format(from + (to - from) * (p >= 1 ? 1 : e));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Reveal children once as they scroll into view (staggered). */
export function revealOnScroll(root: ParentNode): void {
  if (reduced() || !("IntersectionObserver" in window)) return;
  const items = [...root.querySelectorAll<HTMLElement>("[data-reveal]")];
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        el.classList.add("in");
        io.unobserve(el);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  items.forEach((el, i) => {
    el.style.setProperty("--i", String(i % 6));
    el.classList.add("pre");
    io.observe(el);
  });
}

/**
 * Replace a container's content in place, for data changing under a still frame (stepping
 * weeks, switching a range or a view): the old content fades out quickly, the new one fades in
 * with a short nudge from the side you moved toward (`dir` 1 forward, -1 back, 0 in place).
 * The nudge is small on purpose: a bigger slide reads as the page margins jumping. Only
 * opacity and transform animate, so it stays on the compositor.
 */
export async function swap(container: HTMLElement, next: Node | Node[], dir: -1 | 0 | 1 = 0): Promise<void> {
  const nodes = Array.isArray(next) ? next : [next];
  container.getAnimations().forEach((a) => a.cancel());
  if (reduced() || !container.children.length || !container.animate) {
    container.replaceChildren(...nodes);
    return;
  }
  await container
    .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" })
    .finished.catch(() => {});
  container.replaceChildren(...nodes);
  container.getAnimations().forEach((a) => a.cancel());
  await container
    .animate([{ opacity: 0, transform: `translate3d(${dir * 10}px, ${dir ? 0 : 4}px, 0)` }, { opacity: 1, transform: "none" }], {
      duration: 300,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    })
    .finished.catch(() => {});
}
