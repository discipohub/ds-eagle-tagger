"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = {
  require,
  console,
  setTimeout,
  clearTimeout,
  eagle: {
    folder: { async getAll() { return []; } },
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
  context.__folders = await vm.runInContext("getAllFoldersWithFallback()", context);
  const count = vm.runInContext("flattenFolderTree(__folders).length", context);
  if (count < 1) throw new Error("folder fallback returned no folders");
  console.log(`folder fallback verified: ${count} folders`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
