"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeDocument } = require("./helpers/fake-dom.js");
const { createScheduler, MAX_CONCURRENT_FILES, MARKERS_PER_BATCH } = require("../src/content/file-annotations.js");

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness(count = 8, lineCount = 1) {
  const documentNode = new FakeDocument();
  const records = [];
  const timers = new Map();
  const requests = [];
  const progress = [];
  const observed = new Set();
  let timerId = 0;
  let viewport;
  let current = true;
  let fileQueries = 0;
  const query = documentNode.querySelectorAll.bind(documentNode);
  documentNode.querySelectorAll = (selector) => {
    if (selector === ".diff-file.file-holder") fileQueries += 1;
    return query(selector);
  };
  const report = {
    canAnnotate: true, cycleId: "11111111-1111-4111-8111-111111111111", generation: 1,
    reportFileCount: count, files: [],
  };

  function addFile(index, parent = documentNode, path = `Sources/File${index}.swift`) {
    const file = documentNode.createElement("div");
    file.className = "diff-file file-holder";
    file.setAttribute("data-new-path", path);
    const cells = [];
    for (let i = 1; i <= lineCount; i += 1) {
      const cell = documentNode.createElement("td");
      cell.className = "new_line new";
      cell.setAttribute("data-linenumber", String(i));
      file.append(cell);
      cells.push(cell);
    }
    parent.append(file);
    let scans = 0;
    const query = file.querySelectorAll.bind(file);
    file.querySelectorAll = (selector) => {
      if (selector === "td.new_line.new[data-linenumber]") scans += 1;
      return query(selector);
    };
    const descriptor = { fileId: index.toString(16).padStart(64, "0"), repoRelativePath: path, uncovered: 0 };
    const record = { file, cells, descriptor, get scans() { return scans; } };
    records.push(record);
    report.files.push(descriptor);
    return record;
  }
  for (let i = 1; i <= count; i += 1) addFile(i);

  const scheduler = createScheduler({
    documentNode,
    sendMessage: (message) => new Promise((resolve) => requests.push({ message, resolve })),
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    createIntersectionObserver(callback, options) {
      viewport = callback;
      assert.equal(options.rootMargin, "600px 0px");
      return {
        observe: (file) => observed.add(file),
        unobserve: (file) => observed.delete(file),
        disconnect: () => observed.clear(),
      };
    },
    isCurrent: () => current,
    onProgress: (stats) => progress.push(stats),
  });
  function visible(items, isIntersecting = true) {
    viewport(items.map((record) => ({ target: record.file, isIntersecting })));
  }
  function respond(request, options = {}) {
    const descriptor = report.files.find((file) => file.fileId === request.message.fileId);
    request.resolve({ ok: true, result: {
      cycle_id: report.cycleId, generation: request.message.generation,
      file: { file_id: descriptor.fileId, repo_relative_path: descriptor.repoRelativePath },
      lines: Array.from({ length: lineCount }, (_, i) => ({
        new_line_number: i + 1, state: "covered", coverage_source: "current_build", regions: [],
      })),
      ...options,
    } });
  }
  function runTimers(delay) {
    const ready = [...timers].filter(([, value]) => value.delay === delay);
    for (const [id, { callback }] of ready) { timers.delete(id); callback(); }
  }
  function mutation(target, addedNodes = [], removedNodes = []) {
    scheduler.handleMutations([{ type: "childList", target, addedNodes, removedNodes }]);
  }
  function markerCount() { return documentNode.querySelectorAll(".ioscov-line-marker").length; }
  return {
    scheduler, report, documentNode, records, requests, progress, observed,
    visible, respond, runTimers, mutation, markerCount, addFile,
    get fileQueries() { return fileQueries; },
    invalidate() { current = false; },
  };
}

test("a large diff scans no offscreen rows and never exceeds four file requests", async () => {
  const h = harness(467);
  h.scheduler.setReport(h.report);
  assert.equal(h.observed.size, 467);
  assert.equal(h.requests.length, 0);
  assert.equal(h.records.reduce((sum, record) => sum + record.scans, 0), 0);
  h.visible(h.records.slice(0, 10));
  await settle();
  assert.equal(h.requests.length, MAX_CONCURRENT_FILES);
  assert.equal(h.records[10].scans, 0);
  h.respond(h.requests[1]); // The first request remains slow; this file must still render.
  await settle();
  assert.equal(h.records[1].file.querySelectorAll(".ioscov-line-marker").length, 1);
  assert.equal(h.records[0].file.querySelectorAll(".ioscov-line-marker").length, 0);
  assert.equal(h.requests.length, MAX_CONCURRENT_FILES + 1);
  h.visible(h.records.slice(5, 10), false); // Discard offscreen queued work before it starts.
  for (const request of h.requests) h.respond(request);
  await settle();
  assert.equal(h.requests.length, 5);
  h.scheduler.destroy();
});

