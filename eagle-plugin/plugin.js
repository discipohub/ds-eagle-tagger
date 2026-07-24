/* global eagle */
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const readline = require("node:readline");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"]);
const ENGINE_VERSION = "0.7.2";
const TAGGING_PIPELINE_VERSION = 1;
const HISTORY_PATH_KEY = "eagle-auto-tagger.history-db";
const SETTINGS_KEY = "eagle-auto-tagger.settings";
const SAFE_BATCHES_KEY = "eagle-auto-tagger.safe-batches";
const PYTHON_INSTALL_SOURCES = [
  {
    name: "中国科学技术大学镜像",
    mirror: "https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone/",
  },
  { name: "GitHub 官方源", mirror: null },
];
const PYPI_INSTALL_SOURCES = [
  { name: "中国科学技术大学镜像", index: "https://mirrors.ustc.edu.cn/pypi/simple" },
  { name: "清华大学镜像", index: "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple" },
  { name: "PyPI 官方源", index: "https://pypi.org/simple" },
];
const ENGINE_FILES = [
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

const state = {
  scope: "folder",
  scopeTitle: "尚未读取",
  allFolders: [],
  selectedFolderIds: new Set(),
  folderSearch: "",
  folders: [],
  items: [],
  todo: [],
  skipped: 0,
  historySkipped: 0,
  historyAvailable: true,
  historyRecords: [],
  historyContext: null,
  historyWarning: "",
  tagMode: "untagged",
  batch: 4,
  batchMode: "auto",
  recommendedBatch: 4,
  gpuInfo: null,
  engineRoot: "",
  engineProcess: null,
  setupProcess: null,
  setupLogPath: "",
  modelUpdateProcess: null,
  modelUpdate: null,
  engineReady: false,
  stopped: false,
  written: 0,
  previewed: 0,
  failures: [],
  writeSkipped: 0,
  engineDone: null,
  pageBeforeSettings: "select",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function showToast(message, duration = 3600) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), duration);
}

function tagKey(tag) {
  return String(tag || "").trim().normalize("NFKC").toLocaleLowerCase();
}

function mergeItemTags(existingTags, predictedTags) {
  const merged = [];
  const seen = new Set();
  for (const source of [existingTags, predictedTags]) {
    for (const rawTag of Array.isArray(source) ? source : []) {
      const tag = String(rawTag || "").trim();
      const key = tagKey(tag);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(tag);
    }
  }
  return merged;
}

function planTagUpdate(existingTags, predictedTags, tagMode) {
  const currentTags = Array.isArray(existingTags) ? existingTags : [];
  if (tagMode !== "merge" && currentTags.length > 0) {
    return { action: "skip-existing", tags: currentTags, existingCount: currentTags.length, addedCount: 0 };
  }
  const tags = mergeItemTags(currentTags, predictedTags);
  const existingKeys = new Set(currentTags.map(tagKey).filter(Boolean));
  const addedCount = tags.filter((tag) => !existingKeys.has(tagKey(tag))).length;
  return {
    action: addedCount > 0 ? "write" : "skip-no-new",
    tags,
    existingCount: currentTags.length,
    addedCount,
  };
}

function selectTodoItems(items, tagMode) {
  const source = Array.isArray(items) ? items : [];
  if (tagMode === "merge") return [...source];
  return source.filter((item) => !Array.isArray(item.tags) || item.tags.length === 0);
}

function appendLog(message) {
  const log = $("#live-log");
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  log.textContent += `\n[${time}] ${message}`;
  log.scrollTop = log.scrollHeight;
}

function showPage(name) {
  $$(".page").forEach((page) => page.classList.remove("active"));
  const page = $(`#page-${name}`);
  if (page) page.classList.add("active");
  $$(".step").forEach((step) => step.classList.toggle("active", step.dataset.page === name));
}

function setEngineStatus(text, kind = "neutral") {
  const node = $("#engine-status");
  node.textContent = `● ${text}`;
  node.className = `status-pill ${kind}`;
}

function displayGpuName(gpu = state.gpuInfo) {
  const name = String(gpu?.name || "NVIDIA GPU")
    .replace(/^NVIDIA\s+/i, "")
    .replace(/^GeForce\s+/i, "");
  return name || "NVIDIA GPU";
}

function gpuFingerprint(gpu = state.gpuInfo) {
  if (!gpu) return "";
  return String(gpu.uuid || `${gpu.name || "gpu"}-${gpu.memory_total_mb || 0}`);
}

function loadSafeBatches() {
  try {
    const value = JSON.parse(localStorage.getItem(SAFE_BATCHES_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function rememberSafeBatch(batch) {
  const fingerprint = gpuFingerprint();
  if (!fingerprint || ![1, 2, 4, 8].includes(Number(batch))) return;
  const values = loadSafeBatches();
  const previous = Number(values[fingerprint] || 8);
  values[fingerprint] = Math.min(previous, Number(batch));
  localStorage.setItem(SAFE_BATCHES_KEY, JSON.stringify(values));
}

function effectiveRecommendedBatch(hardwareBatch, gpu = state.gpuInfo) {
  const recommended = [1, 2, 4, 8].includes(Number(hardwareBatch))
    ? Number(hardwareBatch)
    : 2;
  const remembered = Number(loadSafeBatches()[gpuFingerprint(gpu)] || recommended);
  return Math.min(recommended, [1, 2, 4, 8].includes(remembered) ? remembered : recommended);
}

function batchHintText() {
  if (!state.gpuInfo) {
    return state.batchMode === "auto"
      ? `未读取到显存信息，保守使用 Batch ${state.batch}`
      : `当前为手动设置；自动模式将根据可用显存推荐`;
  }
  const free = (Number(state.gpuInfo.memory_free_mb || 0) / 1024).toFixed(1);
  const total = (Number(state.gpuInfo.memory_total_mb || 0) / 1024).toFixed(1);
  return state.batchMode === "auto"
    ? `${displayGpuName()} · 可用 ${free} / ${total} GB · 自动 Batch ${state.batch}`
    : `当前手动 Batch ${state.batch} · 自动推荐 ${state.recommendedBatch}`;
}

function renderBatchControls() {
  $$("#batch-options button").forEach((button) => {
    const value = button.dataset.batch;
    const active = state.batchMode === "auto"
      ? value === "auto"
      : Number(value) === state.batch;
    button.classList.toggle("active", active);
    button.classList.toggle(
      "recommended",
      state.batchMode === "auto" && Number(value) === state.recommendedBatch,
    );
    if (value === "auto") button.textContent = `自动 ${state.recommendedBatch}`;
  });
  const hint = $("#batch-hint");
  if (hint) hint.textContent = batchHintText();
}

function persistBatchPreference() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    saved = {};
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    ...saved,
    batch_mode: state.batchMode,
    batch_size: state.batch,
  }));
}

function applyGpuRecommendation(event) {
  state.gpuInfo = event.gpu || null;
  state.recommendedBatch = effectiveRecommendedBatch(
    event.recommended_batch || event.batch_size || 2,
    state.gpuInfo,
  );
  if (state.batchMode === "auto") state.batch = state.recommendedBatch;
  renderBatchControls();
}

function updateGpuStatus() {
  setEngineStatus(`${displayGpuName()} · CUDA · Batch ${state.batch}`, "good");
}

function defaultEngineRoot() {
  const localData = process.env.LOCALAPPDATA;
  if (!localData) return "";
  return path.join(localData, "EagleAutoTagger", "engine");
}

function defaultHistoryDbPath() {
  const localData = process.env.LOCALAPPDATA;
  if (!localData) return "";
  return path.join(localData, "EagleAutoTagger", "data", "history.sqlite3");
}

function historyDbPath() {
  return localStorage.getItem(HISTORY_PATH_KEY) || defaultHistoryDbPath();
}

function engineCandidates() {
  const saved = localStorage.getItem("eagle-auto-tagger.engine-root");
  const candidates = [
    saved,
    defaultEngineRoot(),
    path.resolve(eagle.plugin.path, ".."),
  ];
  return [...new Set(candidates.filter(Boolean))];
}

function resolveEngine() {
  const developmentRoot = path.resolve(eagle.plugin.path, "..");
  const developmentEngine = path.join(eagle.plugin.path, "engine");
  const developmentPython = path.join(
    developmentRoot,
    ".venv",
    "Scripts",
    "python.exe",
  );
  const developmentWorker = path.join(developmentEngine, "plugin_engine.py");
  if (fs.existsSync(developmentPython) && fs.existsSync(developmentWorker)) {
    state.engineRoot = developmentEngine;
    return {
      root: developmentEngine,
      python: developmentPython,
      worker: developmentWorker,
    };
  }
  for (const root of engineCandidates()) {
    const python = path.join(root, ".venv", "Scripts", "python.exe");
    const worker = path.join(root, "plugin_engine.py");
    if (fs.existsSync(python) && fs.existsSync(worker)) {
      state.engineRoot = root;
      localStorage.setItem("eagle-auto-tagger.engine-root", root);
      return { root, python, worker };
    }
  }
  return null;
}

function readActiveModelConfig(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  const localConfigPath = path.join(root, "config.local.json");
  const selectionPath = path.join(root, "model-selection.json");
  if (fs.existsSync(localConfigPath)) {
    Object.assign(config, JSON.parse(fs.readFileSync(localConfigPath, "utf8")));
  }
  if (fs.existsSync(selectionPath)) {
    Object.assign(config, JSON.parse(fs.readFileSync(selectionPath, "utf8")));
  }
  return config;
}

function readEngineVersion(root) {
  try {
    return fs.readFileSync(path.join(root, ".engine-version"), "utf8").trim();
  } catch {
    return "";
  }
}

