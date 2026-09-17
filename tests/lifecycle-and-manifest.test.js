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

test("uncovered filter remains checked and applied after summary rerender", async () => {
  const documentNode = new FakeDocument();
  const mount = documentNode.createElement("main");
  mount.className = "diffs";
  documentNode.append(mount);

  const fileIds = ["a".repeat(64), "b".repeat(64)];
  const paths = ["Sources/Feature.swift", "Sources/Other.swift"];
  const states = ["uncovered", "covered"];
  paths.forEach((repoPath, index) => {
    const file = documentNode.createElement("div");
    file.className = "diff-file file-holder";
    file.setAttribute("data-new-path", repoPath);
    const line = documentNode.createElement("td");
    line.className = "new_line new";
    line.setAttribute("data-linenumber", "10");
    file.append(line);
    documentNode.append(file);
  });

  const result = {
    status: "ready",
    canAnnotate: true,
    shouldPoll: false,
    cycleId: "11111111-1111-4111-8111-111111111111",
    generation: 1,
    reportFileCount: 2,
    files: paths.map((repoRelativePath, index) => ({
      fileId: fileIds[index],
      repoRelativePath,
      uncovered: index === 0 ? 1 : 0,
    })),
  };
  const controller = createController({
    documentNode,
    locationNode: {
      href: "https://git.example.com/group/project/merge_requests/42/diffs",
    },
    sendMessage: async (message) => {
      if (message.action === "RESOLVE_MR") return { ok: true, result };
      const index = fileIds.indexOf(message.fileId);
      return { ok: true, result: {
        cycle_id: result.cycleId,
        generation: result.generation,
        file: { file_id: message.fileId, repo_relative_path: paths[index] },
        lines: [{
          new_line_number: 10,
          state: states[index],
          coverage_source: "current_build",
          regions: [{ covered: states[index] === "covered" }],
        }],
      } };
    },
    setTimer: () => 1,
    clearTimer() {},
  });

  await controller.refresh(false);
  let filter = documentNode.querySelector("#ioscov-summary input");
  filter.checked = true;
  filter.listeners.get("change")();
  assert.equal(documentNode.querySelectorAll(".ioscov-file-dimmed").length, 1);

  await controller.refresh(false);
  filter = documentNode.querySelector("#ioscov-summary input");
  assert.equal(filter.checked, true);
  assert.equal(documentNode.querySelectorAll(".ioscov-file-dimmed").length, 1);
});

test("manifest is MV3 and keeps hosts optional with minimal capabilities", () => {
  const manifestPath = path.join(__dirname, "..", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage", "scripting", "tabs"]);
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
