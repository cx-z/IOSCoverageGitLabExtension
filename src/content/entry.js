(function attachContentEntry(root, factory) {
  const urls = root.IOSCoverageGitLabUrl ||
    (typeof require === "function" ? require("./gitlab-url.js") : null);
  const dom = root.IOSCoverageGitLabDom ||
    (typeof require === "function" ? require("./gitlab-dom-adapter.js") : null);
  const renderer = root.IOSCoverageRenderer ||
    (typeof require === "function" ? require("./coverage-renderer.js") : null);
  const annotations = root.IOSCoverageFileAnnotations ||
    (typeof require === "function" ? require("./file-annotations.js") : null);
  const api = factory(
    urls,
    dom,
    renderer,
    annotations,
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
})(typeof globalThis === "object" ? globalThis : self, function createContentEntry(urls, dom, renderer, annotations, host) {
  "use strict";

  function navigationChanged(previous, next) {
    if (!previous && !next) return false;
    if (!previous || !next) return true;
    return previous.identity !== next.identity || previous.pathname !== next.pathname;
  }

  function createController(dependencies) {
    const { documentNode, locationNode, sendMessage, setTimer, clearTimer } = dependencies;
    let observer = null;
    let versionObserver = null;
    let versionRoot = null;
    let debounceTimer = null;
    let pollTimer = null;
    let requestGeneration = 0;
    let currentMr = null;
    let currentVersion = "unknown";
    let currentPageVersion = null;
    let currentResult = null;
    let uncoveredFilterEnabled = false;
    let destroyed = false;
    let resolving = false;
    let pageIdentityInvalidated = false;
    const eventTarget = dependencies.eventTarget || host;
    const createMutationObserver = dependencies.createMutationObserver ||
      (typeof host.MutationObserver === "function" ? ((callback) => new host.MutationObserver(callback)) : null);
    const createIntersectionObserver = dependencies.createIntersectionObserver ||
      (typeof host.IntersectionObserver === "function" ?
        ((callback, options) => new host.IntersectionObserver(callback, options)) : null);
    const fileAnnotations = annotations.createScheduler({
      documentNode, sendMessage, setTimer, clearTimer, createIntersectionObserver,
      observeFile: createMutationObserver ? (element) => {
        const scopedObserver = createMutationObserver(onMutations);
        scopedObserver.observe(element, { attributes: true, attributeOldValue: true,
          attributeFilter: ["class"], subtree: true });
        return scopedObserver;
      } : null,
      isCurrent: () => !destroyed && !resolving && currentResult && currentResult.canAnnotate &&
        !navigationChanged(currentMr, urls.parseMergeRequestUrl(locationNode.href)) &&
        currentVersion === dom.readVersionState(documentNode) &&
        currentPageVersion === dom.readPageVersion(documentNode, locationNode.href),
      onProgress: (progress) => showResult(progress),
    });

    function actions() {
      return {
        onRefresh: () => void refresh(true),
        onOpenSettings: () => void sendMessage({ action: "OPEN_OPTIONS" }),
        onFilter: (enabled) => {
          uncoveredFilterEnabled = enabled;
          fileAnnotations.setFilter(enabled);
        },
      };
    }

    function show(viewModel) {
      const mount = dom.findSummaryMount(documentNode);
      if (mount) renderer.renderSummary(documentNode, mount, viewModel, actions());
    }

    function resetLineState() {
      fileAnnotations.suspend(true);
    }

    function stopPolling() {
      if (pollTimer !== null) clearTimer(pollTimer);
      pollTimer = null;
    }

    function schedulePolling() {
      stopPolling();
      if (!currentResult || !currentResult.shouldPoll || documentNode.hidden) {
        return;
      }
      pollTimer = setTimer(() => {
        pollTimer = null;
        void refresh(false);
      }, currentResult.presentationId ? 15000 : 5000);
    }

    function errorStatus(code) {
      if (code === "unreachable") return "unreachable";
      if (code === "invalid_token") return "invalid_token";
      if (code === "unconfigured") return "unconfigured";
      return "service_error";
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
        strictMatch: result.strictMatch,
        uncoveredFilterEnabled,
        unrenderedFileCount: extra.unrendered,
      };
    }

    function showResult(progress) {
      if (!currentResult || destroyed || resolving) return;
      const result = progress.unsupported && currentResult.canAnnotate ?
        { ...currentResult, status: "dom_unsupported", canAnnotate: false } : currentResult;
      show(viewModel(result, progress));
    }

    async function refresh(manual) {
      if (destroyed) return;
      const token = ++requestGeneration;
      pageIdentityInvalidated = false;
      resolving = true;
      fileAnnotations.suspend();
      const parsed = urls.parseMergeRequestUrl(locationNode.href);
      const version = parsed ? dom.readVersionState(documentNode) : "unknown";
      if (!parsed) {
        currentMr = null;
        currentResult = null;
        resolving = false;
        uncoveredFilterEnabled = false;
        stopPolling();
        resetLineState();
        renderer.clearAll(documentNode);
        return;
      }
      const pageVersion = dom.readPageVersion(documentNode, locationNode.href);
      const mrChanged = navigationChanged(currentMr, parsed);
      const versionChanged = version !== currentVersion || pageVersion !== currentPageVersion;
      if (mrChanged || versionChanged) uncoveredFilterEnabled = false;
      if (manual || mrChanged || versionChanged) {
        resetLineState();
      }
      currentMr = parsed;
      currentVersion = version;
      currentPageVersion = pageVersion;
      if (!currentResult || manual || mrChanged || versionChanged) show({ status: "loading", canAnnotate: false });

      let response;
      try {
        response = await sendMessage({
          action: "RESOLVE_MR",
          mr: parsed,
          versionState: version,
          pageVersion,
        });
      } catch (_error) {
        response = { ok: false, error: "unreachable" };
      }
      if (destroyed || token !== requestGeneration) return;
      // A route/version may change before MutationObserver's debounce callback fires.
      if (
        navigationChanged(parsed, urls.parseMergeRequestUrl(locationNode.href)) ||
        version !== dom.readVersionState(documentNode) ||
        pageVersion !== dom.readPageVersion(documentNode, locationNode.href)
      ) {
        void refresh(false);
        return;
      }
      resolving = false;
      if (!response || !response.ok) {
        currentResult = null;
        stopPolling();
        resetLineState();
        show({ status: errorStatus(response && response.error), canAnnotate: false });
        return;
      }

      currentResult = response.result;
      // Publish the summary independently of file-detail latency.
      show(viewModel(currentResult));
      const progress = fileAnnotations.setReport(currentResult);
      fileAnnotations.setFilter(uncoveredFilterEnabled);
      showResult(progress);
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
      if (mutation.type === "attributes" && mutation.attributeName === "class") {
        const withoutFilter = (value) => (value || "").split(/\s+/)
          .filter((name) => name && name !== "ioscov-file-dimmed").join(" ");
        // SVGElement.className is SVGAnimatedString, whereas the attribute is always text.
        if (withoutFilter(mutation.oldValue) === withoutFilter(mutation.target.getAttribute("class"))) return true;
      }
      const changed = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
      return changed.length > 0 && changed.every(isExtensionOwnedNode);
    }

    function onMutations(mutations) {
      if (destroyed) return;
      const external = mutations.filter((mutation) => !mutationIsExtensionOnly(mutation));
      if (external.length === 0) return;
      // Invalidate before debounce so late file chunks cannot cross page versions.
      if (currentPageVersion !== dom.readPageVersion(documentNode, locationNode.href)) {
        requestGeneration += 1;
        pageIdentityInvalidated = true;
        resetLineState();
      }
      fileAnnotations.handleMutations(external);
      if (debounceTimer !== null) return;
      debounceTimer = setTimer(() => {
        debounceTimer = null;
        observeVersion();
        const next = urls.parseMergeRequestUrl(locationNode.href);
        const nextVersion = next ? dom.readVersionState(documentNode) : "unknown";
        if (pageIdentityInvalidated || navigationChanged(currentMr, next) || nextVersion !== currentVersion ||
          currentPageVersion !== dom.readPageVersion(documentNode, locationNode.href)) {
          void refresh(false);
        }
      }, 180);
    }

    function onVisibilityChange() {
      if (documentNode.hidden) stopPolling();
      else {
        fileAnnotations.resume();
        if (currentResult && currentResult.shouldPoll) schedulePolling();
      }
    }

    function onPopState() {
      void refresh(false);
    }

    // Global class observation also captures GitLab spinners, SVG icons and syntax highlighting.
    function observeVersion() {
      const nextRoot = documentNode.querySelector(".mr-version-dropdown");
      if (versionRoot === nextRoot) return;
      if (versionObserver) versionObserver.disconnect();
      versionRoot = nextRoot;
      if (versionRoot && createMutationObserver) {
        versionObserver = createMutationObserver(onMutations);
        versionObserver.observe(versionRoot, { attributes: true, attributeOldValue: true,
          attributeFilter: ["class", "href"], subtree: true });
      }
    }

    function start() {
      observer = createMutationObserver(onMutations);
      observer.observe(documentNode.documentElement, {
        childList: true, subtree: true, attributes: true, attributeOldValue: true,
        attributeFilter: ["data-new-path", "data-title", "data-view", "data-linenumber", "data-position"],
      });
      observeVersion();
      documentNode.addEventListener("visibilitychange", onVisibilityChange);
      eventTarget.addEventListener("popstate", onPopState);
      eventTarget.addEventListener("pagehide", destroy, { once: true });
      void refresh(false);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      requestGeneration += 1;
      if (observer) observer.disconnect();
      if (versionObserver) versionObserver.disconnect();
      if (debounceTimer !== null) clearTimer(debounceTimer);
      stopPolling();
      documentNode.removeEventListener("visibilitychange", onVisibilityChange);
      eventTarget.removeEventListener("popstate", onPopState);
      eventTarget.removeEventListener("pagehide", destroy);
      fileAnnotations.destroy();
      renderer.clearAll(documentNode);
    }

    return { destroy, refresh, start };
  }

  return { createController, navigationChanged };
});
