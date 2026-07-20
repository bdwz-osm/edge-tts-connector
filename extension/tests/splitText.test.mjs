import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, "../src/splitText.ts");
const dir = mkdtempSync(join(tmpdir(), "etc-split-"));
const out = join(dir, "splitText.mjs");

await esbuild.build({
  entryPoints: [src],
  outfile: out,
  format: "esm",
  platform: "neutral",
  target: "es2022",
});

const { splitSoft, SOFT_MAX, HARD_MAX } = await import(out);

describe("splitSoft", () => {
  it("keeps short text whole", () => {
    assert.deepEqual(splitSoft("Hello world."), ["Hello world."]);
  });

  it("splits on sentence boundaries under soft max packing", () => {
    const a = "A".repeat(200) + ".";
    const b = "B".repeat(200) + ".";
    const c = "C".repeat(200) + ".";
    const parts = splitSoft(`${a} ${b} ${c}`);
    assert.ok(parts.length >= 2);
    assert.ok(parts.every((p) => p.length <= SOFT_MAX + 5));
  });

  it("wraps at whitespace when no sentence punct", () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    assert.ok(text.length > SOFT_MAX);
    const parts = splitSoft(text);
    assert.ok(parts.length >= 2);
    assert.ok(parts.every((p) => p.length <= SOFT_MAX));
    assert.equal(parts.join(" "), text);
  });

  it("hard-slices when a single token exceeds HARD_MAX", () => {
    const token = "x".repeat(HARD_MAX + 500);
    const parts = splitSoft(token);
    assert.ok(parts.length >= 2);
    assert.ok(parts.every((p) => p.length <= HARD_MAX));
    assert.equal(parts.join(""), token);
  });

  it("uses clause breaks for long run-ons", () => {
    const chunk = "word ".repeat(80).trim(); // ~400 chars
    const text = `${chunk}: ${chunk}: ${chunk}`;
    const parts = splitSoft(text);
    assert.ok(parts.length >= 2);
    assert.ok(parts.every((p) => p.length <= SOFT_MAX));
  });
});
