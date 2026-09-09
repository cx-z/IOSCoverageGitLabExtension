"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const contracts = require("../src/shared/contracts.js");

const cycleId = "11111111-1111-4111-8111-111111111111";
const buildId = "22222222-2222-4222-8222-222222222222";
const fileId = "f".repeat(64);
const sha = "a".repeat(40);
const summary = {
  changed_new_side: 4,
  measurable: 2,
  covered: 1,
  uncovered: 1,
  not_measurable: 1,
  unknown: 1,
  changed_line_coverage_percent: 50,
};

test("accepts the existing server response shapes", () => {
  assert.doesNotThrow(() => contracts.validateCycleList({
    cycles: [{
      id: cycleId,
      gitlab_host: "git.example.com",
      gitlab_project_path: "group/project",
      mr_iid: 42,
    }],
    count: 1,
  }));
  assert.doesNotThrow(() => contracts.validateCycleDetail({ cycle: { id: cycleId } }));
  assert.doesNotThrow(() => contracts.validateAnalysis({
    cycle_id: cycleId,
    status: "succeeded",
    latest_success: { generation: 3, current_build_id: buildId, summary },
  }));
  assert.doesNotThrow(() => contracts.validateReport({
    schema_version: 1,
    status: "complete",
    cycle_id: cycleId,
    current_build_id: buildId,
    generation: 3,
    updated_at: "2026-01-02T03:04:05Z",
    summary,
    files: [{ file_id: fileId, repo_relative_path: "Sources/Feature.swift", uncovered: 1 }],
  }));
});

test("accepts all four states and all four coverage sources", () => {
  const states = ["covered", "uncovered", "not_measurable", "unknown"];
  const sources = ["current_build", "historical_inheritance", "mixed", "none"];
  assert.doesNotThrow(() => contracts.validateFileDetail({
    schema_version: 1,
    cycle_id: cycleId,
    generation: 3,
    file: { file_id: fileId, repo_relative_path: "Sources/Feature.swift" },
    lines: states.map((state, index) => ({
      new_line_number: index + 1,
      state,
      coverage_source: sources[index],
      regions: [],
    })),
  }));
});

test("rejects invalid paths, states, sources, and SHAs", () => {
  assert.equal(contracts.isSafeRepoPath("Sources/Feature.swift"), true);
  ["Feature.swift", "../Feature.swift", "/Sources/Feature.swift", "Sources\\Feature.swift"]
    .forEach((path) => {
      const expected = path === "Feature.swift";
      assert.equal(contracts.isSafeRepoPath(path), expected);
    });
  assert.throws(() => contracts.validateFileDetail({
    schema_version: 1,
    cycle_id: cycleId,
    generation: 1,
    file: { file_id: fileId, repo_relative_path: "Sources/Feature.swift" },
    lines: [{ new_line_number: 1, state: "missed", coverage_source: "none", regions: [] }],
  }));
});

test("rejects malformed report identity instead of coercing it", () => {
  assert.throws(() => contracts.validateReport({
    schema_version: 1,
    status: "complete",
    cycle_id: cycleId,
    current_build_id: buildId,
    generation: 1,
    updated_at: "2026-01-02T03:04:05Z",
    summary,
    files: [{ file_id: fileId, repo_relative_path: "../Feature.swift", uncovered: 1 }],
  }));
});

function resolverDocument() {
  return {
    schema_version: 1,
    status: "ready",
    can_annotate: true,
    should_poll: false,
    mr: {
      host: "git.example.com",
      project_path: "group/project",
      iid: "42",
      canonical_url: "https://git.example.com/group/project/merge_requests/42",
      diff: { base_sha: sha, start_sha: "b".repeat(40), head_sha: "c".repeat(40) },
    },
    cycle: { id: cycleId },
    analysis: {
      status: "succeeded",
      requested_generation: 3,
      completed_generation: 3,
    },
    report: {
      generation: 3,
      updated_at: "2026-01-02T03:04:05Z",
      current_build_id: buildId,
      summary,
      build_diff: { base_sha: sha, start_sha: "b".repeat(40), head_sha: "c".repeat(40) },
      summary_api: `/api/v1/cycles/${cycleId}/report`,
    },
  };
}

test("resolver contract accepts the fixed ready schema", () => {
  assert.doesNotThrow(() => contracts.validateResolverResponse(resolverDocument()));
});

test("resolver contract rejects extra fields and caller-controlled report paths", () => {
  const extra = resolverDocument();
  extra.unexpected = true;
  assert.throws(() => contracts.validateResolverResponse(extra));

  const arbitraryPath = resolverDocument();
  arbitraryPath.report.summary_api = "https://evil.example/report";
  assert.throws(() => contracts.validateResolverResponse(arbitraryPath));

  const nestedExtra = resolverDocument();
  nestedExtra.mr.diff.short_sha = "deadbeef";
  assert.throws(() => contracts.validateResolverResponse(nestedExtra));
});

test("resolver contract rejects can_annotate without exact three-SHA equality", () => {
  const mismatched = resolverDocument();
  mismatched.report.build_diff.head_sha = "d".repeat(40);
  assert.throws(() => contracts.validateResolverResponse(mismatched));
});

test("resolver contract validates stale and not-ready state invariants", () => {
  const stale = resolverDocument();
  stale.status = "stale_diff";
  stale.can_annotate = false;
  stale.report.build_diff.base_sha = "d".repeat(40);
  assert.doesNotThrow(() => contracts.validateResolverResponse(stale));

  const notReady = resolverDocument();
  notReady.status = "mr_diff_refs_not_ready";
  notReady.can_annotate = false;
  notReady.mr.diff = { base_sha: null, start_sha: null, head_sha: null };
  notReady.cycle = null;
  notReady.analysis = null;
  notReady.report = null;
  assert.doesNotThrow(() => contracts.validateResolverResponse(notReady));
});
