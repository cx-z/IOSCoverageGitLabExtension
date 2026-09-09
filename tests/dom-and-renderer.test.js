"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeDocument } = require("./helpers/fake-dom.js");
const dom = require("../src/content/gitlab-dom-adapter.js");
const renderer = require("../src/content/coverage-renderer.js");

function appendElement(documentNode, parent, tag, className, attributes = {}) {
  const node = documentNode.createElement(tag);
  node.className = className;
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  parent.append(node);
  return node;
}

function makeFile(documentNode, path, view = "inline") {
  const file = appendElement(documentNode, documentNode, "div", "diff-file file-holder", {
    "data-view": view,
  });
  const title = appendElement(documentNode, file, "span", "file-title-name", {
    "data-title": path,
  });
  title.textContent = path;
  return file;
}

function makeNewLine(documentNode, file, number) {
  return appendElement(documentNode, file, "td", "new_line new", {
    "data-linenumber": String(number),
  });
}

function line(state, coverageSource, number = 10) {
  return {
    new_line_number: number,
    state,
    coverage_source: coverageSource,
    regions: state === "uncovered" ? [{ covered: true }, { covered: false }] : [],
  };
}

test("DOM adapter finds only exact new-side changed line cells in both views", () => {
  const documentNode = new FakeDocument();
  const inline = makeFile(documentNode, "Sources/Feature.swift", "inline");
  makeNewLine(documentNode, inline, 10);
  appendElement(documentNode, inline, "td", "new_line", { "data-linenumber": "11" });
  appendElement(documentNode, inline, "td", "old_line old", { "data-linenumber": "9" });
  const parallel = makeFile(documentNode, "Sources/Other.swift", "parallel");
  makeNewLine(documentNode, parallel, 20);

  const scan = dom.scanDiff(documentNode);
  assert.equal(scan.fileCount, 2);
  assert.deepEqual(scan.files.map((file) => file.lines.map((item) => item.newLineNumber)), [[10], [20]]);
  assert.deepEqual(scan.files.map((file) => file.view), ["inline", "parallel"]);
});

test("ambiguous paths and duplicate line numbers fail closed", () => {
  const documentNode = new FakeDocument();
  const first = makeFile(documentNode, "Sources/Feature.swift");
  makeNewLine(documentNode, first, 10);
  makeNewLine(documentNode, first, 10);
  const second = makeFile(documentNode, "Sources/Feature.swift");
  makeNewLine(documentNode, second, 11);
  const scan = dom.scanDiff(documentNode);
  assert.equal(scan.ambiguousFileCount, 2);
});

test("rename notation is rejected and collapsed files are reported without expansion", () => {
  const documentNode = new FakeDocument();
  const file = makeFile(documentNode, "Sources/{Old => New}/Feature.swift");
  appendElement(documentNode, file, "a", "click-to-expand");
  const scan = dom.scanDiff(documentNode);
  assert.equal(scan.files[0].path, null);
  assert.equal(scan.files[0].collapsed, true);
});

test("path plus new line number is the only annotation key", () => {
  const documentNode = new FakeDocument();
  const exact = makeFile(documentNode, "Sources/Feature.swift");
  const exactCell = makeNewLine(documentNode, exact, 10);
  const suffix = makeFile(documentNode, "Archive/Sources/Feature.swift");
  const suffixCell = makeNewLine(documentNode, suffix, 10);
  const scan = dom.scanDiff(documentNode);
  const details = [{
    file: { repo_relative_path: "Sources/Feature.swift" },
    lines: [line("covered", "current_build")],
  }];
  const plan = renderer.planAnnotations(scan, details, true);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].target, exactCell);
  assert.equal(suffixCell.querySelector(`.${renderer.MARKER_CLASS}`), null);
});

test("renders four distinct states and four source labels without HTML parsing", () => {
  const documentNode = new FakeDocument();
  const file = makeFile(documentNode, "Sources/Feature.swift");
  const states = ["covered", "uncovered", "not_measurable", "unknown"];
  const sources = ["current_build", "historical_inheritance", "mixed", "none"];
  states.forEach((_state, index) => makeNewLine(documentNode, file, index + 1));
  const scan = dom.scanDiff(documentNode);
  const details = [{
    file: { repo_relative_path: "Sources/Feature.swift" },
    lines: states.map((state, index) => line(state, sources[index], index + 1)),
  }];
  const plan = renderer.planAnnotations(scan, details, true);
  renderer.applyAnnotationPlan(documentNode, plan, 1, true);
  const markers = documentNode.querySelectorAll(`.${renderer.MARKER_CLASS}`);
  assert.deepEqual(markers.map((marker) => marker.textContent), ["✓", "×", "·", "?"]);
  assert.deepEqual(markers.map((marker) => marker.dataset.state), states);
  assert.deepEqual(markers.map((marker) => marker.getAttribute("role")), ["img", "img", "img", "img"]);
  sources.forEach((source, index) => {
    assert.match(markers[index].getAttribute("aria-label"), new RegExp(renderer.SOURCE_LABELS[source]));
  });
});

test("repeat scans are idempotent and a generation change replaces old markers", () => {
  const documentNode = new FakeDocument();
  const file = makeFile(documentNode, "Sources/Feature.swift");
  makeNewLine(documentNode, file, 10);
  const scan = dom.scanDiff(documentNode);
  const first = renderer.planAnnotations(scan, [{
    file: { repo_relative_path: "Sources/Feature.swift" },
    lines: [line("covered", "current_build")],
  }], true);
  renderer.applyAnnotationPlan(documentNode, first, 1, true);
  renderer.applyAnnotationPlan(documentNode, first, 1, true);
  assert.equal(documentNode.querySelectorAll(`.${renderer.MARKER_CLASS}`).length, 1);

  const second = renderer.planAnnotations(scan, [{
    file: { repo_relative_path: "Sources/Feature.swift" },
    lines: [line("uncovered", "mixed")],
  }], true);
  renderer.applyAnnotationPlan(documentNode, second, 2, true);
  const markers = documentNode.querySelectorAll(`.${renderer.MARKER_CLASS}`);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].dataset.generation, "2");
  assert.equal(markers[0].textContent, "×");
});

test("stale or unverified results clear every existing line marker", () => {
  const documentNode = new FakeDocument();
  const file = makeFile(documentNode, "Sources/Feature.swift");
  makeNewLine(documentNode, file, 10);
  const scan = dom.scanDiff(documentNode);
  const plan = renderer.planAnnotations(scan, [{
    file: { repo_relative_path: "Sources/Feature.swift" },
    lines: [line("covered", "current_build")],
  }], true);
  renderer.applyAnnotationPlan(documentNode, plan, 1, true);
  renderer.applyAnnotationPlan(documentNode, [], 1, false);
  assert.equal(documentNode.querySelectorAll(`.${renderer.MARKER_CLASS}`).length, 0);
});

test("malicious external text is rendered literally and never assigned through innerHTML", () => {
  const documentNode = new FakeDocument();
  const mount = appendElement(documentNode, documentNode, "main", "diffs");
  const payload = "<img src=x onerror=alert(1)>";
  const summary = renderer.renderSummary(documentNode, mount, {
    status: "ready",
    canAnnotate: false,
    updatedAt: payload,
    buildSha: "a".repeat(40),
  }, { onRefresh() {}, onOpenSettings() {}, onFilter() {} });
  assert.match(summary.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(summary.querySelector("img"), null);
});
