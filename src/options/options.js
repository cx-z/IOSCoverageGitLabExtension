"use strict";

const form = document.querySelector("#settings-form");
const serverInput = document.querySelector("#server-origin");
const gitlabInput = document.querySelector("#gitlab-origin");
const tokenInput = document.querySelector("#operator-token");
const tokenState = document.querySelector("#token-state");
const statusNode = document.querySelector("#status");
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
    invalid_token: "Token 无效或权限不足",
    unreachable: "Coverage 服务不可达",
    permission_missing: "尚未授予所需的精确 origin 权限",
    unconfigured: "请填写 Token",
  };
  return labels[code] || "操作失败，请检查配置";
}

function normalizedFormValues() {
  return {
    serverOrigin: IOSCoverageOrigins.normalizeServerOrigin(serverInput.value.trim()),
    gitlabOrigin: IOSCoverageOrigins.normalizeGitLabOrigin(gitlabInput.value.trim()),
    operatorToken: tokenInput.value,
  };
}

async function requestOrigins(origins) {
  const patterns = origins.map(IOSCoverageOrigins.originPattern);
  return chrome.permissions.request({ origins: patterns });
}

async function send(action, values) {
  return chrome.runtime.sendMessage({ action, ...values });
}

async function load() {
  const response = await send("GET_OPTIONS_STATE", {});
  if (!response || !response.ok) {
    setStatus("无法读取扩展设置", "error");
    return;
  }
  serverInput.value = response.result.serverOrigin;
  gitlabInput.value = response.result.gitlabOrigin;
  tokenState.textContent = response.result.hasToken ?
    "已保存 Token；留空可保留原值。" : "尚未保存 Token。";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("");
  setBusy(true);
  try {
    const values = normalizedFormValues();
    const granted = await requestOrigins([values.serverOrigin, values.gitlabOrigin]);
    if (!granted) throw new Error("permission_missing");
    const response = await send("SAVE_SETTINGS", values);
    if (!response || !response.ok) throw new Error(response && response.error);
    tokenInput.value = "";
    tokenState.textContent = "已保存 Token；留空可保留原值。";
    setStatus("设置已保存。重新加载已打开的 MR 页面即可启用扩展。", "success");
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
    const granted = await requestOrigins([values.serverOrigin]);
    if (!granted) throw new Error("permission_missing");
    const response = await send("TEST_CONNECTION", values);
    if (!response || !response.ok) throw new Error(response && response.error);
    setStatus("连接成功，Coverage 服务可达且 Token 权限有效。", "success");
  } catch (error) {
    setStatus(errorLabel(error.message), "error");
  } finally {
    setBusy(false);
  }
});

document.querySelector("#clear-token").addEventListener("click", async () => {
  setBusy(true);
  try {
    const response = await send("CLEAR_TOKEN", {});
    if (!response || !response.ok) throw new Error(response && response.error);
    tokenInput.value = "";
    tokenState.textContent = "尚未保存 Token。";
    setStatus("Token 已清除。", "success");
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

void load();
