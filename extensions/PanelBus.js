const crypto = require("crypto");

// ─────────────────────────────────────────────────────────────────────────────
//  PanelBus — commands from the panel, over Discord (canonical copy:
//  bot-panel/bot-lib/PanelBus.js; the panel side is server/services/discordBus.js).
//
//  The panel never calls this bot over the network. Its own Discord bot posts
//  a command in one private channel, mentioning this bot; this bot runs the
//  handler and replies to that message, mentioning the panel, with the result.
//  Both envelopes are HMAC-signed with this project's PANEL_API_KEY, so a
//  message from anyone else — or a forged one — is ignored.
//
//    const bus = new PanelBus(client);
//    bus.handle("order.complete", ({ orderId }) => completeOrder(client, orderId));
//    bus.start(); // after client.init()
//
//  On start (and every 5 minutes) it tells the panel which commands it handles
//  and re-reads the last 3 days of the channel, so commands posted while the
//  bot was down still run — each id only once (a ✅/❌ reaction and a local
//  list mark what is done).
//
//    PANEL_API_URL  the panel gateway on this node (http://127.0.0.1:4201)
//    PANEL_API_KEY  this project's own key
// ─────────────────────────────────────────────────────────────────────────────

const TAG = "panel-bus";
const VERSION = 1;
const INLINE_MAX = 1700;
const SEEN_KEY = "panelBusSeen"; // local quick.db key — never list it in PANEL_SHARED
const SEEN_DAYS = 7;
const CATCH_UP_DAYS = 3;

const canonical = (e) => [e.v, e.id, e.ts, e.kind, e.cmd || "", JSON.stringify(e.body ?? null)].join("\n");

class PanelBus {
    constructor(client) {
        this.client = client;
        this.handlers = new Map();
        this.seen = new Map(); // id → at
        this.busy = new Set();
        this.base = String(process.env.PANEL_API_URL || "").replace(/\/+$/, "");
        this.key = process.env.PANEL_API_KEY || "";
        this.channelId = null;
        this.panelBotId = null;
        this.handle("ping", (body) => ({ pong: true, bot: client.user?.tag || null, at: body?.at ?? null, uptime: Math.round(process.uptime()) }));
    }

    handle(cmd, fn) {
        this.handlers.set(cmd, fn);
        return this;
    }

    sign(e) {
        return crypto.createHmac("sha256", this.key).update(canonical(e)).digest("hex");
    }

    verify(e) {
        if (typeof e?.sig !== "string" || !/^[0-9a-f]{64}$/.test(e.sig)) return false;
        return crypto.timingSafeEqual(Buffer.from(this.sign(e), "hex"), Buffer.from(e.sig, "hex"));
    }

