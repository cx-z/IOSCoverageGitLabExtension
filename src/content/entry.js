(function attachContentEntry(root, factory) {
  const urls = root.IOSCoverageGitLabUrl ||
    (typeof require === "function" ? require("./gitlab-url.js") : null);
  const dom = root.IOSCoverageGitLabDom ||
    (typeof require === "function" ? require("./gitlab-dom-adapter.js") : null);
  const renderer = root.IOSCoverageRenderer ||
    (typeof require === "function" ? require("./coverage-renderer.js") : null);
  const api = factory(
    urls,
    dom,
    renderer,
    root,
  );
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.IOSCoverageContent = api;

  if (
    typeof document === "object" &&
    typeof chrome === "object" &&
    chrome.runtime &&
    chrome.runtime.sendMessage
  ) {
    if (root.__iosCoverageController) root.__iosCoverageController.destroy();
    root.__iosCoverageController = api.createController({
      documentNode: document,
      locationNode: location,
      sendMessage: (message) => chrome.runtime.sendMessage(message),
      setTimer: setTimeout,
      clearTimer: clearTimeout,
    });
    root.__iosCoverageController.start();
  }
})(typeof globalThis === "object" ? globalThis : self, function createContentEntry(urls, dom, renderer, host) {
  "use strict";

  function navigationChanged(previous, next) {
    if (!previous && !next) return false;
    if (!previous || !next) return true;
    return previous.identity !== next.identity || previous.pathname !== next.pathname;
  }

  function createController(dependencies) {
    const { documentNode, locationNode, sendMessage, setTimer, clearTimer } = dependencies;
    let observer = null;
    let debounceTimer = null;
    let pollTimer = null;
    let pollCount = 0;
    let requestGeneration = 0;
    let currentMr = null;
    let currentVersion = "unknown";
    let currentResult = null;
    let destroyed = false;
    const fileCache = new Map();

    function actions() {
      return {
        onRefresh: () => void refresh(true),
        onOpenSettings: () => void sendMessage({ action: "OPEN_OPTIONS" }),
        onFilter: (enabled) => renderer.applyUncoveredFilter(documentNode, enabled),
      };
    }

    function show(viewModel) {
      const mount = dom.findSummaryMount(documentNode);
      if (mount) renderer.renderSummary(documentNode, mount, viewModel, actions());
    }

    function resetLineState() {
      renderer.clearLineMarkers(documentNode);
      fileCache.clear();
    }

    function stopPolling() {
      if (pollTimer !== null) clearTimer(pollTimer);
      pollTimer = null;
    }

    function schedulePolling() {
      stopPolling();
      if (!currentResult || !currentResult.shouldPoll || pollCount >= 12 || documentNode.hidden) {
        return;
      }
      pollTimer = setTimer(() => {
        pollTimer = null;
        pollCount += 1;
        void refresh(false);
      }, 5000);
    }

    function errorStatus(code) {
      if (code === "unreachable") return "unreachable";
      if (code === "invalid_token") return "invalid_token";
      if (code === "unconfigured") return "unconfigured";
      return "service_error";
    }

    async function loadVisibleFileDetails(scan, result, token) {
      const reportFiles = new Map(result.files.map((file) => [file.repoRelativePath, file]));
      const paths = new Set();
      for (const file of scan.files) {
        if (!file.ambiguous && file.path && file.lines.length > 0 && reportFiles.has(file.path)) {
          paths.add(file.path);
        }
      }
      const details = await Promise.all(Array.from(paths).map(async (path) => {
        const descriptor = reportFiles.get(path);
        const cacheKey = `${result.cycleId}:${result.generation}:${descriptor.fileId}`;
        if (fileCache.has(cacheKey)) return fileCache.get(cacheKey);
        const response = await sendMessage({
          action: "LOAD_REPORT_FILE",
          cycleId: result.cycleId,
          generation: result.generation,
          fileId: descriptor.fileId,
        });
        if (token !== requestGeneration || !response || !response.ok) return null;
        fileCache.set(cacheKey, response.result);
        return response.result;
      }));
      return details.filter(Boolean);
    }

    async function annotateCurrent(token) {
      if (!currentResult || !currentResult.canAnnotate) {
        renderer.clearLineMarkers(documentNode);
        return { annotated: 0, unrendered: currentResult ? currentResult.reportFileCount || 0 : 0 };
      }
      const scan = dom.scanDiff(documentNode);
      if (scan.fileCount === 0 || scan.ambiguousFileCount > 0) {
        renderer.clearLineMarkers(documentNode);
        return { annotated: 0, unsupported: true, unrendered: currentResult.reportFileCount || 0 };
      }
      const details = await loadVisibleFileDetails(scan, currentResult, token);
      if (token !== requestGeneration) return { annotated: 0, interrupted: true };
      const plan = renderer.planAnnotations(scan, details, true);
      const applied = renderer.applyAnnotationPlan(
        documentNode,
        plan,
        currentResult.generation,
        true,
      );
      const renderedPaths = new Set(scan.files
        .filter((file) => !file.ambiguous && file.lines.length > 0)
        .map((file) => file.path));
      return {
        ...applied,
        unrendered: Math.max(0, (currentResult.reportFileCount || 0) - renderedPaths.size),
      };
    }

    function viewModel(result, extra = {}) {
      return {
        status: result.status,
        summary: result.summary,
        generation: result.generation,
        updatedAt: result.updatedAt,
        buildSha: result.buildSha,
        reportPageUrl: result.reportPageUrl,
        uncoveredFileCount: result.uncoveredFileCount,
        canAnnotate: result.canAnnotate,
        unrenderedFileCount: extra.unrendered,
      };
    }

    async function refresh(manual) {
      if (destroyed) return;
      const token = ++requestGeneration;
      const parsed = urls.parseMergeRequestUrl(locationNode.href);
      const version = parsed ? dom.readVersionState(documentNode) : "unknown";
      if (!parsed) {
        currentMr = null;
        currentResult = null;
        stopPolling();
        renderer.clearAll(documentNode);
        return;
      }
      if (manual || navigationChanged(currentMr, parsed) || version !== currentVersion) {
        pollCount = 0;
        resetLineState();
      }
      currentMr = parsed;
      currentVersion = version;
      show({ status: "loading", canAnnotate: false });

      let response;
      try {
        response = await sendMessage({
          action: "RESOLVE_MR",
          mr: parsed,
          versionState: version,
        });
      } catch (_error) {
        response = { ok: false, error: "unreachable" };
      }
      if (destroyed || token !== requestGeneration) return;
      if (!response || !response.ok) {
        currentResult = null;
        stopPolling();
        resetLineState();
        show({ status: errorStatus(response && response.error), canAnnotate: false });
        return;
      }

      const previousGeneration = currentResult && currentResult.generation;
      currentResult = response.result;
      if (previousGeneration !== undefined && previousGeneration !== currentResult.generation) {
        resetLineState();
      }
      if (!currentResult.canAnnotate) renderer.clearLineMarkers(documentNode);
      const annotation = await annotateCurrent(token);
      if (destroyed || token !== requestGeneration || annotation.interrupted) return;
      if (annotation.unsupported) {
        show(viewModel({ ...currentResult, status: "dom_unsupported", canAnnotate: false }, annotation));
      } else {
        show(viewModel(currentResult, annotation));
      }
      schedulePolling();
    }

    function isExtensionOwnedNode(node) {
      let element = node && node.nodeType === 1 ? node : node && node.parentElement;
      while (element) {
        if (
          element.id === renderer.SUMMARY_ID ||
          element.classList.contains(renderer.MARKER_CLASS)
        ) return true;
        element = element.parentElement;
      }
      return false;
    }

    function mutationIsExtensionOnly(mutation) {
      if (isExtensionOwnedNode(mutation.target)) return true;
      const changed = [...mutation.addedNodes, ...mutation.removedNodes];
      return changed.length > 0 && changed.every(isExtensionOwnedNode);
    }

    function onMutations(mutations) {
      if (destroyed || mutations.every(mutationIsExtensionOnly)) return;
      if (debounceTimer !== null) clearTimer(debounceTimer);
      debounceTimer = setTimer(() => {
        debounceTimer = null;
        const next = urls.parseMergeRequestUrl(locationNode.href);
        const nextVersion = next ? dom.readVersionState(documentNode) : "unknown";
        if (navigationChanged(currentMr, next) || nextVersion !== currentVersion) {
          void refresh(false);
        } else if (currentResult && currentResult.canAnnotate) {
          const token = requestGeneration;
          void annotateCurrent(token).then((annotation) => {
            if (!annotation.interrupted && currentResult) show(viewModel(currentResult, annotation));
          });
        }
      }, 180);
    }

    function onVisibilityChange() {
      if (documentNode.hidden) stopPolling();
      else if (currentResult && currentResult.shouldPoll) schedulePolling();
    }

    function onPopState() {
      void refresh(false);
    }

    function start() {
      observer = new MutationObserver(onMutations);
      observer.observe(documentNode.documentElement, { childList: true, subtree: true });
      documentNode.addEventListener("visibilitychange", onVisibilityChange);
      host.addEventListener("popstate", onPopState);
      host.addEventListener("pagehide", destroy, { once: true });
      void refresh(false);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      requestGeneration += 1;
      if (observer) observer.disconnect();
      if (debounceTimer !== null) clearTimer(debounceTimer);
      stopPolling();
      documentNode.removeEventListener("visibilitychange", onVisibilityChange);
      host.removeEventListener("popstate", onPopState);
      renderer.clearAll(documentNode);
    }

    return { destroy, refresh, start };
  }

  return { createController, navigationChanged };
});
