/**
 * docs/engine-contract.md from web/lib/contract.ts and the engine itself: each call with what it
 * takes and what it answers (read off lib/shell.ts by the type checker), the engine's calls into
 * the screens, and the screens' events. Run after changing the contract: bun scripts/contract-doc.ts
 */
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const shellPath = join(root, "web/lib/shell.ts");
const contractPath = join(root, "web/lib/contract.ts");
const config = ts.parseJsonConfigFileContent(ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile).config, ts.sys, root);
const program = ts.createProgram([shellPath, contractPath], config.options);
const checker = program.getTypeChecker();
const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;

function exported(file: string, name: string): ts.Type {
  const sf = program.getSourceFile(file)!;
  const sym = checker.getExportsOfModule(checker.getSymbolAtLocation(sf)!).find((s) => s.name === name)!;
  return checker.getDeclaredTypeOfSymbol(sym);
}
const show = (t: ts.Type) => {
  const s = checker.typeToString(t, undefined, flags);
  return s === "Record<string, never>" || s === "{ [x: string]: never; }" ? "—" : s.length > 400 ? `${s.slice(0, 400)}…` : s;
};

// The contract's own words: the comment above each member, and the section headings.
const src = readFileSync(contractPath, "utf8");
const lines = src.split("\n");
function section(name: string): Array<{ name: string; note?: string; heading?: string }> {
  const start = lines.findIndex((l) => l.startsWith(`export interface ${name}`));
  const out: Array<{ name: string; note?: string; heading?: string }> = [];
  let note: string | undefined;
  let heading: string | undefined;
  for (let i = start + 1; i < lines.length && !lines[i]!.startsWith("}"); i++) {
    const l = lines[i]!.trim();
    const h = /^\/\/ ---- (.+)$/.exec(l);
    if (h) heading = h[1];
    else if (l.startsWith("/**")) note = l.replace(/^\/\*\*\s*/, "").replace(/\s*\*\/$/, "");
    else {
      const m = /^([a-zA-Z]+):/.exec(l);
      if (m) {
        out.push({ name: m[1]!, note, heading });
        note = undefined;
        heading = undefined;
      }
    }
  }
  return out;
}

const calls = exported(contractPath, "EngineCalls");
const results = exported(shellPath, "EngineResults");
const prop = (t: ts.Type, n: string) => checker.getTypeOfSymbol(t.getProperty(n)!);

const md: string[] = [
  "# The engine contract",
  "",
  "Generated from `web/lib/contract.ts` and `web/lib/shell.ts` by `bun scripts/contract-doc.ts`; don't edit by hand.",
  "",
  "The native screens (Android today, iOS later) draw everything; the TypeScript engine (the same code the PC runs) does the work. They talk over three channels:",
  "",
  "- **Calls into the engine:** the screens send `api` events. A path `rpc:<name>` is one of the calls below, with its arguments as the JSON body; any other path goes to the engine's HTTP API (`src/api.ts`, the routes the PC serves). The engine answers with `reply` (and `chunk` for streamed lines).",
  "- **Calls into the screens:** the engine calls the native plugin's methods.",
  "- **Events from the screens:** the plugin notifies the page.",
  "",
  "## Calls into the engine",
  "",
];
for (const c of section("EngineCalls")) {
  if (c.heading) md.push(`### ${c.heading}`, "");
  md.push(`**\`${c.name}\`**${c.note ? ` · ${c.note}` : ""}`, "", `- takes \`${show(prop(calls, c.name))}\``, `- answers \`${show(prop(results, c.name))}\``, "");
}
for (const [title, name] of [["Calls into the screens", "ScreenCalls"], ["Events from the screens", "ScreenEvents"]] as const) {
  const t = exported(contractPath, name);
  md.push(`## ${title}`, "");
  for (const c of section(name)) md.push(`- **\`${c.name}\`** \`${show(prop(t, c.name))}\`${c.note ? ` · ${c.note}` : ""}`);
  md.push("");
}
writeFileSync(join(root, "docs/engine-contract.md"), md.join("\n"));
console.log(`docs/engine-contract.md: ${section("EngineCalls").length} calls`);