test("row mutations only rescan their file and reuse an in-flight or completed detail", async () => {
  const h = harness(2);
  h.scheduler.setReport(h.report);
  h.visible(h.records);
  await settle();
  const first = h.records[0];
  h.mutation(first.file);
  h.mutation(first.file);
  h.runTimers(180);
  assert.equal(h.requests.length, 2);
  h.respond(h.requests[0]);
  h.respond(h.requests[1]);
  await settle();
  assert.equal(h.markerCount(), 2);
  assert.equal(first.scans, 2);
  assert.equal(h.records[1].scans, 1);
  h.mutation(first.file);
  h.runTimers(180);
  await settle();
  assert.equal(first.scans, 3);
  assert.equal(h.records[1].scans, 1);
  assert.equal(h.requests.length, 2);
  assert.equal(h.fileQueries, 1);
  h.scheduler.destroy();
});

test("new subtrees and removed files update tracking without rediscovering the whole page", async () => {
  const h = harness(2);
  const added = h.records[1];
  added.file.remove();
  h.scheduler.setReport(h.report);
  const wrapper = h.documentNode.createElement("section");
  h.documentNode.append(wrapper);
  wrapper.append(added.file);
  h.mutation(h.documentNode, [wrapper]);
  h.runTimers(180);
  assert.equal(h.fileQueries, 1);
  assert.equal(h.observed.size, 2);
  assert.equal(added.scans, 0);
  h.visible([added]);
  await settle();
  wrapper.remove();
  h.mutation(h.documentNode, [], [wrapper]);
  h.runTimers(180);
  assert.equal(h.observed.size, 1);
  h.respond(h.requests[0]);
  await settle();
  assert.equal(added.file.querySelectorAll(".ioscov-line-marker").length, 0);
  h.scheduler.destroy();
});

test("stale results clear rendered markers and discard all outstanding responses", async () => {
  const h = harness(6);
  h.scheduler.setReport(h.report);
  h.visible(h.records);
  await settle();
  h.respond(h.requests[0]);
  await settle();
  assert.equal(h.markerCount(), 1);
  h.scheduler.setReport({ ...h.report, canAnnotate: false });
  assert.equal(h.markerCount(), 0);
  for (const request of h.requests) h.respond(request);
  await settle();
  assert.equal(h.markerCount(), 0);
  assert.equal(h.requests.length, 5);
  h.scheduler.destroy();
});

test("generation changes preserve the concurrency bound and cannot apply old responses", async () => {
  const h = harness(6);
  h.scheduler.setReport(h.report);
  h.visible(h.records);
  await settle();
  const oldRequests = [...h.requests];
  h.scheduler.setReport({ ...h.report, generation: 2 });
  await settle();
  assert.equal(h.requests.length, 4); // Old network requests still occupy their slots.
  for (const request of oldRequests) h.respond(request);
  await settle();
  assert.equal(h.markerCount(), 0);
  assert.equal(h.requests.length, 8);
  assert.ok(h.requests.slice(4).every((request) => request.message.generation === 2));
  h.respond(h.requests[4]);
  await settle();
  assert.equal(h.documentNode.querySelector(".ioscov-line-marker").dataset.generation, "2");
  h.scheduler.destroy();
});

test("large files yield between marker batches and stop on navigation or destruction", async () => {
  const h = harness(1, MARKERS_PER_BATCH + 10);
  h.scheduler.setReport(h.report);
  h.visible(h.records);
  await settle();
  h.respond(h.requests[0]);
  await settle();
  assert.equal(h.markerCount(), MARKERS_PER_BATCH);
  h.invalidate();
  h.runTimers(0);
  await settle();
  assert.equal(h.markerCount(), MARKERS_PER_BATCH);
  h.scheduler.destroy();
  assert.equal(h.markerCount(), 0);
  assert.equal(h.observed.size, 0);
});

test("duplicate paths, including offscreen ones, fail closed and recover after removal", async () => {
  const h = harness(2);
  h.records[1].file.setAttribute("data-new-path", h.records[0].descriptor.repoRelativePath);
  const stats = h.scheduler.setReport(h.report);
  h.visible([h.records[0]]);
  await settle();
  assert.equal(stats.unsupported, true);
  assert.equal(h.requests.length, 0);
  h.records[1].file.remove();
  h.mutation(h.documentNode, [], [h.records[1].file]);
  h.runTimers(180);
  await settle();
  assert.equal(h.requests.length, 1);
  h.respond(h.requests[0]);
  await settle();
  assert.equal(h.markerCount(), 1);
  h.scheduler.destroy();
});

