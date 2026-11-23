/**
 * Which build this is. The owner's build (the default) may carry the one part still taken from
 * Suunto's own files, for the owner's own watch: the captured workout runner, offered beside
 * Tartan's own. The public build (`bun run build:web:public`, `bun run android:build:public`)
 * carries only Tartan's own; the bundler drops the rest (it is loaded with import() behind this
 * flag). Faces use Tartan's own layout in both (src/watchface/layout.ts).
 */
declare const PUBLIC_BUILD: boolean | undefined;

export const PUBLIC: boolean =
  typeof PUBLIC_BUILD !== "undefined" ? PUBLIC_BUILD : typeof process !== "undefined" && process.env?.TARTAN_PUBLIC === "1";
