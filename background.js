const PROVIDER_CONFIG = {
  moonshot: {
    id: "moonshot",
    displayName: "Kimi",
    apiUrl: "https://api.moonshot.cn/v1/chat/completions",
    modelsUrl: "https://api.moonshot.cn/v1/models",
    defaultModel: "moonshot-v1-8k",
    fallbackPriority: [
      "moonshot-v1-8k",
      "moonshot-v1-32k",
      "moonshot-v1-128k",
      "kimi-k2-0711-preview",
      "kimi-k2-turbo-preview",
      "kimi-latest"
    ],
    keyStorageKeys: ["kimiApiKey", "apiKey", "moonshotApiKey"],
    modelStorageKey: "kimiModel"
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    apiUrl: "https://api.deepseek.com/chat/completions",
    modelsUrl: "https://api.deepseek.com/models",
    defaultModel: "deepseek-chat",
    fallbackPriority: ["deepseek-v4-flash"],
    keyStorageKeys: ["deepseekApiKey"],
    modelStorageKey: "deepseekModel"
  }
};

const DEFAULT_PROVIDER = "moonshot";
const REQUEST_TIMEOUT_MS = 30000;

function truncateText(input, maxLength = 180) {
  const text = String(input || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function normalizeProvider(rawProvider) {
  const value = String(rawProvider || "").trim().toLowerCase();
  if (value === "deepseek") {
    return "deepseek";
  }
  return "moonshot";
}

function getProviderConfig(provider) {
  const providerId = normalizeProvider(provider);
  return PROVIDER_CONFIG[providerId] || PROVIDER_CONFIG[DEFAULT_PROVIDER];
}

function createDiagnostics(enabled, provider) {
  if (!enabled) {
    return null;
  }

  return {
    selectedProvider: getProviderConfig(provider).displayName,
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

  if (mode === "to-english") {
    return [
      {
        role: "system",
        content:
          "You are a professional translator. Translate user text into concise, natural English. Return only the translated result."
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

async function readProvider(providerOverride = "") {
  const override = normalizeProvider(providerOverride);
  if (providerOverride) {
    return override;
  }

  const [syncData, localData] = await Promise.all([
    getStorageValue("sync", ["aiProvider", "provider"]),
    getStorageValue("local", ["aiProvider", "provider"])
  ]);

  return normalizeProvider(syncData.aiProvider || localData.aiProvider || syncData.provider || localData.provider || DEFAULT_PROVIDER);
}

async function readApiKey(provider, apiKeyOverride = "") {
  const manual = normalizeApiKey(apiKeyOverride);
  if (manual) {
    return manual;
  }

  const config = getProviderConfig(provider);
  const [syncData, localData] = await Promise.all([
    getStorageValue("sync", config.keyStorageKeys),
    getStorageValue("local", config.keyStorageKeys)
  ]);

  const candidates = config.keyStorageKeys.flatMap((keyName) => [syncData[keyName], localData[keyName]]);
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

function pickBestModel(availableModels, provider) {
  const config = getProviderConfig(provider);
  const ids = availableModels
    .map((item) => String(item?.id || "").trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return config.defaultModel;
  }

  for (const preferred of config.fallbackPriority) {
    if (ids.includes(preferred)) {
      return preferred;
    }
  }

  return ids[0];
}

async function fetchAvailableModels(apiKey, provider, diagnostics) {
  const config = getProviderConfig(provider);
  const response = await fetch(config.modelsUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  addDiagnosticStep(diagnostics, {
    endpoint: config.modelsUrl,
    status: response.status
  });

  if (!response.ok) {
    const errorText = await parseErrorMessage(response);
    addDiagnosticStep(diagnostics, {
      endpoint: config.modelsUrl,
      status: response.status,
      error: errorText
    });
    throw new Error(`Failed to fetch model list: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return Array.isArray(data?.data) ? data.data : [];
}

async function resolveModel(apiKey, provider, forceRefresh = false, diagnostics = null) {
  const config = getProviderConfig(provider);
  if (!forceRefresh) {
    const cached = await chrome.storage.local.get([config.modelStorageKey]);
    const value = cached[config.modelStorageKey];
    if (typeof value === "string" && value.trim()) {
      if (diagnostics) {
        diagnostics.selectedModel = value.trim();
      }
      return value.trim();
    }
  }

  try {
    const availableModels = await fetchAvailableModels(apiKey, provider, diagnostics);
    const bestModel = pickBestModel(availableModels, provider);
    await chrome.storage.local.set({ [config.modelStorageKey]: bestModel });
    if (diagnostics) {
      diagnostics.selectedModel = bestModel;
    }
    return bestModel;
  } catch {
    // Do not block request flow if listing models is unavailable for this key/account.
    if (diagnostics) {
      diagnostics.selectedModel = config.defaultModel;
    }
    return config.defaultModel;
  }
}

async function postChatCompletion(apiKey, payload, provider) {
  const config = getProviderConfig(provider);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(config.apiUrl, {
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

async function executeChatCompletion(apiKey, mode, text, model, provider, diagnostics = null) {
  const config = getProviderConfig(provider);
  const isTranslateMode = mode === "translate" || mode === "to-english";
  const response = await postChatCompletion(
    apiKey,
    {
      model,
      temperature: isTranslateMode ? 0.2 : 0.5,
      messages: buildMessages(mode, text)
    },
    provider
  );

  addDiagnosticStep(diagnostics, {
    endpoint: config.apiUrl,
    status: response.status
  });

  if (!response.ok) {
    const errorText = await parseErrorMessage(response);
    addDiagnosticStep(diagnostics, {
      endpoint: config.apiUrl,
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
    throw new Error(`${config.displayName} API returned an empty message.`);
  }

  return {
    ok: true,
    message: message.trim()
  };
}

async function executeChatCompletionStream(apiKey, mode, text, model, provider, onChunk, diagnostics = null) {
  const config = getProviderConfig(provider);
  const isTranslateMode = mode === "translate" || mode === "to-english";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: isTranslateMode ? 0.2 : 0.5,
        messages: buildMessages(mode, text),
        stream: true
      }),
      signal: controller.signal
    });

    addDiagnosticStep(diagnostics, {
      endpoint: config.apiUrl,
      status: response.status
    });

    if (!response.ok) {
      const errorText = await parseErrorMessage(response);
      addDiagnosticStep(diagnostics, {
        endpoint: config.apiUrl,
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
      throw new Error(`${config.displayName} API returned empty stream body.`);
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
      throw new Error(`${config.displayName} API returned an empty message.`);
    }

    return {
      ok: true,
      message: output
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isModelErrorResponse(result) {
  if (!result || result.ok || result.status !== 400) {
    return false;
  }

  const lower = String(result.errorText || "").toLowerCase();
  return lower.includes("model") && (lower.includes("not exist") || lower.includes("not found") || lower.includes("invalid"));
}

async function callAI({ mode, text, apiKeyOverride = "", providerOverride = "", withDiagnostics = false }) {
  const provider = await readProvider(providerOverride);
  const config = getProviderConfig(provider);
  const diagnostics = createDiagnostics(withDiagnostics, provider);
  const apiKey = await readApiKey(provider, apiKeyOverride);

  if (!apiKey) {
    throwWithDiagnostics(`${config.displayName} API key is missing. Please set it in extension options.`, diagnostics);
  }

  if (!isLikelyValidApiKey(apiKey)) {
    throwWithDiagnostics(`${config.displayName} API key format looks invalid. Please paste the raw key from ${config.displayName} open platform.`, diagnostics);
  }

  let model = await resolveModel(apiKey, provider, false, diagnostics);
  let result;

  try {
    result = await executeChatCompletion(apiKey, mode, text, model, provider, diagnostics);
  } catch (error) {
    if (error?.name === "AbortError") {
      throwWithDiagnostics(`${config.displayName} API request timed out. Please check your network or try again later.`, diagnostics);
    }
    if (diagnostics) {
      error.diagnostics = diagnostics;
    }
    throw error;
  }

  if (isModelErrorResponse(result)) {
    model = await resolveModel(apiKey, provider, true, diagnostics);
    try {
      result = await executeChatCompletion(apiKey, mode, text, model, provider, diagnostics);
    } catch (error) {
      if (error?.name === "AbortError") {
        throwWithDiagnostics(`${config.displayName} API request timed out. Please check your network or try again later.`, diagnostics);
      }
      if (diagnostics) {
        error.diagnostics = diagnostics;
      }
      throw error;
    }
  }

  if (!result.ok) {
    if (result.status === 401) {
      throwWithDiagnostics(
        `${config.displayName} API key authentication failed (401). Please confirm this key is active, then save it again in extension options.`,
        diagnostics
      );
    }
    throwWithDiagnostics(`${config.displayName} API failed: ${result.status} ${result.errorText}`, diagnostics);
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

async function callAIStream({ mode, text, apiKeyOverride = "", providerOverride = "", onChunk, withDiagnostics = false }) {
  const provider = await readProvider(providerOverride);
  const config = getProviderConfig(provider);
  const diagnostics = createDiagnostics(withDiagnostics, provider);
  const apiKey = await readApiKey(provider, apiKeyOverride);

  if (!apiKey) {
    throwWithDiagnostics(`${config.displayName} API key is missing. Please set it in extension options.`, diagnostics);
  }

  if (!isLikelyValidApiKey(apiKey)) {
    throwWithDiagnostics(`${config.displayName} API key format looks invalid. Please paste the raw key from ${config.displayName} open platform.`, diagnostics);
  }

  let model = await resolveModel(apiKey, provider, false, diagnostics);
  let result;

  try {
    result = await executeChatCompletionStream(apiKey, mode, text, model, provider, onChunk, diagnostics);
  } catch (error) {
    if (error?.name === "AbortError") {
      throwWithDiagnostics(`${config.displayName} API request timed out. Please check your network or try again later.`, diagnostics);
    }
    if (diagnostics) {
      error.diagnostics = diagnostics;
    }
    throw error;
  }

  if (isModelErrorResponse(result)) {
    model = await resolveModel(apiKey, provider, true, diagnostics);
    try {
      result = await executeChatCompletionStream(apiKey, mode, text, model, provider, onChunk, diagnostics);
    } catch (error) {
      if (error?.name === "AbortError") {
        throwWithDiagnostics(`${config.displayName} API request timed out. Please check your network or try again later.`, diagnostics);
      }
      if (diagnostics) {
        error.diagnostics = diagnostics;
      }
      throw error;
    }
  }

  if (!result.ok) {
    if (result.status === 401) {
      throwWithDiagnostics(
        `${config.displayName} API key authentication failed (401). Please confirm this key is active, then save it again in extension options.`,
        diagnostics
      );
    }
    throwWithDiagnostics(`${config.displayName} API failed: ${result.status} ${result.errorText}`, diagnostics);
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

async function testAIAuth(providerOverride = "") {
  const result = await callAI({ mode: "explain", text: "hello", providerOverride });
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
        const result = await callAIStream({
          mode: message.mode,
          text: message.text,
          providerOverride: message.provider || "",
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
    callAI({ mode: message.mode, text: message.text, providerOverride: message.provider || "" })
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

    callAI({
      mode: "explain",
      text: "hello",
      apiKeyOverride: message.apiKey || "",
      providerOverride: message.provider || "",
      withDiagnostics: diagnose
    })
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
    testAIAuth(message?.provider || "")
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
