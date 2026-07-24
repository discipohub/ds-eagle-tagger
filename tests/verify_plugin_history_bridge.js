"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(projectRoot, "eagle-plugin", "plugin.js"), "utf8");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eagle-auto-tagger-history-"));
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
context.__database = path.join(temporaryRoot, "custom-drive", "history.sqlite3");
vm.runInContext("resolveEngine = () => __engine", context);

(async () => {
  try {
    const status = await vm.runInContext(
      'runHistoryCommand("status", {}, { dbPath: __database })',
      context,
    );
    assert.equal(status.count, 0);

    const recorded = await vm.runInContext(
      `runHistoryCommand("record", {
        model_repo: "test/model",
        model_revision: "r1",
        signature: "s1",
        settings: { general_threshold: 0.35, max_tags: 50 },
        records: [{ id: "item-1", generated_tags: ["tag_a", "tag_b"] }]
      }, { dbPath: __database })`,
      context,
    );
    assert.equal(recorded.recorded, 1);

    const filtered = await vm.runInContext(
      `runHistoryCommand("filter", {
        signature: "s1",
        items: [{ id: "item-1", tags: ["manual", "TAG_A", "tag_b"] }]
      }, { dbPath: __database })`,
      context,
    );
    assert.deepEqual(Array.from(filtered.skipped_ids), ["item-1"]);
    assert.deepEqual(Array.from(filtered.pending_ids), []);
    console.log("plugin history bridge verified: custom path, record and filter");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
