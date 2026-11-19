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
let lastPdfTabResult = { candidateName: "", error: "", at: 0 };

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
    lastPdfTabResult = { candidateName: "", error: "", at: 0 };
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
    enqueueDownload(msg.url, msg.candidateName, msg.filename)
      .then(() => sendResponse({ queued: true, ok: true }))
      .catch((err) => {
        console.warn("[LBRD] DOWNLOAD_RESUME failed:", err);
        sendResponse({ queued: false, ok: false, error: String(err && err.message || err) });
      });
    return true; // async
  }

  // ── Content script tells us the name for the next save ──
  if (msg.type === "SET_INTENDED_FILENAME") {
    const fname = msg.filename || buildFilename(msg.candidateName);
    lastIntendedRelativePath = fname.includes("/") ? fname : `LinkedIn_Resumes/${fname}`;
    sendResponse({ ok: true, path: lastIntendedRelativePath });
    return true;
  }

  // ── Expect a new PDF tab (content script couldn't grab URL) ──
  if (msg.type === "EXPECT_PDF_TAB") {
    clearPdfWatch();
    lastPdfTabResult = { candidateName: "", error: "", at: 0 };
    const intended = buildFilename(msg.candidateName);
    lastIntendedRelativePath = `LinkedIn_Resumes/${intended}`;
    pendingPdfDownload = {
      candidateName: msg.candidateName,
      sourceTabId: sender.tab ? sender.tab.id : -1,
      timeoutId: setTimeout(() => {
        if (pendingPdfDownload) {
          lastPdfTabResult = {
            candidateName: "",
            error: "PDF tab watch timed out",
            at: Date.now(),
          };
          pendingPdfDownload = null;
        }
      }, 60000),
    };
    console.log(`[LBRD] Watching for PDF tab for: ${msg.candidateName} (source tab: ${pendingPdfDownload.sourceTabId})`);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "CLEAR_PDF_TAB") {
    clearPdfWatch();
    lastPdfTabResult = { candidateName: "", error: "", at: 0 };
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "PDF_TAB_STATUS") {
    sendResponse({
      watching: !!pendingPdfDownload,
      lastSavedCandidate: lastPdfTabResult.candidateName || "",
      lastError: lastPdfTabResult.error || "",
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
    lower.startsWith("data:application/pdf") ||
    (lower.includes("licdn.com") && !lower.includes(".js") && !lower.includes(".css"))
  );
}

// ── Watch for new tabs — ANY new tab counts while expecting PDF ──

async function handleNewTabUrl(tabId, url) {
  if (!pendingPdfDownload) return;
  if (!url || url === "" || url === "about:blank" || url === "chrome://newtab/") return;
  if (tabId === pendingPdfDownload.sourceTabId) return; // skip the source tab
  if (!isPdfLikeUrl(url) && !url.includes("licdn.com") && !url.includes("linkedin.com")) {
    // Ignore unrelated new tabs while watching
    return;
  }

  // Avoid racing: if we already started handling this tab, skip
  if (pendingPdfDownload.handlingTabId === tabId) return;
  pendingPdfDownload.handlingTabId = tabId;

  const candidateName = pendingPdfDownload.candidateName;
  const filename = buildFilename(candidateName);
  console.log(`[LBRD] PDF tab detected (tabId=${tabId}): ${url.substring(0, 120)}`);

  let saved = false;
  let finalUrl = url;

  try {
    // Settle + wait out virus-scan interstitial before clearing the watch
    await sleep(2000 + Math.floor(Math.random() * 2000)); // 2–4s

    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async (fname) => {
        try {
          // Wait until LinkedIn virus-scan interstitial clears or we get real PDF bytes
          const start = Date.now();
          const maxWait = 20000;
          while (Date.now() - start < maxWait) {
            const bodyText = (document.body && document.body.innerText) || "";
            const scanning = /Scanning resume for viruses|scan.*virus|Please refresh/i.test(bodyText);
            if (scanning) {
              await new Promise((r) => setTimeout(r, 700 + Math.floor(Math.random() * 500)));
              continue;
            }
            break;
          }

          const pageUrl = window.location.href;
          const resp = await fetch(pageUrl, { credentials: "include" });
          if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}`, url: pageUrl };
          const buf = await resp.arrayBuffer();
          const head = new Uint8Array(buf.slice(0, 4));
          const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
          if (!isPdf) {
            return { ok: false, error: "Tab content is not a PDF yet", url: pageUrl };
          }
          const blob = new Blob([buf], { type: "application/pdf" });
          const u = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = u;
          a.download = fname;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(u), 15000);
          return { ok: true, url: pageUrl };
        } catch (e) {
          return { ok: false, error: e.message, url: window.location.href };
        }
      },
      args: [filename],
    });

    const r = results?.[0]?.result;
    if (r && r.url) finalUrl = r.url;

    if (r && r.ok) {
      console.log(`[LBRD] In-tab fetch+download succeeded for: ${filename}`);
      saved = true;
    } else {
      console.log(`[LBRD] In-tab fetch failed (${r?.error}), falling back to chrome.downloads`);
      // Only fall back if we are past the interstitial; otherwise mark error
      if (r && /not a PDF|virus|scan|refresh/i.test(r.error || "")) {
        lastPdfTabResult = {
          candidateName: "",
          error: r.error || "PDF not ready after virus scan wait",
          at: Date.now(),
        };
        saved = false;
      } else {
        await triggerDownload(finalUrl, filename);
        saved = true;
      }
    }
  } catch (err) {
    // executeScript might fail on chrome:// PDF viewer pages
    console.log(`[LBRD] executeScript failed (${err.message}), falling back to chrome.downloads`);
    try {
      await triggerDownload(finalUrl, filename);
      saved = true;
    } catch (dlErr) {
      lastPdfTabResult = {
        candidateName: "",
        error: dlErr.message || String(dlErr),
        at: Date.now(),
      };
      saved = false;
    }
  }

  clearPdfWatch();

  if (saved) {
    lastPdfTabResult = { candidateName, error: "", at: Date.now() };
    pushLog(`✓ Tab watcher saved: ${candidateName}`);
  }

  // Close the PDF tab only after we attempted save (longer if failed mid-scan)
  setTimeout(() => {
    chrome.tabs.remove(tabId).catch(() => {});
  }, saved ? 2500 : 5000);
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

function enqueueDownload(url, candidateName, explicitFilename) {
  const filename = explicitFilename || buildFilename(candidateName);
  return new Promise((resolve, reject) => {
    downloadQueue.push({ url, filename, candidateName, resolve, reject });
    if (!isProcessingQueue) {
      processQueue();
    }
  });
}

async function processQueue() {
  isProcessingQueue = true;

  while (downloadQueue.length > 0) {
    const { url, filename, candidateName, resolve, reject } = downloadQueue.shift();

    try {
      await triggerDownload(url, filename);
      lastPdfTabResult = { candidateName: candidateName || "", error: "", at: Date.now() };
      resolve({ ok: true, filename });
    } catch (err) {
      console.warn("[LBRD] Download failed:", filename, err);
      lastPdfTabResult = {
        candidateName: "",
        error: err.message || String(err),
        at: Date.now(),
      };
      reject(err);
    }

    // Uneven gap between downloads (less metronomic than a fixed 500ms)
    await sleep(800 + Math.floor(Math.random() * 1200));
  }

  isProcessingQueue = false;
}

// ── Chrome Downloads API ──────────────────────────────────
// LinkedIn media URLs often ship Content-Disposition: filename="download"
// (or a path ending in /download). The `filename` option on downloads.download
// is NOT enough — Chrome still prefers the server name unless we override via
// onDeterminingFilename.

const forcedFilenamesById = new Map();   // downloadId -> "LinkedIn_Resumes/Name_Resume_date.pdf"
const forcedFilenamesByUrl = new Map();  // url -> same

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  try {
    let forced = forcedFilenamesById.get(item.id);
    if (!forced && item.url) {
      forced = forcedFilenamesByUrl.get(item.url);
    }

    const base = (item.filename || "").split(/[/\\]/).pop() || "";
    const isGenericDownloadName = /^download(\.pdf)?$/i.test(base);

    // Extension-initiated, or any generic "download" during an active bulk run
    if (
      !forced &&
      isGenericDownloadName &&
      lastIntendedRelativePath &&
      (item.byExtensionId === chrome.runtime.id || downloadState.running)
    ) {
      forced = lastIntendedRelativePath;
    }

    if (forced) {
      forcedFilenamesById.delete(item.id);
      if (item.url) forcedFilenamesByUrl.delete(item.url);
      console.log(`[LBRD] Forcing filename: ${forced} (was: ${item.filename})`);
      suggest({ filename: forced, conflictAction: "uniquify" });
      return;
    }
  } catch (err) {
    console.warn("[LBRD] onDeterminingFilename error:", err);
  }
  suggest();
});

let lastIntendedRelativePath = "";

function triggerDownload(url, filename) {
  const relativePath = filename.includes("/")
    ? filename
    : `LinkedIn_Resumes/${filename}`;

  lastIntendedRelativePath = relativePath;
  forcedFilenamesByUrl.set(url, relativePath);

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: url,
        filename: relativePath,
        conflictAction: "uniquify",
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          forcedFilenamesByUrl.delete(url);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        forcedFilenamesById.set(downloadId, relativePath);
        console.log(`[LBRD] Download started: ${relativePath} (id: ${downloadId})`);
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          chrome.downloads.onChanged.removeListener(onChanged);
          clearTimeout(safetyTimer);
          // Keep id mapping until onDeterminingFilename fires; clean up later
          setTimeout(() => forcedFilenamesById.delete(downloadId), 60000);
          fn(value);
        };
        const onChanged = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state && delta.state.current === "complete") {
            finish(resolve, downloadId);
          } else if (delta.state && delta.state.current === "interrupted") {
            finish(reject, new Error(`Download interrupted: ${relativePath}`));
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);
        const safetyTimer = setTimeout(() => finish(resolve, downloadId), 20000);
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
