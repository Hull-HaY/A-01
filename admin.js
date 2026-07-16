import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, onValue, set, push, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

const firebaseConfig = {
    apiKey: "AIzaSyDAq_LdMur6TizliELlrrT0NFCTC1F7K8g",
    authDomain: "causelist-98e7b.firebaseapp.com",
    databaseURL: "https://causelist-98e7b-default-rtdb.firebaseio.com/",
    projectId: "causelist-98e7b",
    storageBucket: "causelist-98e7b.firebasestorage.app",
    messagingSenderId: "610909892107",
    appId: "1:610909892107:web:119b5ccba217f1c070610e",
    measurementId: "G-540D56WGM2"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const ADMIN_PASSCODE_SHA256 = "78d9cf3fcd250f32f46f6f76bb504e1b573e8ee047eba76d3a4f8c46a377ff5d";

const uploadInput = document.getElementById("pdfUpload");
const uploadStatus = document.getElementById("uploadStatus");
const newUploadBtn = document.getElementById("newUploadBtn");
const addMoreBtn = document.getElementById("addMoreBtn");
const clearDataBtn = document.getElementById("clearDataBtn");
const announcementInput = document.getElementById("announcementInput");
const postAnnouncementBtn = document.getElementById("postAnnouncementBtn");
const newsList = document.getElementById("newsList");

let currentAnnouncements = {};
let currentMatters = [];
let uploadMode = "replace"; // "replace" or "append"

// Sync current matters for appending
onValue(ref(db, 'publishedData/matters'), (snap) => {
    currentMatters = snap.val() || [];
});

async function sha256(value) {
    const data = new TextEncoder().encode(value);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function enforceAdminPasscode() {
    const pass = prompt("Admin passcode required:");
    if (!pass) {
        document.body.innerHTML = "<h1 style='color:white; text-align:center; margin-top:100px;'>Unauthorized Access</h1>";
        return;
    }
    const enteredHash = await sha256(pass);
    if (enteredHash !== ADMIN_PASSCODE_SHA256) {
        alert("Unauthorized.");
        document.body.innerHTML = "<h1 style='color:white; text-align:center; margin-top:100px;'>Unauthorized Access</h1>";
    }
}

enforceAdminPasscode();

// --- PDF PROCESSING ---
uploadInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    uploadStatus.innerText = `Reading ${files.length} PDF file(s)...`;
    const mergedData = [];
    const failedFiles = [];

    for (let index = 0; index < files.length; index++) {
        const file = files[index];
        uploadStatus.innerText = `Parsing file ${index + 1}/${files.length}: ${file.name}`;
        try {
            const text = await extractPdfText(file);
            mergedData.push(
                ...parseCauseListText(text).map((item) => ({
                    ...item,
                    sourceFile: file.name
                }))
            );
        } catch (error) {
            console.error(`PDF parse failed (${file.name}):`, error);
            failedFiles.push(file.name);
        }
    }

    if (mergedData.length === 0) {
        uploadStatus.innerText = `Parsed 0/${files.length}. Failed: ${failedFiles.length}`;
        return;
    }

    let finalData = mergedData;
    if (uploadMode === "append") {
        finalData = [...currentMatters, ...mergedData];
        console.log(`Appending ${mergedData.length} new matters to existing ${currentMatters.length}.`);
    }

    publishMatters(finalData);
    const parsedFiles = files.length - failedFiles.length;
    uploadStatus.innerText = `${uploadMode === "append" ? "Added" : "Published"} ${mergedData.length} matters from ${parsedFiles}/${files.length} files. Total: ${finalData.length}`;
    
    // Reset input so the same file can be selected again if needed
    uploadInput.value = "";
});

newUploadBtn.addEventListener("click", () => {
    uploadMode = "replace";
    uploadInput.click();
});

addMoreBtn.addEventListener("click", () => {
    uploadMode = "append";
    uploadInput.click();
});

async function extractPdfText(file) {
    const buffer = await file.arrayBuffer();
    const typedData = new Uint8Array(buffer);
    let pdf = await pdfjsLib.getDocument({ data: typedData }).promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const lines = rebuildLinesFromTextItems(content.items);
        pages.push(lines.join("\n"));
    }
    return pages.join("\n");
}

function rebuildLinesFromTextItems(items) {
    const byY = new Map();
    items.forEach((item) => {
        const y = Math.round(item.transform[5] * 10) / 10;
        const x = item.transform[4];
        if (!byY.has(y)) byY.set(y, []);
        byY.get(y).push({ x, str: item.str });
    });
    return [...byY.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, row]) => row.sort((a, b) => a.x - b.x).map((r) => r.str).join(" ").replace(/\s+/g, " ").trim())
        .filter(Boolean);
}

// Map a case-number prefix to a tribunal name. This is the most reliable
// per-matter signal, so it is preferred when available.
// e.g. NAIROBI_RRC/783/2019 -> RRT, BPR/E123/2024 -> BPRT, TATC/E1138/2025 -> TAT
const CASE_PREFIX_MAP = {
    RRC: "RRT",
    RRT: "RRT",
    BPR: "BPRT",
    BPRT: "BPRT",
    BPRC: "BPRT",
    TAT: "TAT",
    TATC: "TAT",
};

