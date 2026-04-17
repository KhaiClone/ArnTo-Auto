/**
 * CJS re-export of the core quest logic from main.js
 * We inline the necessary classes/functions here since main.js is ESM.
 */

const axios = require("axios");
const { Buffer } = require("buffer");

// ── Config ─────────────────────────────────────────────────────────────────────
const API_BASE = "https://discord.com/api/v9";
const POLL_INTERVAL = 60;
const HEARTBEAT_INTERVAL = 20;
const AUTO_ACCEPT = true;
const DEBUG = false;
const SUPPORTED_TASKS = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"];

// ── Colors ─────────────────────────────────────────────────────────────────────
const C = { RESET: "\x1b[0m", GREEN: "\x1b[92m", YELLOW: "\x1b[93m", RED: "\x1b[91m", CYAN: "\x1b[96m", BOLD: "\x1b[1m", DIM: "\x1b[2m" };

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function isUnauthorizedStatus(s) { return s === 401 || s === 403; }
function createUnauthorizedError(ctx, status) { const e = new Error(`${ctx} (${status})`); e.invalidToken = true; e.httpStatus = status; return e; }
function throwIfUnauthorized(res, ctx) { if (isUnauthorizedStatus(res?.status) || /unauthorized/i.test(res?.data?.message ?? "")) throw createUnauthorizedError(ctx, res?.status ?? 401); }