function ensureCurrentEngineFiles() {
  const engine = resolveEngine();
  const bundledRoot = path.resolve(eagle.plugin.path, "engine");
  if (engine && path.resolve(engine.root) === bundledRoot) return engine;
  if (!engine || readEngineVersion(engine.root) === ENGINE_VERSION) return engine;
  copyBundledEngine(engine.root);
  return resolveEngine();
}

function historySettings(configured = settings()) {
  return {
    general_threshold: configured.general_threshold,
    character_threshold: configured.character_threshold,
    max_tags: configured.max_tags,
    include_rating: configured.include_rating,
    filter_graphic_person_tags: configured.filter_graphic_person_tags,
  };
}

function historyRunContext(configured = settings()) {
  const engine = resolveEngine();
  if (!engine) throw new Error("本地 GPU 推理引擎不可用。");
  const config = readActiveModelConfig(engine.root);
  const modelRepo = String(config.model_repo || "").trim();
  const modelRevision = String(config.model_revision || "").trim();
  if (!modelRepo || !modelRevision) throw new Error("无法读取模型版本信息。");
  const recordedSettings = historySettings(configured);
  const signatureSource = JSON.stringify({
    pipeline_version: TAGGING_PIPELINE_VERSION,
    model_repo: modelRepo,
    model_revision: modelRevision,
    settings: recordedSettings,
  });
  return {
    model_repo: modelRepo,
    model_revision: modelRevision,
    settings: recordedSettings,
    signature: crypto.createHash("sha256").update(signatureSource).digest("hex"),
  };
}

function runHistoryCommand(operation, payload = {}, { dbPath = historyDbPath(), timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const engine = resolveEngine();
    if (!engine) {
      reject(new Error("本地 GPU 推理引擎不可用。"));
      return;
    }
    const script = path.join(engine.root, "tag_history.py");
    if (!fs.existsSync(script)) {
      reject(new Error("处理记录组件缺失，请在设置中修复本地引擎。"));
      return;
    }
    if (!dbPath) {
      reject(new Error("无法确定处理记录保存位置。"));
      return;
    }
    const child = spawn(engine.python, [script, "--db", dbPath, operation], {
      cwd: engine.root,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
    });
    let output = "";
    let diagnostics = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error("处理记录响应超时。"));
      }
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { diagnostics += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try {
        const response = JSON.parse(output.trim() || "{}");
        if (code !== 0 || !response.ok) {
          throw new Error(response.error || diagnostics.trim() || `处理记录进程退出代码 ${code}`);
        }
        resolve(response);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(payload), "utf8");
  });
}

async function updateTodoForTagMode({ notify = true } = {}) {
  state.historySkipped = 0;
  state.historyAvailable = true;
  state.historyWarning = "";
  if (state.tagMode !== "merge") {
    state.todo = selectTodoItems(state.items, state.tagMode);
    state.skipped = state.items.length - state.todo.length;
    return;
  }

  state.todo = [...state.items];
  state.skipped = 0;
  if (!state.items.length) return;
  try {
    const context = historyRunContext();
    const result = await runHistoryCommand("filter", {
      signature: context.signature,
      items: state.items.map((item) => ({ id: item.id, tags: item.tags || [] })),
    });
    const pendingIds = new Set(result.pending_ids || []);
    state.todo = state.items.filter((item) => pendingIds.has(item.id));
    state.historySkipped = state.items.length - state.todo.length;
    state.skipped = state.historySkipped;
  } catch (error) {
    state.historyAvailable = false;
    state.historyWarning = error.message;
    state.todo = [...state.items];
    state.skipped = 0;
    if (notify) {
      showToast(`处理记录不可用，本次仍会识别全部图片：${error.message}`, 6500);
    }
  }
}

function appendSetupLog(message) {
  const log = $("#setup-log");
  const text = String(message || "").trim();
  if (!text) return;
  log.textContent += `${log.textContent ? "\n" : ""}${text}`;
  log.scrollTop = log.scrollHeight;
  if (state.setupLogPath) {
    try {
      fs.appendFileSync(state.setupLogPath, `${text}\r\n`, "utf8");
    } catch {
      // The on-screen log must remain usable even when the log directory is read-only.
    }
  }
}

function missingMsvcRuntimeFiles() {
  const windowsRoot = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
  const system32 = path.join(windowsRoot, "System32");
  return ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"].filter(
    (filename) => !fs.existsSync(path.join(system32, filename)),
  );
}

function formatEngineProbeError(details) {
  const raw = String(details || "推理引擎检查失败").trim();
  const lower = raw.toLocaleLowerCase();
  let guidance = "推理引擎启动失败。";
  if (
    /vcruntime|msvcp|onnxruntime_pybind11_state|dll load failed|动态链接库/.test(lower)
  ) {
    guidance =
      "Microsoft Visual C++ x64 运行库缺失或损坏。请安装最新的 Microsoft Visual C++ v14 Redistributable (x64)，重启 Windows 后再点“修复 / 重新安装引擎”。";
  } else if (
    /driver version is insufficient|cuda driver|nvcuda|cudnn|cublas|error 126/.test(lower)
  ) {
    guidance =
      "NVIDIA 驱动或 CUDA 运行组件未能加载。请更新 NVIDIA Studio / Game Ready 驱动，重启 Windows 后再点“修复 / 重新安装引擎”。";
  } else if (/access is denied|permissionerror|拒绝访问|winerror 5/.test(lower)) {
    guidance =
      "运行文件被权限或安全软件阻止。请允许 Eagle 和 EagleAutoTagger 目录运行本地 Python，然后重新安装引擎。";
  }
  return `${guidance}\n原始错误：${raw}`;
}

function parseWorkerEvents(output) {
  const events = [];
  for (const line of String(output || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Keep non-JSON output available as diagnostics instead of failing the probe parser.
    }
  }
  return events;
}

function copyBundledEngine(targetRoot) {
  const bundledRoot = path.join(eagle.plugin.path, "engine");
  if (!fs.existsSync(path.join(bundledRoot, "plugin_engine.py"))) {
    throw new Error("插件安装包不完整：缺少本地推理引擎文件。");
  }
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const filename of ENGINE_FILES) {
    const source = path.join(bundledRoot, filename);
    if (!fs.existsSync(source)) throw new Error(`插件安装包缺少 ${filename}`);
    fs.copyFileSync(source, path.join(targetRoot, filename));
  }
  fs.writeFileSync(path.join(targetRoot, ".engine-version"), ENGINE_VERSION, "utf8");
}

function runSetupCommand(command, args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const baseRoot = path.dirname(cwd);
    const childEnv = {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      UV_LINK_MODE: "copy",
      UV_NATIVE_TLS: "true",
      UV_HTTP_TIMEOUT: "120",
      UV_CACHE_DIR: path.join(baseRoot, "cache"),
      UV_PYTHON_INSTALL_DIR: path.join(baseRoot, "python"),
      ...extraEnv,
    };
    for (const [key, value] of Object.entries(childEnv)) {
      if (value == null || value === "") delete childEnv[key];
    }
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    state.setupProcess = child;
    let pending = "";
    const consume = (chunk) => {
      pending += chunk;
      const lines = pending.split(/[\r\n]+/);
      pending = lines.pop() || "";
      for (const line of lines.map((value) => value.trim()).filter(Boolean)) appendSetupLog(line);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", reject);
    child.on("close", (code) => {
      state.setupProcess = null;
      if (pending.trim()) appendSetupLog(pending.trim());
      if (code === 0) resolve();
      else reject(new Error(`安装程序退出，代码 ${code}`));
    });
  });
}

function showEngineSetup(repair = false) {
  $("#setup-title").textContent = repair ? "修复本地 GPU 引擎" : "安装本地 GPU 引擎";
  $("#setup-lead").textContent = repair
    ? "将重新创建运行环境，不会删除已经下载的模型。"
    : "只需安装一次。完成后，识别过程始终在这台电脑上运行。";
  $("#install-engine").textContent = repair ? "开始修复" : "开始安装";
  $("#install-engine").disabled = false;
  $("#setup-log-panel").classList.add("hidden");
  showPage("setup");
}

