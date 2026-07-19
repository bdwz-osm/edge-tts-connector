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
const target = process.argv[2] === "firefox" ? "firefox" : "chrome";
const dist = join(__dirname, "dist", target);
const src = join(__dirname, "src");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const entries = {
  background: join(src, "background.ts"),
  content: join(src, "content.ts"),
  popup: join(src, "popup.ts"),
  options: join(src, "options.ts"),
};
if (target === "chrome") {
  entries.offscreen = join(src, "offscreen.ts");
}

await esbuild.build({
  entryPoints: entries,
  bundle: true,
  outdir: dist,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
  define: {
    __BROWSER__: JSON.stringify(target),
  },
});

const manifestSrc =
  target === "firefox"
    ? join(__dirname, "manifest.firefox.json")
    : join(__dirname, "manifest.chrome.json");
copyFileSync(manifestSrc, join(dist, "manifest.json"));

for (const name of ["popup.html", "options.html"]) {
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

for (const name of ["popup.css", "options.css"]) {
  const p = join(src, name);
  if (existsSync(p)) copyFileSync(p, join(dist, name));
}

console.log(`built ${target} → dist/${target}/`);
