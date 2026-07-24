"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const calls = [];
const context = {
  require,
  console,
  setTimeout,
  clearTimeout,
  Buffer,
  eagle: {
    item: {
      async open(id) { calls.push(["open", id]); },
      async select(ids) { calls.push(["select", ...ids]); },
    },
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

(async () => {
  await vm.runInContext('locateItemInEagle("ITEM_A")', context);
  assert.deepEqual(calls, [["open", "ITEM_A"], ["select", "ITEM_A"]]);

  calls.length = 0;
  context.eagle.item.open = undefined;
  context.eagle.item.getById = async (id) => ({
    async open() { calls.push(["instance-open", id]); },
  });
  await vm.runInContext('locateItemInEagle("ITEM_B")', context);
  assert.deepEqual(calls, [["instance-open", "ITEM_B"], ["select", "ITEM_B"]]);
  console.log("individual Eagle item location verified");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
