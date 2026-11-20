import { expect, test } from "bun:test";
import { tokens } from "../web/lib/theme.ts";

const roles = { primary: "#37618e", on_primary: "#ffffff", surface: "#f8f9ff", surface_container: "#eceef4", surface_container_high: "#e6e8ee", surface_container_highest: "#e1e2e8", surface_dim: "#d8dae0", outline: "#73777f", outline_variant: "#c3c6cf", on_surface: "#191c20", on_surface_variant: "#43474e" };

test("Material You: wallpaper roles become Tartan's tokens; nothing but colours gets through", () => {
  const light = tokens(roles, false);
  expect(light).toContain("--primary: #37618e;");
  expect(light).toContain("--bg: #f8f9ff;");
  expect(light).toContain("--surface-1: #eceef4;");
  expect(light).toContain("--surface-2: #e1e2e8;"); // fields: container highest in light
  expect(light).toContain("--surface-3: #d8dae0;");
  expect(light).toContain("--ink-3: #73777f;");
  expect(light).toContain("--hairline: color-mix(in srgb, #c3c6cf 55%, #eceef4);");
  expect(light).not.toContain("--s1"); // the data colours stay Tartan's
  const dark = tokens(roles, true);
  expect(dark).toContain("--surface-2: #e6e8ee;"); // container high in dark
  expect(dark).toContain("--surface-3: #e1e2e8;");
  expect(tokens({ primary: "red; } body { display: none", surface: "#ffffff" }, false)).toBe("--bg: #ffffff;");
});
