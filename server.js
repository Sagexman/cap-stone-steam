// SteamPulse API server. Run it with: node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const STEAM_STORE = "https://store.steampowered.com";
const STEAM_API = "https://api.steampowered.com";

// --- tiny cache: stores { key -> { value, expires } } ---

const cache = new Map();

async function cached(key, ttl, load) {
    const hit = cache.get(key);
    if (hit && Date.now() < hit.expires) return hit.value;
    const value = await load();
    cache.set(key, { value, expires: Date.now() + ttl * 1000 });
    return value;
}

async function getSteamData(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Steam said " + response.status);
    return response.json();
}

// --- Steam data ---

const featured = () => cached("featured", 600, async () => {
    const home = await getSteamData(STEAM_STORE + "/api/featuredcategories/?cc=us&l=english");
    const data = home.categories || home;
    return {
        topSellers: data.top_sellers?.items ?? [],
        newReleases: data.new_releases?.items ?? [],
        comingSoon: data.coming_soon?.items ?? [],
    };
});

const appInfo = (appid) => cached("app:" + appid, 86400, async () => {
    const url = STEAM_STORE + "/api/appdetails/?appids=" + appid +
        "&l=english&cc=us&filters=basic,genres,release_date,price_overview,recommendations,developers";
    const entry = (await getSteamData(url))[appid];
    return entry && entry.success ? entry.data : null;
});

async function playerCount(appid) {
    const json = await getSteamData(STEAM_API + "/ISteamUserStats/GetNumberOfCurrentPlayers/v0001/?appid=" + appid);
    if (json.response && typeof json.response.player_count === "number") return json.response.player_count;
    return null;
}

// --- trends & coming soon ---

const genreNames = (info) => (info && info.genres ? info.genres.map((g) => g.description) : []);

function demandScore(genres, profile) {
    let score = 0;
    const why = [];
    for (const genre of genres) {
        for (const other of profile) {
            if (genre.toLowerCase() === other.name.toLowerCase()) {
                score += other.share;
                why.push(other.name);
            }
        }
    }
    return { score, why: why.slice(0, 3) };
}

async function buildTrends() {
    const lists = await featured();

    const rows = [];
    for (const [i, item] of lists.topSellers.entries()) rows.push({ id: item.id, weight: 2 / (i + 1) });
    for (const [i, item] of lists.newReleases.entries()) rows.push({ id: item.id, weight: 1 / (i + 1) });

    const totals = {};
    let surveyed = 0;

    for (const row of rows) {
        const info = await appInfo(row.id);
        if (!info || info.type !== "game" || !info.genres) continue;
        surveyed += 1;
        for (const genre of info.genres) {
            totals[genre.description] = (totals[genre.description] || 0) + row.weight;
        }
    }

    const genres = Object.keys(totals)
        .map((name) => ({ name, score: totals[name] }))
        .sort((a, b) => b.score - a.score);

    const total = genres.reduce((sum, g) => sum + g.score, 0) || 1;
    for (const g of genres) g.share = g.score / total;

    return { sources: ["steam"], surveyed, genres, at: Date.now() };
}

async function buildComingSoon(genres) {
    const items = [];
    for (const game of (await featured()).comingSoon) {
        const info = await appInfo(game.id);
        if (!info || info.type !== "game") continue;

        const names = genreNames(info);
        items.push({
            appid: info.steam_appid,
            name: info.name || game.name,
            img: info.header_image || game.header_image,
            date: info.release_date?.date || "",
            genres: names,
            match: demandScore(names, genres),
        });
    }
    return items.sort((a, b) => b.match.score - a.match.score);
}

const aggregate = () => cached("aggregate", 600, async () => {
    const trends = await buildTrends();
    return { trends, coming: await buildComingSoon(trends.genres) };
});

// --- watchlist saved to a file ---

const DATA_FOLDER = path.join(__dirname, "data");
const WATCHLIST_FILE = path.join(DATA_FOLDER, "watchlist.json");

let watchlist = [];
try {
    watchlist = JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf8"));
} catch {}

function saveWatchlist() {
    fs.mkdirSync(DATA_FOLDER, { recursive: true });
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2));
}

