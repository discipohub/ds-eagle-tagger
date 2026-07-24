"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const itemsByFolder = {
  A: [
    { id: "A1", name: "A1", ext: "jpg", tags: [] },
    { id: "SHARED", name: "shared", ext: "png", tags: [] },
  ],
  B: [
    { id: "B1", name: "B1", ext: "webp", tags: [] },
    { id: "SHARED", name: "shared", ext: "png", tags: [] },
  ],
  C: [{ id: "C1", name: "C1", ext: "jpeg", tags: [] }],
};

const queriedFolderSets = [];
const context = {
  require,
  console,
  setTimeout,
  clearTimeout,
  eagle: {
    item: {
      async get(options) {
        queriedFolderSets.push(options.folders);
        const items = itemsByFolder[options.folders[0]] || [];
        return items.filter((item) => item.ext === options.ext);
      },
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
  context.__items = await vm.runInContext('queryFolderImageItems(["A", "B", "C"])', context);
  const ids = vm.runInContext("__items.map((item) => item.id).sort()", context);
  assert.deepEqual(Array.from(ids), ["A1", "B1", "C1", "SHARED"]);
  assert.ok(queriedFolderSets.every((folders) => folders.length === 1));
  console.log("folder union verified: 3 folders, 4 unique images");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