async function installLocalEngine() {
  const button = $("#install-engine");
  button.disabled = true;
  button.textContent = "正在安装…";
  $("#setup-log").textContent = "";
  $("#setup-log-panel").classList.remove("hidden");
  try {
    if (process.platform !== "win32" || process.arch !== "x64") {
      throw new Error("当前版本仅支持 Windows x64。");
    }
    const targetRoot = defaultEngineRoot();
    if (!targetRoot) throw new Error("无法读取 Windows 本地用户目录。");
    const setupLogDirectory = path.join(path.dirname(targetRoot), "logs");
    fs.mkdirSync(setupLogDirectory, { recursive: true });
    state.setupLogPath = path.join(setupLogDirectory, "setup.log");
    fs.writeFileSync(
      state.setupLogPath,
      `ds Eagle Tagger ${ENGINE_VERSION} 安装日志\r\n${new Date().toISOString()}\r\n`,
      "utf8",
    );
    const bundledUv = path.join(eagle.plugin.path, "engine", "tools", "uv.exe");
    if (!fs.existsSync(bundledUv)) throw new Error("插件安装包不完整：缺少环境安装工具。");

    appendSetupLog(`安装位置：${targetRoot}`);
    appendSetupLog(`安装日志：${state.setupLogPath}`);
    const missingRuntime = missingMsvcRuntimeFiles();
    if (missingRuntime.length) {
      appendSetupLog(
        `提示：系统目录未检测到 Microsoft Visual C++ x64 运行库（${missingRuntime.join("、")}）。将继续安装；若最终验证失败，请安装后重试：https://aka.ms/vc14/vc_redist.x64.exe`,
      );
    }
    appendSetupLog("正在准备本地推理文件…");
    copyBundledEngine(targetRoot);

    const venv = path.join(targetRoot, ".venv");
    const python = path.join(venv, "Scripts", "python.exe");
    appendSetupLog("正在准备 Python 3.12 环境…");
    let pythonReady = false;
    let pythonError = null;
    for (const source of PYTHON_INSTALL_SOURCES) {
      appendSetupLog(`尝试 Python 下载源：${source.name}`);
      try {
        fs.rmSync(venv, { recursive: true, force: true });
        await runSetupCommand(
          bundledUv,
          ["venv", "--python", "3.12", venv],
          targetRoot,
          { UV_PYTHON_INSTALL_MIRROR: source.mirror },
        );
        pythonReady = true;
        appendSetupLog(`Python 3.12 已通过${source.name}准备完成。`);
        break;
      } catch (error) {
        pythonError = error;
        appendSetupLog(`${source.name}暂时不可用，自动尝试下一个来源。`);
      }
    }
    if (!pythonReady) throw pythonError || new Error("所有 Python 下载源均不可用。");

    appendSetupLog("正在安装 NVIDIA GPU 推理组件，这一步可能需要几分钟…");
    let dependenciesReady = false;
    let dependenciesError = null;
    for (const source of PYPI_INSTALL_SOURCES) {
      appendSetupLog(`尝试 Python 依赖源：${source.name}`);
      try {
        await runSetupCommand(
          bundledUv,
          [
            "pip",
            "install",
            "--quiet",
            "--python",
            python,
            "--link-mode",
            "copy",
            "--index-url",
            source.index,
            "-r",
            path.join(targetRoot, "requirements-gpu.txt"),
          ],
          targetRoot,
        );
        dependenciesReady = true;
        appendSetupLog(`GPU 推理组件已通过${source.name}安装完成。`);
        break;
      } catch (error) {
        dependenciesError = error;
        appendSetupLog(`${source.name}暂时不可用，保留缓存并自动尝试下一个来源。`);
      }
    }
    if (!dependenciesReady) {
      throw dependenciesError || new Error("所有 Python 依赖下载源均不可用。");
    }

    localStorage.setItem("eagle-auto-tagger.engine-root", targetRoot);
    appendSetupLog("正在验证本地推理引擎…");
    await probeEngine({ notify: false, log: true, throwOnError: true });
    appendSetupLog("安装完成，可以开始使用。");
    state.engineReady = true;
    button.textContent = "安装完成";
    showToast("本地 GPU 引擎安装完成。", 2800);
    await loadFolderList();
    showPage("select");
  } catch (error) {
    appendSetupLog(`安装失败：${error.message}`);
    if (state.setupLogPath) appendSetupLog(`请将安装日志发给维护者：${state.setupLogPath}`);
    setEngineStatus("安装失败", "bad");
    showToast(`安装失败：${error.message}`, 6500);
    button.disabled = false;
    button.textContent = "重试安装";
  }
}

function spawnWorker(args = []) {
  const engine = resolveEngine();
  if (!engine) {
    throw new Error("找不到本地推理引擎，请先完成首次安装或在设置中修复引擎。");
  }
  return spawn(engine.python, [engine.worker, ...args], {
    cwd: engine.root,
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
  });
}

async function probeEngine({ notify = true, log = false, throwOnError = false } = {}) {
  setEngineStatus("正在检查 GPU…", "neutral");
  try {
    const child = spawnWorker(["--probe"]);
    let output = "";
    let diagnostics = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { diagnostics += chunk; });
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("GPU 检查超时"));
      }, 30000);
      child.on("error", reject);
      child.on("close", (exitCode) => { clearTimeout(timeout); resolve(exitCode); });
    });
    const events = parseWorkerEvents(output);
    const event = events.find((item) => item.type === "probe");
    const fatal = events.find((item) => item.type === "fatal");
    if (code !== 0 || !event?.ok) {
      const details =
        diagnostics.trim() ||
        fatal?.error ||
        output.trim() ||
        `推理引擎检查失败（退出代码 ${code}）`;
      throw new Error(formatEngineProbeError(details));
    }
    const gpu = event.provider === "CUDAExecutionProvider";
    if (gpu) {
      applyGpuRecommendation(event);
      updateGpuStatus();
    } else {
      setEngineStatus(event.provider, "neutral");
    }
    state.engineReady = true;
    $("#engine-location").textContent = state.engineRoot || defaultEngineRoot() || "—";
    return true;
  } catch (error) {
    state.engineReady = false;
    setEngineStatus("本地引擎不可用", "bad");
    if (log) appendSetupLog(`验证失败：${error.message}`);
    if (notify) showToast(error.message, 6500);
    if (throwOnError) throw error;
    return false;
  }
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 ** 3) return `${(value / (1024 ** 3)).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / (1024 ** 2)).toFixed(0)} MB`;
  return `${Math.max(0, value).toLocaleString("zh-CN")} B`;
}

function modelCatalogRelease(config, root) {
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, "model-catalog.json"), "utf8"));
    return (catalog.releases || []).find((release) => (
      release.id === config.model_id
      || (
        release.model_repo === config.model_repo
        && release.model_revision === config.model_revision
      )
    ));
  } catch {
    return null;
  }
}

function refreshCurrentModelDisplay() {
  const engine = resolveEngine();
  if (!engine) return;
  try {
    const config = readActiveModelConfig(engine.root);
    const release = modelCatalogRelease(config, engine.root);
    $("#current-model-name").textContent = release?.name || config.model_repo || "WD14";
    $("#current-model-version").textContent = release?.version
      || config.model_version
      || String(config.model_revision || "未知版本").slice(0, 12);
    $("#current-model-revision").textContent = String(config.model_revision || "—").slice(0, 12);
  } catch (error) {
    $("#model-update-status").textContent = `无法读取当前模型：${error.message}`;
  }
}

function runModelUpdater(args, onEvent = () => {}) {
  return new Promise((resolve, reject) => {
    const engine = resolveEngine();
    if (!engine) {
      reject(new Error("本地 GPU 推理引擎不可用。"));
      return;
    }
    const script = path.join(engine.root, "model_update.py");
    if (!fs.existsSync(script)) {
      reject(new Error("模型更新组件缺失，请先修复本地引擎。"));
      return;
    }
    const child = spawn(
      engine.python,
      [script, "--engine-version", ENGINE_VERSION, ...args],
      {
        cwd: engine.root,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    state.modelUpdateProcess = child;
    let diagnostics = "";
    let finalEvent = null;
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { diagnostics += chunk; });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        finalEvent = event;
        onEvent(event);
      } catch {
        diagnostics += `${line}\n`;
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      state.modelUpdateProcess = null;
      if (code === 0 && finalEvent?.ok !== false) resolve(finalEvent);
      else reject(new Error(finalEvent?.error || diagnostics.trim() || `模型更新进程退出代码 ${code}`));
    });
  });
}

function renderModelUpdate(release) {
  const card = $("#model-update-card");
  if (!release) {
    card.classList.add("hidden");
    return;
  }
  const totalBytes = Object.values(release.model_sizes || {}).reduce(
    (sum, value) => sum + Number(value || 0),
    0,
  );
  $("#model-update-title").textContent = `${release.name} · ${release.version}`;
  $("#model-update-notes").textContent = release.notes || "已批准的新模型版本。";
  $("#model-update-size").textContent = `下载约 ${formatFileSize(totalBytes)}`;
  $("#download-model-update").dataset.releaseId = release.id;
  $("#model-update-progress").classList.add("hidden");
  card.classList.remove("hidden");
}

async function checkModelUpdates() {
  const button = $("#check-model-update");
  button.disabled = true;
  button.textContent = "正在检查…";
  $("#model-update-status").textContent = "正在读取批准模型清单…";
  renderModelUpdate(null);
  try {
    const event = await runModelUpdater(["check"]);
    state.modelUpdate = event.update_available ? event.latest : null;
    if (event.plugin_update_required) {
      const required = event.incompatible_latest;
      $("#model-update-status").textContent = `发现 ${required.version}，需要先更新插件。`;
      renderModelUpdate(null);
    } else if (event.update_available) {
      $("#model-update-status").textContent = "发现经过批准的新模型版本。";
      renderModelUpdate(event.latest);
    } else if (event.online_configured && !event.online_checked) {
      $("#model-update-status").textContent = "在线更新源暂时无法连接，未更改当前模型。";
    } else if (!event.online_configured) {
      $("#model-update-status").textContent = "当前已是最新的内置稳定模型；在线更新服务将在发布后启用。";
    } else {
      $("#model-update-status").textContent = "当前已是最新批准版本。";
    }
    if (event.warnings?.length) console.warn("Model catalog warnings", event.warnings);
  } catch (error) {
    $("#model-update-status").textContent = `检查失败：${error.message}`;
    showToast(`模型更新检查失败：${error.message}`, 6500);
  } finally {
    button.disabled = false;
    button.textContent = "检查模型更新";
  }
}

function updateModelDownloadProgress(event) {
  if (event.type === "model_update_status") {
    $("#model-update-status").textContent = event.message;
    return;
  }
  if (event.type !== "model_update_download") return;
  const downloaded = Number(event.downloaded_bytes || 0);
  const total = Number(event.total_bytes || 0);
  const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
  const filename = event.filename === "model.onnx" ? "模型文件" : "标签表";
  $("#model-update-progress").classList.remove("hidden");
  $("#model-update-progress-label").textContent = `${filename} ${percent}% · ${formatFileSize(downloaded)} / ${formatFileSize(total)}`;
  $("#model-update-progress-fill").style.width = `${percent}%`;
}

