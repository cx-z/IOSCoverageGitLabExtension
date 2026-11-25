(function attachContracts(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.IOSCoverageContracts = api;
})(typeof globalThis === "object" ? globalThis : self, function createContracts() {
  "use strict";

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  const SHA256 = /^[0-9a-f]{64}$/;
  const LINE_STATES = new Set(["covered", "uncovered", "not_measurable", "unknown"]);
  const COVERAGE_SOURCES = new Set([
    "current_build",
    "historical_inheritance",
    "mixed",
    "none",
  ]);
  const ANALYSIS_STATES = new Set(["idle", "queued", "running", "succeeded", "failed"]);
  const RESOLVER_STATUSES = new Set([
    "ready",
    "cycle_not_found",
    "report_not_available",
    "analysis_pending",
    "analysis_failed",
    "stale_diff",
    "mr_not_open",
    "mr_diff_refs_not_ready",
  ]);

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function isNonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0;
  }

  function hasExactKeys(value, keys) {
    if (!isRecord(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]);
  }

  function isSafeRepoPath(value) {
    if (typeof value !== "string" || value.length === 0 || value.startsWith("/")) {
      return false;
    }
    if (value.includes("\\") || value.includes("\0")) {
      return false;
    }
    const parts = value.split("/");
    return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
  }

  function isSummary(value) {
    if (!isRecord(value)) return false;
    const countKeys = [
      "changed_new_side",
      "measurable",
      "covered",
      "uncovered",
      "not_measurable",
      "unknown",
    ];
    if (!countKeys.every((key) => isNonNegativeInteger(value[key]))) return false;
    const percent = value.changed_line_coverage_percent;
    return percent === null || (typeof percent === "number" && Number.isFinite(percent));
  }

  function isStrictSummary(value) {
    return hasExactKeys(value, [
      "changed_new_side",
      "measurable",
      "covered",
      "uncovered",
      "not_measurable",
      "unknown",
      "changed_line_coverage_percent",
    ]) && isSummary(value);
  }

  function isTimestamp(value) {
    return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
  }

  function isDiff(value, allowNull) {
    if (!hasExactKeys(value, ["base_sha", "start_sha", "head_sha"])) return false;
    const values = [value.base_sha, value.start_sha, value.head_sha];
    return allowNull ? values.every((item) => item === null) : values.every((item) => SHA.test(item));
  }

  function sameDiff(left, right) {
    return left.base_sha === right.base_sha &&
      left.start_sha === right.start_sha &&
      left.head_sha === right.head_sha;
  }

  function validateResolverResponse(value) {
    const topKeys = [
      "schema_version",
      "status",
      "can_annotate",
      "should_poll",
      "mr",
      "cycle",
      "analysis",
      "report",
    ];
    if (
      !hasExactKeys(value, topKeys) ||
      value.schema_version !== 1 ||
      !RESOLVER_STATUSES.has(value.status) ||
      typeof value.can_annotate !== "boolean" ||
      typeof value.should_poll !== "boolean" ||
      !hasExactKeys(value.mr, ["host", "project_path", "iid", "canonical_url", "diff"]) ||
      typeof value.mr.host !== "string" ||
      value.mr.host.length === 0 ||
      !isSafeRepoPath(value.mr.project_path) ||
      !/^[1-9]\d*$/.test(value.mr.iid) ||
      typeof value.mr.canonical_url !== "string"
    ) {
      throw new Error("Resolver response is invalid");
    }

    const noDiff = value.status === "mr_not_open" || value.status === "mr_diff_refs_not_ready";
    if (!isDiff(value.mr.diff, noDiff)) throw new Error("Resolver MR diff is invalid");

    if (value.cycle !== null && !hasExactKeys(value.cycle, ["id"])) {
      throw new Error("Resolver Cycle is invalid");
    }
    if (value.cycle !== null && !UUID.test(value.cycle.id)) {
      throw new Error("Resolver Cycle is invalid");
    }

    if (value.analysis !== null) {
      if (
        !hasExactKeys(value.analysis, ["status", "requested_generation", "completed_generation"]) ||
        !ANALYSIS_STATES.has(value.analysis.status) ||
        !isNonNegativeInteger(value.analysis.requested_generation) ||
        !isNonNegativeInteger(value.analysis.completed_generation)
      ) {
        throw new Error("Resolver analysis is invalid");
      }
    }

    if (value.report !== null) {
      if (
        !hasExactKeys(value.report, [
          "generation",
          "updated_at",
          "current_build_id",
          "summary",
          "build_diff",
          "summary_api",
        ]) ||
        !isNonNegativeInteger(value.report.generation) ||
        !isTimestamp(value.report.updated_at) ||
        !UUID.test(value.report.current_build_id) ||
        !isStrictSummary(value.report.summary) ||
        !isDiff(value.report.build_diff, false) ||
        typeof value.report.summary_api !== "string" ||
        value.cycle === null ||
        value.report.summary_api !== `/api/v1/cycles/${value.cycle.id}/report`
      ) {
        throw new Error("Resolver report is invalid");
      }
    }

    const emptyProductState = noDiff || value.status === "cycle_not_found";
    if (emptyProductState && (
      value.can_annotate || value.should_poll || value.cycle !== null ||
      value.analysis !== null || value.report !== null
    )) {
      throw new Error("Resolver empty state is inconsistent");
    }
    if (value.status === "report_not_available" && (
      value.can_annotate || value.should_poll || value.cycle === null ||
      value.analysis === null || value.report !== null
    )) {
      throw new Error("Resolver report state is inconsistent");
    }
    if (value.status === "analysis_pending" && (
      !value.should_poll || value.cycle === null || value.analysis === null ||
      !["queued", "running"].includes(value.analysis.status) ||
      (value.can_annotate !== (value.report !== null))
    )) {
      throw new Error("Resolver pending state is inconsistent");
    }
    if (value.status === "analysis_failed" && (
      value.should_poll || value.cycle === null || value.analysis === null ||
      value.analysis.status !== "failed" ||
      (value.can_annotate !== (value.report !== null))
    )) {
      throw new Error("Resolver failed state is inconsistent");
    }
    if (value.status === "ready" && (
      !value.can_annotate || value.should_poll || value.cycle === null ||
      value.analysis === null || value.report === null ||
      ["queued", "running", "failed"].includes(value.analysis.status)
    )) {
      throw new Error("Resolver ready state is inconsistent");
    }
    if (value.status === "stale_diff" && (
      value.can_annotate || value.cycle === null || value.analysis === null ||
      value.report === null ||
      value.should_poll !== ["queued", "running"].includes(value.analysis.status) ||
      sameDiff(value.mr.diff, value.report.build_diff)
    )) {
      throw new Error("Resolver stale state is inconsistent");
    }
    if (value.can_annotate && (
      value.report === null || !sameDiff(value.mr.diff, value.report.build_diff)
    )) {
      throw new Error("Resolver annotation identity is inconsistent");
    }
    return value;
  }

  function validateCycleList(value) {
    if (!isRecord(value) || !Array.isArray(value.cycles) || value.count !== value.cycles.length) {
      throw new Error("Cycle list response is invalid");
    }
    for (const cycle of value.cycles) {
      if (
        !isRecord(cycle) ||
        !UUID.test(cycle.id) ||
        typeof cycle.gitlab_host !== "string" ||
        !isSafeRepoPath(cycle.gitlab_project_path) ||
        !/^\d+$/.test(String(cycle.mr_iid))
      ) {
        throw new Error("Cycle item is invalid");
      }
    }
    return value;
  }

  function validateCycleDetail(value) {
    if (!isRecord(value) || !isRecord(value.cycle) || !UUID.test(value.cycle.id)) {
      throw new Error("Cycle detail response is invalid");
    }
    return value;
  }

  function validateAnalysis(value) {
    if (!isRecord(value) || !UUID.test(value.cycle_id) || !ANALYSIS_STATES.has(value.status)) {
      throw new Error("Analysis response is invalid");
    }
    if (value.latest_success !== null && value.latest_success !== undefined) {
      if (
        !isRecord(value.latest_success) ||
        !isNonNegativeInteger(value.latest_success.generation) ||
        !UUID.test(value.latest_success.current_build_id) ||
        !isSummary(value.latest_success.summary)
      ) {
        throw new Error("Latest success response is invalid");
      }
    }
    return value;
  }

  function validateReport(value) {
    if (
      !isRecord(value) ||
      value.schema_version !== 1 ||
      value.status !== "complete" ||
      !UUID.test(value.cycle_id) ||
      !UUID.test(value.current_build_id) ||
      !isNonNegativeInteger(value.generation) ||
      !isTimestamp(value.updated_at) ||
      !isSummary(value.summary) ||
      !Array.isArray(value.files)
    ) {
      throw new Error("Report response is invalid");
    }
    const fileIds = new Set();
    const paths = new Set();
    for (const file of value.files) {
      if (
        !isRecord(file) ||
        !SHA256.test(file.file_id) ||
        !isSafeRepoPath(file.repo_relative_path) ||
        !isNonNegativeInteger(file.uncovered) ||
        fileIds.has(file.file_id) ||
        paths.has(file.repo_relative_path)
      ) {
        throw new Error("Report file is invalid");
      }
      fileIds.add(file.file_id);
      paths.add(file.repo_relative_path);
    }
    return value;
  }

  function validateFileDetail(value) {
    if (
      !isRecord(value) ||
      value.schema_version !== 1 ||
      !UUID.test(value.cycle_id) ||
      !isNonNegativeInteger(value.generation) ||
      !isRecord(value.file) ||
      !SHA256.test(value.file.file_id) ||
      !isSafeRepoPath(value.file.repo_relative_path) ||
      !Array.isArray(value.lines)
    ) {
      throw new Error("Report file response is invalid");
    }
    for (const line of value.lines) {
      if (
        !isRecord(line) ||
        !Number.isInteger(line.new_line_number) ||
        line.new_line_number <= 0 ||
        !LINE_STATES.has(line.state) ||
        !COVERAGE_SOURCES.has(line.coverage_source) ||
        !Array.isArray(line.regions) ||
        line.regions.some((region) => !isRecord(region) || typeof region.covered !== "boolean")
      ) {
        throw new Error("Report line is invalid");
      }
    }
    return value;
  }

  function isMappedSummary(value) {
    // Older schema-2 servers expose categories only; newer ones provide the MR ratio.
    if (value.measurable === 0 && value.changed_line_coverage_percent === null) return true;
    const measurable = value.covered + value.uncovered;
    return value.measurable === measurable && measurable > 0 &&
      typeof value.changed_line_coverage_percent === "number" &&
      Math.abs(value.changed_line_coverage_percent - value.covered / measurable * 100) <= 1e-9;
  }

  function validatePresentationResolver(value) {
    if (!hasExactKeys(value, ["schema_version", "status", "can_annotate", "should_poll", "mr", "cycle",
      "analysis", "report", "page_version", "presentation_id", "projection"]) || value.schema_version !== 2 ||
      (typeof value.page_version !== "string" || !/^[1-9][0-9]{0,18}$/.test(value.page_version))) throw new Error("Invalid MR presentation");
    if ((!RESOLVER_STATUSES.has(value.status) && value.status !== "page_version_unverified") ||
      typeof value.can_annotate !== "boolean" || typeof value.should_poll !== "boolean" ||
      (value.status === "page_version_unverified" && value.can_annotate)) throw new Error("Invalid presentation status");
    // Validate the RECEIVED schema-2 state before adapting only reference shapes.
    const analysis = value.analysis;
    const hasReport = value.report !== null;
    const hasProjection = value.projection !== null;
    const pending = isRecord(analysis) && ["queued", "running"].includes(analysis.status);
    const empty = ["mr_not_open", "mr_diff_refs_not_ready", "cycle_not_found"].includes(value.status);
    if (empty && (value.can_annotate || value.should_poll || value.cycle !== null || analysis !== null ||
      hasReport || hasProjection || value.presentation_id !== null)) throw new Error("Invalid empty state");
    if (!empty) {
      if (!isRecord(value.cycle) || !isRecord(analysis)) throw new Error("Missing MR state");
      if (value.status === "report_not_available" && (value.can_annotate || value.should_poll || hasReport || pending ||
        analysis.status === "failed")) throw new Error("Invalid missing-report state");
      if (value.status === "analysis_pending" && (!pending || !value.should_poll || value.can_annotate !== hasReport)) {
        throw new Error("Invalid pending state");
      }
      if (value.status === "analysis_failed" && (analysis.status !== "failed" || value.can_annotate !== hasReport ||
        value.should_poll !== hasReport)) throw new Error("Invalid failed state");
      if (value.status === "ready" && (!value.can_annotate || !value.should_poll || !hasReport || pending ||
        analysis.status === "failed")) throw new Error("Invalid ready state");
      if (value.status === "page_version_unverified" && (value.can_annotate || !hasReport || value.should_poll !== pending)) {
        throw new Error("Invalid page-version state");
      }
      if (value.status === "stale_diff") throw new Error("Schema 2 requires an explicit page/projection decision");
    }
    if (value.can_annotate !== hasProjection) throw new Error("Invalid projection authorization");
    const legacy = { ...value, schema_version: 1 };
    delete legacy.page_version; delete legacy.presentation_id; delete legacy.projection;
    // The original schema-2 state has passed above; reuse schema-1 reference-shape checks only.
    if (value.status === "page_version_unverified") legacy.status = "stale_diff";
    if (legacy.report) {
      legacy.can_annotate = sameDiff(legacy.mr.diff, legacy.report.build_diff);
      legacy.should_poll = ["queued", "running"].includes(legacy.analysis.status);
      legacy.status = !legacy.can_annotate ? "stale_diff" : legacy.analysis.status === "failed" ? "analysis_failed" :
        legacy.should_poll ? "analysis_pending" : "ready";
    }
    validateResolverResponse(legacy);
    if (!value.can_annotate) {
      if (value.presentation_id !== null || value.projection !== null) throw new Error("Unexpected projection");
      return value;
    }
    const projection = value.projection;
    if (typeof value.presentation_id !== "string" || !SHA256.test(value.presentation_id) || !value.report ||
      !hasExactKeys(projection, ["summary", "files", "strict_match"]) ||
      typeof projection.strict_match !== "boolean" || !isSummary(projection.summary) ||
      (projection.strict_match && !sameDiff(value.mr.diff, value.report.build_diff)) ||
      (!projection.strict_match && !isMappedSummary(projection.summary))) {
      throw new Error("Invalid projection identity");
    }
    validateReport({schema_version: 1, status: "complete", cycle_id: value.cycle.id,
      current_build_id: value.report.current_build_id, generation: value.report.generation,
      updated_at: value.report.updated_at, ...projection});
    for (const category of ["covered", "uncovered", "not_measurable", "unknown", "changed_new_side"]) {
      if (projection.files.some(file => !isNonNegativeInteger(file[category])) ||
        projection.files.reduce((sum, file) => sum + file[category], 0) !== projection.summary[category]) {
        throw new Error("Invalid projection totals");
      }
    }
    if (projection.summary.covered + projection.summary.uncovered + projection.summary.not_measurable +
      projection.summary.unknown !== projection.summary.changed_new_side) throw new Error("Invalid line totals");
    return value;
  }

  function validatePresentationFile(value) {
    if (!isRecord(value) || value.schema_version !== 2 || typeof value.presentation_id !== "string" || !SHA256.test(value.presentation_id) ||
      (typeof value.page_version !== "string" || !/^[1-9][0-9]{0,18}$/.test(value.page_version))) throw new Error("Invalid file identity");
    validateFileDetail({ ...value, schema_version: 1 });
    const numbers = new Set();
    for (const line of value.lines) {
      if (numbers.has(line.new_line_number)) throw new Error("Duplicate line");
      numbers.add(line.new_line_number);
      if (line.evidence && (!UUID.test(line.evidence.build_id) || !SHA.test(line.evidence.git_sha) ||
        !SHA256.test(line.evidence.input_set_sha256) || !SHA256.test(line.evidence.export_sha256) ||
        (line.evidence.reported_at !== undefined && !isTimestamp(line.evidence.reported_at)))) {
        throw new Error("Invalid evidence identity");
      }
    }
    return value;
  }

  return {
    ANALYSIS_STATES,
    COVERAGE_SOURCES,
    LINE_STATES,
    RESOLVER_STATUSES,
    hasExactKeys,
    isRecord,
    isSafeRepoPath,
    validateAnalysis,
    validateCycleDetail,
    validateCycleList,
    validateFileDetail,
    validateReport,
    validateResolverResponse,
    validatePresentationResolver,
    validatePresentationFile,
  };
});
