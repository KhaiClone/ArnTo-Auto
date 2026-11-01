/**
 * questFeed.js
 * Auto Quest in the order feed (functions/orderFeed.js): one message per single
 * order and one per monthly pass, listing every quest — ⏳ waiting, ✅ done, ⏭️ not
 * done when the run ended — with the progress and the order's state. Replaces the
 * old "one message per finished quest" notices.
 *
 * Fed by the panel's quest events (functions/panelQuestEvent.js): run_start (every
 * quest a run is about to do), quest_done (with questId), status done / token_dead /
 * error / stopped, removed and — for a monthly pass — run_end. A monthly pass names
 * itself with runId, so the run again after an egress retry lands in the same
 * message. The local fallback runner (extensions/AutoQuest.js) feeds the same
 * functions from events/discord/client/ready.js, without ids.
 *
 * Events may arrive out of order (each is its own bus message): a quest_done after
 * the order's end still ticks its line off, and an end never undoes "done".
 *
 * Entries live in client.db "quest_feed" ({ key → entry }); quick.db rewrites the
 * whole key per write, so every change goes through one chain.
 */

const orderFeed = require("./orderFeed");

const DB_KEY = "quest_feed";
const DAY = 24 * 60 * 60 * 1000;
const KEEP_ENDED_MS = 7 * DAY;
const KEEP_OPEN_MS = 35 * DAY;
// A single order's quest_done this soon after its end still belongs to it; later,
// it is a new order on the same account (one whose run_start never came). Same for
// a run_start after an admin's Stop: soon = resumed, later = a new order.
const LATE_MS = 15 * 60 * 1000;
const LIST_MAX = 3900; // embed description limit is 4096

let _chain = Promise.resolve();
const _serial = (fn) => {
    const run = _chain.then(fn, fn);
    _chain = run.catch(() => {});
    return run;
};

// ── Look ───────────────────────────────────────────────────────────────────────

const STATE = {
    running: { text: "⏳ Đang chạy", color: 0xf39c12 },
    done: { text: "✅ Hoàn tất", color: 0x57f287 },
    paused: { text: "⏸️ Chờ nhập lại token", color: 0xfee75c },
    error: { text: "⚠️ Tạm dừng do lỗi — admin sẽ xử lý", color: 0xed4245 },
    stopped: { text: "🚫 Đã dừng", color: 0x95a5a6 },
};
const ICON = { wait: "⏳", done: "✅", skip: "⏭️" };
const OPEN = new Set(["running", "paused", "error"]);

const trunc = (s, n) => {
    s = String(s ?? "");
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const vnDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }); // 2026-11-04
// en-GB, not vi-VN: ICU builds disagree on vi-VN's separator ("01/11" vs "01-11").
const vnShort = (ms) =>
    new Date(ms).toLocaleDateString("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit" }); // 04/11

function _list(lines) {
    const out = [];
    let len = 0;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const s = `${ICON[l.state] ?? ICON.wait} **${trunc(l.name, 100)}**${l.taskType ? ` · \`${l.taskType}\`` : ""}`;
        if (len + s.length + 1 > LIST_MAX) {
            out.push(`… và ${lines.length - i} quest nữa`);
            break;
        }
        out.push(s);
        len += s.length + 1;
    }
    return out.join("\n");
}

function buildEmbed(client, e) {
    const st = STATE[e.state] ?? STATE.running;
    const done = e.lines.filter((l) => l.state === "done").length;
    return client.embed(_list(e.lines), {
        title: e.plan === "monthly" ? `♾️ Quest tháng · lượt ${vnShort(e.startedAt)}` : "⚡ Quest lẻ",
        color: st.color,
        fields: [
            { name: "👤 Khách hàng", value: `<@${e.userId}>`, inline: true },
            { name: "🎮 Account", value: e.username ? `**${e.username}**` : `\`${e.accountId ?? "?"}\``, inline: true },
            { name: "📋 Tiến độ", value: `**${done}/${e.lines.length}** quest`, inline: true },
            { name: "📌 Trạng thái", value: st.text, inline: false },
        ],
        footer: { text: `QUEST • ${e.accountId ?? "—"}` },
        timestamp: true,
    });
}

// ── Storage ────────────────────────────────────────────────────────────────────

async function _all(client) {
    return (await client.db.get(DB_KEY)) ?? {};
}

async function _saveAll(client, all) {
    const now = Date.now();
    for (const [k, e] of Object.entries(all)) {
        if (now - (e.updatedAt || 0) > (OPEN.has(e.state) ? KEEP_OPEN_MS : KEEP_ENDED_MS)) delete all[k];
    }
    await client.db.set(DB_KEY, all);
}

const singleKey = (userId, accountId) => `single:${userId}:${accountId}`;
const monthlyKey = (accountId, runId) => `monthly:${accountId}:${runId || vnDay(Date.now())}`;

/** The account's latest monthly entry still open (for events without a runId). */
function _openMonthly(all, accountId) {
    return Object.entries(all)
        .filter(([k, e]) => k.startsWith(`monthly:${accountId}:`) && OPEN.has(e.state))
        .sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0))[0]?.[0];
}

