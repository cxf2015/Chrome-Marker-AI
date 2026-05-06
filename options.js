const apiKeyInput = document.getElementById("apiKey");
const saveBtn = document.getElementById("saveBtn");
const testBtn = document.getElementById("testBtn");
const diagnosticModeInput = document.getElementById("diagnosticMode");
const statusEl = document.getElementById("status");

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
    getStorageValue("sync", ["kimiApiKey", "apiKey", "moonshotApiKey", "kimiDiagnosticMode"]),
    getStorageValue("local", ["kimiApiKey", "apiKey", "moonshotApiKey", "kimiDiagnosticMode"])
  ]);

  apiKeyInput.value =
    syncData.kimiApiKey ||
    localData.kimiApiKey ||
    syncData.apiKey ||
    localData.apiKey ||
    syncData.moonshotApiKey ||
    localData.moonshotApiKey ||
    "";

  diagnosticModeInput.checked = Boolean(syncData.kimiDiagnosticMode ?? localData.kimiDiagnosticMode ?? false);
}

async function save() {
  const key = normalizeApiKey(apiKeyInput.value);
  const diagnosticMode = Boolean(diagnosticModeInput.checked);
  const [syncOk, localOk] = await Promise.all([
    setStorageValue("sync", { kimiApiKey: key, kimiDiagnosticMode: diagnosticMode }),
    setStorageValue("local", { kimiApiKey: key, kimiDiagnosticMode: diagnosticMode })
  ]);

  apiKeyInput.value = key;
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
  const key = normalizeApiKey(apiKeyInput.value);
  const diagnose = Boolean(diagnosticModeInput.checked);
  if (!key) {
    setStatus("Test failed: please paste API key first.", true);
    return;
  }

  setStatus("Testing...", false);
  try {
    await save();
    const response = await chrome.runtime.sendMessage({ type: "kimi-test-auth", apiKey: key, diagnose });
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