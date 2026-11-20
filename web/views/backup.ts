/**
 * Backups in Settings → More (and "I have a backup" in the intro): a passphrase, Back up now,
 * every week by itself on the phone, and restore. The file is useless without the passphrase
 * (src/backup.ts), which is why setting one says to write it down.
 */
import { MIN_PASSPHRASE } from "../../src/backup.ts";
import { backupNow, backupPrefs, restoreFrom, setBackupPrefs, weeklyBackup } from "../lib/backup.ts";
import { ago, el, icon } from "../lib/dom.ts";
import { act, deviceMode, isNative, notify } from "../state.ts";

const passField = (label: string, autocomplete: AutoFill = "new-password") => {
  const input = el("input", { type: "password", autocomplete, minLength: MIN_PASSPHRASE, required: true });
  return { input, field: el("label", { class: "field" }, el("span", {}, label), input) };
};

/** Pick a backup file and give its passphrase; on success the app starts again with it all. */
export function restoreForm(done: (r: { files: number; created: string }) => void = () => location.reload()): HTMLElement {
  const file = el("input", { type: "file", accept: ".tartan,application/octet-stream" });
  const { input: pass, field } = passField("Its passphrase", "current-password");
  const err = el("p", { class: "field-error", hidden: true });
  const go = el("button", { type: "submit", class: "btn filled" }, icon("undo", "ic sm"), "Restore");
  const form = el(
    "form",
    { class: "setup restore-form" },
    el("label", { class: "field" }, el("span", {}, "The backup file"), file),
    field,
    err,
    el("p", { class: "footnote" }, "What's in the backup replaces what's here now: workouts, plan, lifts, check-ins, coach notes and keys."),
    el("div", { class: "row" }, go),
  );
  form.onsubmit = (e) => {
    e.preventDefault();
    err.hidden = true;
    const f = file.files?.[0];
    if (!f) {
      err.replaceChildren(icon("warn", "ic sm"), "Pick the backup file first (tartan-backup-….tartan).");
      err.hidden = false;
      return;
    }
    void act(go, "Restore", async () => {
      try {
        const r = await restoreFrom(f, pass.value);
        notify(`Restored ${r.files} files from the backup of ${new Date(r.created).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}.`);
        setTimeout(() => done(r), 900);
      } catch (e) {
        err.replaceChildren(icon("warn", "ic sm"), `${(e as Error).message.replace(/^./, (c) => c.toUpperCase())}.`);
        err.hidden = false;
      }
    });
  };
  return form;
}

export function backupCard(): HTMLElement {
  const sec = el("section", { class: "card backup-card" });
  const draw = () => {
    const p = backupPrefs();
    const head = el("div", { class: "card-head" }, el("div", {}, el("h2", {}, icon("history", "ic"), "Backups"), el("p", { class: "sub" }, p.last ? `Last backup ${ago(new Date(p.last))}${p.where === `Documents/Tartan` ? ", in Documents/Tartan" : ""}.` : `No backup yet. If this ${deviceMode ? "phone is lost or the app is removed" : "computer is lost or its disk fails"}, a backup is how your data comes back.`)));
    if (!p.pass) {
      // First: a passphrase, twice.
      const a = passField("Passphrase");
      const b = passField("The same again");
      const err = el("p", { class: "field-error", hidden: true });
      const set = el("button", { type: "submit", class: "btn filled" }, "Set passphrase");
      const form = el(
        "form",
        { class: "setup" },
        el("p", {}, `Backups are encrypted with a passphrase you choose (at least ${MIN_PASSPHRASE} characters). `, el("b", {}, "Write it down somewhere safe:"), " without it a backup can't be opened, not even by Tartan."),
        el("div", { class: "grid-fields" }, a.field, b.field),
        err,
        el("div", { class: "row" }, set),
      );
      form.onsubmit = (e) => {
        e.preventDefault();
        const bad = a.input.value.length < MIN_PASSPHRASE ? `At least ${MIN_PASSPHRASE} characters.` : a.input.value !== b.input.value ? "The two don't match." : "";
        err.replaceChildren(...(bad ? [icon("warn", "ic sm"), bad] : []));
        err.hidden = !bad;
        if (bad) return;
        setBackupPrefs({ ...backupPrefs(), pass: a.input.value, weekly: isNative });
        notify(isNative ? "Passphrase set. Tartan backs up every week by itself; Back up now makes one today." : "Passphrase set.");
        draw();
      };
      sec.replaceChildren(head, form, el("details", { class: "more" }, el("summary", {}, "Restore from a backup"), restoreForm()));
      return;
    }
    const now = el("button", { type: "button", class: "btn filled" }, icon("down", "ic sm"), "Back up now");
    now.onclick = () =>
      act(now, "Backup", async () => {
        const bytes = await backupNow(backupPrefs().pass!);
        notify(`Backup made (${Math.max(1, Math.round(bytes / 1024))} KB). Keep it somewhere other than this ${isNative ? "phone" : "computer"}.`);
        draw();
      });
    const sw = el("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(!!p.weekly), "aria-label": "Back up every week" }, el("i"));
    sw.onclick = () => {
      setBackupPrefs({ ...backupPrefs(), weekly: !backupPrefs().weekly });
      if (backupPrefs().weekly) void weeklyBackup().then(draw);
      draw();
    };
    const change = el("button", { type: "button", class: "btn text small" }, "Change passphrase");
    change.onclick = () => {
      setBackupPrefs({ ...backupPrefs(), pass: undefined });
      draw();
    };
    const kids: Array<HTMLElement | null> = [
      head,
      el("div", { class: "row" }, now),
      isNative ? el("div", { class: "switch-row" }, el("div", {}, el("h3", {}, "Every week, by itself"), el("p", { class: "sub" }, "Into Documents/Tartan on this phone, the last four kept. Copy one off the phone now and then.")), sw) : null,
      p.failed ? el("p", { class: "callout" }, icon("warn", "ic sm"), `The weekly backup didn't work ${ago(new Date(p.failed.at))}: ${p.failed.text}. Back up now to try again.`) : null,
      el("details", { class: "more" }, el("summary", {}, "Restore from a backup"), restoreForm()),
      el("div", { class: "row" }, change),
    ];
    sec.replaceChildren(...kids.filter((x): x is HTMLElement => !!x));
  };
  draw();
  return sec;
}
