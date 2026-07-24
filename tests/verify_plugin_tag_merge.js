"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = {
  require,
  console,
  setTimeout,
  clearTimeout,
  localStorage: { getItem() { return null; }, setItem() {} },
  eagle: {
    onPluginCreate() {},
    onPluginRun() {},
    onPluginBeforeExit() {},
  },
  window: { addEventListener() {} },
};

vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "eagle-plugin", "plugin.js"), "utf8"),
  context,
);

context.__items = [
  { id: "empty", tags: [] },
  { id: "manual", tags: ["manual"] },
  { id: "missing" },
];

const untaggedIds = vm.runInContext(
  "selectTodoItems(__items, 'untagged').map((item) => item.id)",
  context,
);
const mergeIds = vm.runInContext(
  "selectTodoItems(__items, 'merge').map((item) => item.id)",
  context,
);
assert.deepEqual(Array.from(untaggedIds), ["empty", "missing"]);
assert.deepEqual(Array.from(mergeIds), ["empty", "manual", "missing"]);

context.__existing = ["Manual", "solo", "  landscape  "];
context.__predicted = ["manual", "1girl", "SOLO", "landscape", "", "1girl"];
const merged = vm.runInContext("mergeItemTags(__existing, __predicted)", context);
assert.deepEqual(Array.from(merged), ["Manual", "solo", "landscape", "1girl"]);

context.__rerun = Array.from(merged);
const rerun = vm.runInContext("mergeItemTags(__rerun, __predicted)", context);
assert.deepEqual(Array.from(rerun), ["Manual", "solo", "landscape", "1girl"]);

const safeMode = vm.runInContext(
  "planTagUpdate(__existing, __predicted, 'untagged')",
  context,
);
assert.equal(safeMode.action, "skip-existing");

const additiveMode = vm.runInContext(
  "planTagUpdate(__existing, __predicted, 'merge')",
  context,
);
assert.equal(additiveMode.action, "write");
assert.equal(additiveMode.addedCount, 1);
assert.deepEqual(Array.from(additiveMode.tags), ["Manual", "solo", "landscape", "1girl"]);

context.__merged = Array.from(additiveMode.tags);
const repeatedMode = vm.runInContext(
  "planTagUpdate(__merged, __predicted, 'merge')",
  context,
);
assert.equal(repeatedMode.action, "skip-no-new");
assert.equal(repeatedMode.addedCount, 0);

console.log("tag merge verified: originals preserved, new tags appended, reruns deduplicated");
