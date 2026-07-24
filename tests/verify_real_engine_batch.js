"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"]);
const engineRoot = process.argv[2];
const folderId = process.argv[3];
if (!engineRoot || !folderId) {
  throw new Error("usage: node verify_real_engine_batch.js <engine-root> <eagle-folder-id>");
}

function getJson(endpoint) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:41595${endpoint}`, { timeout: 10000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
}

(async () => {
  const listed = await getJson(`/api/item/list?limit=20&offset=0&folders=${encodeURIComponent(folderId)}`);
  const sourceItems = listed.data.filter((item) => IMAGE_EXTS.has(String(item.ext).toLowerCase())).slice(0, 4);
  assert.equal(sourceItems.length, 4);

  const items = [];
  for (const item of sourceItems) {
    const thumbnail = await getJson(`/api/item/thumbnail?id=${encodeURIComponent(item.id)}`);
    items.push({ id: item.id, name: item.name, path: decodeURIComponent(thumbnail.data) });
  }

  const child = spawn(
    path.join(engineRoot, ".venv", "Scripts", "python.exe"),
    [path.join(engineRoot, "plugin_engine.py")],
    { cwd: engineRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const events = [];
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({
    items,
    settings: {
      batch_size: 4,
      general_threshold: 0.35,
      character_threshold: 0.75,
      max_tags: 50,
      include_rating: true,
    },
  }), "utf8");

  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("real engine batch timed out"));
    }, 120000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timeout); resolve(code); });
  });
  for (const line of stdout.trim().split(/\r?\n/).filter(Boolean)) events.push(JSON.parse(line));
  assert.equal(exitCode, 0, stderr);
  assert.ok(events.some((event) => event.type === "batch_start"));
  assert.equal(events.filter((event) => event.type === "item_result").length, 4, stderr);
  assert.ok(events.some((event) => event.type === "done"));
  console.log("real engine batch verified: 4/4 results, no Eagle writes");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
