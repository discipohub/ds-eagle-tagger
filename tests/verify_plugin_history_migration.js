"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(projectRoot, "eagle-plugin", "plugin.js"), "utf8");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eagle-history-migration-"));
const storage = new Map();
const nodes = new Map();
let dialogResponse = 0;

function nodeFor(selector) {
  if (!nodes.has(selector)) {
    nodes.set(selector, {
      textContent: "",
      className: "",
      classList: { add() {}, remove() {}, toggle() {} },
    });
  }
  return nodes.get(selector);
}

const context = {
  require,
  console,
  process,
  document: {
    querySelector: nodeFor,
    querySelectorAll() { return []; },
  },
  localStorage: {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, value); },
  },
  eagle: {
    plugin: { path: path.join(projectRoot, "eagle-plugin") },
    dialog: {
      async showMessageBox() { return { response: dialogResponse }; },
    },
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

async function seed(database, itemId) {
  context.__database = database;
  context.__itemId = itemId;
  await vm.runInContext(
    `runHistoryCommand("record", {
      model_repo: "test/model",
      model_revision: "r1",
      signature: "s1",
      settings: { general_threshold: 0.35, max_tags: 50 },
      records: [{ id: __itemId, generated_tags: ["tag_a"] }]
    }, { dbPath: __database })`,
    context,
  );
}

(async () => {
  try {
    const moveSource = path.join(temporaryRoot, "source", "history.sqlite3");
    const moveTarget = path.join(temporaryRoot, "target", "history.sqlite3");
    await seed(moveSource, "move-item");
    storage.set("eagle-auto-tagger.history-db", moveSource);
    dialogResponse = 0;
    context.__target = moveTarget;
    await vm.runInContext("switchHistoryDatabase(__target)", context);
    assert.equal(fs.existsSync(moveSource), false, "迁移成功后应删除旧记录库");
    assert.equal(fs.existsSync(moveTarget), true, "迁移后应保留新记录库");
    assert.equal(storage.get("eagle-auto-tagger.history-db"), path.resolve(moveTarget));

    const copySource = path.join(temporaryRoot, "copy-source", "history.sqlite3");
    const copyTarget = path.join(temporaryRoot, "copy-target", "history.sqlite3");
    await seed(copySource, "copy-item");
    storage.set("eagle-auto-tagger.history-db", copySource);
    dialogResponse = 1;
    context.__target = copyTarget;
    await vm.runInContext("switchHistoryDatabase(__target)", context);
    assert.equal(fs.existsSync(copySource), true, "保留备份时不应删除旧记录库");
    assert.equal(fs.existsSync(copyTarget), true, "保留备份时应创建新记录库");
    console.log("history migration verified: move deletes source, backup copy retains source");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