const _new = ({ userId, accountId, username, plan }) => ({
    userId: String(userId),
    accountId: accountId != null ? String(accountId) : null,
    username: username || null,
    plan: plan === "monthly" ? "monthly" : "single",
    lines: [],
    state: "running",
    messageId: null,
    gone: false,
    startedAt: Date.now(),
    updatedAt: Date.now(),
});

/** Post the entry's message, or edit it. A message someone deleted stays deleted. */
async function _render(client, e) {
    e.updatedAt = Date.now();
    if (e.gone) return;
    const embed = buildEmbed(client, e);
    if (e.messageId) {
        if ((await orderFeed.edit(client, e.messageId, e.userId, embed)) === "gone") e.gone = true;
        return;
    }
    const posted = await orderFeed.post(client, e.userId, embed);
    if (posted) e.messageId = posted.messageId;
}

const _line = (q) => ({
    id: q.questId != null ? String(q.questId) : q.id != null ? String(q.id) : null,
    name: trunc(q.name || q.questName || "Quest", 120),
    taskType: q.taskType || null,
});

// ── Events ─────────────────────────────────────────────────────────────────────

/**
 * A run is about to do `quests` ([{ questId, name, taskType }]): all of them as waiting.
 * Single: an order not finished yet (panel restart, retry, quests added) keeps its
 * message; a finished one means a new order → a new message. Monthly: a new pass ends
 * whatever pass of the account was left open (stopped half-way).
 */
function runStarted(client, info) {
    if (!orderFeed.isEnabled(client) || !info?.userId) return Promise.resolve();
    return _serial(async () => {
        const all = await _all(client);
        const monthly = info.plan === "monthly";
        const key = monthly ? monthlyKey(info.accountId, info.runId) : singleKey(info.userId, info.accountId);
        if (monthly) {
            for (const [k, e] of Object.entries(all)) {
                if (k === key || !k.startsWith(`monthly:${info.accountId}:`) || !OPEN.has(e.state)) continue;
                for (const l of e.lines) if (l.state === "wait") l.state = "skip";
                e.state = "stopped";
                e.endedAt = Date.now();
                await _render(client, e);
            }
        }
        let e = all[key];
        // Single: a done order, or one an admin stopped a while ago, is over — this is a new one.
        const over = !monthly && e && (e.state === "done" || (e.state === "stopped" && Date.now() - (e.endedAt || 0) > LATE_MS));
        if (!e || over) e = all[key] = _new(info);
        if (info.username) e.username = info.username;
        for (const q of info.quests || []) {
            const l = _line(q);
            const have = e.lines.find((x) => (l.id && x.id === l.id) || (!x.id && x.name === l.name));
            if (have) {
                if (!have.id) have.id = l.id;
                if (have.state === "skip") have.state = "wait";
            } else e.lines.push({ ...l, state: "wait" });
        }
        e.state = "running";
        delete e.endedAt;
        await _render(client, e);
        await _saveAll(client, all);
    });
}

/** One quest finished: its line ticked off (added if the run never listed it). */
function questDone(client, info) {
    if (!orderFeed.isEnabled(client) || !info?.userId) return Promise.resolve();
    return _serial(async () => {
        const all = await _all(client);
        const monthly = info.plan === "monthly";
        const key = monthly ? monthlyKey(info.accountId, info.runId) : singleKey(info.userId, info.accountId);
        let e = all[key];
        if (!e || (!monthly && e.state === "done" && Date.now() - (e.endedAt || 0) > LATE_MS)) e = all[key] = _new(info);
        if (info.username) e.username = info.username;
        const l = _line(info);
        const have =
            e.lines.find((x) => l.id && x.id === l.id) || e.lines.find((x) => x.state !== "done" && x.name === l.name);
        if (have) {
            have.state = "done";
            if (!have.taskType) have.taskType = l.taskType;
        } else e.lines.push({ ...l, state: "done" });
        // A quest finishing means the run is going again (after a token reset, say).
        if (e.state === "paused" || e.state === "error") e.state = "running";
        await _render(client, e);
        await _saveAll(client, all);
    });
}

/**
 * The run ended: `state` done | stopped (what was not done → ⏭️), or paused (token
 * dead) | error (it may still go on). A finished order is never reopened by a late end.
 */
function runEnded(client, info) {
    if (!orderFeed.isEnabled(client) || !info?.userId || !STATE[info.state]) return Promise.resolve();
    return _serial(async () => {
        const all = await _all(client);
        const key =
            info.plan === "monthly"
                ? info.runId
                    ? monthlyKey(info.accountId, info.runId)
                    : _openMonthly(all, info.accountId)
                : singleKey(info.userId, info.accountId);
        const e = key && all[key];
        if (!e || e.state === "done") return;
        if (info.state === "done" || info.state === "stopped") {
            for (const l of e.lines) if (l.state === "wait") l.state = "skip";
            e.endedAt = Date.now();
        }
        e.state = info.state;
        await _render(client, e);
        await _saveAll(client, all);
    });
}

module.exports = { runStarted, questDone, runEnded, buildEmbed };