test("duplicate row numbers clear only the affected file and a later row update can recover", async () => {
  const h = harness(2, 2);
  h.scheduler.setReport(h.report);
  h.visible([h.records[0]]);
  await settle();
  h.respond(h.requests[0]);
  await settle();
  assert.equal(h.markerCount(), 2);
  h.records[1].cells[1].setAttribute("data-linenumber", "1");
  h.visible([h.records[1]]);
  await settle();
  assert.equal(h.markerCount(), 2);
  assert.equal(h.scheduler.statistics().unsupported, false);
  h.records[1].cells[1].setAttribute("data-linenumber", "2");
  h.mutation(h.records[1].file);
  h.runTimers(180);
  await settle();
  assert.equal(h.requests.length, 2);
  h.respond(h.requests[1]);
  await settle();
  assert.equal(h.markerCount(), 4);
  h.scheduler.destroy();
});

test("renumbered or reclassified cells lose markers no longer present in the file plan", async () => {
  const h = harness(1, 2);
  h.scheduler.setReport(h.report);
  h.visible(h.records);
  await settle();
  h.respond(h.requests[0]);
  await settle();
  const record = h.records[0];
  record.cells[0].setAttribute("data-linenumber", "30");
  record.cells[1].className = "new_line";
  h.mutation(record.file);
  h.runTimers(180);
  await settle();
  assert.equal(h.markerCount(), 0);
  assert.equal(h.requests.length, 1);
  h.scheduler.destroy();
});

test("failed file requests leave slots available for other files", async () => {
  const h = harness(5);
  h.scheduler.setReport(h.report);
  h.visible(h.records);
  await settle();
  h.requests[0].resolve({ ok: false, error: "unreachable" });
  await settle();
  assert.equal(h.requests.length, 5);
  h.respond(h.requests[4]);
  await settle();
  assert.equal(h.records[4].file.querySelectorAll(".ioscov-line-marker").length, 1);
  h.scheduler.destroy();
});

test("a detached and rebuilt file container rescans when the same node is reinserted", async () => {
  const h = harness(1);
  h.scheduler.setReport(h.report);
  h.visible(h.records);
  await settle();
  h.respond(h.requests[0]);
  await settle();
  const record = h.records[0];
  record.file.remove();
  record.cells[0].remove();
  const replacement = h.documentNode.createElement("td");
  replacement.className = "new_line new";
  replacement.setAttribute("data-linenumber", "1");
  record.file.append(replacement);
  h.documentNode.append(record.file);
  h.mutation(h.documentNode, [record.file], [record.file]);
  h.runTimers(180);
  await settle();
  assert.equal(record.scans, 2);
  assert.equal(h.requests.length, 1);
  assert.notEqual(replacement.querySelector(".ioscov-line-marker"), null);
  h.scheduler.destroy();
});

test("returning to an offscreen file invalidates class changes made while its observer was detached", async () => {
  const h = harness(1);
  h.scheduler.setReport(h.report);
  h.visible(h.records);
  await settle();
  h.respond(h.requests[0]);
  await settle();
  assert.equal(h.markerCount(), 1);
  h.visible(h.records, false);
  // No mutation callback: class observation is deliberately disconnected outside the viewport margin.
  h.records[0].cells[0].className = "new_line";
  h.visible(h.records);
  await settle();
  assert.equal(h.records[0].scans, 2);
  assert.equal(h.markerCount(), 0);
  assert.equal(h.requests.length, 1);
  h.scheduler.destroy();
});

test("P14 same-generation MR snapshot changes discard pending details and cached markers", async () => {
  const h = harness(1);
  h.report.presentationId = 'a'.repeat(64);
  h.scheduler.setReport(h.report);
  h.visible(h.records);
  await settle();
  const old = h.requests[0];
  const next = {...h.report, presentationId:'b'.repeat(64)};
  h.scheduler.setReport(next);
  h.respond(old, {presentation_id:'a'.repeat(64)});
  await settle();
  assert.equal(h.markerCount(),0);
  assert.equal(h.requests.length,2);
  assert.equal(h.requests[1].message.presentationId,'b'.repeat(64));
  h.respond(h.requests[1], {presentation_id:'b'.repeat(64)});
  await settle();
  assert.equal(h.markerCount(),1);
  h.scheduler.destroy();
});

test("P13 ambiguous offscreen paths do not block an unrelated visible file", async () => {
  const h = harness(3);
  h.records[1].file.setAttribute("data-new-path", h.records[0].descriptor.repoRelativePath);
  const stats = h.scheduler.setReport(h.report);
  assert.equal(stats.unsupported,false);
  h.visible(h.records);
  await settle();
  assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].message.fileId,h.records[2].descriptor.fileId);
  h.respond(h.requests[0]); await settle();
  assert.equal(h.markerCount(),1);
  h.scheduler.destroy();
});
