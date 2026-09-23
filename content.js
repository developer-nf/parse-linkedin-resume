/**
 * content.js – LinkedIn Bulk Resume Downloader  (v6)
 *
 * Supports two LinkedIn UIs:
 *
 * A) Hiring Manager (/hiring/jobs/.../applicants/...) — MOST COMMON
 *    1. Click .hiring-applicants__list-item in left list
 *    2. Wait for right panel + resume viewer
 *    3. Grab PDF from .ui-attachment__download-button OR
 *       .hiring-resume-viewer__pdf-download-link-icon → <a href>
 *    4. fetch(blob) download — no separate "Resume" button
 *
 * B) Talent Hub / newer Recruiter (data-view-name UI)
 *    1. Click card → Resume button → Download button → close popup
 */

// Allow re-injection on extension reload
if (window.__lbrd_cleanup) {
  try { window.__lbrd_cleanup(); } catch (_) {}
}

(() => {
  let applicantCards = [];
  let stopRequested = false;

  // ── Helpers ─────────────────────────────────────────────

  const randomDelay = (min = 0, max = 5) =>
    new Promise((r) => setTimeout(r, (Math.random() * (max - min) + min) * 1000));

  // Random sleep: 0 to ms
  const rsleep = (ms) => new Promise((r) => setTimeout(r, Math.random() * ms));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── Human-like mouse movement + click ───────────────────
  // Simulates: jitter → smooth glide → jitter → hover → click
  // with randomized timing to mimic real human behavior.

  function getElCenter(el) {
    const r = el.getBoundingClientRect();
    // Randomise click point within inner 60% of element
    return {
      x: r.left + r.width * (0.2 + Math.random() * 0.6),
      y: r.top + r.height * (0.2 + Math.random() * 0.6),
    };
  }

  async function humanMouseMove(target) {
    const dest = getElCenter(target);
    // Start from a random nearby point (simulates cursor already in general area)
    let cx = dest.x - 80 - Math.random() * 200;
    let cy = dest.y - 60 - Math.random() * 150;

    const steps = 8 + Math.floor(Math.random() * 10); // 8-17 steps
    for (let s = 0; s < steps; s++) {
      const t = (s + 1) / steps; // 0→1 progress

      // Ease-in-out bezier-ish interpolation
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

      let nx = cx + (dest.x - cx) * ease;
      let ny = cy + (dest.y - cy) * ease;

      // Add jitter — stronger at start/end, subtle in the middle
      const jitterPhase = (t < 0.2 || t > 0.8) ? 1 : 0.3;
      nx += (Math.random() - 0.5) * 6 * jitterPhase;
      ny += (Math.random() - 0.5) * 4 * jitterPhase;

      target.dispatchEvent(new MouseEvent("mousemove", {
        clientX: nx, clientY: ny, bubbles: true, cancelable: true,
      }));

      // Variable speed: fast in middle, slow at ends
      const stepDelay = t < 0.15 || t > 0.85
        ? 20 + Math.random() * 30
        : 6 + Math.random() * 14;
      await sleep(stepDelay);
    }

    // Final small jitter-settle at destination
    for (let j = 0; j < 2 + Math.floor(Math.random() * 3); j++) {
      target.dispatchEvent(new MouseEvent("mousemove", {
        clientX: dest.x + (Math.random() - 0.5) * 2,
        clientY: dest.y + (Math.random() - 0.5) * 2,
        bubbles: true, cancelable: true,
      }));
      await sleep(10 + Math.random() * 20);
    }

    return dest;
  }

  async function humanClick(el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(100 + Math.random() * 200); // wait for scroll

    const pos = await humanMouseMove(el);

    // Hover pause (humans hesitate slightly before clicking)
    await sleep(50 + Math.random() * 150);

    // mouseenter + mouseover
    el.dispatchEvent(new MouseEvent("mouseenter", { clientX: pos.x, clientY: pos.y, bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseover",  { clientX: pos.x, clientY: pos.y, bubbles: true }));
    await sleep(20 + Math.random() * 40);

    // mousedown → small delay → mouseup → click  (realistic press duration)
    el.dispatchEvent(new MouseEvent("mousedown", { clientX: pos.x, clientY: pos.y, bubbles: true, cancelable: true, button: 0 }));
    await sleep(40 + Math.random() * 80); // hold duration
    el.dispatchEvent(new MouseEvent("mouseup",   { clientX: pos.x, clientY: pos.y, bubbles: true, cancelable: true, button: 0 }));
    await sleep(5 + Math.random() * 15);
    el.dispatchEvent(new MouseEvent("click",     { clientX: pos.x, clientY: pos.y, bubbles: true, cancelable: true, button: 0 }));
  }

  function sanitiseName(raw) {
    return raw.trim().replace(/\s+/g, "_").replace(/[^\w\-]/g, "").substring(0, 80) || "Unknown_Candidate";
  }

  function log(msg) {
    console.log(`[LBRD] ${msg}`);
    notify("LOG", { message: msg });
  }

  // ══════════════════════════════════════════════════════════
  //  SCAN — find applicant cards using CONTENT-BASED detection
  // ══════════════════════════════════════════════════════════

  const INVALID_CARD_NAMES = new Set([
    "message", "rate_as", "more", "unknown_candidate", "see_full_profile",
    "applicants", "shortlist", "all_applicants",
  ]);

  function isInvalidCardName(name) {
    const n = (name || "").toLowerCase();
    return !n || INVALID_CARD_NAMES.has(n) || n.startsWith("rate_");
  }

  function scanApplicantCards() {
    const found = new Map();

    // ── Strategy 0: Classic Hiring Manager list (LinkedIn Jobs Hiring) ──
    // Matches: https://www.linkedin.com/hiring/jobs/.../applicants/...
    document.querySelectorAll(".hiring-applicants__list-item").forEach((el) => {
      const name = extractNameFromCard(el);
      if (!isInvalidCardName(name) || name === "Unviewed_applicant") {
        found.set(el, name === "Unknown_Candidate" ? "Unviewed_applicant" : name);
      }
    });

    // ── Strategy 1: data-view-name on applicant items ──
    // LinkedIn often puts data-view-name on list items
    document.querySelectorAll('[data-view-name*="applicant" i]').forEach((el) => {
      if (!found.has(el)) {
        const name = extractNameFromCard(el);
        if (!isInvalidCardName(name) || name === "Unviewed_applicant") {
          found.set(el, name);
        }
      }
    });

    // Skip fuzzy strategies when Hiring Manager list already matched (avoids "Message" false positives)
    const hasHiringList = found.size > 0 && !!document.querySelector(".hiring-applicants__list-item");

    if (!hasHiringList) {
    // Also check componentkey items (LinkedIn uses this extensively)
    document.querySelectorAll('[componentkey]').forEach((el) => {
      // Only cards in a list-like context, not the detail panel
      const text = el.textContent;
      const looksLikeCard =
        (text.includes("Must-have") || text.includes("Preferred") ||
         text.includes("/3") || text.includes("/5") ||
         text.includes("1st") || text.includes("2nd") || text.includes("3rd")) &&
        el.textContent.trim().length < 500 &&
        el.textContent.trim().length > 20;

      // Make sure it's not the detail panel (which is larger)
      if (looksLikeCard && !found.has(el)) {
        // Check it's not already a child of something we found
        let isDuplicate = false;
        for (const existing of found.keys()) {
          if (existing.contains(el) || el.contains(existing)) {
            isDuplicate = true;
            break;
          }
        }
        if (!isDuplicate) found.set(el, extractNameFromCard(el));
      }
    });
    }
    // ── Strategy 2: Find the list container and its children ──
    // The left panel is usually a scrollable container with repeating children
    if (found.size === 0) {
      // Find all scrollable containers
      const allElements = document.querySelectorAll("*");
      let bestContainer = null;
      let bestScore = 0;

      for (const el of allElements) {
        // A list container should have multiple similar children and be scrollable
        const children = el.children;
        if (children.length < 2) continue;

        // Check if it looks like a list of applicant cards
        let matchingChildren = 0;
        for (const child of children) {
          const text = child.textContent;
          if (
            (text.includes("Must-have") || text.includes("Preferred") ||
             text.includes("/3") || text.includes("/5")) &&
            (text.includes("1st") || text.includes("2nd") || text.includes("3rd") ||
             text.includes("India") || text.includes("·"))
          ) {
            matchingChildren++;
          }
        }

        if (matchingChildren > bestScore) {
          bestScore = matchingChildren;
          bestContainer = el;
        }
      }

      if (bestContainer && bestScore >= 2) {
        log(`  Strategy 2: Found list container with ${bestScore} applicant children`);
        for (const child of bestContainer.children) {
          const text = child.textContent;
          const looksLikeCard =
            (text.includes("Must-have") || text.includes("Preferred") ||
             text.includes("/3") || text.includes("/5")) &&
            text.trim().length > 20 && text.trim().length < 500;
          if (looksLikeCard && !found.has(child)) {
            found.set(child, extractNameFromCard(child));
          }
        }
      }
    }

    // ── Strategy 3: Role-based — look for [role="list"] → [role="listitem"] ──
    if (found.size === 0) {
      document.querySelectorAll('[role="list"]').forEach((list) => {
        const items = list.querySelectorAll('[role="listitem"], li, [role="option"]');
        items.forEach((item) => {
          const text = item.textContent;
          if (
            text.trim().length > 20 && text.trim().length < 500 &&
            (text.includes("·") || text.includes("2nd") || text.includes("3rd") || text.includes("1st"))
          ) {
            if (!found.has(item)) found.set(item, extractNameFromCard(item));
          }
        });
      });
    }

    // ── Strategy 4: Anchor links with hiring/applicant URLs ──
    if (found.size === 0) {
      document.querySelectorAll('a[href*="applicationId"], a[href*="applicant"]').forEach((a) => {
        // Walk up to the card container
        const card = a.closest("li") || a.closest("[componentkey]") || a.parentElement;
        if (card && !found.has(card) && card.textContent.trim().length > 20) {
          found.set(card, extractNameFromCard(card));
        }
      });
    }

    // ── Strategy 5: ULTRA-broad — find siblings of the detail panel ──
    if (found.size === 0) {
      // The "Shortlist" or "Applicants" heading is usually above the list
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let textNode;
      while ((textNode = walker.nextNode())) {
        const t = textNode.textContent.trim();
        if (t === "Shortlist" || t === "Applicants" || t === "All applicants") {
          // Go up to find the list container near this heading
          let parent = textNode.parentElement;
          for (let depth = 0; depth < 5 && parent; depth++) {
            parent = parent.parentElement;
          }
          if (parent) {
            // Look for repeating child patterns
            const candidates = parent.querySelectorAll("*");
            for (const c of candidates) {
              if (
                c.children.length === 0 || c.children.length > 10 ||
                c.textContent.trim().length > 500 || c.textContent.trim().length < 20
              ) continue;
              const text = c.textContent;
              if (
                (text.includes("·") || text.includes("2nd") || text.includes("3rd")) &&
                (text.includes("/3") || text.includes("/5") || text.includes("Must-have"))
              ) {
                if (!found.has(c)) found.set(c, extractNameFromCard(c));
              }
            }
          }
          break;
        }
      }
    }

    // De-duplicate: if a parent and child are both in the map, keep only the child
    const toRemove = [];
    for (const a of found.keys()) {
      for (const b of found.keys()) {
        if (a !== b && a.contains(b)) {
          toRemove.push(a); // remove the parent
        }
      }
    }
    for (const el of toRemove) found.delete(el);

    // Drop junk cards (e.g. Message button mistaken as an applicant)
    for (const [el, name] of [...found.entries()]) {
      if (isInvalidCardName(name) && name !== "Unviewed_applicant") {
        found.delete(el);
      }
    }

    applicantCards = [...found].map(([el, name]) => ({ element: el, name }));
    log(`Scan complete: ${applicantCards.length} applicant(s) found.`);
    if (applicantCards.length > 0) {
      log(`  Names: ${applicantCards.map((c) => c.name).join(", ")}`);
    }
    return applicantCards.length;
  }

  function extractNameFromCard(card) {
    for (const sel of [
      ".artdeco-entity-lockup__title",
      "h2", "h3", "h4",
      'a[href*="/in/"]',
      'a[href*="/talent/profile/"]',
    ]) {
      const el = card.querySelector(sel);
      if (el) {
        const raw = (el.childNodes[0]?.textContent || el.textContent).trim();
        if (raw.length > 1 && raw.length < 60) {
          if (/unviewed\s+applicant/i.test(raw)) return "Unviewed_applicant";
          const cleaned = sanitiseName(
            raw.replace(/[·•].*$/, "").replace(/['’]s application$/i, "").trim()
          );
          if (cleaned) return cleaned;
        }
      }
    }

    const text = card.textContent.trim();
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length > 0) {
      let name = lines[0];
      name = name.replace(/[·•].*$/, "").trim();
      if (/unviewed\s+applicant/i.test(name)) return "Unviewed_applicant";
      if (name.length > 1 && name.length < 60) return sanitiseName(name);
    }

    return "Unknown_Candidate";
  }

  /** Name from open detail panel: "Rahul Parashar's application" */
  function extractNameFromDetailPanel() {
    const selectors = [
      ".hiring-applicant-header h1",
      ".hiring-applicant-header .artdeco-entity-lockup__title",
      "#hiring-detail-root h1",
      ".hiring-applicants__right-column h1",
    ];
    for (const sel of selectors) {
      const header = document.querySelector(sel);
      if (!header) continue;
      let raw = (header.childNodes[0]?.textContent || header.textContent || "").trim();
      raw = raw
        .replace(/['’]s application.*/i, "")
        .replace(/\d+(st|nd|rd|th).*/i, "")
        .replace(/degree connection/gi, "")
        .split("\n")[0]
        .trim();
      const cleaned = sanitiseName(raw.replace(/[·•].*$/, "").trim());
      if (cleaned && !isInvalidCardName(cleaned) && cleaned !== "Unviewed_applicant") {
        return cleaned;
      }
    }
    return null;
  }

  function isHiringManagerUI() {
    return !!document.querySelector(
      ".hiring-applicants__list-item, .hiring-applicant-header, .hiring-resume-viewer__pdf-download-link-icon, .ui-attachment__download-button"
    );
  }

  /**
   * Hiring Manager resume URL — NOT "See full profile".
   * Real download controls:
   *   .ui-attachment__download-button
   *   .hiring-resume-viewer__pdf-download-link-icon → closest <a>
   */
  function getHiringResumeDownloadUrl() {
    const attachment = document.querySelector("a.ui-attachment__download-button, .ui-attachment__download-button");
    if (attachment && attachment.href && !attachment.href.includes("/in/")) {
      log("  ✓ Hiring resume URL via ui-attachment__download-button");
      return attachment.href;
    }

    const icon = document.querySelector(
      ".hiring-resume-viewer__pdf-download-link-icon, svg.hiring-resume-viewer__pdf-download-link-icon"
    );
    if (icon) {
      const link = icon.closest("a");
      if (link && link.href && !link.href.includes("/in/")) {
        log("  ✓ Hiring resume URL via resume-viewer download icon");
        return link.href;
      }
    }

    for (const a of document.querySelectorAll(
      ".hiring-applicant-header-actions__dropdown-content a[href], .artdeco-dropdown__content a[href]"
    )) {
      const href = (a.href || "").toLowerCase();
      const text = (a.textContent || "").toLowerCase();
      if (
        (text.includes("download") && text.includes("resume")) ||
        href.includes("mediaauth") ||
        href.includes(".pdf") ||
        href.includes("dms/")
      ) {
        if (!href.includes("/in/")) {
          log("  ✓ Hiring resume URL via More dropdown");
          return a.href;
        }
      }
    }

    return null;
  }

  /** LinkedIn blocks the resume download control until its virus scan finishes. */
  function isVirusScanBlocking() {
    const section = document.querySelector(".hiring-resume-viewer__virus-scan-section");
    if (section) {
      const style = window.getComputedStyle(section);
      if (style.display !== "none" && style.visibility !== "hidden") return true;
    }
    const viewer = document.querySelector(".hiring-resume-viewer, .artdeco-card");
    const text = (viewer?.textContent || document.body?.innerText || "");
    return /Scanning resume for viruses/i.test(text);
  }

  async function waitForHiringResumeUrl(maxWaitMs = 12000) {
    const start = Date.now();
    let loggedVirus = false;
    while (Date.now() - start < maxWaitMs) {
      const url = getHiringResumeDownloadUrl();
      if (url) return url;

      if (isVirusScanBlocking()) {
        if (!loggedVirus) {
          log("  ⏳ LinkedIn virus scan in progress — waiting for download control…");
          loggedVirus = true;
        }
      }

      const detail = document.querySelector(
        ".hiring-applicant-detail, #hiring-detail-root, .hiring-applicants__right-column, .scaffold-layout__detail, main"
      );
      if (detail) detail.scrollTop = (detail.scrollTop || 0) + 200;

      await sleep(400 + Math.random() * 200);
    }
    return null;
  }

  /**
   * Wait out LinkedIn's virus-scan interstitial, then return the resume URL.
   * If scan text persists, re-select the applicant once to reload the detail panel
   * (LinkedIn's own copy says "Please refresh").
   */
  async function waitForResumeReady(card, maxWaitMs = 45000) {
    let url = await waitForHiringResumeUrl(Math.min(15000, maxWaitMs));
    if (url) return url;

    if (isVirusScanBlocking() || !getHiringResumeDownloadUrl()) {
      log("  Virus scan / no download yet — re-selecting applicant to refresh panel…");
      await selectApplicant(card);
      await sleep(1500 + Math.random() * 1000);
      url = await waitForHiringResumeUrl(Math.max(20000, maxWaitMs - 15000));
      if (url) return url;
    }

    if (!url) {
      await tryOpenMoreMenuForResume();
      url = await waitForHiringResumeUrl(5000);
    }

    if (!url) {
      url = extractPdfUrl();
      if (url) log("  ✓ PDF URL from preview iframe/embed");
    }

    return url;
  }

  async function tryOpenMoreMenuForResume() {
    const moreBtn = Array.from(document.querySelectorAll(".hiring-applicant-header-actions button")).find((b) =>
      /more/i.test(b.textContent || "")
    );
    if (!moreBtn) return false;

    log("  Opening More… menu to look for resume…");
    await humanClick(moreBtn);
    await sleep(500 + Math.random() * 400);
    return true;
  }

  // ══════════════════════════════════════════════════════════
  //  SELECT APPLICANT — click their card
  // ══════════════════════════════════════════════════════════

  async function selectApplicant(card) {
    const el = card.element;

    // Prefer list-item anchor; avoid "See full profile" (/in/...) links
    const anchors = [...el.querySelectorAll("a")].filter((a) => {
      const href = a.getAttribute("href") || "";
      return href && !href.includes("/in/") && !/see full profile/i.test(a.textContent || "");
    });

    const clickTarget =
      el.querySelector("a.hiring-applicants__list-item-link") ||
      el.querySelector('a[href*="applicationId"]') ||
      el.querySelector('a[href*="applicant"]') ||
      el.querySelector('a[href*="/hiring/"]') ||
      anchors[0] ||
      el.querySelector("a") ||
      el;

    log(`  Clicking: <${clickTarget.tagName}> "${clickTarget.textContent.trim().substring(0, 40)}…"`);

    await humanClick(clickTarget);

    // Hiring Manager Ember UI needs more time for detail + resume viewer
    await sleep(1200 + Math.random() * 1200);
  }


  // ══════════════════════════════════════════════════════════
  //  FIND "Resume" BUTTON
  // ══════════════════════════════════════════════════════════

  async function findResumeButton(maxWaitMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      // 1. data-view-name (from the HTML you shared)
      let btn = document.querySelector('button[data-view-name="hiring-applicant-view-resume"]');
      if (btn) { log("  ✓ Found Resume via data-view-name"); return btn; }

      btn = document.querySelector('button[data-view-name*="resume" i]');
      if (btn) { log("  ✓ Found Resume via partial data-view-name"); return btn; }

      // 2. SVG icon #document-small
      const docIcon = document.querySelector('svg[id="document-small"]');
      if (docIcon) {
        btn = docIcon.closest("button");
        if (btn) { log("  ✓ Found Resume via svg#document-small"); return btn; }
      }

      // 3. Leaf span with text "Resume" inside a button
      for (const b of document.querySelectorAll("button")) {
        for (const span of b.querySelectorAll("span")) {
          if (span.children.length === 0 && span.textContent.trim() === "Resume") {
            log("  ✓ Found Resume via span text"); return b;
          }
        }
      }

      await rsleep(600);
    }
    log("  ⚠ Resume button NOT found"); return null;
  }

  // ══════════════════════════════════════════════════════════
  //  FIND "Download" BUTTON inside the resume popup
  // ══════════════════════════════════════════════════════════

  async function findDownloadButton(maxWaitMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      // 1. SVG icon #download-small (from the HTML you shared)
      const dlIcon = document.querySelector('svg[id="download-small"]');
      if (dlIcon) {
        const btn = dlIcon.closest("button") || dlIcon.closest("a");
        if (btn) { log("  ✓ Found Download via svg#download-small"); return btn; }
      }

      // 2. Leaf span with exact text "Download"
      for (const b of document.querySelectorAll("button")) {
        for (const span of b.querySelectorAll("span")) {
          if (span.children.length === 0 && span.textContent.trim() === "Download") {
            log("  ✓ Found Download via span text"); return b;
          }
        }
      }

      // 3. aria-label
      try {
        const ariaBtn = document.querySelector('button[aria-label*="Download" i]');
        if (ariaBtn) { log("  ✓ Found Download via aria-label"); return ariaBtn; }
      } catch (_) {}

      // 4. Direct download link
      for (const a of document.querySelectorAll("a[href]")) {
        const href = (a.href || "").toLowerCase();
        if (
          (href.includes("resume") || href.includes(".pdf") || href.includes("mediaauth")) &&
          !href.includes("/hiring/") && !href.includes("/jobs/")
        ) {
          log("  ✓ Found Download via href"); return a;
        }
      }

      await rsleep(600);
    }
    log("  ⚠ Download button NOT found"); return null;
  }

  // ══════════════════════════════════════════════════════════
  //  EXTRACT PDF URL from the resume preview popup
  // ══════════════════════════════════════════════════════════

  function extractPdfUrl() {
    // 1. Check <iframe> sources (LinkedIn often renders PDF in an iframe)
    for (const iframe of document.querySelectorAll("iframe")) {
      const src = iframe.src || "";
      if (src && (src.includes(".pdf") || src.includes("mediaauth") || src.includes("resume") || src.includes("dms/"))) {
        log(`  ✓ PDF URL from iframe: ${src.substring(0, 80)}…`);
        return src;
      }
    }

    // 2. Check <embed> elements
    for (const embed of document.querySelectorAll("embed")) {
      const src = embed.src || "";
      if (src && (src.includes(".pdf") || src.includes("mediaauth") || src.includes("resume"))) {
        log(`  ✓ PDF URL from embed: ${src.substring(0, 80)}…`);
        return src;
      }
    }

    // 3. Check <object> elements
    for (const obj of document.querySelectorAll("object")) {
      const data = obj.data || "";
      if (data && (data.includes(".pdf") || data.includes("mediaauth") || data.includes("resume"))) {
        log(`  ✓ PDF URL from object: ${data.substring(0, 80)}…`);
        return data;
      }
    }

    // 4. Check anchors near the download button / in modal / dialog
    const modals = document.querySelectorAll('[role="dialog"], [role="presentation"], [class*="modal"], [class*="overlay"]');
    for (const modal of modals) {
      for (const a of modal.querySelectorAll("a[href]")) {
        const href = a.href || "";
        if (href && (href.includes(".pdf") || href.includes("mediaauth") || href.includes("dms/"))) {
          log(`  ✓ PDF URL from modal anchor: ${href.substring(0, 80)}…`);
          return href;
        }
      }
    }

    // 5. Broad search for any anchor with PDF-like URL in the whole page
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href || "";
      if (
        href &&
        (href.includes(".pdf") || href.includes("mediaauth")) &&
        !href.includes("/hiring/") && !href.includes("/jobs/") && !href.includes("/in/")
      ) {
        log(`  ✓ PDF URL from page anchor: ${href.substring(0, 80)}…`);
        return href;
      }
    }

    return null;
  }

  // ══════════════════════════════════════════════════════════
  //  FETCH + BLOB DOWNLOAD — downloads PDF with session cookies
  //  This avoids the one-time-token problem where chrome.downloads
  //  makes a second HTTP request that fails.
  // ══════════════════════════════════════════════════════════

  function buildDownloadFilename(candidateName) {
    let safe = (candidateName || "Unknown_Candidate")
      .trim().replace(/\s+/g, "_").replace(/[^\w\-]/g, "").substring(0, 80);
    if (!safe) safe = "Unknown_Candidate";
    const ts = new Date().toISOString().slice(0, 10);
    return `${safe}_Resume_${ts}.pdf`;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
      reader.readAsDataURL(blob);
    });
  }

  function looksLikePdf(bytes) {
    if (!bytes || bytes.length < 4) return false;
    // %PDF
    return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  }

  function setCurrentFilenameInPage(candidateName) {
    const filename = buildDownloadFilename(candidateName);
    const script = document.createElement("script");
    script.textContent = `window.__lbrd_currentFilename = ${JSON.stringify(filename)};`;
    document.documentElement.appendChild(script);
    script.remove();
    // Tell background so chrome.downloads.onDeterminingFilename can rename
    // LinkedIn's generic "download" files to the applicant name.
    chrome.runtime.sendMessage({
      type: "SET_INTENDED_FILENAME",
      candidateName,
      filename,
    }).catch(() => {});
    return filename;
  }

  function clearPdfTabWatch() {
    chrome.runtime.sendMessage({ type: "CLEAR_PDF_TAB" }).catch(() => {});
  }

  /**
   * Fetch the resume with session cookies, then save via background chrome.downloads
   * so the filename is always CandidateName_Resume_YYYY-MM-DD.pdf under LinkedIn_Resumes/.
   * Falls back to an in-page <a download> if messaging fails.
   */
  async function downloadViaFetch(url, candidateName) {
    const filename = setCurrentFilenameInPage(candidateName);
    log(`  Fetching PDF blob from: ${url.substring(0, 80)}…`);
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      const header = new Uint8Array(buf.slice(0, 8));
      if (!looksLikePdf(header)) {
        // LinkedIn sometimes returns an HTML interstitial / error instead of the PDF
        const asText = new TextDecoder().decode(buf.slice(0, 500));
        if (/virus|scanning|sign.?in|login/i.test(asText)) {
          throw new Error("Got HTML interstitial instead of PDF (virus scan or auth)");
        }
        log("  ⚠ Response does not start with %PDF — downloading anyway");
      }

      const pdfBlob = new Blob([buf], { type: "application/pdf" });

      // Prefer chrome.downloads so name + LinkedIn_Resumes/ folder are guaranteed
      try {
        const dataUrl = await blobToDataUrl(pdfBlob);
        const queued = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: "DOWNLOAD_RESUME", url: dataUrl, candidateName, filename },
            (resp) => {
              if (chrome.runtime.lastError) {
                log(`  ⚠ Background msg error: ${chrome.runtime.lastError.message}`);
                resolve(false);
                return;
              }
              resolve(!!(resp && (resp.queued || resp.ok)));
            }
          );
        });
        if (queued) {
          clearPdfTabWatch();
          log(`  ✓ Queued named download: ${filename}`);
          return true;
        }
      } catch (msgErr) {
        log(`  ⚠ Background download path failed: ${msgErr.message}`);
      }

      // Fallback: in-page blob download (still uses applicant name)
      const blobUrl = URL.createObjectURL(pdfBlob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
      clearPdfTabWatch();
      log(`  ✓ Blob download triggered: ${filename}`);
      return true;
    } catch (err) {
      log(`  ⚠ Fetch-blob failed: ${err.message}`);
      return false;
    }
  }

  // ══════════════════════════════════════════════════════════
  //  INTERCEPT window.open IN THE MAIN WORLD via <script> injection
  //  Content scripts run in an isolated world — they CANNOT override
  //  the page's window.open. We must inject into the page itself.
  //  The injected code ALSO fetches the PDF as a blob and triggers
  //  a download directly (so the one-time URL isn't wasted).
  // ══════════════════════════════════════════════════════════

  let interceptedUrl = null;
  let mainWorldDownloaded = false;
  let interceptListenerActive = false;

  function startWindowOpenIntercept(candidateName) {
    interceptedUrl = null;
    mainWorldDownloaded = false;

    // Listen for messages from the injected page script (only add once)
    if (!interceptListenerActive) {
      window.addEventListener("message", onInterceptMessage);
      interceptListenerActive = true;
    }

    const filename = buildDownloadFilename(candidateName);

    // Inject a <script> into the page's main world
    // Re-inject every time to update the filename for the current candidate
    const script = document.createElement("script");
    script.textContent = `
      (function() {
        if (!window.__lbrd_origOpen) {
          window.__lbrd_origOpen = window.open;
        }
        window.__lbrd_currentFilename = ${JSON.stringify(filename)};
        window.open = function(url) {
          var s = String(url || "");
          window.postMessage({ __lbrd_intercepted: true, url: s }, "*");
          fetch(s, { credentials: "include" })
            .then(function(r) { return r.arrayBuffer(); })
            .then(function(buf) {
              var blob = new Blob([buf], { type: "application/pdf" });
              var u = URL.createObjectURL(blob);
              var a = document.createElement("a");
              a.href = u;
              a.download = window.__lbrd_currentFilename || "Unknown_Candidate_Resume.pdf";
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(function() { URL.revokeObjectURL(u); }, 15000);
              window.postMessage({ __lbrd_download_done: true }, "*");
            })
            .catch(function(err) {
              window.postMessage({ __lbrd_download_failed: true, error: err.message }, "*");
            });
          return null;
        };
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();
  }

  function onInterceptMessage(event) {
    if (event.source !== window) return;
    if (event.data && event.data.__lbrd_intercepted) {
      interceptedUrl = event.data.url;
      log(`  ✓ Intercepted URL (main world): ${interceptedUrl.substring(0, 80)}…`);
    }
    if (event.data && event.data.__lbrd_download_done) {
      mainWorldDownloaded = true;
      log("  ✓ Main-world fetch+download succeeded!");
    }
    if (event.data && event.data.__lbrd_download_failed) {
      log(`  ⚠ Main-world fetch failed: ${event.data.error}`);
    }
  }

  // Don't restore window.open between downloads — keep it patched
  function checkInterceptResult() {
    const result = { url: interceptedUrl, downloadedInMainWorld: mainWorldDownloaded };
    interceptedUrl = null;
    mainWorldDownloaded = false;
    return result;
  }

  /** Poll background until the PDF-tab watcher confirms a download (or times out). */
  async function waitForPdfTabDownload(maxWaitMs = 10000) {
    const start = Date.now();
    // Brief grace so EXPECT_PDF_TAB / DOWNLOAD_RESUME can register
    await sleep(300);
    while (Date.now() - start < maxWaitMs) {
      const status = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "PDF_TAB_STATUS" }, (resp) => {
          if (chrome.runtime.lastError) resolve({});
          else resolve(resp || {});
        });
      });
      if (status.lastSavedCandidate) {
        log(`  ✓ Confirmed save: ${status.lastSavedCandidate}`);
        return true;
      }
      if (!status.watching && status.lastError) {
        log(`  ⚠ Tab watcher: ${status.lastError}`);
        return false;
      }
      // If watch already cleared with no save and no error, keep polling briefly
      // (DOWNLOAD_RESUME may still be finishing)
      await sleep(400);
    }
    clearPdfTabWatch();
    return false;
  }

  // ══════════════════════════════════════════════════════════
  //  INTERCEPT <a target="_blank"> clicks (another way LinkedIn opens PDFs)
  // ══════════════════════════════════════════════════════════

  function interceptLinkClicks() {
    const script = document.createElement("script");
    script.textContent = `
      (function() {
        if (window.__lbrd_linkInterceptInstalled) return;
        window.__lbrd_linkInterceptInstalled = true;
        document.addEventListener("click", function(e) {
          var a = e.target.closest ? e.target.closest("a") : null;
          if (a && a.href && (a.target === "_blank" || a.getAttribute("target") === "_blank")) {
            var href = a.href.toLowerCase();
            if (href.includes(".pdf") || href.includes("mediaauth") || href.includes("resume")
                || href.includes("dms/") || href.includes("media.licdn")) {
              e.preventDefault();
              e.stopPropagation();
              window.postMessage({ __lbrd_intercepted: true, url: a.href }, "*");
              var fname = window.__lbrd_currentFilename || "Unknown_Candidate_Resume.pdf";
              fetch(a.href, { credentials: "include" })
                .then(function(r) { return r.arrayBuffer(); })
                .then(function(buf) {
                  var blob = new Blob([buf], { type: "application/pdf" });
                  var u = URL.createObjectURL(blob);
                  var el = document.createElement("a");
                  el.href = u;
                  el.download = fname;
                  document.body.appendChild(el);
                  el.click();
                  el.remove();
                  setTimeout(function() { URL.revokeObjectURL(u); }, 15000);
                  window.postMessage({ __lbrd_download_done: true, filename: fname }, "*");
                })
                .catch(function(err) {
                  window.postMessage({ __lbrd_download_failed: true, error: String(err && err.message || err) }, "*");
                });
            }
          }
        }, true);
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();
  }

  // Inject link click interceptor on load
  interceptLinkClicks();

  // ══════════════════════════════════════════════════════════
  //  CLOSE popup
  // ══════════════════════════════════════════════════════════

  async function closePreviewPopup() {
    for (const sel of [
      'button[aria-label="Dismiss"]', 'button[aria-label="Close"]',
      'button[aria-label="dismiss"]', 'button[aria-label="close"]',
      ".artdeco-modal__dismiss", 'button[data-test-modal-close-btn]',
    ]) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); log("  Closed popup"); await rsleep(300); return; }
    }

    for (const modal of document.querySelectorAll('[role="dialog"], [role="presentation"]')) {
      const btn = modal.querySelector('button[aria-label*="ismiss" i], button[aria-label*="lose" i]');
      if (btn) { btn.click(); log("  Closed modal"); await rsleep(300); return; }
    }

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
    log("  Sent Escape"); await rsleep(300);
  }

  // ══════════════════════════════════════════════════════════
  //  MAIN DOWNLOAD LOOP
  // ══════════════════════════════════════════════════════════

  async function startBulkDownload() {
    stopRequested = false;
    const total = applicantCards.length;
    let downloaded = 0, failed = 0;
    const hiringUI = isHiringManagerUI();

    log(`Starting bulk download for ${total} applicant(s)…`);
    log(`  Detected UI: ${hiringUI ? "Hiring Manager (Jobs applicants)" : "Talent Hub / Recruiter-style"}`);

    chrome.runtime.sendMessage({ type: "DOWNLOAD_STARTED", total }).catch(() => {});

    for (let i = 0; i < applicantCards.length; i++) {
      if (stopRequested) {
        notify("DONE", { downloaded, total, failed });
        chrome.runtime.sendMessage({ type: "DOWNLOAD_STOPPED" }).catch(() => {});
        return;
      }

      const card = applicantCards[i];
      let name = card.name;
      log(`\n━━━ [${i + 1}/${total}] ${name} ━━━`);
      clearPdfTabWatch();
      setCurrentFilenameInPage(name);

      try {
        log("  Step 1: Selecting applicant…");
        await selectApplicant(card);

        // Prefer real name from detail header ("Rahul Parashar's application")
        const detailName = extractNameFromDetailPanel();
        if (detailName) {
          name = detailName;
          card.name = detailName;
          log(`  Name from detail panel: ${name}`);
        }
        setCurrentFilenameInPage(name);

        let dlSuccess = false;

        // ── Path A: Hiring Manager — resume PDF link in the detail pane ──
        if (hiringUI || document.querySelector(".hiring-applicant-header")) {
          log("  Step 2: Looking for Hiring resume download link (incl. virus-scan wait)…");
          setCurrentFilenameInPage(name);
          const pdfUrl = await waitForResumeReady(card, 45000);

          if (pdfUrl) {
            log("  Step 3: Fetching resume blob…");
            dlSuccess = await downloadViaFetch(pdfUrl, name);
            if (!dlSuccess) {
              log("  Blob failed — trying background download + PDF tab watcher…");
              chrome.runtime.sendMessage({ type: "EXPECT_PDF_TAB", candidateName: name });
              dlSuccess = await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                  { type: "DOWNLOAD_RESUME", url: pdfUrl, candidateName: name },
                  (resp) => resolve(!!(resp && resp.ok))
                );
              });
              if (!dlSuccess) {
                dlSuccess = await waitForPdfTabDownload(12000);
              } else {
                clearPdfTabWatch();
              }
            }
          } else {
            const stillScanning = isVirusScanBlocking();
            const errMsg = stillScanning
              ? "LinkedIn virus scan never finished — no download control appeared"
              : "No resume download link found";
            log(`  ✗ ${errMsg} for ${name}`);
            failed++;
            notify("DOWNLOAD_ERROR", { candidateName: name, error: errMsg });
            notify("PROGRESS", { downloaded, total, failed });
            if (i < applicantCards.length - 1) await randomDelay(0, 3);
            continue;
          }
        } else {
          // ── Path B: Talent Hub — Resume button → Download button ──
          log("  Step 2: Looking for Resume button…");
          const resumeBtn = await findResumeButton(10000);
          if (!resumeBtn) {
            log(`  ✗ No Resume button for ${name}`);
            failed++;
            notify("PROGRESS", { downloaded, total, failed });
            if (i < applicantCards.length - 1) await randomDelay(0, 3);
            continue;
          }

          log("  Step 2: Clicking Resume…");
          await humanClick(resumeBtn);

          log("  Step 3: Waiting for popup…");
          await sleep(600 + Math.random() * 600);
          const downloadBtn = await findDownloadButton(10000);
          if (!downloadBtn) {
            log(`  ✗ No Download button for ${name}`);
            failed++;
            await closePreviewPopup();
            notify("PROGRESS", { downloaded, total, failed });
            if (i < applicantCards.length - 1) await randomDelay(0, 3);
            continue;
          }

          await rsleep(200);
          setCurrentFilenameInPage(name);

          let pdfUrl = extractPdfUrl();

          if (pdfUrl) {
            log("  Step 3: Direct PDF URL found, fetching blob…");
            dlSuccess = await downloadViaFetch(pdfUrl, name);
            if (!dlSuccess) {
              chrome.runtime.sendMessage({ type: "EXPECT_PDF_TAB", candidateName: name });
              dlSuccess = await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                  { type: "DOWNLOAD_RESUME", url: pdfUrl, candidateName: name },
                  (resp) => resolve(!!(resp && resp.ok))
                );
              });
              if (!dlSuccess) dlSuccess = await waitForPdfTabDownload(10000);
              else clearPdfTabWatch();
            }
          } else if (downloadBtn.tagName === "A" && downloadBtn.href) {
            log("  Step 3: Download link href found, fetching blob…");
            dlSuccess = await downloadViaFetch(downloadBtn.href, name);
            if (!dlSuccess) {
              chrome.runtime.sendMessage({ type: "EXPECT_PDF_TAB", candidateName: name });
              dlSuccess = await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                  { type: "DOWNLOAD_RESUME", url: downloadBtn.href, candidateName: name },
                  (resp) => resolve(!!(resp && resp.ok))
                );
              });
              if (!dlSuccess) dlSuccess = await waitForPdfTabDownload(10000);
              else clearPdfTabWatch();
            }
          } else {
            log("  Step 3: Clicking Download (with main-world interception + fetch)…");
            chrome.runtime.sendMessage({ type: "EXPECT_PDF_TAB", candidateName: name });
            startWindowOpenIntercept(name);
            await humanClick(downloadBtn);
            await sleep(1500 + Math.random() * 1500);

            const result = checkInterceptResult();
            if (result.downloadedInMainWorld) {
              dlSuccess = true;
              clearPdfTabWatch();
            } else if (result.url) {
              dlSuccess = await downloadViaFetch(result.url, name);
              if (!dlSuccess) {
                dlSuccess = await new Promise((resolve) => {
                  chrome.runtime.sendMessage(
                    { type: "DOWNLOAD_RESUME", url: result.url, candidateName: name },
                    (resp) => resolve(!!(resp && resp.ok))
                  );
                });
                if (!dlSuccess) dlSuccess = await waitForPdfTabDownload(10000);
                else clearPdfTabWatch();
              }
            } else {
              const postClickUrl = extractPdfUrl();
              if (postClickUrl) {
                dlSuccess = await downloadViaFetch(postClickUrl, name);
                if (!dlSuccess) {
                  dlSuccess = await new Promise((resolve) => {
                    chrome.runtime.sendMessage(
                      { type: "DOWNLOAD_RESUME", url: postClickUrl, candidateName: name },
                      (resp) => resolve(!!(resp && resp.ok))
                    );
                  });
                  if (!dlSuccess) dlSuccess = await waitForPdfTabDownload(10000);
                  else clearPdfTabWatch();
                }
              } else {
                log("  Step 3: Waiting for background PDF tab watcher…");
                dlSuccess = await waitForPdfTabDownload(8000);
                if (!dlSuccess) {
                  log("  ✗ No PDF URL and tab watcher did not confirm a download");
                }
              }
            }
          }

          log("  Step 4: Closing popup…");
          await rsleep(800);
          await closePreviewPopup();
          await rsleep(500);
        }

        if (dlSuccess) {
          downloaded++;
          log(`  ✓ Downloaded: ${name}`);
          notify("PROGRESS", { downloaded, total, failed, candidateName: name });
        } else {
          failed++;
          notify("PROGRESS", { downloaded, total, failed });
        }
      } catch (err) {
        log(`  ✗ Error: ${err.message}`);
        failed++;
        notify("DOWNLOAD_ERROR", { candidateName: name, error: err.message });
        notify("PROGRESS", { downloaded, total, failed });
        await closePreviewPopup();
        await rsleep(300);
      }

      if (i < applicantCards.length - 1 && !stopRequested) {
        const d = Math.random() * 5;
        log(`  ⏳ Waiting ${d.toFixed(1)}s…`);
        await randomDelay(0, 5);
      }
    }

    log(`\n✅ Done! Downloaded: ${downloaded}, Failed: ${failed}`);
    notify("DONE", { downloaded, total, failed });
    chrome.runtime.sendMessage({ type: "DOWNLOAD_STOPPED" }).catch(() => {});
  }

  // ══════════════════════════════════════════════════════════
  //  DEBUG SCAN — dumps actual DOM structure
  // ══════════════════════════════════════════════════════════

  function debugScan() {
    const info = { url: window.location.href };

    const count = scanApplicantCards();
    info.applicantCardsFound = count;
    info.applicantNames = applicantCards.map((c) => c.name);

    info.totalButtons = document.querySelectorAll("button").length;
    info.totalLinks = document.querySelectorAll("a[href]").length;
    info.hiringListItems = document.querySelectorAll(".hiring-applicants__list-item").length;
    info.hiringUI = isHiringManagerUI();

    const hiringUrl = getHiringResumeDownloadUrl();
    info.hiringResumeUrlFound = !!hiringUrl;
    info.hiringResumeUrlPreview = hiringUrl ? hiringUrl.substring(0, 100) : null;
    info.uiAttachmentDownload = !!document.querySelector(".ui-attachment__download-button");
    info.resumeViewerDownloadIcon = !!document.querySelector(".hiring-resume-viewer__pdf-download-link-icon");

    const resumeBtn = document.querySelector('button[data-view-name="hiring-applicant-view-resume"]');
    info.resumeButtonVisible = !!resumeBtn || info.uiAttachmentDownload || info.resumeViewerDownloadIcon;
    info.resumeButtonText = resumeBtn
      ? resumeBtn.textContent.trim().substring(0, 40)
      : (info.uiAttachmentDownload
          ? "ui-attachment__download-button"
          : (info.resumeViewerDownloadIcon ? "hiring-resume-viewer download icon" : ""));

    info.documentIconVisible = !!document.querySelector('svg[id="document-small"]');
    info.downloadIconVisible =
      !!document.querySelector('svg[id="download-small"]') ||
      info.uiAttachmentDownload ||
      info.resumeViewerDownloadIcon;

    info.detailPanelName = extractNameFromDetailPanel();

    info.dataViewButtons = [];
    info.dataViewElements = [];
    document.querySelectorAll("[data-view-name]").forEach((el) => {
      const entry = {
        tag: el.tagName,
        dataViewName: el.getAttribute("data-view-name"),
        text: el.textContent.trim().substring(0, 50),
      };
      info.dataViewElements.push(entry);
      if (el.tagName === "BUTTON") info.dataViewButtons.push(entry);
    });

    info.relevantButtons = [];
    document.querySelectorAll("button").forEach((btn) => {
      const text = btn.textContent.trim().toLowerCase();
      if (text.includes("resume") || text.includes("download") || text.includes("more")) {
        info.relevantButtons.push({
          text: btn.textContent.trim().substring(0, 60),
          dataViewName: btn.getAttribute("data-view-name") || "",
        });
      }
    });

    info.applicationLinks = [];
    document.querySelectorAll(
      '.hiring-applicants__list-item a, a[href*="applicationId"], a[href*="applicant"]'
    ).forEach((a) => {
      info.applicationLinks.push({
        href: a.href.substring(0, 120),
        text: a.textContent.trim().substring(0, 60),
      });
    });

    return info;
  }

  // ── Messaging ───────────────────────────────────────────

  function notify(type, data) {
    chrome.runtime.sendMessage({ type, ...data }).catch(() => {});
  }

  function messageHandler(msg, _sender, sendResponse) {
    switch (msg.action) {
      case "SCAN_RESUMES": sendResponse({ count: scanApplicantCards() }); break;
      case "DEBUG_SCAN": sendResponse({ debug: debugScan() }); break;
      case "START_DOWNLOAD": startBulkDownload(); sendResponse({ ok: true }); break;
      case "STOP_DOWNLOAD": stopRequested = true; sendResponse({ ok: true }); break;
      default: sendResponse({ ok: false });
    }
    return true;
  }

  chrome.runtime.onMessage.addListener(messageHandler);
  window.__lbrd_cleanup = () => chrome.runtime.onMessage.removeListener(messageHandler);

  console.log("[LBRD] Content script v6 loaded (Hiring Manager + Talent Hub).");
})();