// ── Build number ───────────────────────────────────────────────────────────────
async function fetchLatestBuildNumber() {
    const FALLBACK = 504649;
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    try {
        const res = await axios.get("https://discord.com/app", { headers: { "User-Agent": ua }, timeout: 15000 });
        if (res.status !== 200) return FALLBACK;
        let hashes = [...res.data.matchAll(/\/assets\/([a-f0-9]+)\.js/g)].map((m) => m[1]);
        if (!hashes.length) return FALLBACK;
        for (const hash of hashes.slice(-5)) {
            try {
                const ar = await axios.get(`https://discord.com/assets/${hash}.js`, { headers: { "User-Agent": ua }, timeout: 15000 });
                const match = ar.data.match(/buildNumber["'\s:]+["'\s]*(\d{5,7})/);
                if (match) return parseInt(match[1], 10);
            } catch {}
        }
        return FALLBACK;
    } catch { return FALLBACK; }
}

function makeSuperProperties(buildNumber) {
    return Buffer.from(JSON.stringify({
        os: "Windows", browser: "Discord Client", release_channel: "stable",
        client_version: "1.0.9175", os_version: "10.0.26100", os_arch: "x64",
        app_arch: "x64", system_locale: "en-US",
        browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9175 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36",
        browser_version: "32.2.7", client_build_number: buildNumber,
        native_build_number: 59498, client_event_source: null,
    })).toString("base64");
}

// ── Discord API ────────────────────────────────────────────────────────────────
class DiscordAPI {
    constructor(token, buildNumber) {
        this.token = token;
        this.client = axios.create({
            baseURL: API_BASE,
            headers: {
                Authorization: token,
                "Content-Type": "application/json",
                Accept: "*/*",
                "Accept-Language": "en-US,en;q=0.9",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9175 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36",
                "X-Super-Properties": makeSuperProperties(buildNumber),
                "X-Discord-Locale": "en-US",
                "X-Discord-Timezone": "Asia/Ho_Chi_Minh",
                Origin: "https://discord.com",
                Referer: "https://discord.com/channels/@me",
            },
        });
    }
    async get(path) { return this.client.get(path, { validateStatus: () => true }); }
    async post(path, payload = null) { return this.client.post(path, payload, { validateStatus: () => true }); }
}

// ── Quest helpers ──────────────────────────────────────────────────────────────
function _get(d, ...keys) { if (!d) return undefined; for (const k of keys) if (k in d) return d[k]; return undefined; }
function getTaskConfig(q) { const c = q.config ?? {}; return _get(c, "taskConfig", "task_config", "taskConfigV2", "task_config_v2"); }
function getQuestName(q) {
    const c = q.config ?? {}, m = c.messages ?? {};
    const n = _get(m, "questName", "quest_name"); if (n) return n.trim();
    const g = _get(m, "gameTitle", "game_title"); if (g) return g.trim();
    return c.application?.name || `Quest#${q.id ?? "?"}`;
}
function getExpiresAt(q) { return _get(q.config ?? {}, "expiresAt", "expires_at"); }
function getUserStatus(q) { const us = _get(q, "userStatus", "user_status"); return us && typeof us === "object" ? us : {}; }
function isCompletable(q) {
    const exp = getExpiresAt(q); if (exp && new Date(exp) <= new Date()) return false;
    const tc = getTaskConfig(q); return tc?.tasks && SUPPORTED_TASKS.some((t) => tc.tasks[t] != null);
}
function isEnrolled(q) { return Boolean(_get(getUserStatus(q), "enrolledAt", "enrolled_at")); }
function isCompleted(q) { return Boolean(_get(getUserStatus(q), "completedAt", "completed_at")); }
function getTaskType(q) { const tc = getTaskConfig(q); return (tc?.tasks && SUPPORTED_TASKS.find((t) => tc.tasks[t] != null)) ?? null; }
function getSecondsNeeded(q) { const tc = getTaskConfig(q); const t = getTaskType(q); return (!tc || !t) ? 0 : tc.tasks[t]?.target ?? 0; }
function getSecondsDone(q) { const t = getTaskType(q); if (!t) return 0; return getUserStatus(q).progress?.[t]?.value ?? 0; }
function getEnrolledAt(q) { return _get(getUserStatus(q), "enrolledAt", "enrolled_at"); }

// ── QuestAutocompleter ─────────────────────────────────────────────────────────
class QuestAutocompleter {
    constructor(api) { this.api = api; this.completedIds = new Set(); }

    async fetchQuests() {
        try {
            const res = await this.api.get("/quests/@me");
            if (res.status === 200) {
                const d = res.data;
                if (Array.isArray(d)) return d;
                if (d && typeof d === "object") return d.quests ?? [];
                return [];
            }
            throwIfUnauthorized(res, "Token không hợp lệ khi lấy danh sách quest");
            if (res.status === 429) { await sleep(res.data?.retry_after ?? 10); return this.fetchQuests(); }
            return [];
        } catch (err) { if (err?.invalidToken) throw err; return []; }
    }

    async enrollQuest(quest) {
        const qid = quest.id;
        for (let i = 1; i <= 3; i++) {
            try {
                const res = await this.api.post(`/quests/${qid}/enroll`, { location: 11, is_targeted: false, metadata_raw: null, metadata_sealed: null });
                throwIfUnauthorized(res, `Token không hợp lệ khi nhận quest`);
                if (res.status === 429) { await sleep((res.data?.retry_after ?? 5) + 1); continue; }
                return [200, 201, 204].includes(res.status);
            } catch (err) { if (err?.invalidToken) throw err; return false; }
        }
        return false;
    }

    async autoAccept(quests) {
        if (!AUTO_ACCEPT) return quests;
        const unaccepted = quests.filter((q) => !isEnrolled(q) && !isCompleted(q) && isCompletable(q));
        if (!unaccepted.length) return quests;
        for (const q of unaccepted) { await this.enrollQuest(q); await sleep(3); }
        await sleep(2);
        return this.fetchQuests();
    }

    async completeVideo(quest) {
        const qid = quest.id, needed = getSecondsNeeded(quest);
        let done = getSecondsDone(quest);
        const enrolledTs = (getEnrolledAt(quest) ? new Date(getEnrolledAt(quest)).getTime() : Date.now()) / 1000;
        while (done < needed) {
            const maxAllowed = Date.now() / 1000 - enrolledTs + 10;
            if (maxAllowed - done >= 7) {
                try {
                    const res = await this.api.post(`/quests/${qid}/video-progress`, { timestamp: Math.min(needed, done + 7 + Math.random()) });
                    throwIfUnauthorized(res, "Token không hợp lệ");
                    if (res.status === 200) { if (res.data.completed_at) return; done = Math.min(needed, done + 7); }
                    else if (res.status === 429) { await sleep((res.data?.retry_after ?? 5) + 1); continue; }
                } catch (err) { if (err?.invalidToken) throw err; }
            }
            if (done + 7 >= needed) break;
            await sleep(1);
        }
        try { const res = await this.api.post(`/quests/${qid}/video-progress`, { timestamp: needed }); throwIfUnauthorized(res, "Token không hợp lệ"); } catch (err) { if (err?.invalidToken) throw err; }
    }

    async completeHeartbeat(quest) {
        const qid = quest.id, taskType = getTaskType(quest), needed = getSecondsNeeded(quest);
        let done = getSecondsDone(quest);
        const pid = Math.floor(Math.random() * 29000) + 1000;
        while (done < needed) {
            try {
                const res = await this.api.post(`/quests/${qid}/heartbeat`, { stream_key: `call:0:${pid}`, terminal: false });
                throwIfUnauthorized(res, "Token không hợp lệ");
                if (res.status === 200) { done = res.data.progress?.[taskType]?.value ?? done; if (res.data.completed_at || done >= needed) break; }
                else if (res.status === 429) { await sleep((res.data?.retry_after ?? 10) + 1); continue; }
            } catch (err) { if (err?.invalidToken) throw err; }
            await sleep(HEARTBEAT_INTERVAL);
        }
        try { const res = await this.api.post(`/quests/${qid}/heartbeat`, { stream_key: `call:0:${pid}`, terminal: true }); throwIfUnauthorized(res, "Token không hợp lệ"); } catch (err) { if (err?.invalidToken) throw err; }
    }

    async completeActivity(quest) {
        const qid = quest.id, needed = getSecondsNeeded(quest);
        let done = getSecondsDone(quest);
        while (done < needed) {
            try {
                const res = await this.api.post(`/quests/${qid}/heartbeat`, { stream_key: "call:0:1", terminal: false });
                throwIfUnauthorized(res, "Token không hợp lệ");
                if (res.status === 200) { done = res.data.progress?.PLAY_ACTIVITY?.value ?? done; if (res.data.completed_at || done >= needed) break; }
                else if (res.status === 429) { await sleep((res.data?.retry_after ?? 10) + 1); continue; }
            } catch (err) { if (err?.invalidToken) throw err; }
            await sleep(HEARTBEAT_INTERVAL);
        }
        try { const res = await this.api.post(`/quests/${qid}/heartbeat`, { stream_key: "call:0:1", terminal: true }); throwIfUnauthorized(res, "Token không hợp lệ"); } catch (err) { if (err?.invalidToken) throw err; }
    }

    async processQuest(quest) {
        const taskType = getTaskType(quest);
        if (!taskType || this.completedIds.has(quest.id)) return;
        if (["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE"].includes(taskType)) await this.completeVideo(quest);
        else if (["PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP"].includes(taskType)) await this.completeHeartbeat(quest);
        else if (taskType === "PLAY_ACTIVITY") await this.completeActivity(quest);
        this.completedIds.add(quest.id);
    }
}

module.exports = { DiscordAPI, QuestAutocompleter, fetchLatestBuildNumber, C };
