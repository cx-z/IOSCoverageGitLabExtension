(function attachGitLabDomAdapter(root, factory) {
  const contracts = root.IOSCoverageContracts ||
    (typeof require === "function" ? require("../shared/contracts.js") : null);
  const api = factory(contracts);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.IOSCoverageGitLabDom = api;
})(typeof globalThis === "object" ? globalThis : self, function createGitLabDom(contracts) {
  "use strict";

  const FILE_SELECTOR = ".diff-file.file-holder";
  const NEW_LINE_SELECTOR = "td.new_line.new[data-linenumber]";
  const RENAME_MARKERS = ["→", "=>", "{", "}"];

  function textStartsWith(element, expected) {
    return Boolean(element && (element.textContent || "").trim().toLowerCase().startsWith(expected));
  }

  function readVersionState(documentNode) {
    const active = documentNode.querySelector(".mr-version-dropdown a.is-active");
    if (textStartsWith(active, "latest version")) return "latest";
    if (textStartsWith(active, "version")) return "historical";
    return "unknown";
  }

  // The selected version link is page evidence; a live server MR alone is insufficient.
  function readPageVersion(documentNode, href) {
    if (readVersionState(documentNode) !== "latest") return null;
    const active = documentNode.querySelectorAll(".mr-version-dropdown a.is-active");
    if (active.length !== 1) return null;
    try {
      const page = new URL(href);
      const link = new URL(active[0].getAttribute("href"), page);
      const version = link.searchParams.get("diff_id");
      if (link.origin !== page.origin || link.pathname !== page.pathname ||
          !/^[1-9][0-9]{0,18}$/.test(version || "") ||
          link.searchParams.has("start_sha") || page.searchParams.has("start_sha") ||
          (page.searchParams.has("diff_id") && page.searchParams.get("diff_id") !== version)) return null;
      return version;
    } catch (_error) { return null; }
  }

  function lineMatchesDiff(candidate, diff) {
    const row = candidate.target.closest("tr");
    if (!row || !diff) return false;
    for (const button of row.querySelectorAll("[data-position]")) {
      try {
        const position = JSON.parse(button.getAttribute("data-position"));
        if (position.position_type === "text" && position.new_path === candidate.path &&
          position.new_line === candidate.newLineNumber &&
          ["base_sha", "start_sha", "head_sha"].every(key => position[key] === diff[key])) return true;
      } catch (_error) { /* Malformed row identity cannot authorize a marker. */ }
    }
    return false;
  }

  function readNewPath(fileNode) {
    const structured = fileNode.getAttribute("data-new-path");
    if (contracts.isSafeRepoPath(structured)) return structured;

    const title = fileNode.querySelector(".file-title-name[data-title]");
    const displayed = title && title.getAttribute("data-title");
    if (!contracts.isSafeRepoPath(displayed)) return null;
    if (RENAME_MARKERS.some((marker) => displayed.includes(marker))) return null;
    return displayed;
  }

  function parseLineNumber(cell) {
    const raw = cell && cell.getAttribute("data-linenumber");
    if (!/^[1-9]\d*$/.test(raw || "")) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  }

  function scanFile(fileNode) {
    const path = readNewPath(fileNode);
    const result = {
      element: fileNode,
      path,
      view: fileNode.getAttribute("data-view") || "unknown",
      lines: [],
      ambiguous: path === null,
      collapsed: false,
    };
    const cells = Array.from(fileNode.querySelectorAll(NEW_LINE_SELECTOR));
    const byNumber = new Map();
    for (const cell of cells) {
      const lineNumber = parseLineNumber(cell);
      if (lineNumber === null) {
        result.ambiguous = true;
        continue;
      }
      if (byNumber.has(lineNumber)) {
        result.ambiguous = true;
        continue;
      }
      const line = { path, newLineNumber: lineNumber, target: cell };
      byNumber.set(lineNumber, line);
      result.lines.push(line);
    }
    result.collapsed = result.lines.length === 0 && Boolean(fileNode.querySelector("a.click-to-expand"));
    return result;
  }

  function scanDiff(documentNode) {
    const files = Array.from(documentNode.querySelectorAll(FILE_SELECTOR)).map(scanFile);
    const pathCounts = new Map();
    for (const file of files) {
      if (file.path) pathCounts.set(file.path, (pathCounts.get(file.path) || 0) + 1);
    }
    for (const file of files) {
      if (file.path && pathCounts.get(file.path) !== 1) file.ambiguous = true;
    }
    return {
      files,
      fileCount: files.length,
      renderedLineCount: files.reduce((sum, file) => sum + file.lines.length, 0),
      ambiguousFileCount: files.filter((file) => file.ambiguous).length,
      collapsedFileCount: files.filter((file) => file.collapsed).length,
    };
  }

  function findSummaryMount(documentNode) {
    return documentNode.querySelector(".diffs") || documentNode.querySelector(".content-body");
  }

  return {
    FILE_SELECTOR,
    NEW_LINE_SELECTOR,
    findSummaryMount,
    parseLineNumber,
    readNewPath,
    readPageVersion,
    lineMatchesDiff,
    readVersionState,
    scanDiff,
    scanFile,
  };
});
