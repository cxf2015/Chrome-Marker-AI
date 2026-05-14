const providerInput = document.getElementById("provider");
const apiKeyInput = document.getElementById("apiKey");
const deepseekApiKeyInput = document.getElementById("deepseekApiKey");
const saveBtn = document.getElementById("saveBtn");
const testBtn = document.getElementById("testBtn");
const diagnosticModeInput = document.getElementById("diagnosticMode");
const statusEl = document.getElementById("status");

function normalizeProvider(provider) {
  return String(provider || "").trim().toLowerCase() === "deepseek" ? "deepseek" : "moonshot";
}

function normalizeApiKey(rawKey) {
  if (!rawKey) {
    return "";
  }

  return String(rawKey)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/\s+/g, "");
}

function setStatus(text, isError = false) {
  statusEl.style.color = isError ? "#b42318" : "#0a7f28";
  statusEl.textContent = text;
}

function formatDiagnostics(diagnostics) {
  if (!diagnostics || !Array.isArray(diagnostics.steps) || diagnostics.steps.length === 0) {
    return "Diagnostic: no request details captured.";
  }

  const lines = [];
  if (diagnostics.selectedProvider) {
    lines.push(`Provider: ${diagnostics.selectedProvider}`);
  }
  if (diagnostics.selectedModel) {
    lines.push(`Model: ${diagnostics.selectedModel}`);
  }

  diagnostics.steps.forEach((step, index) => {
    lines.push(`${index + 1}. endpoint: ${step.endpoint || "N/A"}`);
    lines.push(`   status: ${typeof step.status === "number" && step.status >= 0 ? step.status : "N/A"}`);
    if (step.error) {
      lines.push(`   error: ${step.error}`);
    }
  });

  return lines.join("\n");
}

async function getStorageValue(area, keys) {
  try {
    return await chrome.storage[area].get(keys);
  } catch {
    return {};
  }
}

async function setStorageValue(area, value) {
  try {
    await chrome.storage[area].set(value);
    return true;
  } catch {
    return false;
  }
}

async function load() {
  const [syncData, localData] = await Promise.all([
    getStorageValue("sync", ["aiProvider", "provider", "kimiApiKey", "apiKey", "moonshotApiKey", "deepseekApiKey", "kimiDiagnosticMode"]),
    getStorageValue("local", ["aiProvider", "provider", "kimiApiKey", "apiKey", "moonshotApiKey", "deepseekApiKey", "kimiDiagnosticMode"])
  ]);

  providerInput.value = normalizeProvider(syncData.aiProvider || localData.aiProvider || syncData.provider || localData.provider || "moonshot");

  const moonshotApiKey =
    syncData.kimiApiKey ||
    localData.kimiApiKey ||
    syncData.apiKey ||
    localData.apiKey ||
    syncData.moonshotApiKey ||
    localData.moonshotApiKey ||
    "";

  apiKeyInput.value = moonshotApiKey;
  deepseekApiKeyInput.value = syncData.deepseekApiKey || localData.deepseekApiKey || "";

  diagnosticModeInput.checked = Boolean(syncData.kimiDiagnosticMode ?? localData.kimiDiagnosticMode ?? false);
}

async function save() {
  const provider = normalizeProvider(providerInput.value);
  const moonshotKey = normalizeApiKey(apiKeyInput.value);
  const deepseekKey = normalizeApiKey(deepseekApiKeyInput.value);
  const diagnosticMode = Boolean(diagnosticModeInput.checked);
  const [syncOk, localOk] = await Promise.all([
    setStorageValue("sync", {
      aiProvider: provider,
      provider,
      kimiApiKey: moonshotKey,
      deepseekApiKey: deepseekKey,
      kimiDiagnosticMode: diagnosticMode
    }),
    setStorageValue("local", {
      aiProvider: provider,
      provider,
      kimiApiKey: moonshotKey,
      deepseekApiKey: deepseekKey,
      kimiDiagnosticMode: diagnosticMode
    })
  ]);

  providerInput.value = provider;
  apiKeyInput.value = moonshotKey;
  deepseekApiKeyInput.value = deepseekKey;
  if (!syncOk && !localOk) {
    setStatus("Save failed: unable to write storage in this context.", true);
    return false;
  }

  if (!syncOk && localOk) {
    setStatus("Saved to local storage (sync unavailable).", false);
  } else {
    setStatus("Saved.", false);
  }

  setTimeout(() => {
    setStatus("");
  }, 1800);

  return true;
}

async function testConnection() {
  const provider = normalizeProvider(providerInput.value);
  const moonshotKey = normalizeApiKey(apiKeyInput.value);
  const deepseekKey = normalizeApiKey(deepseekApiKeyInput.value);
  const key = provider === "deepseek" ? deepseekKey : moonshotKey;
  const diagnose = Boolean(diagnosticModeInput.checked);
  if (!key) {
    setStatus(`Test failed: please paste ${provider === "deepseek" ? "DeepSeek" : "Moonshot/Kimi"} API key first.`, true);
    return;
  }

  setStatus("Testing...", false);
  try {
    await save();
    const response = await chrome.runtime.sendMessage({ type: "kimi-test-auth", apiKey: key, provider, diagnose });
    if (!response?.ok) {
      const error = new Error(response?.error || "Unknown error");
      error.diagnostics = response?.diagnostics || null;
      throw error;
    }

    if (diagnose) {
      const details = formatDiagnostics(response?.diagnostics || null);
      setStatus(`Connection OK. API key is valid.\n${details}`, false);
      return;
    }

    setStatus("Connection OK. API key is valid.", false);
  } catch (error) {
    if (diagnose) {
      const details = formatDiagnostics(error?.diagnostics || null);
      setStatus(`Test failed: ${error.message || "Unknown error"}\n${details}`, true);
      return;
    }

    setStatus(`Test failed: ${error.message || "Unknown error"}`, true);
  }
}

saveBtn.addEventListener("click", save);
testBtn.addEventListener("click", testConnection);

load();