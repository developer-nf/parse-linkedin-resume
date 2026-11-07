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
let pendingPdfDownload = null;   // { candidateName, timeoutId, sourceTabId }

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

  // ── Download request from content script ────────────────
  if (msg.type === "DOWNLOAD_RESUME") {
    enqueueDownload(msg.url, msg.candidateName);
    sendResponse({ queued: true });
    return true;
  }

  // ── Expect a new PDF tab (content script couldn't grab URL) ──
  if (msg.type === "EXPECT_PDF_TAB") {
    clearPdfWatch();
    pendingPdfDownload = {
      candidateName: msg.candidateName,
      sourceTabId: sender.tab ? sender.tab.id : -1,
      timeoutId: setTimeout(clearPdfWatch, 30000), // 30s safety timeout
    };
    console.log(`[LBRD] Watching for PDF tab for: ${msg.candidateName} (source tab: ${pendingPdfDownload.sourceTabId})`);
    sendResponse({ ok: true });
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
  clearPdfWatch();

  // Strategy 1: Try to download from within the tab using fetch+blob
  // (the tab already has the PDF loaded, so re-fetching from same origin works)
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
    } else {
      console.log(`[LBRD] In-tab fetch failed (${r?.error}), falling back to chrome.downloads`);
      await triggerDownload(url, filename);
    }
  } catch (err) {
    // executeScript might fail on chrome:// PDF viewer pages
    console.log(`[LBRD] executeScript failed (${err.message}), falling back to chrome.downloads`);
    await triggerDownload(url, filename);
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
