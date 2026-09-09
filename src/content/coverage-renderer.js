(function attachCoverageRenderer(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.IOSCoverageRenderer = api;
})(typeof globalThis === "object" ? globalThis : self, function createRenderer() {
  "use strict";

  const NAMESPACE = "ioscov";
  const SUMMARY_ID = `${NAMESPACE}-summary`;
  const MARKER_CLASS = `${NAMESPACE}-line-marker`;
  const STATUS_META = {
    covered: { symbol: "✓", label: "已覆盖" },
    uncovered: { symbol: "×", label: "未覆盖" },
    not_measurable: { symbol: "·", label: "不可测量" },
    unknown: { symbol: "?", label: "未知" },
  };
  const SOURCE_LABELS = {
    current_build: "当前 Build",
    historical_inheritance: "历史继承",
    mixed: "当前与历史共同命中",
    none: "无命中来源",
  };
  const SUMMARY_MESSAGES = {
    unconfigured: "尚未配置 Coverage 服务、GitLab origin 或 Token",
    loading: "正在加载 Coverage 报告…",
    unreachable: "Coverage 服务不可达",
    invalid_token: "Coverage Token 无效或权限不足",
    service_error: "Coverage 服务返回了无法验证的响应",
    cycle_not_found: "未找到对应的 Coverage Cycle",
    report_not_available: "Cycle 尚无成功报告",
    analysis_pending: "Coverage 分析正在排队或运行",
    analysis_failed: "Coverage 分析失败，且没有可用旧报告",
    analysis_failed_with_report: "最新分析失败，正在展示上一次成功报告摘要",
    ready: "报告身份已验证，可展示逐行覆盖状态",
    stale_diff: "报告与当前 MR diff 不一致或无法验证",
    mr_not_open: "当前 MR 不是打开状态",
    mr_diff_refs_not_ready: "GitLab 当前 MR diff 身份尚未就绪",
    historical_diff: "当前仅支持 MR 的最新 diff",
    dom_unsupported: "当前 GitLab diff DOM 暂不支持逐行标注",
    unsupported: "当前页面不受支持",
  };

  function element(documentNode, tag, className, text) {
    const node = documentNode.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function clearLineMarkers(rootNode) {
    for (const marker of Array.from(rootNode.querySelectorAll(`.${MARKER_CLASS}`))) {
      marker.remove();
    }
    for (const file of Array.from(rootNode.querySelectorAll(`.${NAMESPACE}-file-dimmed`))) {
      file.classList.remove(`${NAMESPACE}-file-dimmed`);
    }
  }

  function clearAll(rootNode) {
    clearLineMarkers(rootNode);
    const summary = rootNode.querySelector(`#${SUMMARY_ID}`);
    if (summary) summary.remove();
  }

  function shortSha(value) {
    return typeof value === "string" && value.length >= 8 ? value.slice(0, 8) : "—";
  }

  function formatPercent(value) {
    return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
  }

  function appendMetric(documentNode, container, label, value) {
    const metric = element(documentNode, "span", `${NAMESPACE}-metric`);
    metric.append(
      element(documentNode, "span", `${NAMESPACE}-metric-label`, label),
      element(documentNode, "strong", `${NAMESPACE}-metric-value`, value),
    );
    container.append(metric);
  }

  function renderSummary(documentNode, mountNode, viewModel, actions) {
    let summary = documentNode.querySelector(`#${SUMMARY_ID}`);
    if (summary) summary.remove();
    summary = element(documentNode, "section", `${NAMESPACE}-summary`);
    summary.id = SUMMARY_ID;
    summary.setAttribute("aria-live", "polite");

    const heading = element(documentNode, "div", `${NAMESPACE}-summary-heading`);
    heading.append(
      element(documentNode, "strong", `${NAMESPACE}-title`, "iOS Coverage"),
      element(
        documentNode,
        "span",
        `${NAMESPACE}-status ${NAMESPACE}-status-${viewModel.status}`,
        SUMMARY_MESSAGES[viewModel.status] || SUMMARY_MESSAGES.unsupported,
      ),
    );
    summary.append(heading);

    if (viewModel.summary) {
      const metrics = element(documentNode, "div", `${NAMESPACE}-metrics`);
      appendMetric(
        documentNode,
        metrics,
        "covered / measurable",
        `${viewModel.summary.covered} / ${viewModel.summary.measurable}`,
      );
      appendMetric(documentNode, metrics, "覆盖率", formatPercent(viewModel.summary.changed_line_coverage_percent));
      appendMetric(documentNode, metrics, "uncovered", viewModel.summary.uncovered);
      appendMetric(documentNode, metrics, "not_measurable", viewModel.summary.not_measurable);
      appendMetric(documentNode, metrics, "unknown", viewModel.summary.unknown);
      if (Number.isInteger(viewModel.uncoveredFileCount)) {
        appendMetric(documentNode, metrics, "未覆盖文件", viewModel.uncoveredFileCount);
      }
      summary.append(metrics);
    }

    const metadata = element(documentNode, "div", `${NAMESPACE}-metadata`);
    if (Number.isInteger(viewModel.generation)) {
      metadata.append(element(documentNode, "span", "", `generation ${viewModel.generation}`));
    }
    if (viewModel.updatedAt) {
      metadata.append(element(documentNode, "span", "", `报告更新 ${viewModel.updatedAt}`));
    }
    if (viewModel.buildSha) {
      metadata.append(element(documentNode, "span", "", `Build ${shortSha(viewModel.buildSha)}`));
    }
    if (Number.isInteger(viewModel.unrenderedFileCount) && viewModel.unrenderedFileCount > 0) {
      metadata.append(element(documentNode, "span", "", `尚未标注文件 ${viewModel.unrenderedFileCount}`));
    }
    if (metadata.children.length > 0) summary.append(metadata);

    const controls = element(documentNode, "div", `${NAMESPACE}-controls`);
    const refresh = element(documentNode, "button", `${NAMESPACE}-button`, "刷新");
    refresh.type = "button";
    refresh.addEventListener("click", () => actions.onRefresh());
    controls.append(refresh);

    if (viewModel.reportPageUrl) {
      const report = element(documentNode, "a", `${NAMESPACE}-button`, "完整报告");
      report.href = viewModel.reportPageUrl;
      report.target = "_blank";
      report.rel = "noreferrer noopener";
      controls.append(report);
    }

    const settings = element(documentNode, "button", `${NAMESPACE}-button`, "设置");
    settings.type = "button";
    settings.addEventListener("click", () => actions.onOpenSettings());
    controls.append(settings);

    if (viewModel.canAnnotate) {
      const filterLabel = element(documentNode, "label", `${NAMESPACE}-filter`);
      const filter = element(documentNode, "input");
      filter.type = "checkbox";
      filter.addEventListener("change", () => actions.onFilter(Boolean(filter.checked)));
      filterLabel.append(filter, documentNode.createTextNode(" 只看未覆盖"));
      controls.append(filterLabel);
    }
    summary.append(controls);
    mountNode.prepend(summary);
    return summary;
  }

  function buildLineIndex(fileDetails) {
    const byPath = new Map();
    for (const detail of fileDetails) {
      const path = detail && detail.file && detail.file.repo_relative_path;
      if (typeof path !== "string" || byPath.has(path)) {
        if (typeof path === "string") byPath.set(path, null);
        continue;
      }
      const lines = new Map();
      let valid = true;
      for (const line of detail.lines || []) {
        if (lines.has(line.new_line_number)) {
          valid = false;
          break;
        }
        lines.set(line.new_line_number, line);
      }
      byPath.set(path, valid ? lines : null);
    }
    return byPath;
  }

  function planAnnotations(scan, fileDetails, canAnnotate) {
    if (!canAnnotate) return [];
    const index = buildLineIndex(fileDetails);
    const plan = [];
    for (const file of scan.files || []) {
      if (file.ambiguous || !file.path) continue;
      const lines = index.get(file.path);
      if (!(lines instanceof Map)) continue;
      for (const candidate of file.lines) {
        const coverage = lines.get(candidate.newLineNumber);
        if (coverage) plan.push({ ...candidate, coverage, fileElement: file.element });
      }
    }
    return plan;
  }

  function markerDescription(line) {
    const meta = STATUS_META[line.state];
    const source = SOURCE_LABELS[line.coverage_source] || SOURCE_LABELS.none;
    const regions = Array.isArray(line.regions) ? line.regions : [];
    const coveredRegions = regions.filter((region) => region && region.covered).length;
    const partial = line.state === "uncovered" && coveredRegions > 0;
    return `${meta.label}；来源：${source}${partial ? "；部分 region 未覆盖" : ""}`;
  }

  function updateMarker(marker, line, generation) {
    const meta = STATUS_META[line.state];
    marker.className = `${MARKER_CLASS} ${NAMESPACE}-state-${line.state}`;
    marker.dataset.generation = String(generation);
    marker.dataset.state = line.state;
    marker.textContent = meta.symbol;
    marker.setAttribute("role", "img");
    marker.setAttribute("aria-label", markerDescription(line));
    marker.setAttribute("title", markerDescription(line));
  }

  function applyAnnotationPlan(rootNode, plan, generation, canAnnotate) {
    const markers = Array.from(rootNode.querySelectorAll(`.${MARKER_CLASS}`));
    if (!canAnnotate) {
      clearLineMarkers(rootNode);
      return { annotated: 0 };
    }
    if (markers.some((marker) => marker.dataset.generation !== String(generation))) {
      clearLineMarkers(rootNode);
    }
    let annotated = 0;
    for (const item of plan) {
      let marker = item.target.querySelector(`.${MARKER_CLASS}`);
      if (!marker) {
        marker = rootNode.createElement("span");
        item.target.append(marker);
      }
      updateMarker(marker, item.coverage, generation);
      annotated += 1;
    }
    return { annotated };
  }

  function applyUncoveredFilter(rootNode, enabled) {
    for (const file of Array.from(rootNode.querySelectorAll(".diff-file.file-holder"))) {
      const hasUncovered = Boolean(file.querySelector(`.${NAMESPACE}-state-uncovered`));
      file.classList.toggle(`${NAMESPACE}-file-dimmed`, enabled && !hasUncovered);
    }
  }

  return {
    MARKER_CLASS,
    SOURCE_LABELS,
    STATUS_META,
    SUMMARY_ID,
    applyAnnotationPlan,
    applyUncoveredFilter,
    buildLineIndex,
    clearAll,
    clearLineMarkers,
    markerDescription,
    planAnnotations,
    renderSummary,
  };
});
