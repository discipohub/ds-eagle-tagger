"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.join(__dirname, "..");
const pluginRoot = path.join(projectRoot, "eagle-plugin");
const source = fs.readFileSync(path.join(pluginRoot, "plugin.js"), "utf8");
const requiredEngineFiles = [
  "plugin_engine.py",
  "tagger.py",
  "wd14.py",
  "eagle_api.py",
  "tag_history.py",
  "model_update.py",
  "model-catalog.json",
  "config.json",
  "requirements-gpu.txt",
];

assert.doesNotMatch(source, /N:\\eagle-auto-tagger/i, "公开版不能依赖开发机 N 盘路径");
assert.match(source, /windowsHide:\s*true/, "后台进程必须隐藏命令行窗口");
assert.match(source, /EagleAutoTagger/, "应使用固定的本地用户安装目录");
assert.match(source, /setup\.log/, "安装失败时必须保留持久化诊断日志");
assert.match(source, /Microsoft Visual C\+\+/, "安装验证必须给出 Visual C++ 运行库指引");
assert.match(source, /throwOnError/, "首次安装时不能隐藏推理引擎的真实验证错误");

for (const file of requiredEngineFiles) {
  assert.ok(fs.existsSync(path.join(pluginRoot, "engine", file)), `缺少引擎文件：${file}`);
}
const uvPath = path.join(pluginRoot, "engine", "tools", "uv.exe");
assert.ok(fs.statSync(uvPath).size > 1_000_000, "安装包内的 uv.exe 无效");
assert.ok(fs.existsSync(path.join(pluginRoot, "PRIVACY.md")), "缺少隐私说明");
assert.ok(fs.existsSync(path.join(pluginRoot, "THIRD_PARTY_NOTICES.md")), "缺少第三方组件说明");
assert.match(
  fs.readFileSync(path.join(pluginRoot, "LICENSE"), "utf8"),
  /MIT License/,
  "开源发布包必须附带 MIT License",
);

const context = {
  require,
  console,
  process: {
    env: { LOCALAPPDATA: "C:\\Users\\Public\\AppData\\Local" },
    platform: "win32",
    arch: "x64",
  },
  localStorage: { getItem() { return null; }, setItem() {} },
  eagle: {
    plugin: { path: pluginRoot },
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

const defaultRoot = vm.runInContext("defaultEngineRoot()", context);
assert.equal(defaultRoot, "C:\\Users\\Public\\AppData\\Local\\EagleAutoTagger\\engine");

const parsedEvents = vm.runInContext(
  `parseWorkerEvents('third-party diagnostic\\n{"type":"probe","ok":true}\\n')`,
  context,
);
assert.equal(parsedEvents.length, 1, "非 JSON 诊断信息不应破坏引擎事件解析");
assert.equal(parsedEvents[0].type, "probe");
const visualCppGuidance = vm.runInContext(
  `formatEngineProbeError('ImportError: DLL load failed while importing onnxruntime_pybind11_state')`,
  context,
);
assert.match(visualCppGuidance, /Visual C\+\+/, "DLL 导入失败应显示 Visual C++ 修复建议");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eagle-auto-tagger-public-test-"));
try {
  context.__temporaryRoot = temporaryRoot;
  vm.runInContext("copyBundledEngine(__temporaryRoot)", context);
  for (const file of requiredEngineFiles) {
    assert.ok(fs.existsSync(path.join(temporaryRoot, file)), `首次安装没有复制：${file}`);
  }
  assert.equal(fs.readFileSync(path.join(temporaryRoot, ".engine-version"), "utf8"), "0.7.2");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("public engine setup verified: portable path, hidden process, complete bundle");
