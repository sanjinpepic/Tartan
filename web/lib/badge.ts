/** A dot on the Coach tab while the coach's suggested change to the plan waits for you. */
export function coachBadge(on: boolean): void {
  document.querySelector('.nav [data-tab="coach"]')?.classList.toggle("has-badge", on);
}
