"use strict";
// Stand-in for node-addon-require-builtin (the unrestricted variant): with --expose-internals, Node's own
// require already loads internal/* modules, which is all the native addon provides.
const { createRequire } = require("node:module");

const nodeRequire = createRequire(__filename);

function requireBuiltin(moduleId) {
  return nodeRequire(moduleId.startsWith("node:") ? moduleId.slice(5) : moduleId);
}

function isAllowedInternalId() {
  return true;
}

function getBindingInfo() {
  return { source: "dsh-termux", backend: "expose-internals", abi: "js" };
}

module.exports = { requireBuiltin, isAllowedInternalId, getBindingInfo };
module.exports.default = module.exports;
