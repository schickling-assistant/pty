#!/usr/bin/env node
// Generates server-source.txt — the bundle-safe fallback for spawnDaemon
// (see src/spawn.ts). Bundles dist/server.js together with its sibling
// modules into a single self-contained file, keeping npm deps (node-pty,
// @xterm/*) external so the host's node_modules still satisfies them.
//
// Written into both dist/ (shipped to npm) and src/ (so tests running
// through tsx find it next to spawn.ts). The src/ copy is gitignored.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const entry = path.join(root, "dist", "server.js");
if (!fs.existsSync(entry)) {
  console.error(`embed-server-source: missing ${entry}; run tsc first`);
  process.exit(1);
}

const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // External: anything resolved from node_modules. esbuild marks anything not
  // starting with "." or "/" as external when packages: "external" is set.
  packages: "external",
  write: false,
  logLevel: "warning",
});
const [out] = result.outputFiles;
const contents = out.text;

const targets = [
  path.join(root, "dist", "server-source.txt"),
  path.join(root, "src", "server-source.txt"),
];
for (const t of targets) fs.writeFileSync(t, contents);