async function installModelUpdate() {
  const release = state.modelUpdate;
  if (!release) return;
  const totalBytes = Object.values(release.model_sizes || {}).reduce(
    (sum, value) => sum + Number(value || 0),
    0,
  );
  const answer = await eagle.dialog.showMessageBox({
    type: "question",
    title: "更新 WD14 模型",
    message: `安装 ${release.name} · ${release.version}？`,
    detail: `需要下载约 ${formatFileSize(totalBytes)}。下载和校验完成后才会切换，旧版本会暂时保留。`,
    buttons: ["下载并更新", "取消"],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer.response !== 0) return;

  const button = $("#download-model-update");
  button.disabled = true;
  button.textContent = "正在更新…";
  $("#check-model-update").disabled = true;
  $("#model-update-progress-fill").style.width = "0%";
  try {
    await runModelUpdater(["install", release.id], updateModelDownloadProgress);
    state.modelUpdate = null;
    refreshCurrentModelDisplay();
    $("#model-update-status").textContent = "模型更新完成，新任务将使用新版本。";
    $("#model-update-card").classList.add("hidden");
    if (state.items.length) {
      await updateTodoForTagMode({ notify: false });
      renderSelection();
    }
    showToast("WD14 模型更新完成。", 3200);
  } catch (error) {
    $("#model-update-status").textContent = `更新失败：${error.message}`;
    showToast(`模型更新失败：${error.message}`, 6500);
  } finally {
    button.disabled = false;
    button.textContent = "下载并更新";
    $("#check-model-update").disabled = false;
  }
}

function updateLocalModelImportProgress(event) {
  if (event.type === "model_update_status") {
    $("#model-update-status").textContent = event.message;
    return;
  }
  if (event.type !== "model_update_import") return;
  const copied = Number(event.copied_bytes || 0);
  const total = Number(event.total_bytes || 0);
  const percent = total > 0 ? Math.min(100, Math.round((copied / total) * 100)) : 0;
  const filename = event.filename === "model.onnx" ? "模型文件" : "标签表";
  $("#model-update-progress").classList.remove("hidden");
  $("#model-update-progress-label").textContent = `${filename} ${percent}% · ${formatFileSize(copied)} / ${formatFileSize(total)}`;
  $("#model-update-progress-fill").style.width = `${percent}%`;
}

async function importLocalModel() {
  const engine = resolveEngine();
  if (!engine) {
    showToast("请先安装本地 GPU 引擎。", 4200);
    return;
  }
  try {
    const result = await eagle.dialog.showOpenDialog({
      title: "选择 WD14 本地模型文件",
      buttonLabel: "校验并导入",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "WD14 模型文件", extensions: ["onnx", "csv"] },
      ],
    });
    if (result.canceled || !result.filePaths?.length) return;
    const modelFiles = result.filePaths.filter(
      (filePath) => path.extname(filePath).toLowerCase() === ".onnx",
    );
    const tagFiles = result.filePaths.filter(
      (filePath) => path.extname(filePath).toLowerCase() === ".csv",
    );
    if (modelFiles.length !== 1 || tagFiles.length !== 1) {
      throw new Error("请同时选择一个 .onnx 模型文件和一个 .csv 标签表。");
    }

    const answer = await eagle.dialog.showMessageBox({
      type: "question",
      title: "导入本地 WD14 模型",
      message: "校验并导入所选模型文件？",
      detail: "插件会检查固定大小和 SHA-256；只有两个文件都与当前批准版本一致时才会启用。",
      buttons: ["开始导入", "取消"],
      defaultId: 0,
      cancelId: 1,
    });
    if (answer.response !== 0) return;

    const importButton = $("#import-local-model");
    const updateButton = $("#check-model-update");
    importButton.disabled = true;
    importButton.textContent = "正在导入…";
    updateButton.disabled = true;
    $("#model-update-progress-fill").style.width = "0%";
    $("#model-update-progress").classList.remove("hidden");
    $("#model-update-status").textContent = "正在校验本地模型文件…";
    try {
      await runModelUpdater(
        ["import-local", modelFiles[0], tagFiles[0]],
        updateLocalModelImportProgress,
      );
      refreshCurrentModelDisplay();
      $("#model-update-status").textContent = "本地模型已通过校验并导入，后续无需联网下载。";
      $("#model-update-progress-label").textContent = "本地模型导入完成";
      $("#model-update-progress-fill").style.width = "100%";
      if (state.items.length) {
        await updateTodoForTagMode({ notify: false });
        renderSelection();
      }
      showToast("本地 WD14 模型已导入。", 3200);
    } finally {
      importButton.disabled = false;
      importButton.textContent = "导入本地模型";
      updateButton.disabled = false;
    }
  } catch (error) {
    $("#model-update-status").textContent = `本地模型导入失败：${error.message}`;
    showToast(`本地模型导入失败：${error.message}`, 6500);
  }
}

async function refreshHistoryStatus({ notify = false } = {}) {
  const pathNode = $("#history-location");
  const statusNode = $("#history-status");
  if (pathNode) pathNode.textContent = historyDbPath() || "—";
  if (statusNode) statusNode.textContent = "正在检查处理记录…";
  try {
    const result = await runHistoryCommand("status");
    if (statusNode) statusNode.textContent = `已记录 ${Number(result.count || 0).toLocaleString("zh-CN")} 张图片`;
    return result;
  } catch (error) {
    if (statusNode) statusNode.textContent = `当前不可用：${error.message}`;
    if (notify) showToast(`处理记录不可用：${error.message}`, 6500);
    return null;
  }
}

async function switchHistoryDatabase(targetDb) {
  const target = path.resolve(targetDb);
  const current = historyDbPath() ? path.resolve(historyDbPath()) : "";
  if (target === current) {
    await refreshHistoryStatus({ notify: true });
    return false;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  let removeOldAfterSwitch = false;
  let expectedCount = null;
  if (fs.existsSync(target)) {
    const answer = await eagle.dialog.showMessageBox({
      type: "question",
      title: "切换处理记录位置",
      message: "所选位置已有处理记录库，是否直接使用？",
      detail: target,
      buttons: ["使用此记录库", "取消"],
      defaultId: 0,
      cancelId: 1,
    });
    if (answer.response !== 0) return false;
  } else if (current && fs.existsSync(current)) {
    const currentStatus = await runHistoryCommand("status", {}, { dbPath: current });
    if (currentStatus.integrity !== "ok") {
      throw new Error(`旧处理记录未通过完整性检查：${currentStatus.integrity}`);
    }
    const answer = await eagle.dialog.showMessageBox({
      type: "question",
      title: "更改处理记录位置",
      message: "如何处理现有记录？",
      detail: "“迁移”会在新文件校验成功后删除旧文件；“复制”会保留旧文件作为备份。",
      buttons: ["迁移到新位置", "复制并保留备份", "使用空记录库", "取消"],
      defaultId: 0,
      cancelId: 3,
    });
    if (answer.response === 3) return false;
    if (answer.response === 0 || answer.response === 1) {
      fs.copyFileSync(current, target);
      expectedCount = Number(currentStatus.count || 0);
      removeOldAfterSwitch = answer.response === 0;
    }
  }

  const targetStatus = await runHistoryCommand("status", {}, { dbPath: target });
  if (targetStatus.integrity !== "ok") {
    throw new Error(`新处理记录未通过完整性检查：${targetStatus.integrity}`);
  }
  if (expectedCount != null && Number(targetStatus.count || 0) !== expectedCount) {
    throw new Error(`迁移校验失败：原记录 ${expectedCount} 条，新记录 ${targetStatus.count} 条。`);
  }
  localStorage.setItem(HISTORY_PATH_KEY, target);
  let cleanupWarning = "";
  if (removeOldAfterSwitch) {
    try {
      fs.unlinkSync(current);
    } catch (error) {
      cleanupWarning = error.message;
    }
  }
  await refreshHistoryStatus();
  if (state.items.length && state.tagMode === "merge") {
    await updateTodoForTagMode({ notify: false });
    renderSelection();
  }
  showToast(cleanupWarning
    ? `已切换到新位置，但旧文件删除失败：${cleanupWarning}`
    : (removeOldAfterSwitch ? "处理记录已迁移，旧文件已删除。" : "处理记录位置已更新。"),
  cleanupWarning ? 6500 : 2800);
  return true;
}

async function chooseHistoryLocation() {
  try {
    const result = await eagle.dialog.showOpenDialog({
      title: "选择处理记录保存位置",
      defaultPath: path.dirname(historyDbPath() || defaultHistoryDbPath()),
      buttonLabel: "使用此文件夹",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths?.length) return;
    const target = path.join(result.filePaths[0], "EagleAutoTagger", "history.sqlite3");
    await switchHistoryDatabase(target);
  } catch (error) {
    showToast(`无法更改处理记录位置：${error.message}`, 6500);
  }
}

async function resetHistoryLocation() {
  try {
    const target = defaultHistoryDbPath();
    if (!target) throw new Error("无法读取 Windows 本地用户目录。");
    await switchHistoryDatabase(target);
  } catch (error) {
    showToast(`无法恢复默认位置：${error.message}`, 6500);
  }
}

function uniqueImages(items) {
  const map = new Map();
  for (const item of items || []) {
    const ext = String(item.ext || "").toLowerCase();
    if (!item.id || item.isDeleted || !IMAGE_EXTS.has(ext)) continue;
    if (!map.has(item.id)) map.set(item.id, item);
  }
  return [...map.values()];
}

async function queryImageItems(options = {}) {
  const groups = await Promise.all(
    [...IMAGE_EXTS].map((ext) => eagle.item.get({ ...options, ext }))
  );
  return uniqueImages(groups.flat());
}

async function queryFolderImageItems(folderIds) {
  const collected = [];
  const concurrency = 4;
  for (let start = 0; start < folderIds.length; start += concurrency) {
    const batch = folderIds.slice(start, start + concurrency);
    const groups = await Promise.all(
      batch.map((folderId) => queryImageItems({ folders: [folderId] }))
    );
    collected.push(...groups.flat());
  }
  return uniqueImages(collected);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestLocalApi(method, endpoint, payload = null, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const bodyToSend = payload == null ? "" : JSON.stringify(payload);
    const request = http.request({
      hostname: "127.0.0.1",
      port: 41595,
      path: endpoint,
      method,
      timeout,
      headers: bodyToSend ? {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(bodyToSend),
      } : {},
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(`本地接口返回 HTTP ${response.statusCode}`);
          }
          const result = JSON.parse(body);
          if (result.status !== "success") {
            throw new Error("本地接口返回了无法识别的数据");
          }
          resolve(result.data);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("本地接口连接超时")));
    request.on("error", reject);
    if (bodyToSend) request.write(bodyToSend);
    request.end();
  });
}

