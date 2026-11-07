/**
 * background.js – LinkedIn Bulk Resume Downloader (Service Worker)
 * Handles download queueing, clean filename naming, and message relay.
 */

// ── Download Queue ────────────────────────────────────────
const downloadQueue = [];
let isProcessingQueue = false;

// ── Download State (for popup reconnection) ────────────────
let downloadState = {
  running: false,
  downloaded: 0,
  total: 0,
  failed: 0,
  lastCandidate: "",
  logs: [],        // Keep last 50 log lines
};

function pushLog(msg) {
  downloadState.logs.push(msg);
  if (downloadState.logs.length > 50) downloadState.logs.shift();
}

// ── PDF Tab Watcher ───────────────────────────────────────
// When content script signals EXPECT_PDF_TAB, we watch for new tabs
// opened from LinkedIn and auto-download + close them.
let pendingPdfDownload = null;   // { candidateName, timeoutId, sourceTabId, saved, lastError }
let lastSavedCandidate = "";
let lastPdfWatchError = "";

// ── Message Listener ──────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ── Popup asks for current state (reconnection after reopen) ──
  if (msg.type === "GET_STATE") {
    sendResponse({ state: downloadState });
    return true;
  }

  // ── Content script notifies download started / stopped ──
  if (msg.type === "DOWNLOAD_STARTED") {
    downloadState.running = true;
    downloadState.total = msg.total || 0;
    downloadState.downloaded = 0;
    downloadState.failed = 0;
    downloadState.logs = [];
    pushLog("Bulk download started.");
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "DOWNLOAD_STOPPED") {
    downloadState.running = false;
    pushLog("Download stopped.");
    sendResponse({ ok: true });
    return true;
  }

  // ── Install MAIN-world window.open / link intercept (CSP-safe) ──
  if (msg.type === "ENSURE_PAGE_BRIDGE") {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "no tab" });
      return true;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: installPageBridge,
      })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  // ── Set intercept filename + arm intercept in MAIN world ──
  if (msg.type === "ARM_PAGE_BRIDGE") {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "no tab" });
      return true;
    }
    const filename = msg.filename || buildFilename(msg.candidateName);
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: armPageBridge,
        args: [filename, !!msg.active],
      })
      .then(() => sendResponse({ ok: true, filename }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  // ── Download request from content script ────────────────
  if (msg.type === "DOWNLOAD_RESUME") {
    enqueueDownload(msg.url, msg.candidateName);
    sendResponse({ queued: true, ok: true });
    return true;
  }

  // ── Expect a new PDF tab (content script couldn't grab URL) ──
  if (msg.type === "EXPECT_PDF_TAB") {
    clearPdfWatch();
    lastSavedCandidate = "";
    lastPdfWatchError = "";
    pendingPdfDownload = {
      candidateName: msg.candidateName,
      sourceTabId: sender.tab ? sender.tab.id : -1,
      saved: false,
      lastError: "",
      timeoutId: setTimeout(() => {
        if (pendingPdfDownload && !pendingPdfDownload.saved) {
          lastPdfWatchError = lastPdfWatchError || "Timed out waiting for PDF tab";
        }
        clearPdfWatch();
      }, 30000),
    };
    console.log(`[LBRD] Watching for PDF tab for: ${msg.candidateName} (source tab: ${pendingPdfDownload.sourceTabId})`);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "CLEAR_PDF_TAB") {
    clearPdfWatch();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "PDF_TAB_STATUS") {
    sendResponse({
      watching: !!pendingPdfDownload,
      saved: !!(pendingPdfDownload && pendingPdfDownload.saved) ||
        (!!msg.candidateName && lastSavedCandidate === msg.candidateName),
      lastSavedCandidate: lastSavedCandidate,
      lastError: pendingPdfDownload ? pendingPdfDownload.lastError : lastPdfWatchError,
    });
    return true;
  }

  // ── Relay progress / done / error messages to popup ─────
  if (["PROGRESS", "DONE", "DOWNLOAD_ERROR", "LOG"].includes(msg.type)) {
    // Update persistent state
    if (msg.type === "PROGRESS") {
      downloadState.downloaded = msg.downloaded || downloadState.downloaded;
      downloadState.total = msg.total || downloadState.total;
      downloadState.failed = msg.failed || downloadState.failed;
      downloadState.lastCandidate = msg.candidateName || "";
      if (msg.candidateName) pushLog(`✓ Downloaded: ${msg.candidateName}`);
    }
    if (msg.type === "DOWNLOAD_ERROR") {
      downloadState.failed = (downloadState.failed || 0) + 1;
      pushLog(`✗ Failed: ${msg.candidateName || "unknown"} — ${msg.error}`);
    }
    if (msg.type === "LOG") {
      pushLog(msg.message || "");
    }
    if (msg.type === "DONE") {
      downloadState.running = false;
      downloadState.downloaded = msg.downloaded || downloadState.downloaded;
      downloadState.total = msg.total || downloadState.total;
      downloadState.failed = msg.failed || downloadState.failed;
      pushLog(`All done! ${msg.downloaded} resume(s) downloaded, ${msg.failed} failed.`);
    }

    chrome.runtime.sendMessage(msg).catch(() => {});
  }

  return false;
});

