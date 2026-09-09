"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMergeRequestUrl, sameMergeRequest } = require("../src/content/gitlab-url.js");

test("parses exact MR diff route without /-/", () => {
  const result = parseMergeRequestUrl(
    "https://git.example.com/group/project/merge_requests/42/diffs?view=parallel",
  );
  assert.deepEqual(result, {
    origin: "https://git.example.com",
    host: "git.example.com",
    projectPath: "group/project",
    iid: "42",
    pathname: "/group/project/merge_requests/42/diffs",
    identity: "https://git.example.com/group/project/merge_requests/42",
  });
});

test("parses exact MR diff route with /-/ and a multi-level group", () => {
  const result = parseMergeRequestUrl(
    "https://git.example.com/group/subgroup/project/-/merge_requests/7/diffs",
  );
  assert.equal(result.projectPath, "group/subgroup/project");
  assert.equal(result.iid, "7");
});

test("rejects non-MR and non-diff pages", () => {
  assert.equal(parseMergeRequestUrl("https://git.example.com/group/project"), null);
  assert.equal(parseMergeRequestUrl("https://git.example.com/group/project/merge_requests/42"), null);
  assert.equal(parseMergeRequestUrl("https://git.example.com/group/project/merge_requests/42/commits"), null);
});

test("rejects look-alike and extra-suffix routes", () => {
  assert.equal(
    parseMergeRequestUrl("https://git.example.com/group/project/not_merge_requests/42/diffs"),
    null,
  );
  assert.equal(
    parseMergeRequestUrl("https://git.example.com/group/project/merge_requests/42/diffs/evil"),
    null,
  );
  assert.equal(
    parseMergeRequestUrl("https://git.example.com/group/merge_requests/project/merge_requests/42/diffs"),
    null,
  );
});

test("rejects encoded separators, traversal, credentials, HTTP, and zero IID", () => {
  const invalid = [
    "https://git.example.com/group%2Fother/project/merge_requests/42/diffs",
    "https://git.example.com/group/%2e%2e/merge_requests/42/diffs",
    "https://user@git.example.com/group/project/merge_requests/42/diffs",
    "http://git.example.com/group/project/merge_requests/42/diffs",
    "https://git.example.com/group/project/merge_requests/0/diffs",
  ];
  invalid.forEach((value) => assert.equal(parseMergeRequestUrl(value), null));
});

test("MR identity ignores query and diff view but not another IID", () => {
  const left = parseMergeRequestUrl(
    "https://git.example.com/group/project/merge_requests/42/diffs?view=inline",
  );
  const right = parseMergeRequestUrl(
    "https://git.example.com/group/project/-/merge_requests/42/diffs?diff_id=9",
  );
  const other = parseMergeRequestUrl(
    "https://git.example.com/group/project/merge_requests/43/diffs",
  );
  assert.equal(sameMergeRequest(left, right), true);
  assert.equal(sameMergeRequest(left, other), false);
});