async function loadFoldersFromLocalApi() {
  const folders = await requestLocalApi("GET", "/api/folder/list");
  if (!Array.isArray(folders)) throw new Error("本地接口返回了无效文件夹列表");
  return folders;
}

async function getLocalItem(itemId) {
  const item = await requestLocalApi("GET", `/api/item/info?id=${encodeURIComponent(itemId)}`);
  if (!item?.id) throw new Error("无法读取项目当前状态");
  return item;
}

async function updateLocalItemTags(itemId, tags) {
  await requestLocalApi("POST", "/api/item/update", { id: itemId, tags });
}

async function getAllFoldersWithFallback() {
  let pluginError = null;
  if (typeof eagle.folder?.getAll === "function") {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const folders = await eagle.folder.getAll();
        if (Array.isArray(folders) && folders.length) return folders;
      } catch (error) {
        pluginError = error;
      }
      await delay(450);
    }
  }

  try {
    const folders = await loadFoldersFromLocalApi();
    if (folders.length) return folders;
    throw new Error("本地接口返回了空文件夹列表");
  } catch (error) {
    if (pluginError) throw new Error(`${pluginError.message}；备用接口：${error.message}`);
    throw error;
  }
}

function folderParentId(folder, fallback = null) {
  if (typeof folder?.parent === "string") return folder.parent;
  if (folder?.parent?.id) return folder.parent.id;
  if (typeof folder?.parentId === "string") return folder.parentId;
  return fallback;
}

function flattenFolderTree(folders) {
  const entries = new Map();
  let order = 0;

  function collect(folder, inheritedParentId = null) {
    if (!folder?.id) return;
    const parentId = folderParentId(folder, inheritedParentId);
    const existing = entries.get(folder.id);
    if (!existing) {
      entries.set(folder.id, {
        id: folder.id,
        name: folder.name || folder.id,
        parentId,
        source: folder,
        order: order++,
      });
    } else if (!existing.parentId && parentId) {
      existing.parentId = parentId;
    }
    for (const child of folder.children || []) collect(child, folder.id);
  }

  for (const folder of folders || []) collect(folder);

  function lineage(entry, visited = new Set()) {
    if (entry.lineage) return entry.lineage;
    if (!entry.parentId || visited.has(entry.id)) return [entry.name];
    const parent = entries.get(entry.parentId);
    if (!parent) return [entry.name];
    visited.add(entry.id);
    return [...lineage(parent, visited), entry.name];
  }

  const childIdsByParent = new Map();
  for (const entry of entries.values()) {
    if (!entry.parentId || !entries.has(entry.parentId)) continue;
    if (!childIdsByParent.has(entry.parentId)) childIdsByParent.set(entry.parentId, []);
    childIdsByParent.get(entry.parentId).push(entry.id);
  }

  const descendantMemo = new Map();
  function descendantIds(folderId, ancestors = new Set()) {
    if (descendantMemo.has(folderId)) return descendantMemo.get(folderId);
    if (ancestors.has(folderId)) return [];
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(folderId);
    const result = [];
    for (const childId of childIdsByParent.get(folderId) || []) {
      if (nextAncestors.has(childId)) continue;
      result.push(childId, ...descendantIds(childId, nextAncestors));
    }
    const unique = [...new Set(result)];
    descendantMemo.set(folderId, unique);
    return unique;
  }

  return [...entries.values()]
    .sort((left, right) => left.order - right.order)
    .map((entry) => {
      const parts = lineage(entry);
      return {
        ...entry.source,
        id: entry.id,
        name: entry.name,
        depth: parts.length - 1,
        path: parts.join(" / "),
        descendantIds: descendantIds(entry.id),
      };
    });
}

function resetScopeResults() {
  state.items = [];
  state.todo = [];
  state.skipped = 0;
  state.historySkipped = 0;
  state.historyWarning = "";
  state.folders = [];
}

function resetNewTaskState() {
  state.selectedFolderIds.clear();
  state.folderSearch = "";
  resetScopeResults();
  state.scopeTitle = state.scope === "folder" ? "尚未选择文件夹" : "尚未读取";
  state.stopped = false;
  state.written = 0;
  state.previewed = 0;
  state.failures = [];
  state.writeSkipped = 0;
  state.historyRecords = [];
  state.historyContext = null;
  state.engineDone = null;
}

function updateFolderSelectionUI() {
  const count = state.selectedFolderIds.size;
  $("#selected-folder-count").textContent = `已选择 ${count.toLocaleString("zh-CN")} 个文件夹`;
  $("#confirm-folders").disabled = count === 0;
}

function updateDescendantButtons() {
  const foldersById = new Map(state.allFolders.map((folder) => [folder.id, folder]));
  $$(".folder-descendants-button").forEach((button) => {
    const folder = foldersById.get(button.dataset.folderId);
    if (!folder) return;
    const allSelected = [folder.id, ...folder.descendantIds]
      .every((id) => state.selectedFolderIds.has(id));
    button.textContent = allSelected
      ? `已含子级 ${folder.descendantIds.length}`
      : `含子级 ${folder.descendantIds.length}`;
    button.disabled = allSelected;
  });
}

function removeSelectedFolder(folderId) {
  if (!state.selectedFolderIds.delete(folderId)) return;
  resetScopeResults();
  state.scopeTitle = state.selectedFolderIds.size
    ? `已勾选 ${state.selectedFolderIds.size} 个文件夹（尚未统计）`
    : "尚未选择文件夹";
  renderFolderList();
  renderSelection();
}

function selectFolderAndDescendants(folder) {
  const ids = [folder.id, ...(folder.descendantIds || [])];
  let added = 0;
  for (const id of ids) {
    if (!state.selectedFolderIds.has(id)) added += 1;
    state.selectedFolderIds.add(id);
  }
  resetScopeResults();
  state.scopeTitle = `已勾选 ${state.selectedFolderIds.size} 个文件夹（尚未统计）`;
  renderFolderList();
  renderSelection();
  showToast(
    added
      ? `已选择“${folder.name}”及其 ${folder.descendantIds.length} 个子文件夹。`
      : `“${folder.name}”及其子文件夹均已选中。`,
    3000,
  );
}

function renderFolderList() {
  const list = $("#folder-list");
  list.innerHTML = "";
  const query = state.folderSearch.trim().toLocaleLowerCase("zh-CN");
  const visible = query
    ? state.allFolders.filter((folder) => folder.path.toLocaleLowerCase("zh-CN").includes(query))
    : state.allFolders;

  $("#folder-list-status").textContent = query
    ? `找到 ${visible.length.toLocaleString("zh-CN")} / ${state.allFolders.length.toLocaleString("zh-CN")} 个文件夹`
    : `共 ${state.allFolders.length.toLocaleString("zh-CN")} 个文件夹`;

  if (!visible.length) {
    const message = document.createElement("div");
    message.className = "folder-list-message";
    message.textContent = state.allFolders.length ? "没有符合搜索条件的文件夹。" : "当前图库没有可用文件夹。";
    list.appendChild(message);
    updateFolderSelectionUI();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const folder of visible) {
    const row = document.createElement("div");
    const main = document.createElement("label");
    const checkbox = document.createElement("input");
    const name = document.createElement("span");
    const parentPath = document.createElement("span");
    const selected = state.selectedFolderIds.has(folder.id);

    row.className = `folder-row${selected ? " selected" : ""}`;
    row.style.paddingLeft = `${12 + Math.min(folder.depth, 12) * 18}px`;
    row.title = folder.path;
    main.className = "folder-row-main";
    checkbox.type = "checkbox";
    checkbox.checked = selected;
    checkbox.dataset.folderId = folder.id;
    name.className = "folder-row-name";
    name.textContent = folder.name;
    parentPath.className = "folder-row-path";
    parentPath.textContent = query && folder.depth ? folder.path.slice(0, -(folder.name.length + 3)) : "";

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedFolderIds.add(folder.id);
      else state.selectedFolderIds.delete(folder.id);
      row.classList.toggle("selected", checkbox.checked);
      resetScopeResults();
      state.scopeTitle = state.selectedFolderIds.size
        ? `已勾选 ${state.selectedFolderIds.size} 个文件夹（尚未统计）`
        : "尚未选择文件夹";
      updateFolderSelectionUI();
      updateDescendantButtons();
      renderSelection();
    });

    main.append(checkbox, name, parentPath);
    row.appendChild(main);
    if (folder.descendantIds.length) {
      const includeChildren = document.createElement("button");
      const selectionIds = [folder.id, ...folder.descendantIds];
      const allSelected = selectionIds.every((id) => state.selectedFolderIds.has(id));
      includeChildren.type = "button";
      includeChildren.className = "folder-descendants-button";
      includeChildren.dataset.folderId = folder.id;
      includeChildren.textContent = allSelected
        ? `已含子级 ${folder.descendantIds.length}`
        : `含子级 ${folder.descendantIds.length}`;
      includeChildren.title = `选中“${folder.name}”及其全部 ${folder.descendantIds.length} 个子文件夹`;
      includeChildren.disabled = allSelected;
      includeChildren.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectFolderAndDescendants(folder);
      });
      row.appendChild(includeChildren);
    }
    fragment.appendChild(row);
  }
  list.appendChild(fragment);
  updateFolderSelectionUI();
}

