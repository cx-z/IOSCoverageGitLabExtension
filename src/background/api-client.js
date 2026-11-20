(function attachApiClient(root, factory) {
  const contracts = root.IOSCoverageContracts ||
    (typeof require === "function" ? require("../shared/contracts.js") : null);
  const origins = root.IOSCoverageOrigins ||
    (typeof require === "function" ? require("../shared/origins.js") : null);
  const api = factory(contracts, origins);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.IOSCoverageApiClient = api;
})(typeof globalThis === "object" ? globalThis : self, function createApiClient(contracts, origins) {
  "use strict";

  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const RESOLVER_PATH = "/api/v1/integrations/gitlab/merge-request-coverage/resolve";
  const ALLOWED_PATHS = [
    /^\/health$/,
    new RegExp(`^/api/v1/cycles/${UUID}/report$`),
    new RegExp(`^/api/v1/cycles/${UUID}/report/files/[0-9a-f]{64}$`),
    /^\/api\/v1\/integrations\/gitlab\/merge-request-coverage\/resolve$/,
  ];

  class ApiError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  function fixedUrl(serverOrigin, path) {
    const origin = origins.normalizeServerOrigin(serverOrigin);
    if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) {
      throw new ApiError("request_not_allowed");
    }
    return `${origin}${path}`;
  }

  async function requestJson(fetchImpl, settings, path) {
    let response;
    try {
      response = await fetchImpl(fixedUrl(settings.serverOrigin, path), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        redirect: "error",
      });
    } catch (_error) {
      throw new ApiError("unreachable");
    }
    if (response.status === 401 || response.status === 403) throw new ApiError("invalid_token");
    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch (_error) {
        // Stable error classification never echoes response text.
      }
      throw new ApiError(
        body && typeof body.error === "string" ? body.error : `http_${response.status}`,
      );
    }
    try {
      return await response.json();
    } catch (_error) {
      throw new ApiError("invalid_response");
    }
  }

  async function postResolver(fetchImpl, settings, mrUrl, extra = null) {
    let response;
    try {
      response = await fetchImpl(fixedUrl(settings.serverOrigin, RESOLVER_PATH), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(extra ? { schema_version: 2, mr_url: mrUrl, ...extra } : { schema_version: 1, mr_url: mrUrl }),
        cache: "no-store",
        redirect: "error",
      });
    } catch (_error) {
      throw new ApiError("unreachable");
    }
    if (response.status === 401 || response.status === 403) throw new ApiError("invalid_token");
    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch (_error) {
        // Error text and upstream details are deliberately not exposed to the page.
      }
      const code = body && typeof body.error === "string" ? body.error : `http_${response.status}`;
      throw new ApiError(code);
    }
    try {
      const value = await response.json();
      return extra ? (extra.file_id ? contracts.validatePresentationFile(value) :
        contracts.validatePresentationResolver(value)) : contracts.validateResolverResponse(value);
    } catch (_error) {
      throw new ApiError("invalid_response");
    }
  }

  function assertResolverIdentity(resolver, request) {
    const origin = request.mr.origin;
    const expectedHost = new URL(origin).hostname;
    if (
      request.mr.host !== expectedHost ||
      resolver.mr.host !== expectedHost ||
      resolver.mr.project_path !== request.mr.projectPath ||
      resolver.mr.iid !== request.mr.iid
    ) {
      throw new ApiError("identity_mismatch");
    }
    const canonicalCandidates = new Set([
      `${origin}/${request.mr.projectPath}/merge_requests/${request.mr.iid}`,
      `${origin}/${request.mr.projectPath}/-/merge_requests/${request.mr.iid}`,
    ]);
    if (!canonicalCandidates.has(resolver.mr.canonical_url)) {
      throw new ApiError("identity_mismatch");
    }
  }

  function summariesEqual(left, right) {
    return [
      "changed_new_side",
      "measurable",
      "covered",
      "uncovered",
      "not_measurable",
      "unknown",
      "changed_line_coverage_percent",
    ].every((key) => left[key] === right[key]);
  }

  async function resolveMergeRequest(fetchImpl, settings, request) {
    if (!settings.serverOrigin) {
      return { status: "unconfigured", canAnnotate: false, shouldPoll: false, files: [] };
    }
    const mrUrl = `${request.mr.origin}${request.mr.pathname}`;
    if (request.pageVersion === null) return { status: "page_version_unverified", canAnnotate: false, shouldPoll: true, files: [] };
    const resolver = await postResolver(fetchImpl, settings, mrUrl,
      request.pageVersion ? { page_version: request.pageVersion } : null);
    assertResolverIdentity(resolver, request);

    const reportReference = resolver.report;
    const baseResult = {
      status: resolver.status === "analysis_failed" && reportReference ?
        "analysis_failed_with_report" : resolver.status,
      analysisStatus: resolver.analysis ? resolver.analysis.status : null,
      canAnnotate: resolver.can_annotate,
      shouldPoll: resolver.should_poll,
      cycleId: resolver.cycle ? resolver.cycle.id : null,
      generation: reportReference ? reportReference.generation : undefined,
      updatedAt: reportReference ? reportReference.updated_at : undefined,
      buildSha: reportReference ? reportReference.build_diff.head_sha.slice(0, 8) : undefined,
      summary: reportReference ? reportReference.summary : undefined,
      reportPageUrl: resolver.cycle ?
        `${origins.normalizeServerOrigin(settings.serverOrigin)}/cycles/${resolver.cycle.id}` : undefined,
      files: [],
      presentationId: resolver.presentation_id,
      pageVersion: resolver.page_version,
      mrUrl,
      targetDiff: resolver.schema_version === 2 ? resolver.mr.diff : undefined,
      strictMatch: resolver.projection ? resolver.projection.strict_match : true,
    };
    if (!resolver.can_annotate) return baseResult;

    if (resolver.schema_version === 2) {
      if (resolver.page_version !== request.pageVersion) throw new ApiError("identity_mismatch");
      return { ...baseResult, summary: resolver.projection.summary,
        uncoveredFileCount: resolver.projection.files.filter(file => file.uncovered > 0).length,
        reportFileCount: resolver.projection.files.length,
        files: resolver.projection.files.map(file => ({fileId: file.file_id, repoRelativePath: file.repo_relative_path, uncovered: file.uncovered})) };
    }
    const report = contracts.validateReport(
      await requestJson(fetchImpl, settings, reportReference.summary_api),
    );
    if (
      report.cycle_id !== resolver.cycle.id ||
      report.current_build_id !== reportReference.current_build_id ||
      report.generation !== reportReference.generation ||
      report.updated_at !== reportReference.updated_at ||
      !summariesEqual(report.summary, reportReference.summary)
    ) {
      throw new ApiError("identity_mismatch");
    }

    return {
      ...baseResult,
      summary: report.summary,
      uncoveredFileCount: report.files.filter((file) => file.uncovered > 0).length,
      reportFileCount: report.files.length,
      files: report.files.map((file) => ({
        fileId: file.file_id,
        repoRelativePath: file.repo_relative_path,
        uncovered: file.uncovered,
      })),
    };
  }

  async function loadReportFile(fetchImpl, settings, cycleId, fileId) {
    const detail = contracts.validateFileDetail(
      await requestJson(
        fetchImpl,
        settings,
        `/api/v1/cycles/${cycleId}/report/files/${fileId}`,
      ),
    );
    if (detail.cycle_id !== cycleId || detail.file.file_id !== fileId) {
      throw new ApiError("identity_mismatch");
    }
    return {
      schema_version: detail.schema_version,
      cycle_id: detail.cycle_id,
      generation: detail.generation,
      file: {
        file_id: detail.file.file_id,
        repo_relative_path: detail.file.repo_relative_path,
      },
      lines: detail.lines.map((line) => ({
        new_line_number: line.new_line_number,
        state: line.state,
        coverage_source: line.coverage_source,
        regions: line.regions.map((region) => ({ covered: Boolean(region.covered) })),
      })),
    };
  }

  async function loadPresentationFile(fetchImpl, settings, session, fileId) {
    const detail = await postResolver(fetchImpl, settings, session.mrUrl, {
      page_version: session.pageVersion, presentation_id: session.presentationId, file_id: fileId,
    });
    if (detail.presentation_id !== session.presentationId || detail.page_version !== session.pageVersion ||
      detail.cycle_id !== session.cycleId || detail.generation !== session.generation || detail.file.file_id !== fileId) {
      throw new ApiError("identity_mismatch");
    }
    return detail;
  }

  async function testConnection(fetchImpl, settings) {
    await requestJson(fetchImpl, settings, "/health");
    return { ok: true };
  }

  function hasOnlyKeys(value, keys) {
    return contracts.isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
  }

  function validateContentMessage(message) {
    if (!contracts.isRecord(message) || typeof message.action !== "string") return false;
    if (message.action === "OPEN_OPTIONS") return hasOnlyKeys(message, ["action"]);
    if (message.action === "RESOLVE_MR") {
      if (!hasOnlyKeys(message, ["action", "mr", "versionState", "pageVersion"])) return false;
      const mr = message.mr;
      return (
        (message.pageVersion === undefined || message.pageVersion === null || /^[1-9][0-9]{0,18}$/.test(message.pageVersion)) &&
        contracts.isRecord(mr) &&
        hasOnlyKeys(mr, ["origin", "host", "projectPath", "iid", "pathname", "identity"]) &&
        typeof mr.origin === "string" &&
        typeof mr.host === "string" &&
        contracts.isSafeRepoPath(mr.projectPath) &&
        /^[1-9]\d*$/.test(mr.iid) &&
        (message.versionState === "latest" || message.versionState === "historical" ||
          message.versionState === "unknown")
      );
    }
    if (message.action === "LOAD_REPORT_FILE") {
      return (
        hasOnlyKeys(message, ["action", "cycleId", "generation", "fileId", "presentationId"]) &&
        (message.presentationId === undefined || /^[0-9a-f]{64}$/.test(message.presentationId)) &&
        new RegExp(`^${UUID}$`).test(message.cycleId) &&
        Number.isInteger(message.generation) &&
        message.generation >= 0 &&
        /^[0-9a-f]{64}$/.test(message.fileId)
      );
    }
    return false;
  }

  return {
    ApiError,
    fixedUrl,
    loadReportFile,
    loadPresentationFile,
    postResolver,
    requestJson,
    resolveMergeRequest,
    testConnection,
    validateContentMessage,
  };
});
