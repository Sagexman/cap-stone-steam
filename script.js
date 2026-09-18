// SteamPulse.
// The page gets data from server.js, which talks to Steam.

const POLL_MS = 60 * 1000;
const MAX_HISTORY = 60;

const statusBox = document.getElementById("status");
const statusMsg = document.getElementById("statusMsg");
const spinner = document.getElementById("spinner");

const trendSection = document.getElementById("trendSection");
const trendMeta = document.getElementById("trendMeta");
const trendBars = document.getElementById("trendBars");

const liveSection = document.getElementById("liveSection");
const liveMeta = document.getElementById("liveMeta");
const trackerGrid = document.getElementById("trackerGrid");
const trackAppIdEl = document.getElementById("trackAppId");
const trackNoteEl = document.getElementById("trackNote");
const trackBtn = document.getElementById("trackBtn");

const comingSection = document.getElementById("comingSection");
const comingMeta = document.getElementById("comingMeta");
const comingGrid = document.getElementById("comingGrid");

const state = {
    genreDemand: [],
    surveyed: 0,
    tracked: [],
    coming: [],
    sources: [],
    timer: null,
    busy: false,
    lastTick: 0,
};

// --- small helpers ---

function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[ch]));
}

function say(message, busy) {
    statusBox.classList.remove("hidden");
    statusMsg.textContent = message;
    spinner.style.display = busy ? "block" : "none";
}

async function api(url, options) {
    const response = await fetch(url, options);
    let data = null;
    try {
        data = await response.json();
    } catch {}
    if (!response.ok) {
        throw new Error((data && data.error) || "API said " + response.status);
    }
    return data;
}

// Guess the next player count: the average of the last few numbers we have.
function nextHourEstimate(history) {
    if (history.length < 3) return null;
    const recent = history.slice(-3);
    return Math.round(recent.reduce((sum, n) => sum + n, 0) / recent.length);
}