function clearPdfWatch() {
  if (pendingPdfDownload) {
    clearTimeout(pendingPdfDownload.timeoutId);
    pendingPdfDownload = null;
  }
}

/** Injected into LinkedIn's MAIN world via chrome.scripting (bypasses page CSP). */
function installPageBridge() {
  if (window.__lbrd_bridge_installed) return;
  window.__lbrd_bridge_installed = true;
  window.__lbrd_currentFilename = window.__lbrd_currentFilename || "Resume.pdf";
  window.__lbrd_intercept_active = false;

  function looksLikeResumeUrl(href) {
    var h = String(href || "").toLowerCase();
    return (
      h.includes(".pdf") ||
      h.includes("mediaauth") ||
      h.includes("ambry") ||
      h.includes("resume") ||
      h.includes("dms/") ||
      h.includes("media.licdn") ||
      h.includes("resumeviewer") ||
      (h.includes("licdn.com") && !h.includes(".js") && !h.includes(".css"))
    );
  }

  function downloadBlob(buf) {
    var blob = buf instanceof Blob ? buf : new Blob([buf], { type: "application/pdf" });
    var u = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = u;
    a.download = window.__lbrd_currentFilename || "Resume.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(u);
    }, 15000);
  }

  function fetchAndDownload(url) {
    var s = String(url || "");
    window.postMessage({ __lbrd_intercepted: true, url: s }, "*");
    return fetch(s, { credentials: "include" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        downloadBlob(buf);
        window.postMessage({ __lbrd_download_done: true }, "*");
      })
      .catch(function (err) {
        window.postMessage(
          {
            __lbrd_download_failed: true,
            error: String((err && err.message) || err),
          },
          "*"
        );
      });
  }

  if (!window.__lbrd_origOpen) {
    window.__lbrd_origOpen = window.open;
  }

  // While armed: intercept ALL opens (LinkedIn PDF URLs are often opaque).
  // While idle: only intercept obvious resume/PDF links.
  window.open = function (url) {
    var s = String(url || "");
    if (window.__lbrd_intercept_active || looksLikeResumeUrl(s)) {
      fetchAndDownload(s);
      return null;
    }
    return window.__lbrd_origOpen.apply(this, arguments);
  };

  document.addEventListener(
    "click",
    function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a") : null;
      if (!a || !a.href) return;
      var target = a.target || a.getAttribute("target") || "";
      if (target !== "_blank") return;
      if (!(window.__lbrd_intercept_active || looksLikeResumeUrl(a.href))) return;
      e.preventDefault();
      e.stopPropagation();
      fetchAndDownload(a.href);
    },
    true
  );
}

/** Injected into MAIN world to set filename and arm/disarm intercept. */
function armPageBridge(filename, active) {
  if (typeof filename === "string" && filename) {
    window.__lbrd_currentFilename = filename;
  }
  window.__lbrd_intercept_active = !!active;
}

function isPdfLikeUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes(".pdf") ||
    lower.includes("mediaauth") ||
    lower.includes("ambry") ||
    lower.includes("dms/") ||
    lower.includes("media.licdn.com") ||
    lower.includes("resumeViewer") ||
    lower.includes("resume") ||
    (lower.includes("licdn.com") && !lower.includes(".js") && !lower.includes(".css"))
  );
}

// ── Watch for new tabs — ANY new tab counts while expecting PDF ──

