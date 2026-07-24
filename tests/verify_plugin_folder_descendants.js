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

context.__folders = [
  {
    id: "ROOT",
    name: "复集",
    children: [
      { id: "CHILD", name: "子级", children: [{ id: "DEEP", name: "深层", children: [] }] },
      { id: "SIBLING", name: "同级子项", children: [] },
    ],
  },
  { id: "FLAT", name: "扁平子项", parent: "ROOT", children: [] },
];

const flattened = vm.runInContext("flattenFolderTree(__folders)", context);
const normalized = Array.from(flattened, (folder) => ({
  id: folder.id,
  descendants: Array.from(folder.descendantIds),
}));
const byId = new Map(normalized.map((folder) => [folder.id, folder]));
assert.deepEqual(byId.get("ROOT").descendants, ["CHILD", "DEEP", "SIBLING", "FLAT"]);
assert.deepEqual(byId.get("CHILD").descendants, ["DEEP"]);
assert.deepEqual(byId.get("DEEP").descendants, []);
console.log("recursive folder descendants verified: 4 nested descendants");
