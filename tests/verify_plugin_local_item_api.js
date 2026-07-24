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
  Buffer,
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

(async () => {
  const items = await vm.runInContext(
    'requestLocalApi("GET", "/api/item/list?limit=1&offset=0")',
    context,
  );
  assert.ok(Array.isArray(items) && items[0]?.id);
  context.__itemId = items[0].id;
  const item = await vm.runInContext("getLocalItem(__itemId)", context);
  assert.equal(item.id, items[0].id);
  assert.ok(Array.isArray(item.tags));
  console.log(`local item API verified: ${item.id}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
