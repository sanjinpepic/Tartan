/**
 * The clean-room encoder (src/watchface/layout.ts, written only from
 * docs/cleanroom/face-layout-spec.md) against the face layout captured from the Suunto app: given
 * that face's description, it must write the very same bytes. The captured file and its decoding
 * live only in this test's fixture.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { encodeLayout, type LayoutDescription } from "../src/watchface/layout.ts";

// Captured from the Suunto app, so only in the owner's checkout (scripts/owner-overlay.sh).
const FIXTURE = new URL("./fixtures/captured-face-layout.json", import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fixture: any = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : null;

type Decoded = {
  author: string;
  version: string;
  unk196: number;
  unk208: number;
  root: { name: string; preview: string; width: number; height: number; unk356: number };
  resourceKinds: Record<string, 1 | 2>;
  elements: Array<{ name: string; type: number; props: Array<{ key: number; value?: number; ref?: string }> }>;
};

test.skipIf(!fixture)("the clean-room encoder writes the captured layout byte for byte", () => {
  const d = fixture.decoded as unknown as Decoded;
  const want = Uint8Array.from(atob(fixture.bytes_b64), (c) => c.charCodeAt(0));
  expect(createHash("sha256").update(want).digest("hex")).toBe(fixture.sha256);
  const description: LayoutDescription = {
    name: d.root.name,
    preview: d.root.preview,
    author: d.author,
    version: d.version,
    header: { field196: d.unk196, field208: d.unk208, field356: d.root.unk356, width: d.root.width, height: d.root.height },
    filler: "properties",
    elements: d.elements.map((e) => ({
      name: e.name,
      type: e.type,
      properties: e.props.map((p) => (p.ref !== undefined ? { key: p.key, ref: p.ref, kind: d.resourceKinds[p.ref] } : { key: p.key, value: p.value! })),
    })),
  };
  const got = encodeLayout(description);
  expect(got.length).toBe(want.length);
  const firstDiff = got.findIndex((b, i) => b !== want[i]);
  expect(firstDiff).toBe(-1);
});