async function loadFolderList() {
  $("#folder-list-status").textContent = "正在读取文件夹列表…";
  $("#refresh-folders").disabled = true;
  try {
    state.allFolders = flattenFolderTree(await getAllFoldersWithFallback());
    const knownIds = new Set(state.allFolders.map((folder) => folder.id));
    state.selectedFolderIds = new Set([...state.selectedFolderIds].filter((id) => knownIds.has(id)));
    renderFolderList();
    if (!state.allFolders.length) throw new Error("当前图库返回了空文件夹列表");
  } catch (error) {
    state.allFolders = [];
    state.selectedFolderIds.clear();
    renderFolderList();
    $("#folder-list-status").textContent = "文件夹列表读取失败";
    showToast(`无法读取 Eagle 文件夹：${error.message}`, 6500);
  } finally {
    $("#refresh-folders").disabled = false;
  }
}

function updateScopeControls() {
  const folderMode = state.scope === "folder";
  $(".summary-head").classList.toggle("hidden", folderMode);
  $("#folder-picker").classList.toggle("hidden", !folderMode);
  $("#folder-selection-summary").classList.toggle("hidden", !folderMode);
  $("#scan-button").classList.toggle("hidden", folderMode);
  $("#selection-empty").textContent = folderMode
    ? "确认并统计后显示图片数量。"
    : "点击上方按钮读取图片范围。";
}

async function selectCurrentEagleFolders() {
  try {
    if (!state.allFolders.length) await loadFolderList();
    if (!state.allFolders.length) throw new Error("文件夹列表仍为空，请确认 Eagle 本地接口可用。");
    const current = await eagle.folder.getSelected();
    if (!current.length) throw new Error("Eagle 当前没有选中文件夹。");
    const knownIds = new Set(state.allFolders.map((folder) => folder.id));
    let added = 0;
    let matched = 0;
    for (const folder of current) {
      if (knownIds.has(folder.id)) matched += 1;
      if (knownIds.has(folder.id) && !state.selectedFolderIds.has(folder.id)) added += 1;
      if (knownIds.has(folder.id)) state.selectedFolderIds.add(folder.id);
    }
    if (!matched) throw new Error("Eagle 当前文件夹不在已读取的列表中，请点击“刷新列表”。");
    resetScopeResults();
    state.scopeTitle = `已勾选 ${state.selectedFolderIds.size} 个文件夹（尚未统计）`;
    renderFolderList();
    renderSelection();
    showToast(added ? `已加入 ${added} 个 Eagle 当前文件夹。` : "当前文件夹已在勾选列表中。", 2600);
  } catch (error) {
    showToast(error.message, 4200);
  }
}

async function readScope() {
  const readingScope = state.scope;
  const button = readingScope === "folder" ? $("#confirm-folders") : $("#scan-button");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = readingScope === "folder" ? "正在统计…" : "正在读取…";
  $$(".scope-card").forEach((card) => { card.disabled = true; });
  try {
    let rawItems = [];
    state.folders = [];
    if (readingScope === "folder") {
      if (!state.selectedFolderIds.size) throw new Error("请先在列表中勾选一个或多个文件夹。");
      state.folders = state.allFolders.filter((folder) => state.selectedFolderIds.has(folder.id));
      if (!state.folders.length) throw new Error("勾选的文件夹已不可用，请刷新插件后重试。");
      rawItems = await queryFolderImageItems(state.folders.map((folder) => folder.id));
      state.scopeTitle = state.folders.length === 1
        ? state.folders[0].name
        : `${state.folders.length} 个已勾选文件夹`;
    } else if (readingScope === "selected") {
      rawItems = await eagle.item.getSelected();
      if (!rawItems.length) throw new Error("请先在 Eagle 中选中一张或多张图片。 ");
      state.scopeTitle = "当前选中的图片";
    } else {
      rawItems = await queryImageItems();
      state.scopeTitle = "整个 Eagle 图库";
    }

    state.items = uniqueImages(rawItems);
    await updateTodoForTagMode();
    renderSelection();
    if (!state.todo.length) {
      const message = state.tagMode === "merge"
        ? "当前范围在相同模型和设置下已经处理完成。"
        : "当前范围没有需要处理的未标签图片。";
      showToast(message, 4800);
    }
  } catch (error) {
    state.items = [];
    state.todo = [];
    state.skipped = 0;
    state.historySkipped = 0;
    renderSelection();
    showToast(error.message, 5200);
  } finally {
    $$(".scope-card").forEach((card) => { card.disabled = false; });
    button.disabled = readingScope === "folder" && state.selectedFolderIds.size === 0;
    button.textContent = readingScope === "folder" ? "确认并统计" : "重新读取 Eagle 当前选择";
    if (!button.textContent) button.textContent = originalText;
  }
}

function renderSelection() {
  $("#scope-title").textContent = state.scopeTitle;
  $("#total-count").textContent = state.items.length.toLocaleString("zh-CN");
  $("#todo-count").textContent = state.todo.length.toLocaleString("zh-CN");
  const taggedCount = state.items.filter((item) => Array.isArray(item.tags) && item.tags.length > 0).length;
  const displayedSkipped = state.tagMode === "merge" ? state.historySkipped : taggedCount;
  $("#skip-count").textContent = displayedSkipped.toLocaleString("zh-CN");
  $("#todo-count-label").textContent = state.tagMode === "merge" ? "待识别图片" : "待处理未标签";
  $("#tagged-count-label").textContent = state.tagMode === "merge" ? "同设置已处理" : "已有标签跳过";
  $("#selection-empty").classList.toggle("hidden", state.items.length > 0);
  $("#selection-stats").classList.toggle("hidden", state.items.length === 0);
  $("#to-confirm").disabled = state.todo.length === 0;
  const chips = $("#folder-chips");
  chips.innerHTML = "";
  if (state.scope === "folder") {
    const selectedFolders = state.allFolders.filter((folder) => state.selectedFolderIds.has(folder.id));
    for (const folder of selectedFolders) {
      const chip = document.createElement("span");
      const name = document.createElement("span");
      const remove = document.createElement("button");
      chip.className = "chip removable-chip";
      name.textContent = `▣ ${folder.name}`;
      remove.type = "button";
      remove.className = "chip-remove";
      remove.title = `取消选择 ${folder.name}`;
      remove.setAttribute("aria-label", `取消选择 ${folder.name}`);
      remove.addEventListener("click", () => removeSelectedFolder(folder.id));
      chip.append(name, remove);
      chips.appendChild(chip);
    }
    if (!selectedFolders.length) {
      const empty = document.createElement("span");
      empty.className = "selection-summary-empty";
      empty.textContent = "暂未选择";
      chips.appendChild(empty);
    }
  } else if (state.items.length) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = state.scope === "selected" ? `✓ 已选择 ${state.items.length} 张` : `◇ 图库图片 ${state.items.length} 张`;
    chips.appendChild(chip);
  }
}

function renderConfirmation() {
  $("#confirm-scope").textContent = state.scopeTitle;
  $("#confirm-count").textContent = `${state.todo.length.toLocaleString("zh-CN")} 张`;
  $("#confirm-batch").textContent = state.batchMode === "auto"
    ? `自动 · ${state.batch} 张/批`
    : `手动 · ${state.batch} 张/批`;
  $("#confirm-tag-mode").textContent = state.tagMode === "merge"
    ? `保留原标签并追加；已记录跳过 ${state.historySkipped.toLocaleString("zh-CN")} 张`
    : "已有标签自动跳过，不覆盖";
}

function settings() {
  return {
    batch_size: state.batch,
    batch_mode: state.batchMode,
    general_threshold: Number($("#general-threshold").value),
    character_threshold: Number($("#character-threshold").value),
    max_tags: Number($("#max-tags").value),
    include_rating: $("#include-rating").checked,
    filter_graphic_person_tags: $("#filter-graphic-person-tags").checked,
  };
}

function validateSettings(value) {
  if (!(value.general_threshold >= 0 && value.general_threshold <= 1)) throw new Error("普通标签阈值必须在 0 到 1 之间。");
  if (!(value.character_threshold >= 0 && value.character_threshold <= 1)) throw new Error("角色标签阈值必须在 0 到 1 之间。");
  if (!Number.isInteger(value.max_tags) || value.max_tags < 1) throw new Error("标签上限必须是大于 0 的整数。");
}

