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

const ADMIN_PASSCODE_SHA256 = "c2d33f0eaceab8076bb22fedc1c75ccfa616e9a055c9b176bdf88e781af9f71f";

const uploadInput = document.getElementById("pdfUpload");
const uploadStatus = document.getElementById("uploadStatus");
const clearDataBtn = document.getElementById("clearDataBtn");
const announcementInput = document.getElementById("announcementInput");
const postAnnouncementBtn = document.getElementById("postAnnouncementBtn");
const newsList = document.getElementById("newsList");

let currentAnnouncements = {};

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

    publishMatters(mergedData);
    const parsedFiles = files.length - failedFiles.length;
    uploadStatus.innerText = `Published ${mergedData.length} matters from ${parsedFiles}/${files.length} files.`;
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
        if (line.match(/^Tribunal:\s*(.+)$/i)) { currentTribunal = line.match(/^Tribunal:\s*(.+)$/i)[1].trim(); i++; continue; }
        if (line.match(/^[A-Z]+,\s+\d{1,2}\s+[A-Z]+\s+\d{4}$/)) { currentDate = line; i++; continue; }
        if (line.match(/^\d{1,2}:\d{2}\s?(AM|PM)$/i)) { currentTime = line.toUpperCase(); i++; continue; }
        if (line.match(/^(HEARING|MENTION)$/i)) { currentMatterType = line.toUpperCase(); i++; continue; }
        if (line.includes("HON.")) { currentOfficer = line.match(/(HON\.\s*.+?)(?:\s+COURT\b|$)/i)[1].trim(); i++; continue; }
        if (!numberedLinePattern.test(line)) { i++; continue; }

        const matterLines = [line];
        let j = i + 1;
        while (j < lines.length && !numberedLinePattern.test(lines[j]) && !lines[j].match(/^(HEARING|MENTION|Tribunal:)/i)) {
            matterLines.push(lines[j]); j++;
        }
        const fullMatterLine = matterLines.join(" ").replace(/^\d+\.\s+/, "").trim();
        const caseNoMatch = fullMatterLine.match(strictCasePattern) || fullMatterLine.match(fallbackCasePattern);
        const caseNo = caseNoMatch ? caseNoMatch[1] : "N/A";
        allData.push({
            date: currentDate, tribunal: currentTribunal || "BPRT", officer: currentOfficer || "HON. -",
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
