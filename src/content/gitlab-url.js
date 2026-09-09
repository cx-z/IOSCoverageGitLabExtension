(function attachGitLabUrl(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.IOSCoverageGitLabUrl = api;
})(typeof globalThis === "object" ? globalThis : self, function createGitLabUrl() {
  "use strict";

  function decodePathSegment(segment) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch (_error) {
      return null;
    }
    if (
      decoded.length === 0 ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      return null;
    }
    return decoded;
  }

  function parseMergeRequestUrl(value) {
    let url;
    try {
      url = value instanceof URL ? value : new URL(value);
    } catch (_error) {
      return null;
    }
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const raw = url.pathname.split("/").filter(Boolean);
    const segments = raw.map(decodePathSegment);
    if (segments.some((segment) => segment === null)) return null;

    const mrIndexes = [];
    segments.forEach((segment, index) => {
      if (segment === "merge_requests") mrIndexes.push(index);
    });
    if (mrIndexes.length !== 1) return null;
    const mrIndex = mrIndexes[0];
    if (segments.length !== mrIndex + 3 || segments[mrIndex + 2] !== "diffs") return null;
    const iid = segments[mrIndex + 1];
    if (!/^[1-9]\d*$/.test(iid)) return null;

    let projectSegments = segments.slice(0, mrIndex);
    if (projectSegments.at(-1) === "-") projectSegments = projectSegments.slice(0, -1);
    if (projectSegments.length < 2 || projectSegments.some((segment) => segment === "-")) {
      return null;
    }
    return {
      origin: url.origin,
      host: url.hostname,
      projectPath: projectSegments.join("/"),
      iid,
      pathname: url.pathname,
      identity: `${url.origin}/${projectSegments.join("/")}/merge_requests/${iid}`,
    };
  }

  function sameMergeRequest(left, right) {
    return Boolean(left && right && left.identity === right.identity);
  }

  return { parseMergeRequestUrl, sameMergeRequest };
});