async function resolveItemPaths() {
  const resolved = [];
  for (let index = 0; index < state.todo.length; index += 1) {
    let item = state.todo[index];
    if (!item.filePath) item = await eagle.item.getById(item.id);
    resolved.push({ id: item.id, name: item.name || item.id, path: item.filePath });
    if (index > 0 && index % 250 === 0) {
      $("#progress-message").textContent = `正在准备图片路径 ${index} / ${state.todo.length}…`;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return resolved;
}

function updateProgress(event) {
  const total = Number(event.total || state.todo.length || 1);
  const completed = Number(event.completed || 0);
  const percent = Math.min(100, Math.round((completed / total) * 100));
  $("#progress-percent").textContent = `${percent}%`;
  $("#progress-fraction").textContent = `${completed} / ${total}`;
  $("#progress-fill").style.width = `${percent}%`;
  if (event.name) $("#current-item").textContent = event.name;
  if (event.rate) $("#progress-rate").textContent = `${event.rate} 张/秒`;
  if (Number.isFinite(event.eta_seconds)) $("#progress-eta").textContent = formatDuration(event.eta_seconds);
  $("#written-count").textContent = String(state.written + state.previewed);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} 秒`;
  return `约 ${Math.ceil(seconds / 60)} 分钟`;
}

function queueHistoryRecord(itemId, generatedTags) {
  if (!itemId || $("#preview-only").checked) return;
  state.historyRecords.push({
    id: itemId,
    generated_tags: Array.isArray(generatedTags) ? generatedTags : [],
  });
}

async function flushHistoryRecords() {
  if (!state.historyRecords.length || !state.historyContext || $("#preview-only").checked) return;
  const byId = new Map(state.historyRecords.map((record) => [record.id, record]));
  const records = [...byId.values()];
  for (let start = 0; start < records.length; start += 2000) {
    const group = records.slice(start, start + 2000);
    await runHistoryCommand("record", {
      ...state.historyContext,
      records: group,
    });
  }
  appendLog(`处理记录已更新：${records.length} 张`);
}

async function handleEngineEvent(event) {
  if (!event || !event.type) return;
  if (event.type === "status") {
    $("#progress-message").textContent = event.message || "正在准备…";
    appendLog(event.message || event.stage);
  } else if (event.type === "model_download") {
    const downloaded = Number(event.downloaded_bytes) || 0;
    const total = Number(event.total_bytes) || 0;
    const downloadedMb = downloaded / (1024 * 1024);
    const totalMb = total / (1024 * 1024);
    const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
    const displayName = event.filename === "model.onnx" ? "WD14 模型" : "标签表";
    if (event.stage === "checking") {
      $("#progress-message").textContent = `正在校验本地${displayName}…`;
    } else if (event.stage === "connecting") {
      $("#progress-message").textContent = `正在连接模型下载源：${event.source || "自动选择"}`;
    } else if (event.stage === "fallback") {
      $("#progress-message").textContent = `正在使用 Windows 下载通道：${event.source || "备用源"}`;
    } else if (event.stage === "complete") {
      $("#progress-message").textContent = `${displayName}已下载并校验完成`;
    } else {
      $("#progress-message").textContent = `正在下载${displayName}：${percent}%`;
    }
    $("#progress-percent").textContent = `${percent}%`;
    $("#progress-fraction").textContent = total > 0
      ? `${downloadedMb.toFixed(0)} / ${totalMb.toFixed(0)} MB`
      : `${downloadedMb.toFixed(0)} MB`;
    $("#progress-fill").style.width = `${percent}%`;
    $("#current-item").textContent = displayName;
    $("#progress-rate").textContent = event.speed_mbps ? `${event.speed_mbps} MB/秒` : "—";
    if (event.speed_mbps && total > downloaded) {
      $("#progress-eta").textContent = formatDuration((total - downloaded) / (event.speed_mbps * 1024 * 1024));
    } else {
      $("#progress-eta").textContent = "—";
    }
  } else if (event.type === "ready") {
    $("#progress-message").textContent = `模型已就绪：${event.provider}，Batch ${event.batch_size}`;
    appendLog(`模型加载完成，用时 ${event.load_seconds} 秒；${event.provider}`);
    updateProgress({ completed: 0, total: state.todo.length });
    $("#current-item").textContent = "等待识别";
    $("#progress-rate").textContent = "—";
    $("#progress-eta").textContent = "—";
  } else if (event.type === "batch_start") {
    $("#progress-message").textContent = `正在识别第 ${event.batch_index} / ${event.batch_total} 批…`;
    if (event.name) $("#current-item").textContent = event.name;
  } else if (event.type === "batch_adjusted") {
    const nextBatch = Number(event.to_batch || 1);
    state.batch = nextBatch;
    if (event.reason === "oom") {
      rememberSafeBatch(nextBatch);
      state.recommendedBatch = Math.min(state.recommendedBatch, nextBatch);
      persistBatchPreference();
    }
    renderBatchControls();
    if (state.gpuInfo) updateGpuStatus();
    $("#progress-message").textContent = event.message || `Batch 已自动降至 ${nextBatch}`;
    appendLog(event.message || `Batch 已自动降至 ${nextBatch}`);
    showToast(event.message || `Batch 已自动降至 ${nextBatch}`, 4800);
  } else if (event.type === "item_result") {
    if (state.stopped) return;
    try {
      if (Array.isArray(event.filtered_tags) && event.filtered_tags.length) {
        appendLog(`${event.name}: 已过滤图形误判：${event.filtered_tags.join(", ")}`);
      }
      if ($("#preview-only").checked) {
        state.previewed += 1;
        appendLog(`${event.name}: ${event.tags.join(", ")}`);
      } else {
        const current = await getLocalItem(event.id);
        const currentTags = Array.isArray(current.tags) ? current.tags : [];
        const update = planTagUpdate(currentTags, event.tags, state.tagMode);
        if (update.action === "skip-existing") {
          state.writeSkipped += 1;
          appendLog(`${event.name}: 写入前发现已有标签，已安全跳过`);
        } else if (update.action === "skip-no-new") {
          state.writeSkipped += 1;
          queueHistoryRecord(event.id, event.tags);
          appendLog(`${event.name}: 没有新的模型标签，原标签保持不变`);
        } else {
          await updateLocalItemTags(event.id, update.tags);
          state.written += 1;
          queueHistoryRecord(event.id, event.tags);
          appendLog(state.tagMode === "merge"
            ? `${event.name}: 保留 ${update.existingCount} 个原标签，新增 ${update.addedCount} 个模型标签`
            : `${event.name}: 已写入 ${update.addedCount} 个标签`);
        }
      }
    } catch (error) {
      state.failures.push({ id: event.id, name: event.name, error: `Eagle 写入失败：${error.message}` });
      appendLog(`${event.name}: Eagle 写入失败 - ${error.message}`);
    }
    updateProgress(event);
  } else if (event.type === "item_error") {
    state.failures.push({ id: event.id, name: event.name, error: event.error });
    appendLog(`${event.name || event.id}: 推理失败 - ${event.error}`);
    updateProgress(event);
  } else if (event.type === "done") {
    state.engineDone = event;
    appendLog(`GPU 推理完成，共 ${event.total} 张，用时 ${event.elapsed_seconds} 秒`);
  } else if (event.type === "fatal") {
    state.failures.push({ id: "", name: "推理引擎", error: event.error });
    appendLog(`推理引擎错误：${event.error}`);
  }
}

async function startTask() {
  let configured;
  try {
    configured = settings();
    validateSettings(configured);
    if (!resolveEngine()) throw new Error("本地 GPU 推理引擎不可用。");
    state.historyContext = historyRunContext(configured);
  } catch (error) {
    showToast(error.message, 5200);
    return;
  }

  state.stopped = false;
  state.written = 0;
  state.previewed = 0;
  state.failures = [];
  state.writeSkipped = 0;
  state.historyRecords = [];
  state.historyWarning = "";
  state.engineDone = null;
  $("#live-log").textContent = "任务已确认。";
  updateProgress({ completed: 0, total: state.todo.length });
  showPage("progress");

  try {
    const items = await resolveItemPaths();
    const child = spawnWorker();
    state.engineProcess = child;
    let chain = Promise.resolve();
    let stderrBuffer = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";
      for (const line of lines.filter(Boolean)) appendLog(line);
    });

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      chain = chain.then(async () => {
        try {
          await handleEngineEvent(JSON.parse(line));
        } catch (error) {
          state.failures.push({ id: "", name: "事件处理", error: error.message });
          appendLog(`无法处理引擎消息：${error.message}`);
        }
      });
    });

    child.on("error", (error) => {
      state.failures.push({ id: "", name: "启动引擎", error: error.message });
      appendLog(`无法启动推理引擎：${error.message}`);
    });
    child.on("close", async (code) => {
      if (stderrBuffer.trim()) appendLog(stderrBuffer.trim());
      await chain;
      state.engineProcess = null;
      if (code !== 0 && !state.stopped && !state.failures.length) {
        state.failures.push({ id: "", name: "推理引擎", error: `进程退出代码 ${code}` });
      }
      try {
        await flushHistoryRecords();
      } catch (error) {
        state.historyWarning = error.message;
        appendLog(`处理记录未能保存：${error.message}`);
      }
      finishTask();
    });

    child.stdin.end(JSON.stringify({ items, settings: configured }), "utf8");
  } catch (error) {
    state.failures.push({ id: "", name: "任务准备", error: error.message });
    appendLog(`任务准备失败：${error.message}`);
    finishTask();
  }
}

function finishTask() {
  const preview = $("#preview-only").checked;
  $("#result-title").textContent = state.stopped ? "任务已停止" : (state.failures.length ? "任务完成，但有失败项目" : "处理完成");
  $("#result-message").textContent = preview
    ? "本次为预览模式，没有修改 Eagle 标签。"
    : (state.historyWarning
      ? `标签已写回 Eagle，但处理记录未能保存：${state.historyWarning}`
      : "已完成的标签已安全写回 Eagle，处理状态也已记录。");
  $("#result-success").textContent = String(preview ? state.previewed : state.written);
  $("#result-skipped").textContent = String(state.skipped + state.writeSkipped);
  $("#result-failed").textContent = String(state.failures.length);

  const list = $("#failure-list");
  list.innerHTML = "";
  list.classList.toggle("hidden", state.failures.length === 0);
  if (state.failures.some((failure) => failure.id)) {
    const hint = document.createElement("div");
    hint.className = "failure-list-hint";
    hint.textContent = "点击任意失败项目，可在 Eagle 中单独定位";
    list.appendChild(hint);
  }
  for (const failure of state.failures) {
    const row = document.createElement(failure.id ? "button" : "div");
    row.className = `failure-item${failure.id ? " clickable" : ""}`;
    if (failure.id) row.type = "button";
    const title = document.createElement("strong");
    const message = document.createElement("span");
    const locate = document.createElement("span");
    title.textContent = failure.name || failure.id || "未知项目";
    message.textContent = failure.error;
    row.append(title, message);
    if (failure.id) {
      locate.className = "failure-locate";
      locate.textContent = "在 Eagle 中查看 →";
      row.appendChild(locate);
      row.title = `在 Eagle 中定位：${failure.name || failure.id}`;
      row.addEventListener("click", async () => {
        row.disabled = true;
        row.classList.add("locating");
        locate.textContent = "正在定位…";
        try {
          await locateItemInEagle(failure.id);
          locate.textContent = "已定位 ✓";
          showToast(`已在 Eagle 中定位：${failure.name || failure.id}`, 2600);
        } catch (error) {
          locate.textContent = "定位失败";
          showToast(`无法定位该图片：${error.message}`, 5200);
        } finally {
          row.disabled = false;
          row.classList.remove("locating");
        }
      });
    }
    list.appendChild(row);
  }
  const canSelect = state.failures.some((failure) => failure.id);
  $("#select-failures").classList.toggle("hidden", !canSelect);
  showPage("result");
}

function stopTask() {
  if (!state.engineProcess) return;
  state.stopped = true;
  appendLog("用户请求停止任务，正在关闭后台引擎…");
  state.engineProcess.kill();
  $("#stop-button").disabled = true;
  $("#stop-button").textContent = "正在停止…";
}

async function locateItemInEagle(itemId) {
  if (!itemId) throw new Error("该失败记录没有对应的 Eagle 项目 ID");
  if (typeof eagle.item.open === "function") {
    await eagle.item.open(itemId);
  } else {
    const item = await eagle.item.getById(itemId);
    if (!item || typeof item.open !== "function") throw new Error("当前 Eagle 版本不支持项目定位");
    await item.open();
  }
  if (typeof eagle.item.select === "function") await eagle.item.select([itemId]);
}

function bindUI() {
  $("#install-engine").addEventListener("click", installLocalEngine);
  $("#repair-engine").addEventListener("click", () => showEngineSetup(true));
  $("#import-local-model").addEventListener("click", importLocalModel);
  $("#check-model-update").addEventListener("click", checkModelUpdates);
  $("#download-model-update").addEventListener("click", installModelUpdate);
  $("#choose-history-location").addEventListener("click", chooseHistoryLocation);
  $("#reset-history-location").addEventListener("click", resetHistoryLocation);
  $$(".scope-card").forEach((card) => card.addEventListener("click", () => {
    state.scope = card.dataset.scope;
    resetScopeResults();
    state.scopeTitle = state.scope === "folder" && state.selectedFolderIds.size
      ? `已勾选 ${state.selectedFolderIds.size} 个文件夹（尚未统计）`
      : "尚未读取";
    $$(".scope-card").forEach((node) => node.classList.toggle("active", node === card));
    updateScopeControls();
    renderSelection();
    $("#scan-button").textContent = "读取 Eagle 当前选择";
  }));
  $("#scan-button").addEventListener("click", readScope);
  $("#confirm-folders").addEventListener("click", readScope);
  $("#folder-search").addEventListener("input", (event) => {
    state.folderSearch = event.target.value;
    renderFolderList();
  });
  $("#pick-current-folders").addEventListener("click", selectCurrentEagleFolders);
  $("#refresh-folders").addEventListener("click", async () => {
    resetScopeResults();
    state.scopeTitle = "正在刷新文件夹列表…";
    renderSelection();
    await loadFolderList();
    state.scopeTitle = state.selectedFolderIds.size
      ? `已勾选 ${state.selectedFolderIds.size} 个文件夹（尚未统计）`
      : "尚未选择文件夹";
    renderSelection();
  });
  $("#clear-folders").addEventListener("click", () => {
    state.selectedFolderIds.clear();
    resetScopeResults();
    state.scopeTitle = "尚未选择文件夹";
    renderFolderList();
    renderSelection();
  });
  $$("#batch-options button").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.batch === "auto") {
      state.batchMode = "auto";
      state.batch = state.recommendedBatch;
    } else {
      state.batchMode = "manual";
      state.batch = Number(button.dataset.batch);
    }
    persistBatchPreference();
    renderBatchControls();
    if (state.gpuInfo) updateGpuStatus();
  }));
  $$("#tag-mode-options button").forEach((button) => button.addEventListener("click", async () => {
    state.tagMode = button.dataset.tagMode === "merge" ? "merge" : "untagged";
    localStorage.setItem("eagle-auto-tagger.tag-mode", state.tagMode);
    $$("#tag-mode-options button").forEach((node) => node.classList.toggle("active", node === button));
    $("#tag-mode-hint").textContent = state.tagMode === "merge"
      ? "保留原标签并追加新标签；相同模型和设置已处理的图片会自动跳过。"
      : "已有标签的图片会自动跳过，不会被修改。";
    $$("#tag-mode-options button").forEach((node) => { node.disabled = true; });
    await updateTodoForTagMode();
    $$("#tag-mode-options button").forEach((node) => { node.disabled = false; });
    renderSelection();
  }));
  $("#to-confirm").addEventListener("click", () => { renderConfirmation(); showPage("confirm"); });
  $$('[data-back="select"]').forEach((button) => button.addEventListener("click", () => showPage("select")));
  $("#start-button").addEventListener("click", startTask);
  $("#stop-button").addEventListener("click", stopTask);
  $("#new-task").addEventListener("click", () => {
    resetNewTaskState();
    $("#folder-search").value = "";
    $("#stop-button").disabled = false;
    $("#stop-button").textContent = "停止任务";
    renderFolderList();
    renderSelection();
    updateScopeControls();
    showPage("select");
  });
  $("#select-failures").addEventListener("click", async () => {
    const ids = state.failures.map((failure) => failure.id).filter(Boolean);
    if (ids.length) await eagle.item.select(ids);
  });
  $("#settings-nav").addEventListener("click", async () => {
    state.pageBeforeSettings = $(".page.active")?.id.replace("page-", "") || "select";
    showPage("settings");
    refreshCurrentModelDisplay();
    await refreshHistoryStatus();
  });
  $("#settings-done").addEventListener("click", async () => {
    try {
      validateSettings(settings());
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        ...settings(),
        preview_only: $("#preview-only").checked,
      }));
      if (state.items.length) {
        await updateTodoForTagMode();
        renderSelection();
      }
      showPage(state.pageBeforeSettings);
      showToast("设置已保存。", 2200);
    } catch (error) {
      showToast(error.message);
    }
  });
  $$(".step").forEach((step) => step.addEventListener("click", () => {
    if (!state.engineReady) {
      showEngineSetup(false);
      return;
    }
    const page = step.dataset.page;
    if (page === "select") showPage("select");
    else if (page === "confirm" && state.todo.length) { renderConfirmation(); showPage("confirm"); }
    else if (page === "progress" && state.engineProcess) showPage("progress");
    else if (page === "result" && (state.engineDone || state.failures.length)) showPage("result");
  }));
}

function loadSavedSettings() {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (value.general_threshold != null) $("#general-threshold").value = value.general_threshold;
    if (value.character_threshold != null) $("#character-threshold").value = value.character_threshold;
    if (value.max_tags != null) $("#max-tags").value = value.max_tags;
    if (value.include_rating != null) $("#include-rating").checked = value.include_rating;
    if (value.filter_graphic_person_tags != null) {
      $("#filter-graphic-person-tags").checked = value.filter_graphic_person_tags;
    }
    if (value.preview_only != null) $("#preview-only").checked = value.preview_only;
    state.batchMode = value.batch_mode === "manual" ? "manual" : "auto";
    if (state.batchMode === "manual" && [1, 2, 4, 8].includes(Number(value.batch_size))) {
      state.batch = Number(value.batch_size);
    }
    renderBatchControls();
    state.tagMode = localStorage.getItem("eagle-auto-tagger.tag-mode") === "merge" ? "merge" : "untagged";
    $$("#tag-mode-options button").forEach((button) => {
      button.classList.toggle("active", button.dataset.tagMode === state.tagMode);
    });
    $("#tag-mode-hint").textContent = state.tagMode === "merge"
      ? "保留原标签并追加新标签；相同模型和设置已处理的图片会自动跳过。"
      : "已有标签的图片会自动跳过，不会被修改。";
  } catch (error) {
    console.warn("Unable to load settings", error);
  }
}

let initialized = false;
async function initialize() {
  if (initialized) return;
  initialized = true;
  bindUI();
  loadSavedSettings();
  updateScopeControls();
  renderSelection();
  $("#engine-location").textContent = defaultEngineRoot() || "—";
  $("#history-location").textContent = historyDbPath() || "—";
  try {
    ensureCurrentEngineFiles();
  } catch (error) {
    console.warn("Unable to update local engine files", error);
  }
  const ready = await probeEngine({ notify: false });
  if (!ready) {
    showEngineSetup(false);
    return;
  }
  refreshCurrentModelDisplay();
  await refreshHistoryStatus();
  await loadFolderList();
}

eagle.onPluginCreate(() => {});
eagle.onPluginRun(initialize);
eagle.onPluginBeforeExit(() => {
  if (state.engineProcess) state.engineProcess.kill();
  if (state.setupProcess) state.setupProcess.kill();
  if (state.modelUpdateProcess) state.modelUpdateProcess.kill();
});

window.addEventListener("DOMContentLoaded", () => {
  setTimeout(initialize, 250);
});
