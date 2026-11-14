// Loaded with `node --expose-internals --import` before dsh starts. Adapts dsh to Termux without editing the
// installed packages, so the same layer keeps working across dsh releases.
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";

// node-addon-require-builtin and node-addon-system ship no android-arm64 binaries: route them to JS shims.
const requireBuiltinShim = new URL("./require-builtin.cjs", import.meta.url).href;
const flockShim = new URL("./flock.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node-addon-require-builtin") {
      return { url: requireBuiltinShim, format: "commonjs", shortCircuit: true };
    }
    const resolved = nextResolve(specifier, context);
    if (resolved.url?.endsWith("/@deepseek-ai/node-addon-system/lib/flock.js")) {
      return { url: `${flockShim}?base=${encodeURIComponent(resolved.url)}`, format: "module", shortCircuit: true };
    }
    return resolved;
  },
});

// Android's SELinux policy denies link(2) to apps. Fall back to an exclusive copy, which keeps link's
// "fail with EEXIST if the target exists" contract that dsh relies on for no-clobber publishing.
const denied = (error) => error?.code === "EACCES" || error?.code === "EPERM";
const { COPYFILE_EXCL } = fs.constants;
const link = fs.link;
const linkSync = fs.linkSync;
const linkPromise = fs.promises.link;

fs.promises.link = async function (src, dst) {
  try {
    return await linkPromise(src, dst);
  } catch (error) {
    if (!denied(error)) throw error;
    return fs.promises.copyFile(src, dst, COPYFILE_EXCL);
  }
};
fs.linkSync = function (src, dst) {
  try {
    return linkSync(src, dst);
  } catch (error) {
    if (!denied(error)) throw error;
    return fs.copyFileSync(src, dst, COPYFILE_EXCL);
  }
};
fs.link = function (src, dst, callback) {
  link(src, dst, (error) => (denied(error) ? fs.copyFile(src, dst, COPYFILE_EXCL, callback) : callback(error)));
};
syncBuiltinESMExports();
