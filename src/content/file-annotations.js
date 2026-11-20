(function attachFileAnnotations(root, factory) {
  const dom = root.IOSCoverageGitLabDom ||
    (typeof require === "function" ? require("./gitlab-dom-adapter.js") : null);
  const renderer = root.IOSCoverageRenderer ||
    (typeof require === "function" ? require("./coverage-renderer.js") : null);
  const api = factory(dom, renderer);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.IOSCoverageFileAnnotations = api;
})(typeof globalThis === "object" ? globalThis : self, function createFileAnnotations(dom, renderer) {
  "use strict";

  const MAX_CONCURRENT_FILES = 4;
  const MARKERS_PER_BATCH = 200;
  const VIEWPORT_MARGIN = "600px 0px";

  // All mutable state belongs to one content-script controller on the browser main thread.
  function createScheduler(dependencies) {
    const {
      documentNode, sendMessage, setTimer, clearTimer, createIntersectionObserver,
      isCurrent, onProgress, observeFile,
    } = dependencies;
    const files = new Map();
    const pathCounts = new Map();
    const queue = new Set();
    const cache = new Map();
    const pendingDetails = new Map();
    const dirtyFiles = new Set();
    const addedRoots = new Set();
    let report = null;
    let descriptors = new Map();
    let epoch = 0;
    let active = 0;
    let paused = true;
    let destroyed = false;
    let initialized = false;
    let filterEnabled = false;
    let mutationTimer = null;

    const viewportObserver = createIntersectionObserver ? createIntersectionObserver((entries) => {
      if (destroyed) return;
      for (const entry of entries) {
        const file = files.get(entry.target);
        if (!file) continue;
        if (entry.isIntersecting && !file.visible && file.scan) markDirty(file);
        file.visible = entry.isIntersecting;
        updateClassObservation(file);
        if (file.visible && file.needsWork) queue.add(file);
        else if (!file.visible) queue.delete(file);
      }
      pump();
    }, { rootMargin: VIEWPORT_MARGIN }) : null;

    function attached(element) {
      return documentNode.documentElement.contains(element) && element.matches(dom.FILE_SELECTOR);
    }

    // Class changes matter only within nearby files; revisit offscreen snapshots on viewport entry.
    function updateClassObservation(file) {
      const enabled = file.visible && !paused && !destroyed;
      if (enabled && !file.classObserver && observeFile) file.classObserver = observeFile(file.element);
      if (!enabled && file.classObserver) {
        file.classObserver.disconnect();
        file.classObserver = null;
      }
    }

    function validFile(file) {
      return Boolean(file.path && pathCounts.get(file.path) === 1 && !(file.scan && file.scan.ambiguous));
    }

    function countPath(path, delta) {
      if (!path) return;
      const count = (pathCounts.get(path) || 0) + delta;
      if (count) pathCounts.set(path, count);
      else pathCounts.delete(path);
    }

    // A malformed file must not suppress other independently verified files.
    function unsupported() {
      return files.size === 0 || Array.from(files.values()).every(file => !validFile(file));
    }

    function statistics() {
      const annotatedPaths = new Set(Array.from(files.values())
        .filter((file) => file.annotated).map((file) => file.path));
      return {
        unsupported: unsupported(),
        unrendered: Math.max(0, (report ? report.reportFileCount || 0 : 0) - annotatedPaths.size),
      };
    }

    function clearFile(file) {
      if (file.hasMarkers) renderer.clearLineMarkers(file.element);
      file.hasMarkers = false;
      file.annotated = false;
    }

    function applyFilter(file) {
      const descriptor = descriptors.get(file.path);
      const dimmed = Boolean(filterEnabled && descriptor && descriptor.uncovered === 0);
      if (file.element.classList.contains("ioscov-file-dimmed") !== dimmed) {
        file.element.classList.toggle("ioscov-file-dimmed", dimmed);
      }
    }

    function setFilter(enabled) {
      filterEnabled = enabled;
      for (const file of files.values()) applyFilter(file);
    }

    function register(element) {
      if (files.has(element) || !attached(element)) return;
      const file = {
        element, path: dom.readNewPath(element), visible: !viewportObserver,
        revision: 0, scan: null, needsWork: true, working: false,
        annotated: false, hasMarkers: false,
        classObserver: null,
      };
      files.set(element, file);
      countPath(file.path, 1);
      if (viewportObserver) viewportObserver.observe(element);
      else queue.add(file);
      applyFilter(file);
      updateClassObservation(file);
    }

    function discover(rootNode) {
      const discoverFile = (element) => {
        const file = files.get(element);
        if (file) {
          // GitLab can detach, rebuild, and reinsert the same container between observer deliveries.
          markDirty(file);
          dirtyFiles.add(file);
        } else register(element);
      };
      if (rootNode.nodeType === 1 && rootNode.matches(dom.FILE_SELECTOR)) {
        discoverFile(rootNode);
        return;
      }
      for (const element of rootNode.querySelectorAll(dom.FILE_SELECTOR)) discoverFile(element);
    }

    function markDirty(file) {
      file.revision += 1;
      file.scan = null;
      file.needsWork = true;
      file.annotated = false;
      if (file.visible) queue.add(file);
    }

    // Keep mutation handling local: only new subtrees are searched for files; row scans are deferred.
    function handleMutations(mutations) {
      if (destroyed) return;
      for (const mutation of mutations) {
        const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        const element = target && (files.has(target) ? target : target.closest(dom.FILE_SELECTOR));
        if (element) {
          register(element);
          const file = files.get(element);
          if (file && mutation.type === "attributes" &&
              ["data-position", "data-new-path", "data-linenumber"].includes(mutation.attributeName)) clearFile(file);
          if (file && !dirtyFiles.has(file)) {
            markDirty(file); // Invalidates in-flight chunks before the debounce timer runs.
            dirtyFiles.add(file);
          }
        } else {
          for (const node of mutation.addedNodes || []) {
            if (node.nodeType === 1) addedRoots.add(node);
          }
        }
      }
      // A fixed window coalesces a stream of diff insertions without starving visible files.
      if (mutationTimer === null) mutationTimer = setTimer(flushMutations, 180);
    }

    function flushMutations() {
      mutationTimer = null;
      for (const [element, file] of files) {
        if (!attached(element)) {
          clearFile(file);
          element.classList.remove("ioscov-file-dimmed");
          if (viewportObserver) viewportObserver.unobserve(element);
          if (file.classObserver) file.classObserver.disconnect();
          countPath(file.path, -1);
          files.delete(element);
          queue.delete(file);
        }
      }
      for (const rootNode of addedRoots) {
        if (documentNode.documentElement.contains(rootNode)) discover(rootNode);
      }
      addedRoots.clear();
      for (const file of dirtyFiles) {
        if (files.get(file.element) !== file) continue;
        const path = dom.readNewPath(file.element);
        if (path !== file.path) {
          clearFile(file);
          countPath(file.path, -1);
          countPath(path, 1);
        }
        file.path = path;
        applyFilter(file);
      }
      dirtyFiles.clear();
      pump();
      notify();
    }

    function notify() {
      if (!paused && !destroyed && isCurrent()) onProgress(statistics());
    }

    // Requests are shared by exact report/file identity, including while they are in flight.
    function loadDetail(snapshot, descriptor, jobEpoch) {
      const key = `${snapshot.cycleId}:${snapshot.generation}:${snapshot.presentationId || "legacy"}:${descriptor.fileId}`;
      if (cache.has(key)) return Promise.resolve(cache.get(key));
      if (pendingDetails.has(key)) return pendingDetails.get(key);
      const task = Promise.resolve().then(() => sendMessage({
        action: "LOAD_REPORT_FILE", cycleId: snapshot.cycleId,
        generation: snapshot.generation, fileId: descriptor.fileId,
        ...(snapshot.presentationId ? { presentationId: snapshot.presentationId } : {}),
      })).then((response) => {
        if (jobEpoch !== epoch || !response || !response.ok) return null;
        const detail = response.result;
        if (
          !detail || (snapshot.presentationId && detail.presentation_id !== snapshot.presentationId) || detail.cycle_id !== snapshot.cycleId || detail.generation !== snapshot.generation ||
          detail.file.file_id !== descriptor.fileId || detail.file.repo_relative_path !== descriptor.repoRelativePath
        ) return null;
        cache.set(key, detail);
        return detail;
      }).catch(() => null).finally(() => {
        if (pendingDetails.get(key) === task) pendingDetails.delete(key);
      });
      pendingDetails.set(key, task);
      return task;
    }

    function validJob(file, jobEpoch, revision) {
      return !destroyed && !paused && jobEpoch === epoch && revision === file.revision &&
        files.get(file.element) === file && attached(file.element) && isCurrent() && validFile(file);
    }

    async function processFile(file, snapshot, jobEpoch) {
      const revision = file.revision;
      if (!file.scan) file.scan = dom.scanFile(file.element);
      if (!validJob(file, jobEpoch, revision)) return;
      const descriptor = descriptors.get(file.path);
      if (!descriptor || file.scan.lines.length === 0) {
        clearFile(file);
        return;
      }
      const detail = await loadDetail(snapshot, descriptor, jobEpoch);
      if (!detail || !validJob(file, jobEpoch, revision)) return;
      const verifiedScan = snapshot.targetDiff ? { ...file.scan,
        lines: file.scan.lines.filter(line => dom.lineMatchesDiff(line, snapshot.targetDiff)) } : file.scan;
      const plan = renderer.planAnnotations({ files: [verifiedScan] }, [detail], true);
      renderer.pruneLineMarkers(file.element, plan);
      for (let offset = 0; offset < plan.length; offset += MARKERS_PER_BATCH) {
        if (!validJob(file, jobEpoch, revision)) return;
        renderer.applyLineMarkers(documentNode, plan.slice(offset, offset + MARKERS_PER_BATCH), snapshot.generation);
        file.hasMarkers = true;
        if (offset + MARKERS_PER_BATCH < plan.length) await new Promise((resolve) => setTimer(resolve, 0));
      }
      file.annotated = plan.length > 0;
      applyFilter(file);
    }

    function pump() {
      if (paused || destroyed || !report || documentNode.hidden || !isCurrent()) return;
      for (const file of files.values()) {
        if (!validFile(file)) {
          clearFile(file);
          file.needsWork = true;
          queue.delete(file);
        } else if (file.visible && file.needsWork) queue.add(file);
      }
      for (const file of queue) {
        if (active >= MAX_CONCURRENT_FILES) break;
        if (file.working || dirtyFiles.has(file)) continue;
        queue.delete(file);
        if (!file.visible || !file.needsWork || !attached(file.element)) continue;
        file.needsWork = false;
        file.working = true;
        active += 1;
        const jobEpoch = epoch;
        void processFile(file, report, jobEpoch).catch(() => {
          if (jobEpoch === epoch) clearFile(file);
        }).finally(() => {
          file.working = false;
          active -= 1;
          if (file.needsWork && file.visible && files.get(file.element) === file) queue.add(file);
          pump();
          notify();
        });
      }
    }

    // Suspend commits immediately during resolver refreshes; outstanding network slots remain counted.
    function suspend(clear = false) {
      paused = true;
      epoch += 1;
      queue.clear();
      pendingDetails.clear();
      for (const file of files.values()) {
        file.needsWork = true;
        if (clear) {
          clearFile(file);
          file.scan = null;
          updateClassObservation(file);
        }
      }
      if (clear) {
        cache.clear();
        report = null;
        descriptors.clear();
        setFilter(false);
      }
    }

    function setReport(next) {
      const changed = !report || report.cycleId !== next.cycleId || report.generation !== next.generation ||
        report.presentationId !== next.presentationId;
      if (changed || !next.canAnnotate) suspend(true);
      report = next;
      if (!next.canAnnotate) return statistics();
      descriptors = new Map((next.files || []).map((file) => [file.repoRelativePath, file]));
      if (!initialized) {
        initialized = true;
        discover(documentNode);
      }
      paused = false;
      for (const file of files.values()) {
        applyFilter(file);
        updateClassObservation(file);
        if (file.visible && file.needsWork) queue.add(file);
      }
      pump();
      return statistics();
    }

    function destroy() {
      suspend(true);
      destroyed = true;
      if (viewportObserver) viewportObserver.disconnect();
      if (mutationTimer !== null) clearTimer(mutationTimer);
      files.clear();
      pathCounts.clear();
      dirtyFiles.clear();
      addedRoots.clear();
    }

    return { destroy, handleMutations, resume: pump, setFilter, setReport, statistics, suspend };
  }

  return { createScheduler, MAX_CONCURRENT_FILES, MARKERS_PER_BATCH, VIEWPORT_MARGIN };
});
