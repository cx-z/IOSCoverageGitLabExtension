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
    "src/content/file-annotations.js",
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

function viewportController() {
  const documentNode = new FakeDocument();
  const mount = documentNode.createElement("main");
  mount.className = "diffs";
  documentNode.append(mount);
  const version = documentNode.createElement("div");
  version.className = "mr-version-dropdown";
  const active = documentNode.createElement("a");
  active.className = "is-active";
  active.textContent = "latest version";
  version.append(active);
  documentNode.append(version);
  const file = documentNode.createElement("div");
  file.className = "diff-file file-holder";
  file.setAttribute("data-new-path", "Sources/Feature.swift");
  const cell = documentNode.createElement("td");
  cell.className = "new_line new";
  cell.setAttribute("data-linenumber", "10");
  file.append(cell);
  mount.append(file);
  const result = {
    status: "ready", canAnnotate: true, shouldPoll: false,
    cycleId: "11111111-1111-4111-8111-111111111111", generation: 1,
    reportFileCount: 1,
    files: [{ fileId: "a".repeat(64), repoRelativePath: "Sources/Feature.swift", uncovered: 1 }],
  };
  const requests = [];
  const timers = new Map();
  const events = new Map();
  const observations = [];
  let timerId = 0;
  let mutations;
  let viewport;
  const controller = createController({
    documentNode,
    locationNode: { href: "https://git.example.com/group/project/merge_requests/42/diffs" },
    sendMessage: async (message) => {
      if (message.action === "RESOLVE_MR") return {
        ok: true, result: message.versionState === "latest" ? result : {
          status: "historical_diff", canAnnotate: false, files: [],
        },
      };
      return new Promise((resolve) => requests.push({ message, resolve }));
    },
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    eventTarget: {
      addEventListener(name, callback) { events.set(name, callback); },
      removeEventListener(name) { events.delete(name); },
    },
    createMutationObserver(callback) {
      mutations = callback;
      const record = { element: null, options: null, connected: true };
      observations.push(record);
      return {
        observe(element, options) { record.element = element; record.options = options; },
        disconnect() { record.connected = false; },
      };
    },
    createIntersectionObserver(callback) {
      viewport = callback;
      return { observe() {}, unobserve() {}, disconnect() {} };
    },
  });
  controller.start();
  return {
    controller, documentNode, file, cell, active, requests, events, observations,
    visible(isIntersecting = true) { viewport([{ target: file, isIntersecting }]); },
    mutate(record) { mutations([record]); },
    runTimers() {
      for (const [id, { callback }] of [...timers]) { timers.delete(id); callback(); }
    },
    respond() {
      requests[0].resolve({ ok: true, result: {
        cycle_id: result.cycleId, generation: 1,
        file: { file_id: result.files[0].fileId, repo_relative_path: "Sources/Feature.swift" },
        lines: [{ new_line_number: 10, state: "uncovered", coverage_source: "none", regions: [] }],
      } });
    },
  };
}

test("controller publishes summary before visible file details and ignores its own updates", async () => {
  const h = viewportController();
  await new Promise(setImmediate);
  assert.match(h.documentNode.querySelector("#ioscov-summary").textContent, /报告身份已验证/);
  assert.equal(h.requests.length, 0);
  h.visible();
  await new Promise(setImmediate);
  assert.equal(h.requests.length, 1);
  h.respond();
  await new Promise(setImmediate);
  const marker = h.cell.querySelector(".ioscov-line-marker");
  const summary = h.documentNode.querySelector("#ioscov-summary");
  h.mutate({ type: "childList", target: h.cell, addedNodes: [marker], removedNodes: [] });
  h.mutate({ type: "childList", target: summary.parentElement, addedNodes: [summary], removedNodes: [] });
  h.runTimers();
  await new Promise(setImmediate);
  assert.equal(h.requests.length, 1);
  assert.equal(h.documentNode.querySelector("#ioscov-summary"), summary);
  h.controller.destroy();
  assert.equal(h.events.size, 0);
  assert.equal(h.documentNode.querySelector(".ioscov-line-marker"), null);
});

test("a version change rejects an outstanding file even before the navigation debounce fires", async () => {
  const h = viewportController();
  await new Promise(setImmediate);
  h.visible();
  await new Promise(setImmediate);
  h.active.textContent = "version 2";
  h.mutate({ type: "childList", target: h.active, addedNodes: [], removedNodes: [] });
  h.respond();
  await new Promise(setImmediate);
  assert.equal(h.documentNode.querySelector(".ioscov-line-marker"), null);
  h.runTimers();
  await new Promise(setImmediate);
  assert.match(h.documentNode.querySelector("#ioscov-summary").textContent, /当前仅支持 MR 的最新 diff/);
  h.controller.destroy();
});

test("both content-script registration paths load the scheduler before the entry point", () => {
  const root = path.join(__dirname, "..");
  for (const relative of ["src/background/service-worker.js", "scripts/make-company-build.sh"]) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.match(source, /"src\/content\/coverage-renderer.js",\s*"src\/content\/file-annotations.js",\s*"src\/content\/entry.js"/);
  }
});

test("SVG class mutations cannot abort the controller's mutation batch", async () => {
  const h = viewportController();
  await new Promise(setImmediate);
  const svg = h.documentNode.createElement("svg");
  svg.setAttribute("class", "icon loading");
  Object.defineProperty(svg, "className", { value: { baseVal: "icon loading", animVal: "icon loading" } });
  h.active.append(svg);
  assert.doesNotThrow(() => h.mutate({
    type: "attributes", attributeName: "class", target: svg, oldValue: "icon",
  }));
  h.runTimers();
  h.visible();
  await new Promise(setImmediate);
  h.respond();
  await new Promise(setImmediate);
  assert.notEqual(h.cell.querySelector(".ioscov-line-marker"), null);
  h.controller.destroy();
});

test("class observation is scoped to version controls and nearby files", async () => {
  const h = viewportController();
  await new Promise(setImmediate);
  const global = h.observations.find((item) => item.element === h.documentNode.documentElement);
  assert.ok(global);
  assert.equal(global.options.attributeFilter.includes("class"), false);
  assert.equal(h.observations.some((item) => item.element === h.file), false);
  h.visible();
  const nearby = h.observations.find((item) => item.element === h.file && item.connected);
  assert.ok(nearby);
  assert.deepEqual(nearby.options.attributeFilter, ["class"]);
  h.visible(false);
  assert.equal(nearby.connected, false);
  h.controller.destroy();
  assert.ok(h.observations.every((item) => !item.connected));
});

test("P14 a transient page identity change before debounce still restarts resolution", async () => {
  const h = viewportController();
  await new Promise(setImmediate);
  h.visible(); await new Promise(setImmediate);
  assert.equal(h.requests.length,1);
  h.active.setAttribute('href','/group/project/merge_requests/42/diffs?diff_id=123');
  h.mutate({type:'attributes',target:h.active,attributeName:'href'});
  h.active.setAttribute('href','');
  h.runTimers(); await new Promise(setImmediate);
  h.respond(); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(h.requests.length,2);
  assert.equal(h.documentNode.querySelectorAll('.ioscov-line-marker').length,0);
  h.controller.destroy();
});
