const MAX_TEXT_LENGTH = 3000;
const MAX_PAGE_TEXT_LENGTH = 12000;

let toolbar;
let resultCard;
let explainBtn;
let translateBtn;
let toMdBtn;
let resultTitle;
let resultContent;
let lastSelectionRect = null;
let selectionCheckTimer = null;

function createToolbar() {
  toolbar = document.createElement("div");
  toolbar.id = "kimi-selection-toolbar";

  explainBtn = document.createElement("button");
  explainBtn.className = "kimi-toolbar-btn";
  explainBtn.type = "button";
  explainBtn.textContent = "AI Explain";

  translateBtn = document.createElement("button");
  translateBtn.className = "kimi-toolbar-btn";
  translateBtn.type = "button";
  translateBtn.textContent = "To Chinese";

  toMdBtn = document.createElement("button");
  toMdBtn.className = "kimi-toolbar-btn";
  toMdBtn.type = "button";
  toMdBtn.textContent = "To MD";

  toolbar.append(explainBtn, translateBtn, toMdBtn);
  document.documentElement.appendChild(toolbar);

  explainBtn.addEventListener("click", () => handleAction("explain"));
  translateBtn.addEventListener("click", () => handleAction("translate"));
  toMdBtn.addEventListener("click", () => handleAction("to-md"));
}

function createResultCard() {
  resultCard = document.createElement("section");
  resultCard.id = "kimi-result-card";

  const header = document.createElement("div");
  header.className = "kimi-result-header";

  resultTitle = document.createElement("p");
  resultTitle.className = "kimi-result-title";
  resultTitle.textContent = "Result";

  const closeBtn = document.createElement("button");
  closeBtn.className = "kimi-result-close";
  closeBtn.type = "button";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", hideResultCard);

  header.append(resultTitle, closeBtn);

  resultContent = document.createElement("pre");
  resultContent.className = "kimi-result-content";
  resultContent.textContent = "";

  resultCard.append(header, resultContent);
  document.documentElement.appendChild(resultCard);
}

function getSelectionText() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return "";
  }
  return selection.toString().trim().slice(0, MAX_TEXT_LENGTH);
}

function getPageText() {
  const articleEl = document.querySelector("article, main, [role='main']");
  const baseText = articleEl?.innerText || document.body?.innerText || "";
  return String(baseText || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_PAGE_TEXT_LENGTH);
}

function getSelectionRect() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const clientRects = Array.from(range.getClientRects());

  // Some websites return an empty bounding rect for multi-line or complex selections.
  const validRect = clientRects.find((item) => item.width > 0 || item.height > 0);
  if (validRect) {
    return validRect;
  }

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }

  return rect;
}

function placeElementNearRect(el, rect, offsetY = 10) {
  const top = rect.top - offsetY;
  const left = rect.left + rect.width / 2;

  el.style.top = `${Math.max(8, top)}px`;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - 8, left))}px`;
  el.style.transform = "translate(-50%, -100%)";
}

function showToolbar(rect) {
  lastSelectionRect = rect;
  placeElementNearRect(toolbar, rect, 12);
  toolbar.style.display = "flex";
}

function hideToolbar() {
  toolbar.style.display = "none";
}

function showResultCard(title, text) {
  if (!lastSelectionRect) {
    return;
  }

  resultTitle.textContent = title;
  resultContent.textContent = text;
  placeElementNearRect(resultCard, lastSelectionRect, -16);
  resultCard.style.transform = "translate(-50%, 0)";
  resultCard.style.display = "block";
}

function hideResultCard() {
  resultCard.style.display = "none";
}

function setLoading(loading, mode) {
  explainBtn.disabled = loading;
  translateBtn.disabled = loading;
  toMdBtn.disabled = loading;

  if (loading) {
    if (mode === "translate") {
      translateBtn.textContent = "Loading...";
    } else if (mode === "to-md") {
      toMdBtn.textContent = "Loading...";
    } else {
      explainBtn.textContent = "Loading...";
    }
  } else {
    explainBtn.textContent = "AI Explain";
    translateBtn.textContent = "To Chinese";
    toMdBtn.textContent = "To MD";
  }
}

function resolveModeTitle(mode) {
  if (mode === "translate") {
    return "Chinese Translation";
  }
  if (mode === "to-md") {
    return "Markdown Summary";
  }
  return "AI Explanation";
}

function requestKimiStream({ mode, text, onChunk }) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "kimi-stream" });
    let settled = false;
    let hasStarted = false;

    const cleanup = () => {
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
    };

    const finalizeResolve = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };

    const finalizeReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    function onMessage(message) {
      if (!message?.type) {
        return;
      }

      if (message.type === "started") {
        hasStarted = true;
        return;
      }

      if (message.type === "chunk") {
        onChunk(message.chunk || "");
        return;
      }

      if (message.type === "done") {
        finalizeResolve(message.result || "");
        return;
      }

      if (message.type === "error") {
        finalizeReject(new Error(message.error || "Unknown error"));
      }
    }

    function onDisconnect() {
      if (settled) {
        return;
      }

      const runtimeError = chrome.runtime.lastError;
      const message = runtimeError?.message || (hasStarted ? "Stream closed unexpectedly" : "Unable to connect background service");
      finalizeReject(new Error(message));
    }

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    port.postMessage({ type: "kimi-stream-request", mode, text });
  });
}

async function handleAction(mode) {
  const text = mode === "to-md" ? getPageText() : getSelectionText();
  if (!text) {
    hideToolbar();
    return;
  }

  setLoading(true, mode);
  const title = resolveModeTitle(mode);
  showResultCard(title, "Waiting for Kimi response...");

  try {
    let streamed = "";
    await requestKimiStream({
      mode,
      text,
      onChunk: (chunk) => {
        streamed += chunk;
        showResultCard(title, streamed || "Waiting for Kimi response...");
      }
    });

    if (!streamed.trim()) {
      throw new Error("Kimi API returned an empty message.");
    }
  } catch (error) {
    const message = error?.message || "Request failed";
    const lower = message.toLowerCase();
    const needsSetupTip = lower.includes("key is missing") || lower.includes("format is invalid");
    const tip = needsSetupTip ? "\n\nOpen extension options and set Kimi API key first." : "";
    showResultCard("Error", `${message}${tip}`);
  } finally {
    setLoading(false, mode);
  }
}

function onSelectionChange() {
  const text = getSelectionText();
  if (!text) {
    hideToolbar();
    return;
  }

  const rect = getSelectionRect();
  if (!rect) {
    hideToolbar();
    return;
  }

  // Hide previous result only when user makes a new valid text selection.
  hideResultCard();
  showToolbar(rect);
}

function scheduleSelectionCheck() {
  if (selectionCheckTimer) {
    clearTimeout(selectionCheckTimer);
  }

  selectionCheckTimer = setTimeout(() => {
    onSelectionChange();
  }, 20);
}

function onGlobalPointerDown(event) {
  const target = event.target;
  if (!target) {
    return;
  }

  if (toolbar.contains(target) || resultCard.contains(target)) {
    return;
  }

  hideToolbar();
  hideResultCard();
}

function init() {
  createToolbar();
  createResultCard();

  document.addEventListener("mouseup", scheduleSelectionCheck);
  document.addEventListener("keyup", scheduleSelectionCheck);
  document.addEventListener("selectionchange", scheduleSelectionCheck);
  document.addEventListener("pointerdown", onGlobalPointerDown, true);
  window.addEventListener("scroll", () => {
    hideToolbar();
  });
}

init();