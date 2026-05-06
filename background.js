const KIMI_API_URL = "https://api.moonshot.cn/v1/chat/completions";
const KIMI_MODELS_URL = "https://api.moonshot.cn/v1/models";
const KIMI_MODEL = "moonshot-v1-8k";
const MODEL_FALLBACK_PRIORITY = [
  "moonshot-v1-8k",
  "moonshot-v1-32k",
  "moonshot-v1-128k",
  "kimi-k2-0711-preview",
  "kimi-k2-turbo-preview",
  "kimi-latest"
];
const REQUEST_TIMEOUT_MS = 30000;

function truncateText(input, maxLength = 180) {
  const text = String(input || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function createDiagnostics(enabled) {
  if (!enabled) {
    return null;
  }

  return {
    selectedModel: "",
    steps: []
  };
}

function addDiagnosticStep(diagnostics, step) {
  if (!diagnostics) {
    return;
  }

  diagnostics.steps.push({
    endpoint: step.endpoint || "",
    status: typeof step.status === "number" ? step.status : -1,
    error: truncateText(step.error || "")
  });
}

function throwWithDiagnostics(message, diagnostics) {
  const error = new Error(message);
  if (diagnostics) {
    error.diagnostics = diagnostics;
  }
  throw error;
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

function isLikelyValidApiKey(apiKey) {
  // Keep this validation permissive so key format changes do not break users.
  return typeof apiKey === "string" && apiKey.length >= 16 && !/\s/.test(apiKey);
}

function buildMessages(mode, text) {
  if (mode === "translate") {
    return [
      {
        role: "system",
        content:
          "You are a professional translator. Translate user text into concise, natural Simplified Chinese. Return only the translated result."
      },
      {
        role: "user",
        content: text
      }
    ];
  }

  if (mode === "to-md") {
    return [
      {
        role: "system",
        content:
          "You are a technical editor. Convert webpage text into concise, well-structured Markdown. Keep only key information, use headings, bullet points, and short sections. Remove ads/navigation/noise. Output Markdown only."
      },
      {
        role: "user",
        content: text
      }
    ];
  }

  return [
    {
      role: "system",
      content:
        "You are a helpful explainer. Explain the selected text in simple Chinese with short structure and key points."
    },
    {
      role: "user",
      content: text
    }
  ];
}

async function getStorageValue(area, keys) {
  try {
    return await chrome.storage[area].get(keys);
  } catch {
    return {};
  }
}

async function readApiKey() {
  const [syncData, localData] = await Promise.all([
    getStorageValue("sync", ["kimiApiKey", "apiKey", "moonshotApiKey"]),
    getStorageValue("local", ["kimiApiKey", "apiKey", "moonshotApiKey"])
  ]);

  const candidates = [
    syncData.kimiApiKey,
    localData.kimiApiKey,
    syncData.apiKey,
    localData.apiKey,
    syncData.moonshotApiKey,
    localData.moonshotApiKey
  ];

  for (const item of candidates) {
    const key = normalizeApiKey(item || "");
    if (key) {
      return key;
    }
  }

  return "";
}

async function parseErrorMessage(response) {
  try {
    const json = await response.json();
    const message = json?.error?.message || json?.message;
    return message ? String(message) : JSON.stringify(json);
  } catch {
    return await response.text();
  }
}

function pickBestModel(availableModels) {
  const ids = availableModels
    .map((item) => String(item?.id || "").trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return KIMI_MODEL;
  }

  for (const preferred of MODEL_FALLBACK_PRIORITY) {
    if (ids.includes(preferred)) {
      return preferred;
    }
  }

  return ids[0];
}

async function fetchAvailableModels(apiKey, diagnostics) {
  const response = await fetch(KIMI_MODELS_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  addDiagnosticStep(diagnostics, {
    endpoint: KIMI_MODELS_URL,
    status: response.status
  });

  if (!response.ok) {
    const errorText = await parseErrorMessage(response);
    addDiagnosticStep(diagnostics, {
      endpoint: KIMI_MODELS_URL,
      status: response.status,
      error: errorText
    });
    throw new Error(`Failed to fetch model list: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return Array.isArray(data?.data) ? data.data : [];
}

async function resolveModel(apiKey, forceRefresh = false, diagnostics = null) {
  if (!forceRefresh) {
    const { kimiModel } = await chrome.storage.local.get(["kimiModel"]);
    if (typeof kimiModel === "string" && kimiModel.trim()) {
      if (diagnostics) {
        diagnostics.selectedModel = kimiModel.trim();
      }
      return kimiModel.trim();
    }
  }

  try {
    const availableModels = await fetchAvailableModels(apiKey, diagnostics);
    const bestModel = pickBestModel(availableModels);
    await chrome.storage.local.set({ kimiModel: bestModel });
    if (diagnostics) {
      diagnostics.selectedModel = bestModel;
    }
    return bestModel;
  } catch {
    // Do not block request flow if listing models is unavailable for this key/account.
    if (diagnostics) {
      diagnostics.selectedModel = KIMI_MODEL;
    }
    return KIMI_MODEL;
  }
}

async function postChatCompletion(apiKey, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(KIMI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function extractDeltaContent(delta) {
  if (typeof delta === "string") {
    return delta;
  }

  if (Array.isArray(delta)) {
    return delta
      .map((item) => (typeof item?.text === "string" ? item.text : ""))
      .join("");
  }

  return "";
}

function tryParseSseEventBlock(block, onChunk) {
  const lines = String(block || "")
    .split(/\r?\n/)
    .map((line) => line.trim());

  const dataParts = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataParts.push(line.slice(5).trim());
    }
  }

  if (dataParts.length === 0) {
    return { done: false, text: "" };
  }

  const data = dataParts.join("\n");
  if (data === "[DONE]") {
    return { done: true, text: "" };
  }

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { done: false, text: "" };
  }

  const delta = parsed?.choices?.[0]?.delta?.content;
  const chunkText = extractDeltaContent(delta);
  if (chunkText) {
    onChunk(chunkText);
  }

  return { done: false, text: chunkText };
}

async function executeChatCompletion(apiKey, mode, text, model, diagnostics = null) {
  const response = await postChatCompletion(apiKey, {
    model,
    temperature: mode === "translate" ? 0.2 : 0.5,
    messages: buildMessages(mode, text)
  });

  addDiagnosticStep(diagnostics, {
    endpoint: KIMI_API_URL,
    status: response.status
  });

  if (!response.ok) {
    const errorText = await parseErrorMessage(response);
    addDiagnosticStep(diagnostics, {
      endpoint: KIMI_API_URL,
      status: response.status,
      error: errorText
    });
    return {
      ok: false,
      status: response.status,
      errorText
    };
  }

  const data = await response.json();
  const message = data?.choices?.[0]?.message?.content;
  if (!message) {
    throw new Error("Kimi API returned an empty message.");
  }

  return {
    ok: true,
    message: message.trim()
  };
}

async function executeChatCompletionStream(apiKey, mode, text, model, onChunk, diagnostics = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(KIMI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: mode === "translate" ? 0.2 : 0.5,
        messages: buildMessages(mode, text),
        stream: true
      }),
      signal: controller.signal
    });

    addDiagnosticStep(diagnostics, {
      endpoint: KIMI_API_URL,
      status: response.status
    });

    if (!response.ok) {
      const errorText = await parseErrorMessage(response);
      addDiagnosticStep(diagnostics, {
        endpoint: KIMI_API_URL,
        status: response.status,
        error: errorText
      });
      return {
        ok: false,
        status: response.status,
        errorText
      };
    }

    if (!response.body) {
      throw new Error("Kimi API returned empty stream body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullText = "";
    let done = false;

    while (!done) {
      const readResult = await reader.read();
      done = readResult.done;
      if (readResult.value) {
        buffer += decoder.decode(readResult.value, { stream: !done });

        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          const parsed = tryParseSseEventBlock(block, onChunk);
          fullText += parsed.text;
          if (parsed.done) {
            done = true;
            break;
          }

          boundary = buffer.indexOf("\n\n");
        }
      }
    }

    if (buffer.trim()) {
      const parsed = tryParseSseEventBlock(buffer, onChunk);
      fullText += parsed.text;
    }

    const output = fullText.trim();
    if (!output) {
      throw new Error("Kimi API returned an empty message.");
    }

    return {
      ok: true,
      message: output
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callKimi({ mode, text, apiKeyOverride = "", withDiagnostics = false }) {
  const diagnostics = createDiagnostics(withDiagnostics);
  const apiKey = normalizeApiKey(apiKeyOverride) || (await readApiKey());
  if (!apiKey) {
    throwWithDiagnostics("Kimi API key is missing. Please set it in extension options.", diagnostics);
  }

  if (!isLikelyValidApiKey(apiKey)) {
    throwWithDiagnostics("Kimi API key format looks invalid. Please paste the raw key from Moonshot/Kimi open platform.", diagnostics);
  }

  let model = await resolveModel(apiKey, false, diagnostics);
  let result;

  try {
    result = await executeChatCompletion(apiKey, mode, text, model, diagnostics);
  } catch (error) {
    if (error?.name === "AbortError") {
      throwWithDiagnostics("Kimi API request timed out. Please check your network or try again later.", diagnostics);
    }
    if (diagnostics) {
      error.diagnostics = diagnostics;
    }
    throw error;
  }

  if (!result.ok && result.status === 400) {
    const lower = String(result.errorText || "").toLowerCase();
    const modelError = lower.includes("model") && (lower.includes("not exist") || lower.includes("not found") || lower.includes("invalid"));

    if (modelError) {
      model = await resolveModel(apiKey, true, diagnostics);
      try {
        result = await executeChatCompletion(apiKey, mode, text, model, diagnostics);
      } catch (error) {
        if (error?.name === "AbortError") {
          throwWithDiagnostics("Kimi API request timed out. Please check your network or try again later.", diagnostics);
        }
        if (diagnostics) {
          error.diagnostics = diagnostics;
        }
        throw error;
      }
    }
  }

  if (!result.ok) {
    if (result.status === 401) {
      throwWithDiagnostics(
        "Kimi API key authentication failed (401). Please confirm this key belongs to Moonshot Open Platform and is active, then save it again in extension options."
        ,
        diagnostics
      );
    }
    throwWithDiagnostics(`Kimi API failed: ${result.status} ${result.errorText}`, diagnostics);
  }

  if (diagnostics) {
    diagnostics.selectedModel = model;
    return {
      text: result.message,
      diagnostics
    };
  }

  return result.message;
}

async function callKimiStream({ mode, text, apiKeyOverride = "", onChunk, withDiagnostics = false }) {
  const diagnostics = createDiagnostics(withDiagnostics);
  const apiKey = normalizeApiKey(apiKeyOverride) || (await readApiKey());
  if (!apiKey) {
    throwWithDiagnostics("Kimi API key is missing. Please set it in extension options.", diagnostics);
  }

  if (!isLikelyValidApiKey(apiKey)) {
    throwWithDiagnostics("Kimi API key format looks invalid. Please paste the raw key from Moonshot/Kimi open platform.", diagnostics);
  }

  let model = await resolveModel(apiKey, false, diagnostics);
  let result;

  try {
    result = await executeChatCompletionStream(apiKey, mode, text, model, onChunk, diagnostics);
  } catch (error) {
    if (error?.name === "AbortError") {
      throwWithDiagnostics("Kimi API request timed out. Please check your network or try again later.", diagnostics);
    }
    if (diagnostics) {
      error.diagnostics = diagnostics;
    }
    throw error;
  }

  if (!result.ok && result.status === 400) {
    const lower = String(result.errorText || "").toLowerCase();
    const modelError = lower.includes("model") && (lower.includes("not exist") || lower.includes("not found") || lower.includes("invalid"));

    if (modelError) {
      model = await resolveModel(apiKey, true, diagnostics);
      try {
        result = await executeChatCompletionStream(apiKey, mode, text, model, onChunk, diagnostics);
      } catch (error) {
        if (error?.name === "AbortError") {
          throwWithDiagnostics("Kimi API request timed out. Please check your network or try again later.", diagnostics);
        }
        if (diagnostics) {
          error.diagnostics = diagnostics;
        }
        throw error;
      }
    }
  }

  if (!result.ok) {
    if (result.status === 401) {
      throwWithDiagnostics(
        "Kimi API key authentication failed (401). Please confirm this key belongs to Moonshot Open Platform and is active, then save it again in extension options."
        ,
        diagnostics
      );
    }
    throwWithDiagnostics(`Kimi API failed: ${result.status} ${result.errorText}`, diagnostics);
  }

  if (diagnostics) {
    diagnostics.selectedModel = model;
    return {
      text: result.message,
      diagnostics
    };
  }

  return result.message;
}

async function testKimiAuth() {
  const result = await callKimi({ mode: "explain", text: "hello" });
  return { ok: true, preview: result.slice(0, 80) };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "kimi-stream") {
    return;
  }

  port.onMessage.addListener((message) => {
    if (message?.type !== "kimi-stream-request") {
      return;
    }

    (async () => {
      try {
        port.postMessage({ type: "started" });
        const result = await callKimiStream({
          mode: message.mode,
          text: message.text,
          onChunk: (chunk) => {
            port.postMessage({ type: "chunk", chunk });
          }
        });

        port.postMessage({ type: "done", result });
      } catch (error) {
        port.postMessage({
          type: "error",
          error: error?.message || "Unknown error"
        });
      } finally {
        port.disconnect();
      }
    })();
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "kimi-request") {
    callKimi({ mode: message.mode, text: message.text })
      .then((result) => {
        sendResponse({ ok: true, result });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || "Unknown error" });
      });

    return true;
  }

  if (message?.type === "kimi-test-auth") {
    const diagnose = Boolean(message.diagnose);

    callKimi({ mode: "explain", text: "hello", apiKeyOverride: message.apiKey || "", withDiagnostics: diagnose })
      .then((result) => {
        if (!diagnose) {
          sendResponse({ ok: true, preview: result.slice(0, 80) });
          return;
        }

        sendResponse({
          ok: true,
          preview: result.text.slice(0, 80),
          diagnostics: result.diagnostics
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Unknown error",
          diagnostics: error?.diagnostics || null
        });
      });

    return true;
  }

  if (message?.type === "kimi-test-auth-legacy") {
    testKimiAuth()
      .then((result) => {
        sendResponse(result);
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || "Unknown error" });
      });

    return true;
  }

  if (!message?.type) {
    return;
  }
});