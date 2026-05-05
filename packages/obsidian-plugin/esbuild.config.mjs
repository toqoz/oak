// Bundle the Obsidian plugin into a single CommonJS file the way
// Obsidian expects. The plugin is desktop-only (manifest.json), so we
// can leave Node built-ins external — Electron's renderer process
// resolves them at runtime.

import { context, build } from "esbuild";
import { copyFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const dev = watch;

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "node",
  outfile: "dist/main.js",
  sourcemap: dev ? "inline" : false,
  minify: !dev,
  treeShaking: true,
  external: [
    "obsidian",
    "electron",
    // Node built-ins (with and without `node:` prefix) are resolved by
    // Electron at runtime; bundling them would break.
    "node:*",
    "fs",
    "fs/promises",
    "path",
    "os",
    "crypto",
    "child_process",
    "util",
    "url",
    "module",
    "stream",
    "events",
    "buffer",
  ],
  logLevel: "info",
  // index-store.ts deliberately falls back when `import.meta.url` is
  // empty (CJS bundle). Suppress the static-analysis warning.
  logOverride: {
    "empty-import-meta": "silent",
  },
};

async function run() {
  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    // Keep the process alive
    return;
  }
  await build(options);
  // Copy manifest + styles alongside main.js so the plugin can be
  // loaded by pointing Obsidian at packages/obsidian-plugin/dist.
  await copyFile("manifest.json", "dist/manifest.json");
  await copyFile("styles.css", "dist/styles.css");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
