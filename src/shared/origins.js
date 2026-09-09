(function attachOrigins(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.IOSCoverageOrigins = api;
})(typeof globalThis === "object" ? globalThis : self, function createOrigins() {
  "use strict";

  const DEFAULT_SERVER_ORIGIN = "http://127.0.0.1:8765";

  function parseOrigin(value, allowedProtocols) {
    if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
      throw new Error("Origin is required");
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch (_error) {
      throw new Error("Origin is invalid");
    }
    if (!allowedProtocols.includes(parsed.protocol)) {
      throw new Error("Origin scheme is not allowed");
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "" && parsed.pathname !== "/")
    ) {
      throw new Error("Only an origin without credentials, path, query, or fragment is allowed");
    }
    return parsed.origin;
  }

  function normalizeServerOrigin(value) {
    return parseOrigin(value, ["http:", "https:"]);
  }

  function normalizeGitLabOrigin(value) {
    const origin = parseOrigin(value, ["https:"]);
    const parsed = new URL(origin);
    if (parsed.port) {
      throw new Error("GitLab origin must not use a custom port");
    }
    return origin;
  }

  function originPattern(origin) {
    return `${origin}/*`;
  }

  return {
    DEFAULT_SERVER_ORIGIN,
    normalizeGitLabOrigin,
    normalizeServerOrigin,
    originPattern,
  };
});