// --- small helpers ---

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (error) {
                reject(new Error("Bad JSON body"));
            }
        });
        request.on("error", reject);
    });
}

function sendJSON(response, status, body) {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
}

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

const parseAppIds = (text) =>
    String(text).split(",").map((id) => id.trim()).filter((id) => /^\d{1,10}$/.test(id));

// --- routes: [method, URL pattern, handler, success status] ---

const routes = [
    ["GET", /^\/api\/ping$/, () => ({ ok: true })],
    ["GET", /^\/api\/trends$/, async () => (await aggregate()).trends],
    ["GET", /^\/api\/coming$/, async () => {
        const data = await aggregate();
        return { sources: data.trends.sources, items: data.coming, at: data.trends.at };
    }],
    ["GET", /^\/api\/live$/, async (request) => {
        const appids = parseAppIds(new URL(request.url, "http://localhost").searchParams.get("appids") || "");
        if (appids.length === 0) throw httpError(400, "Missing appids");
        return cached("live:" + appids.join(","), 60, async () => {
            const players = {};
            for (const appid of appids) players[appid] = await playerCount(appid);
            return { at: Date.now(), players };
        });
    }],
    ["GET", /^\/api\/watchlist$/, () => ({ items: watchlist })],
    ["POST", /^\/api\/watchlist$/, async (request) => {
        const body = await readBody(request);
        const appid = String(body.appid || "").trim();
        if (!/^\d{1,10}$/.test(appid)) throw httpError(400, "App ID required");
        if (watchlist.some((item) => item.appid === appid)) throw httpError(409, "Already in the watchlist");

        const info = await appInfo(appid);
        if (!info || info.type !== "game") throw httpError(400, "Not a game");

        const item = {
            appid,
            name: info.name,
            img: info.header_image || "",
            note: String(body.note || "").trim().slice(0, 100),
            createdAt: Date.now(),
        };
        watchlist.push(item);
        saveWatchlist();
        return { item };
    }, 201],
    ["DELETE", /^\/api\/watchlist\/(\d{1,10})$/, async (request, match) => {
        if (!watchlist.some((item) => item.appid === match[1])) throw httpError(404, "Not on the watchlist");
        watchlist = watchlist.filter((item) => item.appid !== match[1]);
        saveWatchlist();
        return { ok: true };
    }],
    ["PUT", /^\/api\/watchlist\/(\d{1,10})$/, async (request, match) => {
        const item = watchlist.find((game) => game.appid === match[1]);
        if (!item) throw httpError(404, "Not on the watchlist");
        const body = await readBody(request);
        item.note = String(body.note || "").trim().slice(0, 100);
        saveWatchlist();
        return { item };
    }],
    ["GET", /^\/api\/apps\/(\d{1,10})$/, async (request, match) => {
        const info = await appInfo(match[1]);
        if (!info) throw httpError(404, "Not a Steam app");
        return { info };
    }],
];

const FILES = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
    "/script.js": ["script.js", "text/javascript; charset=utf-8"],
};

// --- the server ---

const server = http.createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    try {
        const pathname = new URL(request.url, "http://localhost").pathname;

        for (const [method, pattern, handler, status = 200] of routes) {
            const match = pattern.exec(pathname);
            if (request.method !== method || !match) continue;
            sendJSON(response, status, await handler(request, match));
            return;
        }

        const file = FILES[pathname];
        if (file) {
            fs.readFile(path.join(__dirname, file[0]), (error, data) => {
                if (error) return sendJSON(response, 404, { error: "Not found" });
                response.writeHead(200, { "Content-Type": file[1] });
                response.end(data);
            });
            return;
        }

        sendJSON(response, 404, { error: "Not found" });
    } catch (error) {
        sendJSON(response, error.status || 500, { error: error.message });
    }
});

server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
        console.log("Port " + PORT + " is already in use. Stop the other server, then run: node server.js");
        process.exit(1);
    } else {
        throw error;
    }
});

server.listen(PORT, () => {
    console.log("SteamPulse API on http://localhost:" + PORT);
});