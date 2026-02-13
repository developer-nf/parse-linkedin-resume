# LinkedIn Bulk Resume Downloader — Chrome Extension

A Chrome Extension (Manifest V3) that helps HR professionals bulk‑download applicant resumes from LinkedIn Hiring / Jobs pages with human‑like delays to avoid detection.

---

## Features

| Feature | Details |
|---|---|
| **Bulk download** | Finds all "Download resume" buttons on the page and clicks them one by one |
| **Human emulation** | Random 5–15 second delay between each download to mimic real user behaviour |
| **Clean filenames** | Resumes are saved as `CandidateName_Resume_YYYY-MM-DD.pdf` inside a `LinkedIn_Resumes` folder |
| **Progress UI** | Popup shows found / downloaded / failed counts, a progress bar, and an activity log |
| **Safety check** | Only activates on `linkedin.com/hiring`, `/talent`, or `/jobs` URLs |

---

## Installation (Developer / Unpacked Mode)

> Chrome Web Store publishing is not covered here — these steps load the extension locally for personal use.

### Step 1 — Get the files

Make sure the project folder contains these files:

```
linkedin_bulk_resume_downloader/
├── manifest.json
├── background.js
├── content.js
├── popup.html
├── popup.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md          ← you are here
```

### Step 2 — Create placeholder icons

The extension expects three PNG icons. You can use any square image; here are the quickest options:

| Option | How |
|---|---|
| **Use a generator** | Go to [favicon.io](https://favicon.io/favicon-generator/) → type "LR" → download the PNGs → rename to `icon16.png`, `icon48.png`, `icon128.png` and drop them into the `icons/` folder. |
| **Use any image** | Resize any PNG to 16×16, 48×48, and 128×128 pixels and place them in `icons/`. |
| **Skip icons** | Remove the `"icons"` and `"default_icon"` keys from `manifest.json` — Chrome will use a default puzzle‑piece icon. |

### Step 3 — Load into Chrome

1. Open **Google Chrome**.
2. Navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top‑right corner).
4. Click **"Load unpacked"**.
5. Select the project folder (`linkedin_bulk_resume_downloader`).
6. The extension icon will appear in your toolbar. Pin it for easy access.

### Step 4 — Verify

You should see the extension listed with no errors. If there's an "Errors" button, click it to debug.

---

## How to Use

### 1. Navigate to LinkedIn

Open any of these pages in Chrome:

- `https://www.linkedin.com/hiring/jobs/...` (LinkedIn Recruiter job applicants list)
- `https://www.linkedin.com/talent/...` (LinkedIn Talent Hub)

> **Important:** You must be logged in to LinkedIn and have access to the recruiter / hiring tools.

### 2. Open the Extension Popup

Click the extension icon in the Chrome toolbar. The popup will:

1. Verify you're on a valid LinkedIn hiring page.
2. Scan the page for resume download buttons.
3. Show how many resumes were found.

### 3. Start Downloading

- Click **"▶ Start Bulk Download (N)"**.
- Watch the progress bar, counters, and activity log update in real time.
- Each download has a **random 5–15 second delay** — this is intentional and keeps you safe.

### 4. Stop (optional)

Click the **"■ Stop"** button at any time to pause. You can close the popup and re‑open it; the content script keeps running in the background.

### 5. Find Your Files

Downloaded resumes are saved to your default Chrome downloads folder inside:

```
Downloads/
└── LinkedIn_Resumes/
    ├── John_Doe_Resume_2026-02-13.pdf
    ├── Jane_Smith_Resume_2026-02-13.pdf
    └── ...
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| **"Not a LinkedIn Hiring / Jobs page"** | Make sure the URL starts with `linkedin.com/hiring`, `/talent`, or `/jobs`. |
| **"No downloadable resumes found"** | Scroll down to load more applicants first — LinkedIn lazy‑loads. Then re‑open the popup to re‑scan. |
| **"Cannot communicate with page"** | Refresh the LinkedIn tab and try again. The content script needs to be injected first. |
| **Downloads go to the wrong folder** | Check `chrome://settings/downloads` — the `LinkedIn_Resumes` sub‑folder is created relative to your default download directory. |
| **Some resumes fail** | LinkedIn may rate‑limit you. Wait a few minutes and try again. The delay randomisation helps, but isn't bulletproof. |

---

## Project Structure

| File | Role |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) — permissions, scripts, icons |
| `background.js` | Service worker — download queue, `chrome.downloads` API, filename builder |
| `content.js` | Content script — DOM scanning, button clicking, human‑like delays |
| `popup.html` | Extension popup UI — progress bar, stats, log |
| `popup.js` | Popup logic — communicates with content script and background worker |

---

## Permissions Explained

| Permission | Why |
|---|---|
| `downloads` | To trigger downloads with clean filenames via `chrome.downloads.download()` |
| `tabs` | To query the active tab URL for the safety check |
| `activeTab` | To access the current tab's page when the popup is opened |
| `scripting` | To inject the content script into already‑open LinkedIn tabs |
| `host_permissions: linkedin.com` | Content script needs to run on LinkedIn pages |

---

## Disclaimer

This extension is provided **for educational and personal productivity purposes only**. Use it responsibly and in compliance with LinkedIn's Terms of Service. The authors are not responsible for any account restrictions resulting from misuse.