async function handleNewTabUrl(tabId, url) {
  if (!pendingPdfDownload) return;
  if (!url || url === "" || url === "about:blank" || url === "chrome://newtab/") return;
  if (tabId === pendingPdfDownload.sourceTabId) return; // skip the source tab

  const candidateName = pendingPdfDownload.candidateName;
  const filename = buildFilename(candidateName);
  console.log(`[LBRD] PDF tab detected (tabId=${tabId}): ${url.substring(0, 120)}`);

  // Strategy 1: Try to download from within the tab using fetch+blob
  // (the tab already has the PDF loaded, so re-fetching from same origin works)
  let ok = false;
  try {
    // Wait a moment for the tab to finish loading
    await sleep(2000);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async (fname) => {
        try {
          const resp = await fetch(window.location.href, { credentials: "include" });
          if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
          const blob = await resp.blob();
          const u = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = u;
          a.download = fname;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(u), 15000);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
      args: [filename],
    });

    const r = results?.[0]?.result;
    if (r && r.ok) {
      console.log(`[LBRD] In-tab fetch+download succeeded for: ${filename}`);
      ok = true;
    } else {
      console.log(`[LBRD] In-tab fetch failed (${r?.error}), falling back to chrome.downloads`);
      await triggerDownload(url, filename);
      ok = true;
    }
  } catch (err) {
    // executeScript might fail on chrome:// PDF viewer pages
    console.log(`[LBRD] executeScript failed (${err.message}), falling back to chrome.downloads`);
    try {
      await triggerDownload(url, filename);
      ok = true;
    } catch (dlErr) {
      lastPdfWatchError = String(dlErr && dlErr.message || dlErr);
      if (pendingPdfDownload) pendingPdfDownload.lastError = lastPdfWatchError;
      ok = false;
    }
  }

  if (ok) {
    lastSavedCandidate = candidateName;
    if (pendingPdfDownload) pendingPdfDownload.saved = true;
    clearPdfWatch();
  }

  // Close the PDF tab after download starts
  setTimeout(() => {
    chrome.tabs.remove(tabId).catch(() => {});
  }, 3000);
}

chrome.tabs.onCreated.addListener((tab) => {
  if (!pendingPdfDownload) return;
  const url = tab.pendingUrl || tab.url || "";
  console.log(`[LBRD] tabs.onCreated: tabId=${tab.id}, url=${url.substring(0, 80)}`);
  if (url && url !== "about:blank" && url !== "chrome://newtab/") {
    handleNewTabUrl(tab.id, url);
  }
  // If URL is blank, onUpdated will fire later with the real URL
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!pendingPdfDownload) return;
  // Only act on URL changes or when loading completes
  const url = changeInfo.url || "";
  if (url) {
    handleNewTabUrl(tabId, url);
  }
});

// ── Queue Processor ───────────────────────────────────────

function enqueueDownload(url, candidateName) {
  const filename = buildFilename(candidateName);
  downloadQueue.push({ url, filename });

  if (!isProcessingQueue) {
    processQueue();
  }
}

async function processQueue() {
  isProcessingQueue = true;

  while (downloadQueue.length > 0) {
    const { url, filename } = downloadQueue.shift();

    try {
      await triggerDownload(url, filename);
    } catch (err) {
      console.warn("[LBRD] Download failed:", filename, err);
    }

    // Small gap between downloads to prevent Chrome from throttling
    await sleep(500);
  }

  isProcessingQueue = false;
}

// ── Chrome Downloads API ──────────────────────────────────

function triggerDownload(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: url,
        filename: `LinkedIn_Resumes/${filename}`,
        conflictAction: "uniquify",   // auto-rename if duplicate
        saveAs: false,                 // silent download
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        console.log(`[LBRD] Download started: ${filename} (id: ${downloadId})`);
        resolve(downloadId);
      }
    );
  });
}

// ── Filename Builder ──────────────────────────────────────

function buildFilename(candidateName) {
  // Sanitise: keep only word chars, hyphens, underscores
  let safe = (candidateName || "Unknown_Candidate")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w\-]/g, "")
    .substring(0, 80);

  if (!safe) safe = "Unknown_Candidate";

  // Append timestamp to guarantee uniqueness
  const ts = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${safe}_Resume_${ts}.pdf`;
}

// ── Utility ───────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Extension Install / Update Hook ──────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.log("[LBRD] LinkedIn Bulk Resume Downloader installed.");
  }
});
