"use strict";

importScripts(
  "../shared/contracts.js",
  "../shared/origins.js",
  "../content/gitlab-url.js",
  "api-client.js",
);

const CONTENT_SCRIPT_ID = "ios-coverage-gitlab-content";
const SETTINGS_KEYS = ["serverOrigin"];
const GRANTED_ORIGINS_KEY = "gitlabOrigins";
const MAX_GRANTED_ORIGINS = 100;
const tabSessions = new Map();

async function protectStorage() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

async function getSettings() {
  const values = await chrome.storage.local.get(SETTINGS_KEYS);
  return {
    serverOrigin: values.serverOrigin || IOSCoverageOrigins.DEFAULT_SERVER_ORIGIN,
  };
}

async function getGrantedOrigins() {
  const values = await chrome.storage.local.get(GRANTED_ORIGINS_KEY);
  const origins = Array.isArray(values[GRANTED_ORIGINS_KEY]) ? values[GRANTED_ORIGINS_KEY] : [];
  return origins.filter((origin) => typeof origin === "string" && origin.length > 0);
}

async function addGrantedOrigin(gitlabOrigin) {
  const origins = await getGrantedOrigins();
  if (!origins.includes(gitlabOrigin)) {
    origins.push(gitlabOrigin);
    await chrome.storage.local.set({ [GRANTED_ORIGINS_KEY]: origins.slice(-MAX_GRANTED_ORIGINS) });
  }
}

async function registerContentScripts() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch (_error) {
    // Absence is expected before first registration.
  }
  const origins = await getGrantedOrigins();
  if (origins.length === 0) return;
  await chrome.scripting.registerContentScripts([{
    id: CONTENT_SCRIPT_ID,
    matches: origins.map(IOSCoverageOrigins.originPattern),
    js: [
      "src/shared/contracts.js",
      "src/content/gitlab-url.js",
      "src/content/gitlab-dom-adapter.js",
      "src/content/coverage-renderer.js",
      "src/content/entry.js",
    ],
    css: ["src/content/styles.css"],
    runAt: "document_idle",
    persistAcrossSessions: true,
  }]);
}

async function migrateLegacySettings() {
  const values = await chrome.storage.local.get(["gitlabOrigin", "operatorToken"]);
  if (typeof values.gitlabOrigin === "string" && values.gitlabOrigin.length > 0) {
    const origins = await getGrantedOrigins();
    if (!origins.includes(values.gitlabOrigin)) {
      origins.push(values.gitlabOrigin);
      await chrome.storage.local.set({ [GRANTED_ORIGINS_KEY]: origins });
    }
    await chrome.storage.local.remove("gitlabOrigin");
  }
  if (values.operatorToken !== undefined) {
    await chrome.storage.local.remove("operatorToken");
  }
}

async function initialize() {
  await protectStorage();
  await migrateLegacySettings();
  await registerContentScripts();
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await initialize();
    const values = await chrome.storage.local.get("serverOrigin");
    if (!values.serverOrigin) {
      await chrome.runtime.openOptionsPage();
    }
  })();
});
chrome.runtime.onStartup.addListener(() => {
  void initialize();
});
void initialize();

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

function isOptionsSender(sender) {
  try {
    const senderUrl = new URL(sender.url || "");
    const extensionUrl = new URL(chrome.runtime.getURL("src/options/options.html"));
    return senderUrl.origin === extensionUrl.origin && senderUrl.pathname === extensionUrl.pathname;
  } catch (_error) {
    return false;
  }
}

async function validateContentSender(sender, message) {
  if (!sender.tab || !Number.isInteger(sender.tab.id) || !sender.url) return null;
  const parsed = IOSCoverageGitLabUrl.parseMergeRequestUrl(sender.url);
  if (!parsed) return null;
  if (message.action === "RESOLVE_MR") {
    if (
      parsed.identity !== message.mr.identity ||
      parsed.projectPath !== message.mr.projectPath ||
      parsed.iid !== message.mr.iid ||
      parsed.origin !== message.mr.origin
    ) return null;
  }
  return { tabId: sender.tab.id, parsed };
}

function safeFailure(error) {
  const code = error && typeof error.code === "string" ? error.code : "invalid_response";
  if (code === "unreachable" || code === "invalid_token") {
    return { ok: false, error: code };
  }
  return { ok: false, error: "invalid_response" };
}