function tribunalFromCaseNo(caseNo) {
    if (!caseNo) return "";
    const cleaned = caseNo.toUpperCase();
    const prefixMatch = cleaned.match(/([A-Z]{2,6})\/[A-Z]?\d+\/\d{4}/);
    const prefix = prefixMatch ? prefixMatch[1] : "";
    return CASE_PREFIX_MAP[prefix] || "";
}

// Known tribunal abbreviations that may legitimately appear on a header line.
const KNOWN_TRIBUNAL_TOKENS = new Set(["TAT", "RRT", "BPRT"]);

// Strictly validate a header token as a tribunal NAME.
// Returns a normalized name only when the text is a recognized tribunal;
// returns "" for dates, officers, "CAUSE LIST", plain content, etc.
// This prevents a repeated "MILIMANI HIGH COURT" header (whose 2nd line is
// NOT a tribunal name) from hijacking the heading.
function normalizeTribunalName(raw) {
    if (!raw) return "";
    const upper = raw.toUpperCase().trim();

    // Descriptive phrases -> canonical abbreviations.
    if (upper.includes("RENT RESTRICTION")) return "RRT";
    if (upper.includes("BUSINESS PREMISES")) return "BPRT";
    if (upper.includes("TAX APPEAL")) return "TAT";

    // Reject obvious non-names.
    if (upper === "TRIBUNAL" || upper === "CAUSE LIST" || upper.includes("HIGH COURT")) return "";
    if (upper.includes("HON.") || /^(MR|MRS|MS|DR)\.\s/.test(upper)) return "";      // officer line
    if (/\d{4}/.test(upper)) return "";                                              // dates / case numbers
    if (/^[A-Z]+,\s+\d/.test(upper)) return "";                                      // "MONDAY, 04 ..."

    // Strip a trailing generic "TRIBUNAL" word: "TAT TRIBUNAL" -> "TAT".
    const candidate = raw.replace(/\s+TRIBUNAL\s*$/i, "").trim();
    const candUpper = candidate.toUpperCase();

    // Accept only recognized abbreviations (short tokens) or descriptive
    // phrases that clearly name a tribunal. Anything else is treated as content.
    if (KNOWN_TRIBUNAL_TOKENS.has(candUpper)) return candUpper;
    if (candUpper.includes("TRIBUNAL")) return candidate; // e.g. "SOMETHING TRIBUNAL"

    return "";
}

// Clean an assembled officer string: strip a trailing court-room marker
// (e.g. "... HON. JIMMY MALLA COURTROOM 1" -> "... HON. JIMMY MALLA")
// and tidy stray separators/whitespace.
function cleanOfficer(raw) {
    return raw
        .replace(/\s+COURT\s*ROOM\s*\d+.*$/i, "")
        .replace(/\s+COURTROOM\s*\d+.*$/i, "")
        .replace(/\s+/g, " ")
        .replace(/[,;]\s*$/, "")
        .trim();
}

