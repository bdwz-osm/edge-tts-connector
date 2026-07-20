import * as esbuild from "esbuild";
import {
  copyFileSync,
  mkdirSync,
  rmSync,
  cpSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const target = process.argv[2] === "firefox" ? "firefox" : "chrome";
// Repo-root build/ — easy to find for Load unpacked / temporary add-on.
const dist = join(repoRoot, "build", target);
const src = join(__dirname, "src");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const define = { __BROWSER__: JSON.stringify(target) };
const common = {
  bundle: true,
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
  define,
};

// Background / UI pages: ES modules. Content must be IIFE (executeScript is classic).
await esbuild.build({
  ...common,
  entryPoints: {
    background: join(src, "background.ts"),
    popup: join(src, "popup.ts"),
    options: join(src, "options.ts"),
    rules: join(src, "rules.ts"),
    ...(target === "chrome"
      ? { offscreen: join(src, "offscreen.ts") }
      : {}),
  },
  outdir: dist,
  format: "esm",
});

await esbuild.build({
  ...common,
  entryPoints: [join(src, "content.ts")],
  outfile: join(dist, "content.js"),
  format: "iife",
});

const manifestSrc =
  target === "firefox"
    ? join(__dirname, "manifest.firefox.json")
    : join(__dirname, "manifest.chrome.json");
copyFileSync(manifestSrc, join(dist, "manifest.json"));

for (const name of ["popup.html", "options.html", "rules.html"]) {
  copyFileSync(join(src, name), join(dist, name));
}
if (target === "chrome") {
  copyFileSync(join(src, "offscreen.html"), join(dist, "offscreen.html"));
}

const stylesSrc = join(src, "styles");
const stylesDist = join(dist, "styles");
if (existsSync(stylesSrc)) {
  mkdirSync(stylesDist, { recursive: true });
  cpSync(stylesSrc, stylesDist, { recursive: true });
}

for (const name of ["popup.css", "options.css", "rules.css"]) {
  const p = join(src, name);
  if (existsSync(p)) copyFileSync(p, join(dist, name));
}

console.log(`built ${target} → build/${target}/`);
