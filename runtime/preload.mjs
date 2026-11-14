// Loaded with `node --expose-internals --import` before dsh starts. Adapts dsh to Termux without editing the
// installed packages, so the same layer keeps working across dsh releases.
import fs from "node:fs";
import http from "node:http";
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

// `dsh web` opens `/?token=...`, which sets a SameSite=Strict cookie and 303-redirects to `./`. Android browsers
// treat a URL handed over by another app as a cross-site navigation, and the redirect stays cross-site, so the
// cookie is withheld and the page answers 401. Reply 200 and let the page itself navigate to `./` instead: that
// navigation is same-origin, so the browser sends the cookie.
const writeHead = http.ServerResponse.prototype.writeHead;
http.ServerResponse.prototype.writeHead = function (statusCode, ...rest) {
  if (statusCode !== 303 || this.req?.headers["sec-fetch-site"] !== "cross-site") {
    return writeHead.call(this, statusCode, ...rest);
  }
  // Headers arrive either as the last argument or, behind wrappers such as on-headers, already set on `this`.
  const last = rest.at(-1);
  const headers = last !== null && typeof last === "object" && !Array.isArray(last) ? last : undefined;
  if ((headers ? headers.location : this.getHeader("location")) !== "./") {
    return writeHead.call(this, statusCode, ...rest);
  }
  const html = "text/html; charset=utf-8";
  let args = [];
  if (headers) {
    const { location, ...kept } = headers;
    args = [{ ...kept, "content-type": html }];
  } else {
    this.removeHeader("location");
    this.setHeader("content-type", html);
  }
  const body = '<!doctype html><meta http-equiv="refresh" content="0;url=./"><a href="./">Continue</a>\n';
  const end = this.end;
  this.end = function (...endArgs) {
    this.end = end;
    const callback = endArgs.find((arg) => typeof arg === "function");
    return this.req.method === "HEAD" ? end.call(this, callback) : end.call(this, body, callback);
  };
  return writeHead.call(this, 200, ...args);
};
