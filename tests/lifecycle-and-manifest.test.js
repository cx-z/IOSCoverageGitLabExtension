"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FakeDocument } = require("./helpers/fake-dom.js");
const { createController, navigationChanged } = require("../src/content/entry.js");
const urls = require("../src/content/gitlab-url.js");

test("route identity changes are detected", () => {
  const first = urls.parseMergeRequestUrl(
    "https://git.example.com/group/project/merge_requests/42/diffs",
  );
  const same = urls.parseMergeRequestUrl(
    "https://git.example.com/group/project/merge_requests/42/diffs?view=parallel",
  );
  const other = urls.parseMergeRequestUrl(
    "https://git.example.com/group/project/merge_requests/43/diffs",
  );
  assert.equal(navigationChanged(first, same), false);
  assert.equal(navigationChanged(first, other), true);
  assert.equal(navigationChanged(first, null), true);
});

test("leaving an MR route clears all extension-owned UI", async () => {
  const documentNode = new FakeDocument();
  const mount = documentNode.createElement("main");
  mount.className = "diffs";
  documentNode.append(mount);
  const locationNode = {
    href: "https://git.example.com/group/project/merge_requests/42/diffs",
  };
  const controller = createController({
    documentNode,
    locationNode,
    sendMessage: async () => ({ ok: true, result: {
      status: "stale_diff",
      canAnnotate: false,
      reportFileCount: 1,
    } }),
    setTimer: () => 1,
    clearTimer() {},
  });

  await controller.refresh(false);
  assert.notEqual(documentNode.querySelector("#ioscov-summary"), null);
  locationNode.href = "https://git.example.com/group/project/merge_requests/42";
  await controller.refresh(false);
  assert.equal(documentNode.querySelector("#ioscov-summary"), null);
});

test("resolver should_poll schedules a bounded five-second refresh", async () => {
  const documentNode = new FakeDocument();
  const mount = documentNode.createElement("main");
  mount.className = "diffs";
  documentNode.append(mount);
  const locationNode = {
    href: "https://git.example.com/group/project/merge_requests/42/diffs",
  };
  const timers = [];
  const controller = createController({
    documentNode,
    locationNode,
    sendMessage: async () => ({ ok: true, result: {
      status: "analysis_pending",
      canAnnotate: false,
      shouldPoll: true,
      files: [],
    } }),
    setTimer(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer() {},
  });

  await controller.refresh(false);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 5000);
});

test("manifest is MV3 and keeps hosts optional with minimal capabilities", () => {
  const manifestPath = path.join(__dirname, "..", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage", "scripting"]);
  assert.equal("host_permissions" in manifest, false);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*", "http://*/*"]);
  assert.equal("content_scripts" in manifest, false);
  assert.equal(manifest.background.service_worker, "src/background/service-worker.js");
  assert.equal(manifest.action.default_title, "打开 iOS Coverage 设置");
});

test("extension sources contain no remote scripts, innerHTML writes, or forbidden permissions", () => {
  const root = path.join(__dirname, "..");
  const sourcePaths = [
    "src/background/service-worker.js",
    "src/background/api-client.js",
    "src/content/entry.js",
    "src/content/gitlab-dom-adapter.js",
    "src/content/coverage-renderer.js",
    "src/options/options.js",
  ];
  const combined = sourcePaths.map((relative) =>
    fs.readFileSync(path.join(root, relative), "utf8")).join("\n");
  assert.doesNotMatch(combined, /\.innerHTML\s*=/);
  assert.doesNotMatch(combined, /document\.cookie|webRequest|browsingData|history\./);
  assert.doesNotMatch(combined, /<script[^>]+https?:/i);
  assert.match(combined, /TRUSTED_CONTEXTS/);
  assert.match(combined, /chrome\.action\.onClicked/);
  assert.match(combined, /chrome\.runtime\.openOptionsPage/);
  assert.doesNotMatch(combined, /readDiffIdentity|diffIdentity/);
});
