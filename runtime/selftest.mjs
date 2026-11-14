// Checks one installed dsh version under the Termux compatibility layer.
// Usage: node --expose-internals --import <dir>/termux/preload.mjs <dir>/termux/selftest.mjs <dir>
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2] ?? ".");
const modules = path.join(root, "node_modules");
const req = createRequire(path.join(modules, "_"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-termux-selftest-"));
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}: ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

try {
  await check("node-pty", () => req("node-pty"));
  await check("koffi", () => req("koffi"));
  await check("sharp (wasm32)", async () => {
    const png = await req("sharp")({ create: { width: 2, height: 2, channels: 3, background: "#000" } }).png().toBuffer();
    if (!png.length) throw new Error("empty image");
  });
  await check("require-builtin shim", () => {
    const { requireBuiltin } = req("node-addon-require-builtin");
    if (typeof requireBuiltin("internal/modules/cjs/loader").Module !== "function") throw new Error("internal module missing");
  });
  await check("flock shim", async () => {
    const flock = path.join(modules, "@deepseek-ai/node-addon-system/lib/flock.js");
    if (!fs.existsSync(flock)) return;
    const { tryLockExclusive } = await import(pathToFileURL(flock).href);
    const file = path.join(tmp, "lock");
    const a = fs.openSync(file, "w");
    const b = fs.openSync(file, "r");
    try {
      await tryLockExclusive(a);
      let contended = false;
      await tryLockExclusive(b).catch((error) => { contended = error.code === "EAGAIN" || error.code === "EWOULDBLOCK"; });
      if (!contended) throw new Error("second lock was not refused");
    } finally {
      fs.closeSync(a);
      fs.closeSync(b);
    }
  });
  await check("link fallback", async () => {
    const src = path.join(tmp, "src");
    const dst = path.join(tmp, "dst");
    fs.writeFileSync(src, "x");
    await fs.promises.link(src, dst);
    let exists = false;
    await fs.promises.link(src, dst).catch((error) => { exists = error.code === "EEXIST"; });
    if (!exists) throw new Error("second link did not fail with EEXIST");
  });
  await check("web login redirect", async () => {
    const cookie = "a=1; Path=/; HttpOnly; SameSite=Strict";
    const server = http.createServer((req, res) => {
      if (req.url.startsWith("/set")) {
        res.setHeader("location", "./");
        res.setHeader("set-cookie", cookie);
        res.writeHead(303);
      } else {
        res.writeHead(303, { location: "./", "set-cookie": cookie });
      }
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const url of [`${base}/?token=x`, `${base}/set?token=x`]) {
        const cross = await fetch(url, { redirect: "manual", headers: { "sec-fetch-site": "cross-site" } });
        const body = await cross.text();
        if (cross.status !== 200 || !cross.headers.get("set-cookie") || !body.includes('url=./"')) {
          throw new Error(`cross-site login answered ${cross.status}`);
        }
        const direct = await fetch(url, { redirect: "manual" });
        if (direct.status !== 303) throw new Error(`direct login answered ${direct.status}`);
      }
    } finally {
      server.close();
    }
  });
  await check("dsh boots (headless --help)", () => {
    const bin = path.join(modules, "@deepseek-ai/dsh/lib/bin.js");
    const preload = path.join(root, "termux/preload.mjs");
    const r = spawnSync(process.execPath, ["--expose-internals", "--import", preload, bin, "--profile", "headless", "--help"], {
      env: { ...process.env, DSH_HOME: path.join(tmp, "home") },
      encoding: "utf8",
      timeout: 180_000,
    });
    if (r.status !== 0 || !/Usage: dsh --profile headless/.test(r.stdout)) {
      throw new Error((r.stderr || r.stdout || `exit ${r.status}`).trim().split("\n").filter((l) => !/^\s+at /.test(l)).slice(-3).join(" | "));
    }
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
