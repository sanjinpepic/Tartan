/**
 * Haptics: a light tick when a choice changes and a firmer one when something lands. Only in
 * the phone app (Capacitor); a no-op in the browser. Never blocks, never throws.
 */
import { Capacitor } from "@capacitor/core";

const native = Capacitor.isNativePlatform();
type H = typeof import("@capacitor/haptics");
let mod: Promise<H> | null = null;
const haptics = () => (mod ??= import("@capacitor/haptics"));

/** A selection changed: a tab, a segment, an answer chip. */
export function tick(): void {
  if (native) void haptics().then((h) => h.Haptics.selectionChanged()).catch(() => {});
}

/** Something landed: a session ticked off, the plan saved, a step completed. */
export function thud(): void {
  if (native) void haptics().then((h) => h.Haptics.impact({ style: h.ImpactStyle.Light })).catch(() => {});
}

/** It worked: a sync or a backup brought data in. */
export function success(): void {
  if (native) void haptics().then((h) => h.Haptics.notification({ type: h.NotificationType.Success })).catch(() => {});
}
