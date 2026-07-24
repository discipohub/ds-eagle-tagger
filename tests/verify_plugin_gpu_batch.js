"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const values = new Map();
const buttons = ["auto", "1", "2", "4", "8"].map((batch) => ({
  dataset: { batch },
  textContent: "",
  classList: { toggle() {} },
}));
const hint = { textContent: "" };
const document = {
  querySelector(selector) {
    if (selector === "#batch-hint") return hint;
    return null;
  },
  querySelectorAll(selector) {
    return selector === "#batch-options button" ? buttons : [];
  },
};
const context = {
  require,
  console,
  process,
  document,
  localStorage: {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  },
  eagle: {
    onPluginCreate() {},
    onPluginRun() {},
    onPluginBeforeExit() {},
  },
  window: { addEventListener() {} },
  setTimeout,
  clearTimeout,
};

vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "eagle-plugin", "plugin.js"), "utf8"),
  context,
);

context.__probe = {
  gpu: {
    uuid: "GPU-PUBLIC-TEST",
    name: "NVIDIA GeForce RTX 3090",
    memory_total_mb: 24576,
    memory_free_mb: 22000,
  },
  recommended_batch: 8,
};

assert.equal(
  vm.runInContext(
    "state.batchMode = 'auto'; applyGpuRecommendation(__probe); state.batch",
    context,
  ),
  8,
);
assert.equal(buttons[0].textContent, "自动 8");
assert.match(hint.textContent, /RTX 3090/);

vm.runInContext("rememberSafeBatch(4)", context);
assert.equal(
  vm.runInContext("applyGpuRecommendation(__probe); state.batch", context),
  4,
);
assert.equal(buttons[0].textContent, "自动 4");

assert.equal(
  vm.runInContext(
    "state.batchMode = 'manual'; state.batch = 2; applyGpuRecommendation(__probe); state.batch",
    context,
  ),
  2,
);

assert.equal(
  vm.runInContext(
    "state.batchMode = 'auto'; applyGpuRecommendation({ recommended_batch: 2 }); state.batch",
    context,
  ),
  2,
);

console.log("GPU batch adaptation verified: auto recommendation, safe memory, manual override");
