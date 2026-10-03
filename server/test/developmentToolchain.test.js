import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const watchFlags = ["--watch", "--watch-preserve-output"];
const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

function assertPackagesAbsent(lock, names) {
  assert.ok(lock.packages);
  for (const path of Object.keys(lock.packages)) {
    for (const name of names) {
      const suffix = `node_modules/${name}`;
      assert.ok(path !== suffix && !path.endsWith(`/${suffix}`), `${path} must be absent`);
    }
  }
}

test("server development uses native watch without changing production startup", () => {
  const manifest = readJson("../package.json");
  assert.equal(manifest.scripts.dev, `node ${watchFlags.join(" ")} src/oldServer.js`);
  assert.equal(manifest.scripts.start, "node src/oldServer.js");
  assert.equal(manifest.devDependencies?.nodemon, undefined);
  assertPackagesAbsent(readJson("../package-lock.json"), ["nodemon", "chokidar", "braces"]);
});

test("frontend lint tooling has one aligned TypeScript-ESLint family without the vulnerable glob chain", () => {
  const lock = readJson("../../dcad-frontend/package-lock.json");
  assertPackagesAbsent(lock, ["fast-glob", "micromatch", "braces"]);
  const umbrella = lock.packages["node_modules/typescript-eslint"];
  assert.ok(umbrella?.version);
  const family = Object.entries(lock.packages).filter(([path]) =>
    /(?:^|\/)node_modules\/@typescript-eslint\/[^/]+$/.test(path));
  assert.ok(family.length > 0);
  for (const [path, entry] of family) {
    // Allow future aligned upgrades instead of permanently pinning this regression to 8.48.0.
    assert.equal(entry.version, umbrella.version, `${path} must match typescript-eslint`);
  }
});

async function bounded(promise, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("native watch restarts an exited synthetic entry when its imported module changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "homenode-native-watch-"));
  let watcher;
  let closed;
  try {
    const entry = join(directory, "entry.mjs");
    const dependency = join(directory, "dependency.mjs");
    await writeFile(dependency, 'export const version = "first";\n');
    await writeFile(entry, 'import { version } from "./dependency.mjs";\nconsole.log(`watch-fixture:${version}`);\n');
    const env = { ...process.env };
    // Do not inherit test-runner context, instrumentation or user preload modules.
    for (const key of Object.keys(env)) {
      if (/^NODE_(OPTIONS|PATH|TEST_CONTEXT|V8_COVERAGE)$/i.test(key)) delete env[key];
    }
    watcher = spawn(process.execPath, [...watchFlags, entry], {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let output = "";
    let spawnError;
    let ended = false;
    let notify = () => {};
    const capture = (chunk) => {
      output = (output + chunk.toString()).slice(-16_384);
      notify();
    };
    watcher.stdout.on("data", capture);
    watcher.stderr.on("data", capture);
    watcher.on("error", (error) => { spawnError = error; notify(); });
    closed = new Promise((resolve) => watcher.once("close", () => {
      ended = true;
      notify();
      resolve();
    }));
    async function waitForRun(version) {
      try {
        await bounded(new Promise((resolve, reject) => {
          notify = () => {
            // The completion banner confirms the finite child exited before the next edit/cleanup.
            if (new RegExp(`watch-fixture:${version}[\\s\\S]*Completed running`).test(output)) resolve();
            else if (spawnError || ended) reject(spawnError ?? new Error(`Watcher exited early:\n${output}`));
          };
          notify();
        }), 15_000, `watch fixture ${version}; output: ${output}`);
      } finally {
        notify = () => {};
      }
    }
    await waitForRun("first");
    await writeFile(dependency, 'export const version = "second";\n');
    await waitForRun("second");
    assert.equal(ended, false, "watcher stays available after the entry exits");
  } finally {
    try {
      let terminationError;
      if (watcher?.pid && watcher.exitCode === null && watcher.signalCode === null) {
        // Kill the tree, not just its parent, even if a failed assertion interrupts a restart.
        try {
          if (process.platform === "win32") {
            execFileSync("taskkill.exe", ["/PID", String(watcher.pid), "/T", "/F"], {
              windowsHide: true, stdio: "pipe", timeout: 5_000,
            });
          } else {
            process.kill(-watcher.pid, "SIGKILL");
          }
        } catch (error) {
          // A restricted host may deny tree inspection. Still reap the watcher;
          // the synthetic child has no persistent handles, and the test must fail.
          terminationError = error;
          watcher.kill("SIGKILL");
        }
      }
      if (closed) await bounded(closed, 5_000, "watcher process tree termination");
      if (terminationError) throw terminationError;
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});