async function handleContentMessage(message, sender) {
  if (!IOSCoverageApiClient.validateContentMessage(message)) {
    return { ok: false, error: "message_not_allowed" };
  }
  const settings = await getSettings();
  const senderContext = await validateContentSender(sender, message);
  if (!senderContext) return { ok: false, error: "sender_not_allowed" };

  if (message.action === "OPEN_OPTIONS") {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
  if (message.action === "RESOLVE_MR") {
    if (message.versionState !== "latest") {
      tabSessions.delete(senderContext.tabId);
      return { ok: true, result: { status: message.versionState === "historical" ?
        "historical_diff" : "dom_unsupported", canAnnotate: false } };
    }
    try {
      const result = await IOSCoverageApiClient.resolveMergeRequest(fetch, settings, message);
      if (result.canAnnotate) {
        tabSessions.set(senderContext.tabId, {
          cycleId: result.cycleId,
          generation: result.generation,
          fileIds: new Set(result.files.map((file) => file.fileId)),
          identity: message.mr.identity,
        });
      } else {
        tabSessions.delete(senderContext.tabId);
      }
      return { ok: true, result };
    } catch (error) {
      tabSessions.delete(senderContext.tabId);
      return safeFailure(error);
    }
  }

  const session = tabSessions.get(senderContext.tabId);
  if (
    !session ||
    session.identity !== senderContext.parsed.identity ||
    session.cycleId !== message.cycleId ||
    session.generation !== message.generation ||
    !session.fileIds.has(message.fileId)
  ) {
    return { ok: false, error: "file_request_not_allowed" };
  }
  try {
    const result = await IOSCoverageApiClient.loadReportFile(
      fetch,
      settings,
      message.cycleId,
      message.fileId,
    );
    if (result.generation !== session.generation) {
      tabSessions.delete(senderContext.tabId);
      return { ok: false, error: "generation_changed" };
    }
    return { ok: true, result };
  } catch (error) {
    return safeFailure(error);
  }
}

async function handleOptionsMessage(message) {
  if (!IOSCoverageContracts.isRecord(message) || typeof message.action !== "string") {
    return { ok: false, error: "message_not_allowed" };
  }
  if (message.action === "GET_OPTIONS_STATE") {
    const settings = await getSettings();
    const origins = await getGrantedOrigins();
    return {
      ok: true,
      result: { serverOrigin: settings.serverOrigin, gitlabOrigins: origins },
    };
  }
  if (message.action === "GET_ACTIVE_GITLAB_MR") {
    if (Object.keys(message).some((key) => key !== "action")) {
      return { ok: false, error: "message_not_allowed" };
    }
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ currentWindow: true });
    } catch (_error) {
      tabs = [];
    }
    let best = null;
    for (const tab of tabs) {
      if (!tab.url) continue;
      const parsed = IOSCoverageGitLabUrl.parseMergeRequestUrl(tab.url);
      if (!parsed) continue;
      const accessed = Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : 0;
      if (!best || accessed > best.accessed) {
        best = { origin: parsed.origin, host: parsed.host, projectPath: parsed.projectPath, iid: parsed.iid, identity: parsed.identity, accessed };
      }
    }
    if (!best) return { ok: true, result: null };
    const { accessed, ...mr } = best;
    return { ok: true, result: mr };
  }
  if (message.action === "ADD_GRANTED_ORIGIN") {
    if (Object.keys(message).some((key) => !["action", "origin"].includes(key))) {
      return { ok: false, error: "message_not_allowed" };
    }
    let origin;
    try {
      origin = IOSCoverageOrigins.normalizeGitLabOrigin(message.origin);
    } catch (_error) {
      let ported = false;
      try {
        ported = Boolean(new URL(message.origin).port);
      } catch (_urlError) {
        ported = false;
      }
      return { ok: false, error: ported ? "unsupported_gitlab_origin" : "invalid_origin" };
    }
    await addGrantedOrigin(origin);
    await registerContentScripts();
    return { ok: true, result: { origin } };
  }
  if (message.action !== "SAVE_SETTINGS" && message.action !== "TEST_CONNECTION") {
    return { ok: false, error: "message_not_allowed" };
  }
  const allowedKeys = ["action", "serverOrigin"];
  if (Object.keys(message).some((key) => !allowedKeys.includes(key))) {
    return { ok: false, error: "message_not_allowed" };
  }
  let serverOrigin;
  try {
    serverOrigin = IOSCoverageOrigins.normalizeServerOrigin(message.serverOrigin);
  } catch (_error) {
    return { ok: false, error: "invalid_origin" };
  }
  const candidate = { serverOrigin };

  if (message.action === "TEST_CONNECTION") {
    try {
      await IOSCoverageApiClient.testConnection(fetch, candidate);
      return { ok: true };
    } catch (error) {
      return safeFailure(error);
    }
  }

  const current = await getSettings();
  const patterns = [IOSCoverageOrigins.originPattern(serverOrigin)];
  if (!(await chrome.permissions.contains({ origins: patterns }))) {
    return { ok: false, error: "permission_missing" };
  }
  await chrome.storage.local.set(candidate);
  tabSessions.clear();

  const oldPattern = current.serverOrigin !== serverOrigin ?
    IOSCoverageOrigins.originPattern(current.serverOrigin) : null;
  if (oldPattern) {
    const granted = await getGrantedOrigins();
    const stillNeeded = granted.some((origin) =>
      IOSCoverageOrigins.originPattern(origin) === oldPattern);
    if (!stillNeeded) await chrome.permissions.remove({ origins: [oldPattern] });
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const task = isOptionsSender(sender) ?
    handleOptionsMessage(message) : handleContentMessage(message, sender);
  task.then(sendResponse, (error) => sendResponse(safeFailure(error)));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabSessions.delete(tabId);
});