function parseCauseListText(fullText) {
    const lines = fullText.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
    let currentDate = "", currentTribunal = "", currentOfficer = "", currentTime = "", currentMatterType = "";
    const allData = [];
    const strictCasePattern = /\b([A-Z0-9_/-]+\/[A-Z]?\d+\/\d{4})\b/i;
    const fallbackCasePattern = /^([A-Z0-9_/-]{4,})\s+/i;
    const numberedLinePattern = /^\d+\./;

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const upperLine = line.toUpperCase();
        // --- Tribunal detection (option A: from header text) ---
        // Explicit "Tribunal: X" label.
        if (line.match(/^Tribunal:\s*(.+)$/i)) {
            const name = normalizeTribunalName(line.match(/^Tribunal:\s*(.+)$/i)[1]);
            if (name) currentTribunal = name;
            i++; continue;
        }
        // "MILIMANI HIGH COURT" is ignored; the tribunal name is the next real line
        // (e.g. "TAT"), skipping the generic word "TRIBUNAL" and "CAUSE LIST".
        if (upperLine.includes("HIGH COURT")) {
            // Try same-line suffix first (e.g. "MILIMANI HIGH COURT - RENT RESTRICTION TRIBUNAL").
            const inline = line.match(/HIGH COURT\s*[-–]\s*(.+)/i);
            let name = inline ? normalizeTribunalName(inline[1]) : "";
            // Otherwise look at the following lines for the first real name.
            let k = i + 1;
            while (!name && k < lines.length && k <= i + 3) {
                const candidate = normalizeTribunalName(lines[k]);
                if (candidate) { name = candidate; break; }
                // Stop scanning once we hit content that clearly isn't a header token.
                if (/^\d+\./.test(lines[k]) || /^[A-Z]+,\s+\d/.test(lines[k])) break;
                k++;
            }
            if (name) currentTribunal = name;
            i++; continue;
        }

        if (line.match(/^[A-Z]+,\s+\d{1,2}\s+[A-Z]+\s+\d{4}$/)) { currentDate = line; i++; continue; }
        if (line.match(/^\d{1,2}:\d{2}\s?(AM|PM)$/i)) { currentTime = line.toUpperCase(); i++; continue; }
        if (line.match(/^(HEARING|MENTION|RULING|JUDGMENT|JUDGEMENT)$/i)) { currentMatterType = line.toUpperCase(); i++; continue; }
        if (line.includes("HON.") || line.match(/^(MR|MRS|MS|DR)\.\s/i)) {
            // Officer lists may wrap across several lines, e.g.:
            //   "HON. A, HON. B, HON. GLORIA"
            //   "AWUOR OGAGA, HON. JIMMY MALLA COURTROOM 1"
            // Collect the current line plus continuation lines until we hit a
            // date/time/matter-type/case-number/tribunal boundary.
            const officerParts = [line];
            let k = i + 1;
            while (k < lines.length) {
                const next = lines[k];
                if (
                    numberedLinePattern.test(next) ||
                    /^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(next) ||
                    /^(HEARING|MENTION|RULING|JUDGMENT|JUDGEMENT)$/i.test(next) ||
                    /^[A-Z]+,\s+\d{1,2}\s+[A-Z]+\s+\d{4}$/.test(next) ||
                    /^Tribunal:/i.test(next) ||
                    next.toUpperCase().includes("HIGH COURT")
                ) break;
                officerParts.push(next);
                // Stop after absorbing a line that ends with the court-room marker.
                if (/COURT\s*ROOM\s*\d+/i.test(next) || /COURTROOM\s*\d+/i.test(next)) { k++; break; }
                k++;
            }
            const cleaned = cleanOfficer(officerParts.join(" "));
            if (cleaned) currentOfficer = cleaned;
            i = k; continue;
        }
        if (!numberedLinePattern.test(line)) { i++; continue; }

        const matterLines = [line];
        let j = i + 1;
        const stopContinuation = (l) =>
            /^(HEARING|MENTION|RULING|JUDGMENT|JUDGEMENT|Tribunal:)/i.test(l) ||
            l.includes("HON.") ||
            /^(MR|MRS|MS|DR)\.\s/i.test(l) ||
            /^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(l) ||
            l.toUpperCase().includes("HIGH COURT");
        while (j < lines.length && !numberedLinePattern.test(lines[j]) && !stopContinuation(lines[j])) {
            matterLines.push(lines[j]); j++;
        }
        const fullMatterLine = matterLines.join(" ").replace(/^\d+\.\s+/, "").trim();
        const caseNoMatch = fullMatterLine.match(strictCasePattern) || fullMatterLine.match(fallbackCasePattern);
        const caseNo = caseNoMatch ? caseNoMatch[1] : "N/A";
        // Tribunal resolution priority:
        //  1) case-number prefix (most reliable per-matter signal; e.g. TATC -> TAT)
        //  2) tribunal name detected from a valid header line
        //  3) hard default
        // Preferring the case number prevents a repeated/incomplete header from
        // mislabelling matters that clearly belong to a specific tribunal.
        const tribunal = tribunalFromCaseNo(caseNo) || currentTribunal || "BPRT";
        allData.push({
            date: currentDate, tribunal, officer: currentOfficer || "HON. -",
            matterType: currentMatterType || "UNSPECIFIED", caseNo, caseLine: fullMatterLine,
            proceedings: fullMatterLine.replace(caseNo, "").trim() || "-", time: currentTime || "-"
        });
        i = j;
    }
    return allData;
}

function publishMatters(matters) {
    set(ref(db, 'publishedData'), { publishedAt: serverTimestamp(), matters }).catch(err => {
        alert("Publish failed. Check permissions.");
    });
}

clearDataBtn.addEventListener("click", () => {
    if (confirm("Clear all published matters?")) {
        set(ref(db, 'publishedData'), null).then(() => alert("Cleared."));
    }
});

// --- NEWS MANAGEMENT ---
function renderAdminNewsList() {
    const keys = Object.keys(currentAnnouncements);
    newsList.innerHTML = keys.length ? "" : "<p class='news-list-empty'>No active news.</p>";
    keys.forEach(key => {
        const li = document.createElement("li");
        li.className = "news-item-row";
        li.innerHTML = `<span class="news-item-text">${currentAnnouncements[key]}</span>
                        <button class="delete-news-btn" data-key="${key}">Delete</button>`;
        li.querySelector(".delete-news-btn").onclick = () => set(ref(db, `announcements/${key}`), null);
        newsList.appendChild(li);
    });
}

onValue(ref(db, 'announcements'), (snap) => {
    currentAnnouncements = snap.val() || {};
    renderAdminNewsList();
});

postAnnouncementBtn.addEventListener("click", () => {
    const text = announcementInput.value.trim();
    if (text) push(ref(db, 'announcements'), text).then(() => announcementInput.value = "");
});
