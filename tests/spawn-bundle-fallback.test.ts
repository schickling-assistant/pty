import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { queryStats } from "../src/client.ts";
import { spawnDaemon, setServerModulePath } from "../src/spawn.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const distServer = path.join(projectRoot, "dist", "server.js");
const distSource = path.join(projectRoot, "dist", "server-source.txt");
const srcServerSource = path.join(projectRoot, "src", "server-source.txt");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pty-bundle-fallback-"));
let linkedTmp: string | null = null;
afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (linkedTmp) fs.rmSync(linkedTmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

let bgPids: number[] = [];
afterEach(() => {
  for (const pid of bgPids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  bgPids = [];
});

let nameCounter = 0;
function uniqueName(): string {
  return `bundle-fb${++nameCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

function makeSessionDir(): string {
  return fs.mkdtempSync(path.join(testRoot, "d-"));
}

function trackPid(dir: string, name: string): void {
  try {
    const pid = parseInt(fs.readFileSync(path.join(dir, `${name}.pid`), "utf-8").trim(), 10);
    if (Number.isFinite(pid)) bgPids.push(pid);
  } catch {}
}

beforeAll(() => {
  // The fallback path requires the embedded source to exist next to spawn.ts
  // (src/) when these tests run via tsx. `npm run build` writes it; surface a
  // clear error if someone runs tests without building.
  if (!fs.existsSync(srcServerSource)) {
    throw new Error(`Missing ${srcServerSource} — run \`npm run build\` first.`);
  }
  // The materialised server runs from os.tmpdir() and so cannot walk up to
  // this project's node_modules to find node-pty. Redirect TMPDIR for this
  // test process to a directory that has node_modules symlinked in, so ESM
  // resolution from the tmpfile can find node-pty. Real bundled consumers
  // handle this themselves (e.g. by shipping a sibling node_modules with
  // their binary, or by using a launcher that sets up the environment).
  linkedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pty-fb-tmp-"));
  fs.symlinkSync(path.join(projectRoot, "node_modules"), path.join(linkedTmp, "node_modules"));
  process.env.TMPDIR = linkedTmp;
});

describe("spawnDaemon bundle-safe fallback", () => {
  it("dist/server-source.txt is a non-empty bundle of the server module", () => {
    const b = fs.readFileSync(distSource, "utf-8");
    // Sanity: the bundle is non-trivial and still references the npm deps as
    // externals (so the host's node_modules satisfies them at runtime).
    expect(b.length).toBeGreaterThan(1000);
    expect(b).toMatch(/from\s+["']node-pty["']/);
    expect(b).toMatch(/from\s+["']@xterm\/headless["']/);
    // No relative imports survive — sibling modules are inlined.
    expect(b).not.toMatch(/from\s+["']\.\.?\/[^"']+["']/);
  });

  it("falls back to the embedded source when the on-disk server module is unreadable", async () => {
    // No setServerModulePath() override; sibling lookup uses __dirname of
    // spawn.ts which under tsx is src/ where server.js doesn't exist, so the
    // fallback path is exercised end-to-end.
    const dir = makeSessionDir();
    const name = uniqueName();
    process.env.PTY_SESSION_DIR = dir;

    await spawnDaemon({
      name,
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
      displayCommand: "sh",
      cwd: dir,
    });

    const stats = await queryStats(name);
    expect(stats.name).toBe(name);
    expect(stats.process.alive).toBe(true);
    trackPid(dir, name);
  }, 15000);

  it("reuses the same tmpfile across multiple spawns with identical source", async () => {
    const source = fs.readFileSync(srcServerSource, "utf-8");
    const hash = crypto.createHash("sha256").update(source).digest("hex").slice(0, 16);
    const expectedDir = path.join(os.tmpdir(), `myobie-pty-server-${hash}`);
    const expected = path.join(expectedDir, "server.js");

    const dir = makeSessionDir();
    process.env.PTY_SESSION_DIR = dir;

    for (let i = 0; i < 2; i++) {
      const name = uniqueName();
      await spawnDaemon({
        name,
        command: "/bin/sh",
        args: ["-c", "sleep 30"],
        displayCommand: "sh",
        cwd: dir,
      });
      trackPid(dir, name);
    }

    expect(fs.existsSync(expected)).toBe(true);
    // Exactly one materialised dir per content hash — no duplicates piling up.
    const matching = fs.readdirSync(os.tmpdir()).filter((f) =>
      f.startsWith(`myobie-pty-server-${hash}`),
    );
    expect(matching).toEqual([path.basename(expectedDir)]);
  }, 20000);

  it("explicit setServerModulePath() override still wins over the fallback", async () => {
    // Point at the real built server.js — must be used directly, no tmpfile
    // shenanigans (the override is the documented escape hatch).
    setServerModulePath(distServer);

    const dir = makeSessionDir();
    const name = uniqueName();
    process.env.PTY_SESSION_DIR = dir;

    await spawnDaemon({
      name,
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
      displayCommand: "sh",
      cwd: dir,
    });

    const stats = await queryStats(name);
    expect(stats.name).toBe(name);
    expect(stats.process.alive).toBe(true);
    trackPid(dir, name);
  }, 15000);
});
