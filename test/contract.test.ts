/**
 * The engine's contract (web/lib/contract.ts) against both sides: every call the native screens
 * make exists in it, every plugin method the page calls is one the native side has, and every
 * event the native side sends is one the page knows. lib/shell.ts `satisfies` EngineCalls, so the
 * engine's side is checked by the type checker.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const contract = readFileSync(join(root, "web/lib/contract.ts"), "utf8");
const block = (name: string) => {
  const i = contract.indexOf(`export interface ${name}`);
  const j = contract.indexOf("\n}\n", i);
  return new Set([...contract.slice(i, j).matchAll(/\n {2}([a-zA-Z]+):/g)].map((m) => m[1]!));
};
const calls = block("EngineCalls");
const screenCalls = block("ScreenCalls");
const events = block("ScreenEvents");

const shellDir = join(root, "android/app/src/main/java/dev/freesuunto/app/shell");
const kotlin = readdirSync(shellDir).filter((f) => f.endsWith(".kt")).map((f) => readFileSync(join(shellDir, f), "utf8")).join("\n");

test("every call the native screens make is in the contract", () => {
  const used = new Set([...kotlin.matchAll(/\b(?:call|rpc)\("([a-zA-Z]+)"/g)].map((m) => m[1]!));
  expect(used.size).toBeGreaterThan(40);
  expect([...used].filter((n) => !calls.has(n))).toEqual([]);
});

test("the engine implements exactly the contract's calls", () => {
  const shell = readFileSync(join(root, "web/lib/shell.ts"), "utf8");
  const i = shell.indexOf("const RPC = {");
  const j = shell.indexOf("} satisfies EngineHandlers;", i);
  const implemented = new Set([...shell.slice(i, j).matchAll(/\n {2}([a-zA-Z]+):/g)].map((m) => m[1]!));
  expect([...calls].filter((n) => !implemented.has(n))).toEqual([]);
  expect([...implemented].filter((n) => !calls.has(n))).toEqual([]);
});

test("the page calls only plugin methods the native side has, and the contract lists them", () => {
  const methods = new Set([...kotlin.matchAll(/@PluginMethod\s+fun ([a-zA-Z]+)\(/g)].map((m) => m[1]!));
  expect([...screenCalls].filter((n) => !methods.has(n))).toEqual([]);
  expect([...methods].filter((n) => !screenCalls.has(n))).toEqual([]);
  const shell = readFileSync(join(root, "web/lib/shell.ts"), "utf8");
  const plugin = shell.slice(shell.indexOf("interface ShellPlugin"), shell.indexOf("\n}\n", shell.indexOf("interface ShellPlugin")));
  const declared = new Set([...plugin.matchAll(/\n {2}([a-zA-Z]+)\(/g)].map((m) => m[1]!).filter((n) => n !== "addListener"));
  expect([...declared].filter((n) => !methods.has(n))).toEqual([]);
});

test("every event the native side sends is one the contract lists", () => {
  const sent = new Set([...kotlin.matchAll(/notifyListeners\("([a-zA-Z]+)"/g)].map((m) => m[1]!));
  expect([...sent].filter((n) => !events.has(n))).toEqual([]);
});

// The iPhone's TartanShell (ios/App/App/Shell, SwiftUI): the same plugin, so the same contract.
const iosDir = join(root, "ios/App/App/Shell");
const swift = readdirSync(iosDir).filter((f) => f.endsWith(".swift")).map((f) => readFileSync(join(iosDir, f), "utf8")).join("\n");

test("iPhone: the plugin has every method the page calls, each registered and implemented", () => {
  const registered = new Set([...swift.matchAll(/CAPPluginMethod\(name: "([a-zA-Z]+)"/g)].map((m) => m[1]!));
  const implemented = new Set([...swift.matchAll(/@objc func ([a-zA-Z]+)\(_ call: CAPPluginCall\)/g)].map((m) => m[1]!));
  expect([...screenCalls].filter((n) => !registered.has(n))).toEqual([]);
  expect([...registered].filter((n) => !screenCalls.has(n))).toEqual([]);
  expect([...registered].filter((n) => !implemented.has(n))).toEqual([]);
  expect(swift).toContain('jsName = "TartanShell"');
});

test("iPhone: every call and event is in the contract", () => {
  const used = new Set([...swift.matchAll(/\brpc\("([a-zA-Z]+)"/g)].map((m) => m[1]!));
  expect(used.size).toBeGreaterThan(3);
  expect([...used].filter((n) => !calls.has(n))).toEqual([]);
  const sent = new Set([...swift.matchAll(/emit\("([a-zA-Z]+)"/g)].map((m) => m[1]!));
  expect(sent.has("api")).toBe(true);
  expect([...sent].filter((n) => !events.has(n))).toEqual([]);
});
