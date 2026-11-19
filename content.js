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

  /** Random pause in [minMs, maxMs] — uneven timing looks less bot-like. */
  function humanPause(minMs, maxMs) {
    const lo = Math.min(minMs, maxMs);
    const hi = Math.max(minMs, maxMs);
    return sleep(lo + Math.random() * (hi - lo));
  }

  /**
   * Gap between applicants: normally 3–12s; ~10% chance of a longer 15–30s
   * "think" pause. Every 8–12 applicants, add an extra cool-down.
   */
  let applicantsSinceLongBreak = 0;
  const longBreakEvery = 8 + Math.floor(Math.random() * 5); // 8–12

  async function humanPauseBetweenApplicants() {
    applicantsSinceLongBreak++;
    let ms;
    if (Math.random() < 0.1) {
      ms = 15000 + Math.random() * 15000; // 15–30s
      log(`  ⏳ Longer human pause ${(ms / 1000).toFixed(1)}s…`);
    } else {
      ms = 3000 + Math.random() * 9000; // 3–12s
      log(`  ⏳ Waiting ${(ms / 1000).toFixed(1)}s…`);
    }
    await sleep(ms);

    if (applicantsSinceLongBreak >= longBreakEvery) {
      applicantsSinceLongBreak = 0;
      const cool = 20000 + Math.random() * 20000; // 20–40s
      log(`  ⏳ Cool-down pause ${(cool / 1000).toFixed(1)}s…`);
      await sleep(cool);
    }
  }

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

  /** Match /hiring/jobs/{jobId}/applicants/{applicationId}/detail/ */
  function getHiringDetailPathMatch() {
    return location.pathname.match(
      /\/hiring\/jobs\/\d+\/applicants\/(\d+)(?:\/detail)?\/?/i
    );
  }

  function isHiringDetailPage() {
    return /\/hiring\/jobs\/\d+\/applicants\/\d+/i.test(location.pathname);
  }

  function getApplicationIdFromPath() {
    const m = getHiringDetailPathMatch();
    return m ? m[1] : "";
  }

  function getJobIdFromPath() {
    const m = location.pathname.match(/\/hiring\/jobs\/(\d+)/i);
    return m ? m[1] : "";
  }

  function buildApplicantDetailHref(appId) {
    const jobId = getJobIdFromPath();
    if (!jobId || !appId) return "";
    return `${location.origin}/hiring/jobs/${jobId}/applicants/${appId}/detail/${location.search || ""}`;
  }

  function absoluteHref(href) {
    if (!href) return "";
    try {
      return new URL(href, location.origin).href;
    } catch (_) {
      return href;
    }
  }

  function getDetailRootElement() {
    return (
      document.querySelector("#hiring-detail-root") ||
      document.querySelector(".hiring-applicant-detail") ||
      document.querySelector(".hiring-applicants__right-column") ||
      document.querySelector(".scaffold-layout__detail") ||
      document.querySelector("main") ||
      document.body
    );
  }

  function looksLikeApplicantListCard(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 8 || t.length > 600) return false;
    return (
      /Must-have|Preferred|See more jobs|\/\d/.test(t) ||
      /\b(1st|2nd|3rd)\b/.test(t) ||
      /unviewed\s+applicant/i.test(t)
    );
  }

  /** Walk up from a list link to the repeating card row (not the whole left column). */
  function cardElementFromApplicantLink(anchor) {
    if (!anchor) return null;
    const preferred =
      anchor.closest(".hiring-applicants__list-item") ||
      anchor.closest('[class*="hiring-applicants__list-item"]') ||
      anchor.closest('[class*="applicant-card"]') ||
      anchor.closest('[class*="list-item"]') ||
      anchor.closest("li") ||
      anchor.closest("[componentkey]");
    if (preferred) return preferred;

    let el = anchor;
    for (let depth = 0; depth < 8 && el && el.parentElement; depth++) {
      const parent = el.parentElement;
      const siblings = [...parent.children].filter((c) => c !== el);
      const similarSiblings = siblings.filter((c) =>
        looksLikeApplicantListCard(c.textContent || "")
      ).length;
      if (similarSiblings >= 1 && looksLikeApplicantListCard(el.textContent || "")) {
        return el;
      }
      el = parent;
    }
    return anchor.parentElement || anchor;
  }

  function addApplicantCard(found, byAppId, el, name, appId) {
    if (!el) return;
    let resolved = name;
    if (!resolved || resolved === "Unknown_Candidate") {
      resolved = extractNameFromCard(el);
    }
    if (isInvalidCardName(resolved) && resolved !== "Unviewed_applicant") return;
    if (resolved === "Unknown_Candidate") resolved = "Unviewed_applicant";

    if (appId) {
      const existing = byAppId.get(appId);
      if (existing && existing !== el) {
        // Prefer the smaller/more specific card node
        if (existing.contains(el)) {
          found.delete(existing);
          byAppId.set(appId, el);
          found.set(el, resolved);
        } else if (!el.contains(existing)) {
          found.set(el, resolved);
          byAppId.set(appId, el);
        }
        return;
      }
      byAppId.set(appId, el);
    }
    found.set(el, resolved);
  }

  function scanApplicantCards() {
    const found = new Map();
    const byAppId = new Map();

    // ── Strategy 0: Classic Hiring Manager list (LinkedIn Jobs Hiring) ──
    document.querySelectorAll(
      ".hiring-applicants__list-item, [class*='hiring-applicants__list-item']"
    ).forEach((el) => {
      const appId =
        (el.querySelector("a[href*='/applicants/']")?.getAttribute("href") || "").match(
          /\/applicants\/(\d+)/
        )?.[1] || "";
      addApplicantCard(found, byAppId, el, extractNameFromCard(el), appId);
    });

    // ── Strategy 0b: Left-rail links to /hiring/jobs/.../applicants/{id}/ ──
    // Current LinkedIn UI often drops .hiring-applicants__list-item but keeps these hrefs.
    document.querySelectorAll('a[href*="/hiring/jobs/"][href*="/applicants/"]').forEach((a) => {
      const href = a.getAttribute("href") || a.href || "";
      const m = href.match(/\/applicants\/(\d+)/i);
      if (!m) return;
      // Skip links that live only in the detail header chrome (not the left list)
      if (a.closest(".hiring-applicant-header, #hiring-detail-root, .hiring-applicant-detail")) {
        // Still allow if the same node is clearly in a multi-card list parent
        const card = cardElementFromApplicantLink(a);
        const parent = card?.parentElement;
        const peerCount = parent
          ? [...parent.children].filter((c) => looksLikeApplicantListCard(c.textContent || "")).length
          : 0;
        if (peerCount < 2) return;
      }
      const card = cardElementFromApplicantLink(a);
      if (!card) return;
      if (!looksLikeApplicantListCard(card.textContent || "") && found.size > 0) return;
      addApplicantCard(found, byAppId, card, extractNameFromCard(card), m[1]);
    });
    if (found.size > 0) {
      log(`  Strategy 0/0b: Found ${found.size} applicant card(s) from hiring list links`);
    }

    // ── Strategy 1: data-view-name on applicant items ──
    document.querySelectorAll('[data-view-name*="applicant" i]').forEach((el) => {
      if (el.closest(".hiring-applicant-header, .hiring-applicant-detail, #hiring-detail-root")) {
        return; // detail chrome, not left-rail cards
      }
      const appId =
        (el.querySelector?.("a[href*='/applicants/']")?.getAttribute("href") || "").match(
          /\/applicants\/(\d+)/
        )?.[1] || "";
      addApplicantCard(found, byAppId, el, extractNameFromCard(el), appId);
    });

    // Skip fuzzy strategies when we already have a solid list (avoids "Message" false positives)
    const hasHiringList = found.size >= 2;

    if (!hasHiringList) {
      document.querySelectorAll("[componentkey]").forEach((el) => {
        const text = el.textContent || "";
        if (!looksLikeApplicantListCard(text)) return;
        if (el.closest(".hiring-applicant-detail, #hiring-detail-root")) return;

        let isDuplicate = false;
        for (const existing of found.keys()) {
          if (existing.contains(el) || el.contains(existing)) {
            isDuplicate = true;
            break;
          }
        }
        if (!isDuplicate) addApplicantCard(found, byAppId, el, extractNameFromCard(el), "");
      });
    }

    // ── Strategy 2: Find the list container and its children ──
    if (found.size === 0) {
      const allElements = document.querySelectorAll("*");
      let bestContainer = null;
      let bestScore = 0;

      for (const el of allElements) {
        const children = el.children;
        if (children.length < 2) continue;

        let matchingChildren = 0;
        for (const child of children) {
          if (looksLikeApplicantListCard(child.textContent || "")) matchingChildren++;
        }

        if (matchingChildren > bestScore) {
          bestScore = matchingChildren;
          bestContainer = el;
        }
      }

      if (bestContainer && bestScore >= 2) {
        log(`  Strategy 2: Found list container with ${bestScore} applicant children`);
        for (const child of bestContainer.children) {
          if (looksLikeApplicantListCard(child.textContent || "")) {
            const appId =
              (child.querySelector("a[href*='/applicants/']")?.getAttribute("href") || "").match(
                /\/applicants\/(\d+)/
              )?.[1] || "";
            addApplicantCard(found, byAppId, child, extractNameFromCard(child), appId);
          }
        }
      }
    }

    // ── Strategy 3: Role-based — look for [role="list"] → [role="listitem"] ──
    if (found.size === 0) {
      document.querySelectorAll('[role="list"]').forEach((list) => {
        const items = list.querySelectorAll('[role="listitem"], li, [role="option"]');
        items.forEach((item) => {
          if (looksLikeApplicantListCard(item.textContent || "")) {
            addApplicantCard(found, byAppId, item, extractNameFromCard(item), "");
          }
        });
      });
    }

    // ── Strategy 4: Anchor links with hiring/applicant URLs (fallback) ──
    if (found.size === 0) {
      document
        .querySelectorAll(
          'a[href*="applicationId"], a[href*="/applicants/"], a[href*="applicant"]'
        )
        .forEach((a) => {
          const href = a.getAttribute("href") || "";
          const m = href.match(/\/applicants\/(\d+)/i) || href.match(/applicationId[=:](\d+)/i);
          const card = cardElementFromApplicantLink(a);
          if (card && (card.textContent || "").trim().length > 8) {
            addApplicantCard(found, byAppId, card, extractNameFromCard(card), m?.[1] || "");
          }
        });
    }

    // ── Strategy 5: ULTRA-broad — near "Applicants" / "Shortlist" heading ──
    if (found.size === 0) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let textNode;
      while ((textNode = walker.nextNode())) {
        const t = textNode.textContent.trim();
        if (
          t === "Shortlist" ||
          t === "Applicants" ||
          t === "All applicants" ||
          /\d[\d,]*\s+applicants/i.test(t)
        ) {
          let parent = textNode.parentElement;
          for (let depth = 0; depth < 6 && parent; depth++) {
            parent = parent.parentElement;
          }
          if (parent) {
            for (const c of parent.querySelectorAll("*")) {
              if (
                c.children.length === 0 ||
                c.children.length > 12 ||
                !looksLikeApplicantListCard(c.textContent || "")
              ) {
                continue;
              }
              addApplicantCard(found, byAppId, c, extractNameFromCard(c), "");
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
          toRemove.push(a);
        }
      }
    }
    for (const el of toRemove) found.delete(el);

    for (const [el, name] of [...found.entries()]) {
      if (isInvalidCardName(name) && name !== "Unviewed_applicant") {
        found.delete(el);
      }
    }

    // ── Strategy 5b: Last-chance — unique /applicants/{id} links as cards ──
    if (found.size < 2) {
      const before = found.size;
      document.querySelectorAll("a[href*='/applicants/']").forEach((a) => {
        const href = a.getAttribute("href") || a.href || "";
        const m = href.match(/\/hiring\/jobs\/\d+\/applicants\/(\d+)/i);
        if (!m) return;
        if (byAppId.has(m[1])) return;
        const card = cardElementFromApplicantLink(a);
        if (!card) return;
        // Ignore tiny icon-only chrome links with no name text
        const text = (card.textContent || "").trim();
        if (text.length < 2) return;
        addApplicantCard(found, byAppId, card, extractNameFromCard(card), m[1]);
      });
      if (found.size > before) {
        log(`  Strategy 5b: Expanded to ${found.size} applicant(s) via unique applicant URLs`);
      }
    }

    // Re-dedupe after late strategies
    const toRemove2 = [];
    for (const a of found.keys()) {
      for (const b of found.keys()) {
        if (a !== b && a.contains(b)) toRemove2.push(a);
      }
    }
    for (const el of toRemove2) found.delete(el);

    // ── Strategy 6: Single-applicant detail ONLY when truly no list cards ──
    let detailSynthetic = false;
    if (found.size === 0 && isHiringDetailPage()) {
      const appId = getApplicationIdFromPath();
      const detailRoot = getDetailRootElement();
      const detailName =
        extractNameFromDetailPanel() ||
        (appId ? `Application_${appId}` : "Unknown_Candidate");
      found.set(detailRoot, detailName);
      detailSynthetic = true;
      log(
        `  Strategy 6: Detail page mode — treating open applicant as 1 card (${detailName})`
      );
    }

    applicantCards = [...found].map(([el, name]) => {
      const link =
        el?.querySelector?.('a[href*="/applicants/"]') ||
        (el?.matches?.('a[href*="/applicants/"]') ? el : null);
      const hrefRaw = link?.getAttribute?.("href") || link?.href || "";
      const appId =
        (hrefRaw.match(/\/applicants\/(\d+)/i) || [])[1] ||
        getApplicationIdFromPath() ||
        "";
      return {
        element: el,
        name,
        appId,
        href: absoluteHref(hrefRaw) || buildApplicantDetailHref(appId),
        isDetailSynthetic: detailSynthetic,
      };
    });
    log(`Scan complete: ${applicantCards.length} applicant(s) found in the current DOM.`);
    if (applicantCards.length > 0 && applicantCards.length <= 15) {
      log(
        `  Note: LinkedIn virtualizes the left list (~${applicantCards.length} visible). Start Bulk Download will scroll to collect more.`
      );
    }
    if (applicantCards.length > 0) {
      const preview = applicantCards.slice(0, 12).map((c) => c.name).join(", ");
      log(`  Names: ${preview}${applicantCards.length > 12 ? "…" : ""}`);
    }
    return applicantCards.length;
  }

  /** Find the scrollable left-rail list (LinkedIn keeps only ~10 cards mounted). */
  function findApplicantListScroller() {
    const links = [
      ...document.querySelectorAll('a[href*="/hiring/jobs/"][href*="/applicants/"]'),
    ];
    let best = null;
    let bestScore = 0;

    for (const a of links) {
      let el = a.parentElement;
      for (let depth = 0; depth < 14 && el; depth++) {
        const style = window.getComputedStyle(el);
        const oy = style.overflowY || style.overflow || "";
        const scrollable =
          el.scrollHeight > el.clientHeight + 50 && /(auto|scroll|overlay)/i.test(oy);
        const linkCount = el.querySelectorAll('a[href*="/applicants/"]').length;
        if (scrollable && linkCount >= 2) {
          const score = linkCount * 20 + (el.scrollHeight - el.clientHeight);
          if (score > bestScore) {
            bestScore = score;
            best = el;
          }
        }
        el = el.parentElement;
      }
    }

    return (
      best ||
      document.querySelector(
        ".hiring-applicants__list, [class*='hiring-applicants__list'], .scaffold-layout__list, [class*='scaffold-layout__list']"
      )
    );
  }

  /** Harvest currently mounted list links into a Map keyed by application id. */
  function harvestVisibleApplicants(bucket) {
    document
      .querySelectorAll('a[href*="/hiring/jobs/"][href*="/applicants/"]')
      .forEach((a) => {
        const hrefRaw = a.getAttribute("href") || a.href || "";
        const m = hrefRaw.match(/\/applicants\/(\d+)/i);
        if (!m) return;
        const appId = m[1];
        const card = cardElementFromApplicantLink(a);
        let name = card ? extractNameFromCard(card) : "";
        if (!name || name === "Unknown_Candidate" || isInvalidCardName(name)) {
          name = `Application_${appId}`;
        }
        if (name === "Unviewed_applicant") name = `Application_${appId}`;
        const href = absoluteHref(hrefRaw) || buildApplicantDetailHref(appId);
        const prev = bucket.get(appId);
        const entry = {
          element: card?.isConnected ? card : null,
          name,
          appId,
          href,
          isDetailSynthetic: false,
        };
        if (!prev) {
          bucket.set(appId, entry);
          return;
        }
        // Prefer a real person name over Application_<id>
        if (/^Application_\d+$/i.test(prev.name) && !/^Application_\d+$/i.test(name)) {
          prev.name = name;
        }
        if (card?.isConnected) prev.element = card;
        if (href) prev.href = href;
      });
  }

  /**
   * Scroll the left applicant rail and collect unique applicants by id.
   * Required because LinkedIn virtualizes the list (~10 nodes in DOM at a time).
   */
  async function scrollCollectApplicants({ maxRounds = 100, stagnantLimit = 5 } = {}) {
    const bucket = new Map();

    for (const c of applicantCards) {
      const appId = c.appId || extractApplicationId(c) || "";
      if (!appId) continue;
      bucket.set(appId, {
        element: c.element?.isConnected ? c.element : null,
        name: c.name || `Application_${appId}`,
        appId,
        href: c.href || buildApplicantDetailHref(appId),
        isDetailSynthetic: false,
      });
    }
    harvestVisibleApplicants(bucket);

    const scroller = findApplicantListScroller();
    if (!scroller) {
      log("  No scrollable applicant list found — using currently visible cards only.");
      applicantCards = [...bucket.values()];
      return applicantCards.length;
    }

    log(
      `  Scrolling left list to load more (virtualized). Starting with ${bucket.size}…`
    );
    notify("LOG", {
      message: `Scrolling applicant list to collect more than the ~${bucket.size} visible in the DOM…`,
    });

    scroller.scrollTop = 0;
    await humanPause(400, 700);
    harvestVisibleApplicants(bucket);

    let stagnant = 0;
    let lastSize = bucket.size;

    for (let round = 0; round < maxRounds && !stopRequested; round++) {
      const step = Math.max(140, Math.floor((scroller.clientHeight || 400) * 0.9));
      const prevTop = scroller.scrollTop;
      scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + step);
      try {
        scroller.dispatchEvent(
          new WheelEvent("wheel", { deltaY: step, bubbles: true, cancelable: true })
        );
      } catch (_) {}
      await humanPause(450, 850);
      harvestVisibleApplicants(bucket);

      if (bucket.size > lastSize) {
        if (bucket.size % 20 === 0 || bucket.size - lastSize >= 8) {
          log(`  …collected ${bucket.size} unique applicants`);
          notify("LOG", { message: `Collected ${bucket.size} unique applicants so far…` });
        }
        lastSize = bucket.size;
        stagnant = 0;
      } else {
        stagnant++;
        // If scroll position did not move, jump toward bottom
        if (scroller.scrollTop <= prevTop + 2) {
          scroller.scrollTop = scroller.scrollHeight;
          await humanPause(600, 1000);
          harvestVisibleApplicants(bucket);
          if (bucket.size > lastSize) {
            lastSize = bucket.size;
            stagnant = 0;
            continue;
          }
        }
        if (stagnant >= stagnantLimit) break;
      }
    }

    applicantCards = [...bucket.values()];
    log(`  Scroll collect finished: ${applicantCards.length} unique applicant(s).`);
    notify("LOG", {
      message: `List collect done — ${applicantCards.length} unique applicant(s). Starting downloads…`,
    });
    return applicantCards.length;
  }

  function extractNameFromCard(card) {
    for (const sel of [
      ".artdeco-entity-lockup__title",
      ".artdeco-entity-lockup__title span",
      '[data-test-row-lockup-full-name]',
      "h2", "h3", "h4",
      'a[href*="/in/"]',
      'a[href*="/talent/profile/"]',
      'a[href*="/applicants/"]',
    ]) {
      const el = card.querySelector(sel);
      if (el) {
        const raw = (el.childNodes[0]?.textContent || el.textContent).trim();
        if (raw.length > 1 && raw.length < 60) {
          if (/unviewed\s+applicant/i.test(raw)) return "Unviewed_applicant";
          if (/^see more jobs$/i.test(raw)) continue;
          const cleaned = sanitiseName(
            raw
              .replace(/[·•].*$/, "")
              .replace(/['’]s application$/i, "")
              .replace(/\b(1st|2nd|3rd)\b.*$/i, "")
              .trim()
          );
          if (cleaned && cleaned.toLowerCase() !== "see_more_jobs") return cleaned;
        }
      }
    }

    const text = card.textContent.trim();
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 0 &&
          !/^see more jobs$/i.test(l) &&
          !/^(1st|2nd|3rd)$/i.test(l)
      );
    if (lines.length > 0) {
      let name = lines[0];
      name = name.replace(/[·•].*$/, "").replace(/\b(1st|2nd|3rd)\b.*$/i, "").trim();
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
      ".hiring-applicant-header .artdeco-entity-lockup__title span",
      "#hiring-detail-root h1",
      ".hiring-applicants__right-column h1",
      ".hiring-applicant-detail h1",
      '[data-test-row-lockup-full-name]',
    ];
    for (const sel of selectors) {
      const header = document.querySelector(sel);
      if (!header) continue;
      let raw = (header.childNodes[0]?.textContent || header.textContent || "").trim();
      raw = raw
        .replace(/['’]s application.*/i, "")
        .replace(/\d+(st|nd|rd|th).*/i, "")
        .replace(/degree connection/gi, "")
        .replace(/unviewed\s+applicant/gi, "")
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
    if (/\/hiring\/jobs\//i.test(location.pathname)) return true;
    return !!document.querySelector(
      ".hiring-applicants__list-item, .hiring-applicant-header, .hiring-resume-viewer__pdf-download-link-icon, .ui-attachment__download-button, .hiring-applicant-detail, #hiring-detail-root"
    );
  }

  function isLikelyResumeHref(href) {
    if (!href) return false;
    const h = href.toLowerCase();
    if (
      h.includes("/in/") ||
      h.startsWith("javascript:") ||
      h === "#" ||
      h.endsWith("#") ||
      h.includes("profile-displayphoto") ||
      h.includes("company-logo")
    ) {
      return false;
    }
    return (
      h.includes("mediaauth") ||
      h.includes("/dms/") ||
      h.includes("linkedin.com/ambry") ||
      /\.pdf(\?|#|$)/i.test(href) ||
      (h.includes("media.licdn.com") && (h.includes("pdf") || h.includes("document") || h.includes("resume")))
    );
  }

  function getResumeSearchRoot() {
    return (
      document.querySelector(".hiring-resume-viewer") ||
      document.querySelector(".hiring-applicant-detail") ||
      document.querySelector("#hiring-detail-root") ||
      document.querySelector(".hiring-applicants__right-column") ||
      document.querySelector(".scaffold-layout__detail") ||
      document
    );
  }

  /**
   * Hiring Manager resume URL — NOT "See full profile".
   * Real download controls:
   *   .ui-attachment__download-button
   *   .hiring-resume-viewer__pdf-download-link-icon → closest <a>
   *   text / mediaAuth / .pdf / dms links in the detail region
   */
  function getHiringResumeDownloadUrl() {
    const attachment = document.querySelector(
      "a.ui-attachment__download-button, .ui-attachment__download-button, a[class*='ui-attachment'][href]"
    );
    if (attachment && attachment.href && !attachment.href.includes("/in/")) {
      log("  ✓ Hiring resume URL via ui-attachment__download-button");
      return attachment.href;
    }

    const icon = document.querySelector(
      ".hiring-resume-viewer__pdf-download-link-icon, svg.hiring-resume-viewer__pdf-download-link-icon, [class*='resume-viewer'][class*='download'] svg, svg[id='download-small']"
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
        isLikelyResumeHref(a.href)
      ) {
        if (!href.includes("/in/")) {
          log("  ✓ Hiring resume URL via More dropdown");
          return a.href;
        }
      }
    }

    // Broader: download-labelled anchors and media/pdf links in the detail region
    const root = getResumeSearchRoot();
    const anchors = root.querySelectorAll
      ? root.querySelectorAll("a[href]")
      : document.querySelectorAll("a[href]");
    for (const a of anchors) {
      const text = (a.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const aria = (a.getAttribute("aria-label") || "").toLowerCase();
      const labelledDownload =
        (text.includes("download") && (text.includes("resume") || text === "download")) ||
        (aria.includes("download") && (aria.includes("resume") || aria.includes("pdf")));
      if (labelledDownload && a.href && !a.href.includes("/in/")) {
        log("  ✓ Hiring resume URL via download-labelled anchor");
        return a.href;
      }
      if (isLikelyResumeHref(a.href)) {
        log("  ✓ Hiring resume URL via media/pdf/dms link");
        return a.href;
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

  /** applicationId from card meta, link, or detail URL — used when name is still "Unviewed applicant". */
  function extractApplicationId(card) {
    if (card?.appId) return String(card.appId);
    const el = card?.element || card;
    if (el && el.querySelectorAll) {
      for (const a of el.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/applicationId[=:](\d+)/i) || href.match(/\/applicants\/(\d+)/);
        if (m) return m[1];
      }
    }
    if (card?.href) {
      const m = String(card.href).match(/\/applicants\/(\d+)/i);
      if (m) return m[1];
    }
    return getApplicationIdFromPath();
  }

  /**
   * Prefer a real person name from the detail panel (and refreshed list card).
   * Falls back to Application_<id> instead of leaving "Unviewed_applicant".
   */
  async function resolveApplicantName(card, fallbackName, maxWaitMs = 6000) {
    const start = Date.now();
    let best = fallbackName;

    while (Date.now() - start < maxWaitMs) {
      const detailName = extractNameFromDetailPanel();
      if (detailName) {
        card.name = detailName;
        return detailName;
      }

      // List card often updates from "Unviewed applicant" → real name after open
      const fromCard = extractNameFromCard(card.element);
      if (fromCard && fromCard !== "Unviewed_applicant" && fromCard !== "Unknown_Candidate") {
        card.name = fromCard;
        return fromCard;
      }

      await humanPause(400, 700);
    }

    if (!best || best === "Unviewed_applicant" || best === "Unknown_Candidate") {
      const appId = extractApplicationId(card);
      if (appId) {
        best = `Application_${appId}`;
        card.name = best;
        log(`  Using application id for filename: ${best}`);
        return best;
      }
    }

    return best || fallbackName;
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
        await humanPause(1000, 2000);
      } else {
        const detail = document.querySelector(
          ".hiring-applicant-detail, #hiring-detail-root, .hiring-applicants__right-column, .scaffold-layout__detail, main"
        );
        if (detail) detail.scrollTop = (detail.scrollTop || 0) + 200;
        await humanPause(500, 900);
      }
    }
    return null;
  }

  /**
   * Soft-refresh resume viewer without full page reload (full reload kills the bulk loop).
   * Opens a different applicant briefly, then returns — forces LinkedIn to remount the panel.
   */
  async function softRefreshResumePanel(card) {
    const others = applicantCards.filter((c) => c.element !== card.element);
    if (others.length > 0) {
      const neighbor = others[Math.floor(Math.random() * Math.min(3, others.length))];
      log("  Soft-refresh: briefly opening another applicant, then returning…");
      await selectApplicant(neighbor);
      await humanPause(800, 1500);
    } else {
      log("  Soft-refresh: re-selecting same applicant…");
    }
    await selectApplicant(card);
    await humanPause(1500, 2500);
  }

  /**
   * Wait for virus-scan to clear + resume URL.
   * First pass is capped (~45s) so one stuck scan doesn't block the whole run;
   * callers can retry later via the end-of-run queue.
   */
  async function waitForResumeReady(card, maxWaitMs = 45000) {
    const deadline = Date.now() + maxWaitMs;

    let url = await waitForHiringResumeUrl(Math.min(18000, maxWaitMs));
    if (url) return url;

    if (Date.now() < deadline && (isVirusScanBlocking() || !getHiringResumeDownloadUrl())) {
      await softRefreshResumePanel(card);
      const remaining = Math.max(5000, deadline - Date.now());
      url = await waitForHiringResumeUrl(Math.min(20000, remaining));
      if (url) return url;
    }

    if (Date.now() < deadline && (isVirusScanBlocking() || !getHiringResumeDownloadUrl())) {
      log("  Soft-refresh: second re-select…");
      await selectApplicant(card);
      await humanPause(2000, 3500);
      const remaining = Math.max(4000, deadline - Date.now());
      url = await waitForHiringResumeUrl(Math.min(12000, remaining));
      if (url) return url;
    }

    if (!url) {
      await tryOpenMoreMenuForResume();
      url = await waitForHiringResumeUrl(Math.min(6000, Math.max(0, deadline - Date.now())));
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
    const appId = card.appId || extractApplicationId(card) || "";

    // Already viewing this applicant (detail synthetic or URL match)
    if (
      card.isDetailSynthetic ||
      (appId && getApplicationIdFromPath() === appId) ||
      (isHiringDetailPage() && applicantCards.length === 1 && !appId)
    ) {
      log("  Already on applicant detail page — skipping list click");
      await humanPause(400, 900);
      return;
    }

    // Re-find live DOM node (virtualized list recycles elements)
    let el = card.element?.isConnected ? card.element : null;
    let liveLink = null;
    if (appId) {
      liveLink = document.querySelector(`a[href*="/applicants/${appId}"]`);
      if (!el && liveLink) el = cardElementFromApplicantLink(liveLink);
      if (el?.isConnected) card.element = el;
    }

    if (el?.isConnected) {
      const anchors = [...el.querySelectorAll("a")].filter((a) => {
        const href = a.getAttribute("href") || "";
        return href && !href.includes("/in/") && !/see full profile/i.test(a.textContent || "");
      });

      const clickTarget =
        (appId && el.querySelector(`a[href*="/applicants/${appId}"]`)) ||
        el.querySelector("a.hiring-applicants__list-item-link") ||
        el.querySelector('a[href*="applicationId"]') ||
        el.querySelector('a[href*="/applicants/"]') ||
        el.querySelector('a[href*="/hiring/"]') ||
        anchors[0] ||
        el.querySelector("a") ||
        el;

      log(
        `  Clicking: <${clickTarget.tagName}> "${(clickTarget.textContent || "")
          .trim()
          .substring(0, 40)}…"`
      );
      await humanClick(clickTarget);
      await humanPause(1500, 3500);
      return;
    }

    // Card scrolled out of DOM — open via stored / built detail URL
    const href = card.href || (liveLink ? absoluteHref(liveLink.href) : "") || buildApplicantDetailHref(appId);
    if (!href) {
      throw new Error("Applicant card no longer in DOM and no detail URL available");
    }
    log(`  List virtualized — opening applicant via URL…`);
    const a = document.createElement("a");
    a.href = href;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();

    const start = Date.now();
    while (Date.now() - start < 10000) {
      if (appId && getApplicationIdFromPath() === appId) break;
      await sleep(300);
    }
    await humanPause(1200, 2200);
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
  async function waitForPdfTabDownload(maxWaitMs = 25000) {
    const start = Date.now();
    // Brief grace so EXPECT_PDF_TAB / DOWNLOAD_RESUME can register
    await humanPause(300, 600);
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
      await humanPause(500, 800);
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
    applicantsSinceLongBreak = 0;
    const virusRetryQueue = []; // cards blocked by virus scan on first pass

    // LinkedIn only mounts ~10 list cards at a time — scroll-collect unique ids first
    log("Phase 0: Expanding virtualized applicant list…");
    notify("LOG", {
      message:
        "Scrolling the left applicant list to collect everyone LinkedIn will load (only ~10 stay in the DOM at once)…",
    });
    scanApplicantCards();
    await scrollCollectApplicants({ maxRounds: 120, stagnantLimit: 6 });

    const total = applicantCards.length;
    let downloaded = 0,
      failed = 0;
    const hiringUI = isHiringManagerUI();

    if (total === 0) {
      log("No applicants collected — nothing to download.");
      notify("DONE", { downloaded: 0, total: 0, failed: 0 });
      chrome.runtime.sendMessage({ type: "DOWNLOAD_STOPPED" }).catch(() => {});
      return;
    }

    log(`Starting bulk download for ${total} applicant(s)…`);
    log(
      `  Detected UI: ${hiringUI ? "Hiring Manager (Jobs applicants)" : "Talent Hub / Recruiter-style"}`
    );

    chrome.runtime.sendMessage({ type: "DOWNLOAD_STARTED", total }).catch(() => {});
    notify("PROGRESS", { downloaded: 0, total, failed: 0 });

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

        // Resolve real name (detail panel / updated list card / applicationId)
        name = await resolveApplicantName(card, name, 6000);
        log(`  Using name: ${name}`);
        setCurrentFilenameInPage(name);

        let dlSuccess = false;

        // ── Path A: Hiring Manager — resume PDF link in the detail pane ──
        if (hiringUI || document.querySelector(".hiring-applicant-header")) {
          log("  Step 2: Looking for Hiring resume download link (incl. virus-scan wait)…");
          name = await resolveApplicantName(card, name, 2500);
          setCurrentFilenameInPage(name);
          const pdfUrl = await waitForResumeReady(card, 45000);

          if (pdfUrl) {
            name = await resolveApplicantName(card, name, 2000);
            setCurrentFilenameInPage(name);
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
                dlSuccess = await waitForPdfTabDownload(25000);
              } else {
                clearPdfTabWatch();
              }
            }
          } else {
            const stillScanning = isVirusScanBlocking();
            if (stillScanning) {
              log(`  ⏸ Virus scan still blocking ${name} — will retry at end of run`);
              virusRetryQueue.push(card);
              notify("PROGRESS", { downloaded, total, failed, candidateName: name });
            } else {
              const errMsg = "No resume download link found";
              log(`  ✗ ${errMsg} for ${name}`);
              failed++;
              notify("DOWNLOAD_ERROR", { candidateName: name, error: errMsg });
              notify("PROGRESS", { downloaded, total, failed });
            }
            if (i < applicantCards.length - 1) await humanPauseBetweenApplicants();
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
            if (i < applicantCards.length - 1) await humanPauseBetweenApplicants();
            continue;
          }

          log("  Step 2: Clicking Resume…");
          await humanClick(resumeBtn);

          log("  Step 3: Waiting for popup…");
          await humanPause(1000, 2500);
          const downloadBtn = await findDownloadButton(10000);
          if (!downloadBtn) {
            log(`  ✗ No Download button for ${name}`);
            failed++;
            await closePreviewPopup();
            notify("PROGRESS", { downloaded, total, failed });
            if (i < applicantCards.length - 1) await humanPauseBetweenApplicants();
            continue;
          }

          await humanPause(200, 500);
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
              if (!dlSuccess) dlSuccess = await waitForPdfTabDownload(25000);
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
              if (!dlSuccess) dlSuccess = await waitForPdfTabDownload(25000);
              else clearPdfTabWatch();
            }
          } else {
            log("  Step 3: Clicking Download (with main-world interception + fetch)…");
            chrome.runtime.sendMessage({ type: "EXPECT_PDF_TAB", candidateName: name });
            startWindowOpenIntercept(name);
            await humanClick(downloadBtn);
            await humanPause(2000, 4000);

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
                if (!dlSuccess) dlSuccess = await waitForPdfTabDownload(25000);
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
                  if (!dlSuccess) dlSuccess = await waitForPdfTabDownload(25000);
                  else clearPdfTabWatch();
                }
              } else {
                log("  Step 3: Waiting for background PDF tab watcher…");
                dlSuccess = await waitForPdfTabDownload(25000);
                if (!dlSuccess) {
                  log("  ✗ No PDF URL and tab watcher did not confirm a download");
                }
              }
            }
          }

          log("  Step 4: Closing popup…");
          await humanPause(600, 1200);
          await closePreviewPopup();
          await humanPause(400, 900);
        }

        if (dlSuccess) {
          downloaded++;
          log(`  ✓ Downloaded: ${name}`);
          notify("PROGRESS", { downloaded, total, failed, candidateName: name });
          // Brief settle after a successful save before pacing to next applicant
          await humanPause(2000, 5000);
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
        await humanPause(300, 700);
      }

      if (i < applicantCards.length - 1 && !stopRequested) {
        await humanPauseBetweenApplicants();
      }
    }

    // ── End-of-run retry for virus-scan blocks (scan often finishes by then) ──
    if (virusRetryQueue.length > 0 && !stopRequested) {
      log(`\n🔁 Retrying ${virusRetryQueue.length} applicant(s) blocked by virus scan…`);
      await humanPause(4000, 8000);

      for (let r = 0; r < virusRetryQueue.length; r++) {
        if (stopRequested) break;
        const card = virusRetryQueue[r];
        let name = card.name || "Unknown_Candidate";
        log(`\n━━━ [retry ${r + 1}/${virusRetryQueue.length}] ${name} ━━━`);
        clearPdfTabWatch();

        try {
          await selectApplicant(card);
          name = await resolveApplicantName(card, name, 6000);
          setCurrentFilenameInPage(name);
          log(`  Using name: ${name}`);

          const pdfUrl = await waitForResumeReady(card, 60000);
          if (!pdfUrl) {
            const errMsg = isVirusScanBlocking()
              ? "LinkedIn virus scan never finished — no download control appeared"
              : "No resume download link found";
            log(`  ✗ Retry failed: ${errMsg} for ${name}`);
            failed++;
            notify("DOWNLOAD_ERROR", { candidateName: name, error: errMsg });
            notify("PROGRESS", { downloaded, total, failed });
          } else {
            name = await resolveApplicantName(card, name, 2000);
            setCurrentFilenameInPage(name);
            log("  Fetching resume blob (retry)…");
            let dlSuccess = await downloadViaFetch(pdfUrl, name);
            if (!dlSuccess) {
              chrome.runtime.sendMessage({ type: "EXPECT_PDF_TAB", candidateName: name });
              dlSuccess = await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                  { type: "DOWNLOAD_RESUME", url: pdfUrl, candidateName: name },
                  (resp) => resolve(!!(resp && resp.ok))
                );
              });
              if (!dlSuccess) dlSuccess = await waitForPdfTabDownload(25000);
              else clearPdfTabWatch();
            }
            if (dlSuccess) {
              downloaded++;
              log(`  ✓ Downloaded on retry: ${name}`);
              notify("PROGRESS", { downloaded, total, failed, candidateName: name });
            } else {
              failed++;
              notify("DOWNLOAD_ERROR", { candidateName: name, error: "Download failed on virus-scan retry" });
              notify("PROGRESS", { downloaded, total, failed });
            }
          }
        } catch (err) {
          failed++;
          log(`  ✗ Retry error: ${err.message}`);
          notify("DOWNLOAD_ERROR", { candidateName: name, error: err.message });
          notify("PROGRESS", { downloaded, total, failed });
        }

        if (r < virusRetryQueue.length - 1 && !stopRequested) {
          await humanPauseBetweenApplicants();
        }
      }
    }

    log(`\n✅ Done! Downloaded: ${downloaded}, Failed: ${failed}`);
    notify("DONE", { downloaded, total, failed });
    chrome.runtime.sendMessage({ type: "DOWNLOAD_STOPPED" }).catch(() => {});
  }

  // ══════════════════════════════════════════════════════════
  //  DEBUG SCAN — dumps actual DOM structure
  // ══════════════════════════════════════════════════════════

  async function debugScan() {
    const info = { url: window.location.href };
    info.isDetailPage = isHiringDetailPage();
    info.applicationIdFromPath = getApplicationIdFromPath() || null;

    const count = scanApplicantCards();
    info.applicantCardsFound = count;
    info.applicantNames = applicantCards.map((c) => c.name);
    info.detailMode = applicantCards.some((c) => c.isDetailSynthetic);

    info.totalButtons = document.querySelectorAll("button").length;
    info.totalLinks = document.querySelectorAll("a[href]").length;
    info.hiringListItems = document.querySelectorAll(".hiring-applicants__list-item").length;
    info.hiringUI = isHiringManagerUI();

    // On detail pages, wait briefly for late-mounted resume controls
    let hiringUrl = getHiringResumeDownloadUrl();
    if (!hiringUrl && info.isDetailPage) {
      hiringUrl = await waitForHiringResumeUrl(5000);
    }
    info.hiringResumeUrlFound = !!hiringUrl;
    info.hiringResumeUrlPreview = hiringUrl ? hiringUrl.substring(0, 100) : null;
    info.uiAttachmentDownload = !!document.querySelector(
      ".ui-attachment__download-button, a[class*='ui-attachment'][href]"
    );
    info.resumeViewerDownloadIcon = !!document.querySelector(
      ".hiring-resume-viewer__pdf-download-link-icon, svg.hiring-resume-viewer__pdf-download-link-icon, svg[id='download-small']"
    );

    const resumeBtn = document.querySelector('button[data-view-name="hiring-applicant-view-resume"]');
    info.resumeButtonVisible =
      !!resumeBtn || info.uiAttachmentDownload || info.resumeViewerDownloadIcon || !!hiringUrl;
    info.resumeButtonText = resumeBtn
      ? resumeBtn.textContent.trim().substring(0, 40)
      : (info.uiAttachmentDownload
          ? "ui-attachment__download-button"
          : (info.resumeViewerDownloadIcon
              ? "hiring-resume-viewer download icon"
              : (hiringUrl ? "media/pdf link" : "")));

    info.documentIconVisible = !!document.querySelector('svg[id="document-small"]');
    info.downloadIconVisible =
      !!document.querySelector('svg[id="download-small"]') ||
      info.uiAttachmentDownload ||
      info.resumeViewerDownloadIcon ||
      !!hiringUrl;

    info.detailPanelName = extractNameFromDetailPanel();
    info.virusScanBlocking = isVirusScanBlocking();

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
      '.hiring-applicants__list-item a, a[href*="applicationId"], a[href*="applicant"], a[href*="/hiring/jobs/"]'
    ).forEach((a) => {
      info.applicationLinks.push({
        href: a.href.substring(0, 120),
        text: a.textContent.trim().substring(0, 60),
      });
    });

    // Surface PDF / media links so markup drift is visible without DevTools
    info.resumeLikeLinks = [];
    document.querySelectorAll("a[href]").forEach((a) => {
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      const aria = a.getAttribute("aria-label") || "";
      const labelled =
        /download/i.test(text) || /download/i.test(aria) || /resume/i.test(text);
      if (isLikelyResumeHref(a.href) || labelled) {
        if (info.resumeLikeLinks.length < 15) {
          info.resumeLikeLinks.push({
            href: a.href.substring(0, 120),
            text: (text || aria).substring(0, 60),
          });
        }
      }
    });

    return info;
  }

  // ── Messaging ───────────────────────────────────────────

  function notify(type, data) {
    chrome.runtime.sendMessage({ type, ...data }).catch(() => {});
  }

  function messageHandler(msg, _sender, sendResponse) {
    switch (msg.action) {
      case "SCAN_RESUMES":
        sendResponse({ count: scanApplicantCards() });
        break;
      case "DEBUG_SCAN":
        debugScan()
          .then((debug) => sendResponse({ debug }))
          .catch((err) => sendResponse({ debug: null, error: String(err) }));
        return true; // async
      case "START_DOWNLOAD":
        startBulkDownload();
        sendResponse({ ok: true });
        break;
      case "STOP_DOWNLOAD":
        stopRequested = true;
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false });
    }
    return true;
  }

  chrome.runtime.onMessage.addListener(messageHandler);
  window.__lbrd_cleanup = () => chrome.runtime.onMessage.removeListener(messageHandler);

  console.log("[LBRD] Content script v8 loaded (Hiring Manager + scroll-collect + Talent Hub).");
})();
