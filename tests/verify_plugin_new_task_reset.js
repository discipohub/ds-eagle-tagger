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

const result = vm.runInContext(`(() => {
  state.scope = "folder";
  state.selectedFolderIds = new Set(["folder-a", "folder-b"]);
  state.folderSearch = "illustration";
  state.folders = [{ id: "folder-a" }];
  state.items = [{ id: "image-a" }];
  state.todo = [{ id: "image-a" }];
  state.failures = [{ id: "image-b" }];
  state.engineDone = { total: 1 };
  state.written = 1;
  state.historyRecords = [{ item_id: "image-a" }];
  resetNewTaskState();
  return {
    selected: [...state.selectedFolderIds],
    search: state.folderSearch,
    folders: state.folders.length,
    items: state.items.length,
    todo: state.todo.length,
    failures: state.failures.length,
    engineDone: state.engineDone,
    written: state.written,
    historyRecords: state.historyRecords.length,
    title: state.scopeTitle,
  };
})()`, context);

assert.deepEqual(Array.from(result.selected), []);
assert.equal(result.search, "");
assert.equal(result.folders, 0);
assert.equal(result.items, 0);
assert.equal(result.todo, 0);
assert.equal(result.failures, 0);
assert.equal(result.engineDone, null);
assert.equal(result.written, 0);
assert.equal(result.historyRecords, 0);
assert.equal(result.title, "尚未选择文件夹");

console.log("new task reset verified: folder choices and prior results cleared");
