"use strict";

const form = document.querySelector("#settings-form");
const serverInput = document.querySelector("#server-origin");
const statusNode = document.querySelector("#status");
const willAuthorizeNode = document.querySelector("#will-authorize");
const buttons = Array.from(document.querySelectorAll("button"));

function setStatus(message, kind = "") {
  statusNode.textContent = message;
  statusNode.className = `status ${kind}`.trim();
}

function setBusy(busy) {
  buttons.forEach((button) => { button.disabled = busy; });
}

function errorLabel(code) {
  const labels = {
    invalid_origin: "origin 格式不正确",
    unsupported_gitlab_origin: "当前 GitLab 站点使用非标准 HTTPS 端口，扩展暂不支持（仅支持默认 443 端口）",
    invalid_token: "Coverage 服务返回 401/403（服务端未启用只读放行时需操作员 Token）",
    unreachable: "Coverage 服务不可达",
    permission_missing: "未授予权限。若 Chrome 没有弹出授权窗口，说明该站点此前被拒绝过：请到 chrome://extensions → 本扩展「详情」→「网站访问权限」中允许对应站点后重试；或卸载重装扩展。",
  };
  return labels[code] || "操作失败，请检查配置";
}

function renderWillAuthorize(mr) {
  if (mr && mr.origin) {
    willAuthorizeNode.textContent = `将授权：${mr.origin}（MR !${mr.iid}）`;
  } else {
    willAuthorizeNode.textContent = "未检测到打开的 GitLab MR 页面；保存/测试时将只申请服务器授权。";
  }
}

async function refreshWillAuthorize() {
  const response = await send("GET_ACTIVE_GITLAB_MR", {});
  renderWillAuthorize(response && response.ok ? response.result : null);
}

function normalizedFormValues() {
  return {
    serverOrigin: IOSCoverageOrigins.normalizeServerOrigin(serverInput.value.trim()),
  };
}

async function requestOrigins(origins) {
  const patterns = origins.map(IOSCoverageOrigins.originPattern);
  return chrome.permissions.request({ origins: patterns });
}

async function send(action, values) {
  return chrome.runtime.sendMessage({ action, ...values });
}

async function findOpenMr() {
  const response = await send("GET_ACTIVE_GITLAB_MR", {});
  return response && response.ok ? response.result : null;
}

// Requests access for the server and (when an MR tab is open) the GitLab origin
// together, records the GitLab origin, then runs the requested action.
async function withPermissions(action, values) {
  const mr = await findOpenMr();
  const origins = [values.serverOrigin, mr ? mr.origin : null].filter(Boolean);
  const granted = await requestOrigins(origins);
  if (!granted) throw new Error("permission_missing");
  if (mr) {
    const recorded = await send("ADD_GRANTED_ORIGIN", { origin: mr.origin });
    if (!recorded || !recorded.ok) throw new Error(recorded && recorded.error);
  }
  return mr;
}

async function load() {
  const response = await send("GET_OPTIONS_STATE", {});
  if (!response || !response.ok) {
    setStatus("无法读取扩展设置", "error");
    return;
  }
  serverInput.value = response.result.serverOrigin;
  await refreshWillAuthorize();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("");
  setBusy(true);
  try {
    const values = normalizedFormValues();
    const mr = await withPermissions("SAVE_SETTINGS", values);
    const response = await send("SAVE_SETTINGS", values);
    if (!response || !response.ok) throw new Error(response && response.error);
    if (mr) {
      setStatus(`设置已保存，已授权 GitLab ${mr.origin}。重新打开 MR 页面即可看到覆盖率。`, "success");
    } else {
      setStatus("设置已保存（未检测到打开的 GitLab MR 页面，GitLab 授权会在下次操作时一起申请）。", "success");
    }
    await refreshWillAuthorize();
  } catch (error) {
    setStatus(errorLabel(error.message), "error");
  } finally {
    setBusy(false);
  }
});

document.querySelector("#test-connection").addEventListener("click", async () => {
  setStatus("");
  setBusy(true);
  try {
    const values = normalizedFormValues();
    const mr = await withPermissions("TEST_CONNECTION", values);
    const response = await send("TEST_CONNECTION", values);
    if (!response || !response.ok) throw new Error(response && response.error);
    setStatus(
      mr ? `连接成功，Coverage 服务可达；已授权 GitLab ${mr.origin}。` : "连接成功，Coverage 服务可达。",
      "success",
    );
    await refreshWillAuthorize();
  } catch (error) {
    setStatus(errorLabel(error.message), "error");
  } finally {
    setBusy(false);
  }
});

document.querySelector("#restore-default").addEventListener("click", () => {
  serverInput.value = IOSCoverageOrigins.DEFAULT_SERVER_ORIGIN;
  setStatus("已恢复默认地址；点击保存后生效。", "success");
});

window.addEventListener("focus", () => {
  void refreshWillAuthorize();
});

void load();
