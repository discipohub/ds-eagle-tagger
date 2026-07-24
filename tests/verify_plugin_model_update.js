"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(projectRoot, "eagle-plugin", "plugin.js"), "utf8");
const context = {
  require,
  console,
  process,
  localStorage: { getItem() { return null; }, setItem() {} },
  eagle: {
    plugin: { path: path.join(projectRoot, "eagle-plugin") },
    onPluginCreate() {},
    onPluginRun() {},
    onPluginBeforeExit() {},
  },
  window: { addEventListener() {} },
  setTimeout,
  clearTimeout,
};

vm.createContext(context);
vm.runInContext(source, context);
const engineRoot = path.join(projectRoot, "eagle-plugin", "engine");
context.__engine = {
  root: engineRoot,
  python: process.env.PYTHON || "python",
  worker: path.join(engineRoot, "plugin_engine.py"),
};
vm.runInContext("resolveEngine = () => __engine", context);

(async () => {
  const event = await vm.runInContext('runModelUpdater(["check"])', context);
  assert.equal(event.type, "model_update_check");
  assert.equal(event.ok, true);
  assert.equal(event.current.id, "wd-eva02-large-tagger-v3-fa2b83fd");
  assert.equal(event.update_available, false);
  assert.equal(event.online_configured, true);
  console.log("plugin model updater verified: approved catalog and current release");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