    /** Tell the panel what this bot handles; learn the channel and the panel's bot id. */
    async hello() {
        const res = await fetch(`${this.base}/api/external/data`, {
            method: "POST",
            headers: { "x-api-key": this.key, "content-type": "application/json" },
            body: JSON.stringify({ op: "hello", commands: [...this.handlers.keys()] }),
            signal: AbortSignal.timeout(15_000),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        this.channelId = json.bus?.channelId || null;
        this.panelBotId = json.bus?.panelBotId || null;
        if (!this.channelId || !this.panelBotId) throw new Error("the panel's Discord bus is not up yet");
    }

    start() {
        if (!this.base || !this.key) {
            console.log("[PanelBus] PANEL_API_URL / PANEL_API_KEY not set — commands from the panel are off");
            return this;
        }
        this.loadSeen().catch(() => {});
        this.client.on("messageCreate", (m) => this.onMessage(m).catch((e) => console.warn("[PanelBus]", e.message)));
        const connect = async () => {
            try {
                await this.hello();
                await this.catchUp();
            } catch (err) {
                console.warn(`[PanelBus] ${err.message} — retrying in 5 minutes`);
            }
        };
        // "ready" became "clientReady" in discord.js 14.22 — Events.ClientReady is right for either.
        const { Events } = require("discord.js");
        if (this.client.isReady()) connect();
        else this.client.once(Events.ClientReady, connect);
        setInterval(connect, 5 * 60 * 1000);
        return this;
    }

    isForMe(msg) {
        const me = this.client.user?.id;
        return (
            !!this.channelId &&
            !!me &&
            msg.channelId === this.channelId &&
            msg.author?.id === this.panelBotId &&
            // The text as well as the parsed mentions: a command posted before this
            // bot joined the server is not recorded as a mention of it. Safe — only
            // an envelope signed with THIS bot's key is ever run.
            (!!msg.mentions?.users?.has(me) || String(msg.content || "").includes(`<@${me}>`))
        );
    }

    async parse(msg) {
        const block = /```json\n([\s\S]+?)\n```/.exec(msg.content || "");
        try {
            if (block) return JSON.parse(block[1]);
            const file = [...(msg.attachments?.values?.() || [])].find((a) => a.name?.startsWith(TAG));
            if (!file) return null;
            const res = await fetch(file.url, { signal: AbortSignal.timeout(20_000) });
            return res.ok ? JSON.parse(await res.text()) : null;
        } catch {
            return null;
        }
    }

    toMessage(label, envelope) {
        const json = JSON.stringify(envelope);
        const head = `<@${this.panelBotId}> \`${TAG}\` ${label}`;
        const allowedMentions = { users: [this.panelBotId], repliedUser: false };
        if (json.length <= INLINE_MAX) return { content: `${head}\n\`\`\`json\n${json}\n\`\`\``, allowedMentions };
        return { content: head, files: [{ attachment: Buffer.from(json), name: `${TAG}-${envelope.id}.json` }], allowedMentions };
    }

    async onMessage(msg) {
        if (this.isForMe(msg)) await this.process(msg);
    }

    async process(msg) {
        const env = await this.parse(msg);
        if (!env || env.kind !== "cmd" || typeof env.id !== "string") return;
        if (this.seen.has(env.id) || this.busy.has(env.id) || msg.reactions?.cache?.some((r) => r.me)) return;
        if (!this.verify(env)) {
            console.warn(`[PanelBus] ignored ${env.id}: signature does not match this project's key`);
            return;
        }
        this.busy.add(env.id);
        let body;
        try {
            const fn = this.handlers.get(env.cmd);
            body = fn ? { ok: true, result: (await fn(env.body, { id: env.id, message: msg })) ?? null } : { ok: false, error: `unknown command "${env.cmd}"` };
        } catch (err) {
            body = { ok: false, error: String(err?.message || err).slice(0, 500) };
        }
        await this.markSeen(env.id);
        this.busy.delete(env.id);
        const reply = { v: VERSION, id: env.id, ts: Date.now(), kind: "reply", cmd: env.cmd, body };
        reply.sig = this.sign(reply);
        await msg.reply(this.toMessage(`${body.ok ? "✅" : "❌"} ${env.cmd} · ${env.id}`, reply)).catch((e) => console.warn(`[PanelBus] reply to ${env.id} failed: ${e.message}`));
        await msg.react(body.ok ? "✅" : "❌").catch(() => {});
        if (!body.ok) console.warn(`[PanelBus] ${env.cmd} ${env.id} failed: ${body.error}`);
    }

    /** Commands posted while this bot was away (oldest first). */
    async catchUp() {
        const channel = await this.client.channels.fetch(this.channelId).catch(() => null);
        if (!channel?.messages) return;
        const cutoff = Date.now() - CATCH_UP_DAYS * 86_400_000;
        const pending = [];
        let before;
        for (let page = 0; page < 5; page++) {
            const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
            if (!batch.size) break;
            for (const m of batch.values()) if (m.createdTimestamp >= cutoff && this.isForMe(m)) pending.push(m);
            const oldest = batch.last();
            before = oldest.id;
            if (oldest.createdTimestamp < cutoff) break;
        }
        pending.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        for (const m of pending) await this.process(m);
    }

    // The ✅ reaction marks a command done; this local list covers a reaction that failed.
    async loadSeen() {
        const list = (await this.client.db.get(SEEN_KEY)) || [];
        for (const s of list) if (s?.id) this.seen.set(s.id, s.at);
    }

    async markSeen(id) {
        const now = Date.now();
        this.seen.set(id, now);
        const cutoff = now - SEEN_DAYS * 86_400_000;
        for (const [k, at] of this.seen) if (at < cutoff) this.seen.delete(k);
        await this.client.db.set(SEEN_KEY, [...this.seen].map(([k, at]) => ({ id: k, at }))).catch(() => {});
    }
}

module.exports = PanelBus;
