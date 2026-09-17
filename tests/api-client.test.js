"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../src/background/api-client.js");

const cycleId = "11111111-1111-4111-8111-111111111111";
const buildId = "22222222-2222-4222-8222-222222222222";
const fileId = "f".repeat(64);
const baseSha = "a".repeat(40);
const startSha = "b".repeat(40);
const headSha = "c".repeat(40);
const summary = {
  changed_new_side: 4,
  measurable: 2,
  covered: 1,
  uncovered: 1,
  not_measurable: 1,
  unknown: 1,
  changed_line_coverage_percent: 50,
};
const settings = {
  serverOrigin: "http://127.0.0.1:8765",
};
const mr = {
  origin: "https://git.example.com",
  host: "git.example.com",
  projectPath: "group/project",
  iid: "42",
  pathname: "/group/project/merge_requests/42/diffs",
  identity: "https://git.example.com/group/project/merge_requests/42",
};

function readyResolver() {
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
      diff: { base_sha: baseSha, start_sha: startSha, head_sha: headSha },
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
      build_diff: { base_sha: baseSha, start_sha: startSha, head_sha: headSha },
      summary_api: `/api/v1/cycles/${cycleId}/report`,
    },
  };
}

function summaryReport() {
  return {
    schema_version: 1,
    status: "complete",
    cycle_id: cycleId,
    current_build_id: buildId,
    generation: 3,
    updated_at: "2026-01-02T03:04:05Z",
    summary,
    files: [{
      file_id: fileId,
      repo_relative_path: "Sources/Feature.swift",
      uncovered: 1,
    }],
  };
}

function fixtureFetch(resolver = readyResolver(), report = summaryReport()) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    if (path.endsWith("/resolve")) {
      return { ok: true, status: 200, json: async () => resolver };
    }
    if (path === `/api/v1/cycles/${cycleId}/report`) {
      return { ok: true, status: 200, json: async () => report };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { calls, fetchImpl };
}

test("resolver sends the fixed request schema without any credential", async () => {
  const fixture = fixtureFetch();
  await api.resolveMergeRequest(fixture.fetchImpl, {
    ...settings,
    runToken: "must-not-be-used",
    operatorToken: "must-not-be-sent",
  }, { mr });

  assert.equal(fixture.calls[0].options.method, "POST");
  assert.equal(
    new URL(fixture.calls[0].url).pathname,
    "/api/v1/integrations/gitlab/merge-request-coverage/resolve",
  );
  assert.equal("Authorization" in fixture.calls[0].options.headers, false);
  assert.deepEqual(JSON.parse(fixture.calls[0].options.body), {
    schema_version: 1,
    mr_url: "https://git.example.com/group/project/merge_requests/42/diffs",
  });
});

test("can_annotate true loads only the resolver-provided fixed summary API", async () => {
  const fixture = fixtureFetch();
  const result = await api.resolveMergeRequest(fixture.fetchImpl, settings, { mr });

  assert.equal(result.status, "ready");
  assert.equal(result.canAnnotate, true);
  assert.deepEqual(fixture.calls.map((call) => ({
    method: call.options.method,
    path: new URL(call.url).pathname,
  })), [
    { method: "POST", path: "/api/v1/integrations/gitlab/merge-request-coverage/resolve" },
    { method: "GET", path: `/api/v1/cycles/${cycleId}/report` },
  ]);
  assert.deepEqual(result.files, [{
    fileId,
    repoRelativePath: "Sources/Feature.swift",
    uncovered: 1,
  }]);
});

test("stale diff retains its resolver summary but never loads report files", async () => {
  const resolver = readyResolver();
  resolver.status = "stale_diff";
  resolver.can_annotate = false;
  resolver.report.build_diff.base_sha = "d".repeat(40);
  const fixture = fixtureFetch(resolver);
  const result = await api.resolveMergeRequest(fixture.fetchImpl, settings, { mr });

  assert.equal(result.status, "stale_diff");
  assert.equal(result.canAnnotate, false);
  assert.deepEqual(result.summary, summary);
  assert.deepEqual(result.files, []);
  assert.equal(fixture.calls.length, 1);
});

test("pending resolver state is returned with polling enabled and no report request", async () => {
  const resolver = readyResolver();
  resolver.status = "analysis_pending";
  resolver.can_annotate = false;
  resolver.should_poll = true;
  resolver.analysis.status = "running";
  resolver.report = null;
  const fixture = fixtureFetch(resolver);
  const result = await api.resolveMergeRequest(fixture.fetchImpl, settings, { mr });

  assert.equal(result.status, "analysis_pending");
  assert.equal(result.shouldPoll, true);
  assert.equal(result.canAnnotate, false);
  assert.equal(fixture.calls.length, 1);
});

test("a resolver/report identity race fails closed", async () => {
  const report = summaryReport();
  report.generation = 4;
  const fixture = fixtureFetch(readyResolver(), report);
  await assert.rejects(
    api.resolveMergeRequest(fixture.fetchImpl, settings, { mr }),
    (error) => error.code === "identity_mismatch",
  );
});

test("a server still requiring a credential is surfaced as invalid Token", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: "insufficient_scope" }),
  });
  await assert.rejects(
    api.resolveMergeRequest(fetchImpl, settings, { mr }),
    (error) => error.code === "invalid_token",
  );
});

test("test connection checks only the public health endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ path: new URL(url).pathname, method: options.method });
    return { ok: true, status: 200, json: async () => ({ version: "test" }) };
  };
  await api.testConnection(fetchImpl, settings);
  assert.deepEqual(calls, [{ path: "/health", method: "GET" }]);
});

test("background request builder rejects arbitrary URLs and paths", () => {
  assert.equal(
    api.fixedUrl(settings.serverOrigin, "/health"),
    "http://127.0.0.1:8765/health",
  );
  assert.throws(() => api.fixedUrl(settings.serverOrigin, "/api/v1/cycles"));
  assert.throws(() => api.fixedUrl(settings.serverOrigin, "/api/v1/admin"));
  assert.throws(() => api.fixedUrl("https://evil.example", "https://evil.example/data"));
});

test("content messages cannot pass diff SHAs, Tokens, or arbitrary URLs", () => {
  assert.equal(api.validateContentMessage({ action: "GET_OPTIONS_STATE" }), false);
  assert.equal(api.validateContentMessage({ action: "FETCH", url: "https://evil.example" }), false);
  assert.equal(api.validateContentMessage({ action: "OPEN_OPTIONS" }), true);
  assert.equal(api.validateContentMessage({
    action: "RESOLVE_MR",
    mr,
    versionState: "latest",
    diffIdentity: { baseSha, startSha, headSha },
  }), false);
  assert.equal(api.validateContentMessage({
    action: "RESOLVE_MR",
    mr,
    versionState: "latest",
    operatorToken: "request-token",
  }), false);
  assert.equal(api.validateContentMessage({
    action: "LOAD_REPORT_FILE",
    cycleId,
    generation: 3,
    fileId,
    url: "https://evil.example",
  }), false);
});
