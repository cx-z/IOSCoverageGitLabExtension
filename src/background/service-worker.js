"use strict";

importScripts(
  "../shared/contracts.js",
  "../shared/origins.js",
  "../content/gitlab-url.js",
  "api-client.js",
);

const CONTENT_SCRIPT_ID = "ios-coverage-gitlab-content";
const SETTINGS_KEYS = ["serverOrigin", "gitlabOrigin", "operatorToken"];
const tabSessions = new Map();

async function protectStorage() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

async function getSettings() {
  const values = await chrome.storage.local.get(SETTINGS_KEYS);
  return {
    serverOrigin: values.serverOrigin || IOSCoverageOrigins.DEFAULT_SERVER_ORIGIN,
    gitlabOrigin: values.gitlabOrigin || "",
    operatorToken: values.operatorToken || "",
  };
}

async function registerContentScript(gitlabOrigin) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch (_error) {
    // Absence is expected before first configuration.
  }
  if (!gitlabOrigin) return;
  const pattern = IOSCoverageOrigins.originPattern(gitlabOrigin);
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) return;
  await chrome.scripting.registerContentScripts([{
    id: CONTENT_SCRIPT_ID,
    matches: [pattern],
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

async function initialize() {
  await protectStorage();
  const settings = await getSettings();
  await registerContentScript(settings.gitlabOrigin);
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await initialize();
    const settings = await getSettings();
    if (!settings.gitlabOrigin || !settings.operatorToken) {
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

async function validateContentSender(sender, message, settings) {
  if (!sender.tab || !Number.isInteger(sender.tab.id) || !sender.url) return null;
  const parsed = IOSCoverageGitLabUrl.parseMergeRequestUrl(sender.url);
  if (!parsed || parsed.origin !== settings.gitlabOrigin) return null;
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
  if (code === "unreachable" || code === "invalid_token" || code === "unconfigured") {
    return { ok: false, error: code };
  }
  return { ok: false, error: "invalid_response" };
}

async function handleContentMessage(message, sender) {
  if (!IOSCoverageApiClient.validateContentMessage(message)) {
    return { ok: false, error: "message_not_allowed" };
  }
  const settings = await getSettings();
  const senderContext = await validateContentSender(sender, message, settings);
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
    return {
      ok: true,
      result: {
        serverOrigin: settings.serverOrigin,
        gitlabOrigin: settings.gitlabOrigin,
        hasToken: Boolean(settings.operatorToken),
      },
    };
  }
  if (message.action === "CLEAR_TOKEN" && Object.keys(message).length === 1) {
    await chrome.storage.local.remove("operatorToken");
    tabSessions.clear();
    return { ok: true };
  }
  if (message.action !== "SAVE_SETTINGS" && message.action !== "TEST_CONNECTION") {
    return { ok: false, error: "message_not_allowed" };
  }
  const allowedKeys = ["action", "serverOrigin", "gitlabOrigin", "operatorToken"];
  if (Object.keys(message).some((key) => !allowedKeys.includes(key))) {
    return { ok: false, error: "message_not_allowed" };
  }
  let serverOrigin;
  let gitlabOrigin;
  try {
    serverOrigin = IOSCoverageOrigins.normalizeServerOrigin(message.serverOrigin);
    gitlabOrigin = IOSCoverageOrigins.normalizeGitLabOrigin(message.gitlabOrigin);
  } catch (_error) {
    return { ok: false, error: "invalid_origin" };
  }
  const current = await getSettings();
  const operatorToken = typeof message.operatorToken === "string" && message.operatorToken.length > 0 ?
    message.operatorToken : current.operatorToken;
  if (!operatorToken) return { ok: false, error: "unconfigured" };
  const candidate = { serverOrigin, gitlabOrigin, operatorToken };

  if (message.action === "TEST_CONNECTION") {
    try {
      await IOSCoverageApiClient.testConnection(fetch, candidate);
      return { ok: true };
    } catch (error) {
      return safeFailure(error);
    }
  }

  const patterns = [
    IOSCoverageOrigins.originPattern(serverOrigin),
    IOSCoverageOrigins.originPattern(gitlabOrigin),
  ];
  if (!(await chrome.permissions.contains({ origins: patterns }))) {
    return { ok: false, error: "permission_missing" };
  }
  await chrome.storage.local.set(candidate);
  await registerContentScript(gitlabOrigin);
  tabSessions.clear();

  const oldPatterns = [current.serverOrigin, current.gitlabOrigin]
    .filter(Boolean)
    .map(IOSCoverageOrigins.originPattern)
    .filter((pattern) => !patterns.includes(pattern));
  if (oldPatterns.length > 0) await chrome.permissions.remove({ origins: oldPatterns });
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