// Draws a small line graph of a game's player history.
function makeSparkline(history) {
    if (history.length < 2) return "";

    const W = 120;
    const H = 32;
    const max = Math.max(1, ...history);
    const step = W / (history.length - 1);

    const points = history.map((n, i) => {
        const x = i * step;
        const y = H - Math.max(2, (n / max) * (H - 4));
        return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");

    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${points}"/></svg>`;
}

function cardImage(src, cls, alt) {
    return src
        ? `<img class="${cls}" src="${src}" alt="${alt}" loading="lazy">`
        : `<div class="${cls} placeholder">?</div>`;
}

const makeItem = (w) => ({
    appid: w.appid,
    name: w.name,
    img: w.img || "",
    note: w.note || "",
    count: null,
    history: [],
});

// --- drawing each section ---

function drawTrendBars() {
    const top = state.genreDemand.slice(0, 8);

    if (top.length === 0) {
        trendBars.innerHTML = '<p class="muted">No genre data came back.</p>';
        return;
    }

    const best = top[0].score;

    trendBars.innerHTML = top.map((genre) => `
        <div class="trend-row">
            <div class="trend-name">${esc(genre.name)}</div>
            <div class="trend-track"><div class="trend-fill" style="width:${Math.max(3, Math.round((genre.score / best) * 100))}%"></div></div>
            <div class="trend-pct">${Math.round(genre.share * 100)}%</div>
        </div>`).join("");

    trendMeta.textContent = state.surveyed + " games surveyed from " + state.sources.join(" + ");
}

function drawTracked() {
    if (state.tracked.length === 0) {
        trackerGrid.innerHTML = '<p class="muted">Your watchlist is empty. Add a game by App ID below.</p>';
        return;
    }

    trackerGrid.innerHTML = state.tracked.map((t) => `
        <div class="tracker-card" id="tcard-${t.appid}">
            <button class="tracker-remove" data-remove="${t.appid}" title="Remove">✕</button>
            ${cardImage(t.img, "tracker-img", "")}
            <div class="tracker-body">
                <div class="tracker-name"><a href="https://store.steampowered.com/app/${t.appid}/" target="_blank" rel="noopener">${esc(t.name)}</a></div>
                <div class="tracker-count" id="tcount-${t.appid}">…</div>
                <div class="tracker-sub">playing now</div>
                <div class="pulse-spark" id="tspark-${t.appid}"></div>
                <div class="tracker-pred" id="tpred-${t.appid}"></div>
                <input class="tracker-note" data-note="${t.appid}" value="${esc(t.note)}" placeholder="note (optional)">
            </div>
        </div>`).join("");

    drawLiveCounts();
}

function drawLiveCounts() {
    for (const t of state.tracked) {
        const countEl = document.getElementById("tcount-" + t.appid);
        const sparkEl = document.getElementById("tspark-" + t.appid);
        const predEl = document.getElementById("tpred-" + t.appid);

        if (countEl) {
            countEl.textContent = t.count === null ? "—" : t.count.toLocaleString();
        }

        if (sparkEl) {
            sparkEl.innerHTML = makeSparkline(t.history);
        }

        if (predEl) {
            const guess = nextHourEstimate(t.history);
            predEl.textContent = guess === null ? "warming up…" : "next hour ~" + guess.toLocaleString();
            predEl.className = guess === null ? "tracker-pred" : "tracker-pred has";
        }
    }

    liveMeta.textContent = state.lastTick === 0
        ? "polls every 60s"
        : `updated ${Math.round((Date.now() - state.lastTick) / 1000)}s ago · polls every 60s`;
}

function drawComing() {
    if (state.coming.length === 0) {
        comingGrid.innerHTML = '<p class="muted">No coming-soon games came back.</p>';
        return;
    }

    const maxScore = Math.max(1, ...state.coming.map((g) => g.match.score));

    comingGrid.innerHTML = state.coming.map((game, k) => {
        const width = Math.max(3, Math.round((game.match.score / maxScore) * 100));
        const why = game.match.why.length > 0
            ? "Matches demand in: " + game.match.why.map(esc).join(", ") + "."
            : "Sits outside today's hot genres.";
        let meta = esc(game.date);
        if (game.genres.length > 0) {
            meta += " · " + esc(game.genres.slice(0, 3).join(", "));
        }

        return `
        <a class="coming-card" href="https://store.steampowered.com/app/${game.appid}/" target="_blank" rel="noopener">
            <div class="coming-rank">${k + 1}</div>
            ${cardImage(game.img, "coming-img", esc(game.name))}
            <div class="coming-body">
                <div class="coming-title">${esc(game.name)}</div>
                <div class="coming-meta">${meta}</div>
                <div class="coming-track"><div class="coming-fill" style="width:${width}%"></div></div>
                <div class="coming-why muted">${why}</div>
            </div>
        </a>`;
    }).join("");

    comingMeta.textContent = "ranked by predicted demand";
}

// --- live player counts ---

async function refreshCounts() {
    if (state.busy || state.tracked.length === 0) return;
    state.busy = true;

    try {
        const ids = state.tracked.map((t) => t.appid).join(",");
        const json = await api("/api/live?appids=" + ids);
        const players = json.players || {};

        for (const t of state.tracked) {
            if (typeof players[t.appid] === "number") {
                t.count = players[t.appid];
                t.history.push(t.count);
                if (t.history.length > MAX_HISTORY) t.history.shift();
            }
        }

        state.lastTick = Date.now();
        drawLiveCounts();
    } finally {
        state.busy = false;
    }
}

// --- watchlist create, update, delete ---

async function addTracked(appid, note) {
    const id = String(appid == null ? "" : appid).trim();
    const noteText = String(note == null ? "" : note).trim();

    if (!/^\d{1,10}$/.test(id)) {
        liveMeta.textContent = "Enter a numeric App ID.";
        return;
    }

    if (state.tracked.some((t) => t.appid === id)) {
        liveMeta.textContent = "Already tracking that game.";
        return;
    }

    try {
        const json = await api("/api/watchlist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ appid: id, note: noteText }),
        });

        state.tracked.push(makeItem(json.item));

        trackAppIdEl.value = "";
        trackNoteEl.value = "";
        drawTracked();
        liveMeta.textContent = "Added to watchlist";
        await refreshCounts();
    } catch (error) {
        liveMeta.textContent = "Add failed: " + error.message;
    }
}

async function removeItem(appid) {
    try {
        await api("/api/watchlist/" + appid, { method: "DELETE" });
    } catch (error) {
        liveMeta.textContent = "Delete failed: " + error.message;
        return;
    }

    state.tracked = state.tracked.filter((t) => t.appid !== appid);
    drawTracked();
    liveMeta.textContent = "Removed from watchlist";
}

async function updateNote(appid, note, input) {
    const newNote = String(note == null ? "" : note).trim();
    const oldNote = state.tracked.find((t) => t.appid === appid)?.note || "";
    if (newNote === oldNote) return;

    try {
        const json = await api("/api/watchlist/" + appid, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ note: newNote }),
        });

        const item = state.tracked.find((t) => t.appid === appid);
        if (item) item.note = json.item.note;

        liveMeta.textContent = "Note saved";
    } catch (error) {
        liveMeta.textContent = "Note failed: " + error.message;
        if (input) input.value = oldNote;
    }
}

trackerGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove]");
    if (button) removeItem(button.dataset.remove);
});

trackerGrid.addEventListener("change", (event) => {
    if (event.target.hasAttribute("data-note")) {
        updateNote(event.target.dataset.note, event.target.value, event.target);
    }
});

trackerGrid.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.hasAttribute("data-note")) {
        event.target.blur();
    }
});

//  loads each part of the page 

async function loadTrends() {
    try {
        const json = await api("/api/trends");
        state.genreDemand = json.genres || [];
        state.surveyed = json.surveyed || 0;
        state.sources = json.sources || [];
        drawTrendBars();
    } catch (error) {
        trendBars.innerHTML = '<p class="muted">Trends failed: ' + esc(error.message) + ".</p>";
    }
    trendSection.classList.remove("hidden");
}

async function loadComing() {
    try {
        const json = await api("/api/coming");
        state.coming = json.items || [];
        drawComing();
    } catch (error) {
        comingGrid.innerHTML = '<p class="muted">Coming soon failed: ' + esc(error.message) + ".</p>";
    }
    comingSection.classList.remove("hidden");
}

async function loadWatchlist() {
    const json = await api("/api/watchlist");
    state.tracked = json.items.map(makeItem);
}

async function loadLive() {
    try {
        await loadWatchlist();
        drawTracked();
        await refreshCounts();

        state.timer = setInterval(() => {
            refreshCounts().catch(() => {});
        }, POLL_MS);
    } catch (error) {
        liveMeta.textContent = "Live tracking failed: " + error.message;
    }
    liveSection.classList.remove("hidden");
}

async function ping() {
    let response;

    try {
        response = await fetch("/api/ping");
    } catch (error) {
        throw new Error("Can't reach the API. Run `node server.js` in this folder, then open http://localhost:3000");
    }

    if (response.status === 404) {
        throw new Error("A plain file server is answering, not SteamPulse. Something else holds the port — stop it, then run `node server.js`");
    }

    if (!response.ok) {
        throw new Error("API said " + response.status);
    }
}

async function load() {
    if (location.protocol === "file:") {
        say("Don't open index.html directly. Run `node server.js` in this folder, then open http://localhost:3000", false);
        return;
    }

    for (const section of [trendSection, liveSection, comingSection]) section.classList.add("hidden");

    if (state.timer !== null) {
        clearInterval(state.timer);
        state.timer = null;
    }

    state.tracked = [];
    state.coming = [];

    try {
        say("Pinging SteamPulse API...", true);
        await ping();
    } catch (error) {
        say(error.message, false);
        return;
    }

    say("Pulling store trends...", true);
    await loadTrends();

    say("Pulling coming soon...", true);
    await loadComing();

    say("Loading watchlist...", true);
    await loadLive();

    statusBox.classList.add("hidden");
}

trackBtn.onclick = () => addTracked(trackAppIdEl.value, trackNoteEl.value);

document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.target === trackAppIdEl || event.target === trackNoteEl)) {
        trackBtn.click();
    }
});

load();