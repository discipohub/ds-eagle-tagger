"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
const pluginRoot = path.join(projectRoot, "eagle-plugin");
const source = fs.readFileSync(path.join(pluginRoot, "plugin.js"), "utf8");
const html = fs.readFileSync(path.join(pluginRoot, "index.html"), "utf8");

assert.match(
  source,
  /https:\/\/mirrors\.ustc\.edu\.cn\/github-release\/astral-sh\/python-build-standalone\//,
  "应配置 USTC Python 下载镜像",
);
assert.match(
  source,
  /https:\/\/mirrors\.ustc\.edu\.cn\/pypi\/simple/,
  "应配置 USTC PyPI 镜像",
);
assert.match(
  source,
  /https:\/\/mirrors\.tuna\.tsinghua\.edu\.cn\/pypi\/web\/simple/,
  "应配置清华 PyPI 备用镜像",
);
assert.match(source, /UV_PYTHON_INSTALL_MIRROR/, "应把 Python 镜像传给 uv");
assert.match(source, /--index-url/, "应把依赖镜像传给 uv");
assert.match(source, /import-local/, "应调用本地模型导入命令");
assert.match(source, /SHA-256/, "本地模型导入前应提示完整性校验");
assert.match(html, /id="import-local-model"/, "设置页应提供本地模型导入按钮");
assert.match(html, /model\.onnx/, "设置页应提示模型文件名");
assert.match(html, /selected_tags\.csv/, "设置页应提示标签表文件名");

console.log("offline model import and mainland setup mirrors verified");
