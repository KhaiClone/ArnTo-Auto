const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const T = require("./uiTemplate");

// ─────────────────────────────────────────────────────────────────────────────
//  MessageTemplates — every message this bot sends, editable on the bot-panel's
//  Embeds page (canonical copy: bot-panel/bot-lib/MessageTemplates.js, with
//  bot-lib/uiTemplate.js beside it).
//
//  The bot's own templates/*.js declare each message: a key, where it is used,
//  its variables and its default (Discohook-shaped). On start the bot uploads
//  that catalog; the panel stores only what the admin changed. The bot polls
//  for changes (every 15 s, through its gateway — the panel never calls a bot)
//  and keeps the last copy in its local database, so a panel that is away
//  changes nothing. A changed template that fails to render, or renders past
//  Discord's limits, falls back to the default — a typo on the panel can never
//  stop an order.
//
//    client.ui = new MessageTemplates(client, { guildId, invite });
//    channel.send(client.ui.message("shop.order.waiting", { order, buyer }, {
//        buttons: { done: { customId: `done_order:${id}` } },
//    }));
//    const card = client.ui.card("auto.dg.cart", { cart });   // Components V2 words
//
//  Panels posted into channels (/dg-setup …) can be re-rendered from the
//  panel: client.ui.refreshable(key, builder) + client.ui.track(key, message).
//
//    PANEL_API_URL  the panel gateway on this node (http://127.0.0.1:4201)
//    PANEL_API_KEY  this project's own key
// ─────────────────────────────────────────────────────────────────────────────

const OVERRIDES_KEY = "uiOverrides"; // local quick.db — never list these in PANEL_SHARED
const POSTED_KEY = "uiPosted";
const POLL_MS = 15_000;
const EPHEMERAL = 64;

const userVars = (u) =>
    u && {
        id: u.id,
        mention: `<@${u.id}>`,
        tag: u.tag,
        username: u.username,
        displayName: u.globalName || u.displayName || u.username,
        avatar: typeof u.displayAvatarURL === "function" ? u.displayAvatarURL() : null,
        bot: !!u.bot,
        createdAt: u.createdTimestamp ?? null,
        __text: `<@${u.id}>`,
    };

const memberVars = (m) =>
    m && {
        ...userVars(m.user),
        displayName: m.displayName,
        avatar: typeof m.displayAvatarURL === "function" ? m.displayAvatarURL() : userVars(m.user).avatar,
        joinedAt: m.joinedTimestamp ?? null,
        roles: m.roles?.cache
            ? [...m.roles.cache.values()].filter((r) => r.id !== m.guild?.id).map((r) => r.name).join(", ")
            : "",
    };

const guildVars = (g, invite) =>
    g && {
        id: g.id,
        name: g.name,
        icon: typeof g.iconURL === "function" ? g.iconURL() : null,
        invite: invite || null,
        inviteUrl: invite ? `https://discord.gg/${invite}` : null,
        memberCount: g.memberCount ?? null,
        __text: g.name,
    };

const channelVars = (ch) =>
    ch && {
        id: ch.id,
        name: ch.name || null,
        mention: `<#${ch.id}>`,
        url: ch.guildId ? `https://discord.com/channels/${ch.guildId}/${ch.id}` : null,
        __text: `<#${ch.id}>`,
    };

const roleVars = (r) => r && { id: r.id, name: r.name, mention: `<@&${r.id}>`, __text: `<@&${r.id}>` };

class MessageTemplates {
    /**
     * @param {import("discord.js").Client} client
     * @param {{ dir?: string, guildId?: string, invite?: string }} opts
     *        dir      folder of template files, relative to the project (templates)
     *        guildId  the server {guild} means when a message has none of its own
     *        invite   its invite code ({guild.invite})
     *
     * A template file may also export `globals: { name: { type, label, value: () => … } }`:
     * variables every template of this bot gets (e.g. {shop.feedbackChannel}).
     */
    constructor(client, { dir = "templates", guildId = null, invite = null } = {}) {
        this.client = client;
        this.guildId = guildId;
        this.invite = invite;
        this.extraGlobals = {};
        this.base = String(process.env.PANEL_API_URL || "").replace(/\/+$/, "");
        this.key = process.env.PANEL_API_KEY || "";
        this.types = {};
        this.defs = {};
        this.overrides = {};
        this.custom = {};
        this.version = 0;
        this.builders = new Map();
        this.posted = [];
        this._warned = new Map();
        this._uploaded = null;
        this.load(path.join(process.cwd(), dir));
        this.hash = crypto.createHash("sha1").update(JSON.stringify(this.catalog())).digest("hex");
        this._restored = this.restore();
    }

    // ── Catalog ──────────────────────────────────────────────────────────────

    load(dir) {
        if (!fs.existsSync(dir)) return;
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
            const mod = require(path.join(dir, file));
            Object.assign(this.types, mod.types || {});
            Object.assign(this.extraGlobals, mod.globals || {});
            for (const [key, def] of Object.entries(mod.templates || {})) {
                if (this.defs[key]) throw new Error(`[ui] template "${key}" is declared twice`);
                const kind = def.kind || "message";
                const errs = kind === "card" ? T.checkCard(def) : T.checkMessage(def.message);
                if (errs.length) throw new Error(`[ui] default of "${key}" is broken: ${errs.join("; ")}`);
                this.defs[key] = { ...def, kind, file };
            }
        }
    }

    /** What the panel needs to list, document and preview every template. */
    catalog() {
        const templates = {};
        for (const [key, d] of Object.entries(this.defs)) {
            templates[key] = {
                kind: d.kind,
                group: d.group || "Khác",
                label: d.label || key,
                description: d.description || "",
                vars: d.vars || {},
                refreshable: !!d.refreshable,
                // Variables only some slots see: { slot: "type" (its fields at top level, e.g. one list item) | { name: "type" } }.
                slotVars: d.slotVars || {},
                ...(d.kind === "card"
                    ? { default: { color: d.color ?? null, texts: d.texts || {}, buttons: d.buttons || {}, selects: d.selects || {} } }
                    : { default: d.message, slots: d.slots || {}, selects: d.selects || {}, allowEmpty: !!d.allowEmpty }),
            };
        }
        const globals = {};
        for (const [k, g] of Object.entries(this.extraGlobals)) globals[k] = { type: g.type, label: g.label };
        return { types: this.types, globals, templates };
    }

    // ── Panel sync ───────────────────────────────────────────────────────────

    async _api(method, p, body) {
        const res = await fetch(`${this.base}/api/external/ui${p}`, {
            method,
            headers: { "x-api-key": this.key, "content-type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(20_000),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        return json;
    }

    async restore() {
        try {
            const saved = (await this.client.db.get(OVERRIDES_KEY)) || {};
            if (saved.overrides) this.overrides = saved.overrides;
            if (saved.custom) this.custom = saved.custom;
            this.posted = (await this.client.db.get(POSTED_KEY)) || [];
        } catch (e) {
            console.warn(`[ui] could not restore the saved templates: ${e.message}`);
        }
    }

    async sync() {
        if (this._uploaded !== this.hash) {
            await this._api("POST", "/catalog", { ...this.catalog(), hash: this.hash });
            this._uploaded = this.hash;
            await this._api("POST", "/posted", { posted: this.posted }).catch(() => {});
        }
        const r = await this._api("GET", `?version=${this.version}&hash=${this.hash}`);
        if (r.needCatalog) this._uploaded = null;
        if (r.unchanged) return;
        this.overrides = r.overrides || {};
        this.custom = r.custom || {};
        this.version = r.version || 0;
        await this.client.db.set(OVERRIDES_KEY, { overrides: this.overrides, custom: this.custom, version: this.version }).catch(() => {});
    }

    /** Start syncing with the panel (call once; safe before ready). */
    start() {
        if (!this.base || !this.key) {
            console.log("[ui] PANEL_API_URL / PANEL_API_KEY not set — the default templates are used");
            return this;
        }
        let failing = false;
        const tick = async () => {
            try {
                await this._restored;
                await this.sync();
                if (failing) console.log("[ui] templates in sync with the panel again");
                failing = false;
            } catch (e) {
                if (!failing) console.warn(`[ui] panel unreachable (${e.message}) — keeping the last templates`);
                failing = true;
            }
        };
        tick();
        setInterval(tick, POLL_MS).unref?.();
        return this;
    }

    /** Bus commands from the panel: re-render posted panels, adopt one by link. */
    attachBus(bus) {
        bus.handle("ui.refresh", ({ keys } = {}) => this.refresh(keys));
        bus.handle("ui.adopt", (body = {}) => this.adopt(body));
        return this;
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    user(u) {
        return userVars(u);
    }
    member(m) {
        return memberVars(m);
    }
    guild(g) {
        return guildVars(g, this.invite);
    }
    channel(ch) {
        return channelVars(ch);
    }
    role(r) {
        return roleVars(r);
    }

    globals(guild) {
        const c = this.client;
        const g = guild || (this.guildId ? c.guilds?.cache?.get(this.guildId) : null);
        const out = { bot: c.user ? userVars(c.user) : null, guild: g ? guildVars(g, this.invite) : null, now: Date.now(), custom: this.custom };
        for (const [k, gl] of Object.entries(this.extraGlobals)) {
            try {
                out[k] = typeof gl.value === "function" ? gl.value(c) : gl.value;
            } catch {
                out[k] = null;
            }
        }
        return out;
    }

    _def(key, kind) {
        const def = this.defs[key];
        if (!def) throw new Error(`[ui] no template "${key}"`);
        if (def.kind !== kind) throw new Error(`[ui] "${key}" is a ${def.kind}, not a ${kind}`);
        return def;
    }

    _warn(key, what) {
        const k = `${key}:${what}`;
        if (Date.now() - (this._warned.get(k) || 0) < 10 * 60 * 1000) return;
        this._warned.set(k, Date.now());
        console.warn(`[ui] ${key}: ${what}`);
    }

    /**
     * A message, ready for send / reply / edit.
     * @param {string} key
     * @param {Object} vars    this message's variables (plain objects — use ui.user(), ui.guild() …)
     * @param {Object} opts
     *        buttons     { slot: { customId | url, disabled?, style? } } — the slots this message offers now
     *        components  rows the code builds itself (menus …), placed before the template's buttons
     *        ephemeral   reply only the user sees
     *        edit        the result replaces a message: empty content / embeds / buttons are sent as such
     *        guild       the server for {guild} (default: the bot's main one)
     */
    message(key, vars = {}, opts = {}) {
        const def = this._def(key, "message");
        const scope = [this.globals(opts.guild), vars];
        const present = {};
        for (const [slot, data] of Object.entries(opts.buttons || {})) if (data) present[slot] = data;
        const extraRows = opts.components || [];
        const over = this.overrides[key];
        let out = null;
        for (const [tpl, which] of over ? [[over, "the panel's version"], [def.message, "the default"]] : [[def.message, "the default"]]) {
            try {
                const msg = T.renderMessage(tpl, scope, { slots: def.slots || {}, present });
                const errs = T.validateMessage(msg, { allowEmpty: extraRows.length > 0 || !!def.allowEmpty });
                if (msg.components.length + extraRows.length > T.LIMITS.rows) errs.push("too many rows of buttons");
                if (!errs.length) {
                    out = msg;
                    break;
                }
                this._warn(key, `${which} cannot be sent (${errs.join("; ")})`);
            } catch (e) {
                this._warn(key, `${which} failed: ${e.message}`);
            }
        }
        if (!out) out = { content: `⚠️ ${key}`, embeds: [], components: [] };
        const payload = {
            embeds: out.embeds,
            components: [...extraRows, ...out.components],
        };
        if (out.content) payload.content = out.content;
        else if (opts.edit) payload.content = "";
        if (opts.ephemeral) payload.flags = EPHEMERAL;
        if (opts.allowedMentions) payload.allowedMentions = opts.allowedMentions;
        return payload;
    }

    /** One string of a template (a message's select menu texts, or a card's words). */
    _text(key, src, fallback, scope) {
        if (src == null && fallback == null) return "";
        try {
            return T.interpolate(src ?? fallback, scope).trim();
        } catch (e) {
            this._warn(key, e.message);
            try {
                return T.interpolate(fallback ?? "", scope).trim();
            } catch {
                return "";
            }
        }
    }

    _selects(key, def, over, vars, opts) {
        const scope = [this.globals(opts?.guild), vars];
        const pick = (slot, field) => this._text(key, over?.selects?.[slot]?.[field], def.selects?.[slot]?.[field], scope);
        const merged = T.mergeSelects(def.selects, T.checkSelects(over?.selects).length ? {} : over?.selects);
        return {
            /** The slot's fixed options (by value), in their declared order: [{ value, label, description?, emoji? }]. */
            fixed: (slot, extra = {}) =>
                Object.entries(merged[slot]?.options || {}).map(([value, o]) => {
                    const s = [...scope, extra];
                    const d = def.selects?.[slot]?.options?.[value] || {};
                    const label = this._text(key, o.label, d.label, s).slice(0, T.LIMITS.optionLabel);
                    const description = this._text(key, o.description, d.description, s).slice(0, T.LIMITS.optionDescription);
                    const emoji = this._text(key, o.emoji, d.emoji, s);
                    return { value, label: label || value, ...(description ? { description } : {}), ...(emoji ? { emoji } : {}) };
                }),
            placeholder: (slot, extra = {}) =>
                this._text(key, over?.selects?.[slot]?.placeholder, def.selects?.[slot]?.placeholder, [...scope, extra]).slice(0, T.LIMITS.placeholder),
            option: (slot, extra = {}) => {
                const s = [...scope, extra];
                const label = this._text(key, over?.selects?.[slot]?.label, def.selects?.[slot]?.label, s).slice(0, T.LIMITS.optionLabel);
                const description = this._text(key, over?.selects?.[slot]?.description, def.selects?.[slot]?.description, s).slice(0, T.LIMITS.optionDescription);
                return { label: label || "—", ...(description ? { description } : {}) };
            },
            pick,
        };
    }

    /** Texts of a message's select menu: ui.select(key, vars).placeholder("pick") / .option("pick", { order }). */
    select(key, vars = {}, opts = {}) {
        const def = this._def(key, "message");
        return this._selects(key, def, this.overrides[key], vars, opts);
    }

    /**
     * The words of a Components V2 view whose layout the code builds:
     *   const c = ui.card("auto.dg.cart", { cart });
     *   c.color · c.text("header", extraVars) · c.button("pay") → { label, emoji, style }
     *   c.applyButton(buttonBuilder, "pay") · c.placeholder("remove") · c.option("remove", { item })
     */
    card(key, vars = {}, opts = {}) {
        const def = this._def(key, "card");
        let over = this.overrides[key] || {};
        if (T.checkCard(over).length) {
            this._warn(key, "the panel's version does not parse — using the default");
            over = {};
        }
        const merged = T.mergeCard(def, over);
        const scope = [this.globals(opts.guild), vars];
        const colorSrc = merged.color;
        const color =
            T.parseColor(typeof colorSrc === "string" ? this._text(key, colorSrc, def.color, scope) : colorSrc) ??
            T.parseColor(typeof def.color === "string" ? this._text(key, def.color, null, scope) : def.color);
        const selects = this._selects(key, def, over, vars, opts);
        const button = (slot, extra = {}) => {
            const s = [...scope, extra];
            const b = merged.buttons[slot] || {};
            const d = def.buttons?.[slot] || {};
            const label = this._text(key, b.label, d.label, s).slice(0, T.LIMITS.buttonLabel);
            const emoji = T.parseEmoji(this._text(key, b.emoji, d.emoji, s));
            return { label, emoji, style: b.style || d.style || null };
        };
        return {
            color,
            text: (slot, extra = {}) => this._text(key, merged.texts[slot], def.texts?.[slot], [...scope, extra]),
            button,
            /** Label / emoji / style onto a discord.js ButtonBuilder (a link button keeps its style). */
            applyButton: (builder, slot, extra = {}) => {
                const b = button(slot, extra);
                if (b.label) builder.setLabel(b.label);
                if (b.emoji) builder.setEmoji(b.emoji);
                if (!b.label && !b.emoji) builder.setLabel(slot);
                const isLink = builder.data?.style === 5;
                if (b.style && !isLink) {
                    const map = { primary: 1, secondary: 2, success: 3, danger: 4 };
                    const st = typeof b.style === "number" ? b.style : map[String(b.style).toLowerCase()];
                    if (st) builder.setStyle(st);
                }
                return builder;
            },
            placeholder: selects.placeholder,
            option: selects.option,
        };
    }

    // ── Posted panels ────────────────────────────────────────────────────────

    /** How to rebuild a posted message of `key` (an async function → payload). */
    refreshable(key, builder) {
        this.builders.set(key, builder);
        return this;
    }

    async _savePosted() {
        await this.client.db.set(POSTED_KEY, this.posted).catch(() => {});
        if (this.base && this.key) await this._api("POST", "/posted", { posted: this.posted }).catch(() => {});
    }

    /** Remember a message just sent for `key` so the panel can update it later. */
    async track(key, message) {
        if (!message?.id || !message.channelId) return;
        this.posted = this.posted.filter((p) => p.messageId !== message.id);
        this.posted.push({ key, guildId: message.guildId || null, channelId: message.channelId, messageId: message.id, at: Date.now() });
        await this._savePosted();
    }

    /** Re-render posted messages (all, or those of `keys`) with the current templates. */
    async refresh(keys) {
        const want = Array.isArray(keys) && keys.length ? new Set(keys) : null;
        const result = { updated: 0, removed: 0, skipped: 0, failed: [] };
        const keep = [];
        for (const p of this.posted) {
            if (want && !want.has(p.key)) {
                keep.push(p);
                continue;
            }
            const builder = this.builders.get(p.key);
            if (!builder) {
                result.skipped++;
                keep.push(p);
                continue;
            }
            try {
                const channel = await this.client.channels.fetch(p.channelId);
                const msg = await channel.messages.fetch(p.messageId);
                await msg.edit(await builder());
                result.updated++;
                keep.push(p);
            } catch (e) {
                // 10003 unknown channel, 10008 unknown message: it is gone — forget it.
                if ([10003, 10008].includes(e.code)) result.removed++;
                else {
                    result.failed.push({ key: p.key, messageId: p.messageId, error: String(e.message).slice(0, 200) });
                    keep.push(p);
                }
            }
        }
        this.posted = keep;
        await this._savePosted();
        return result;
    }

    /** Start tracking a message posted before this existed (a panel's link). */
    async adopt({ key, channelId, messageId } = {}) {
        const builder = this.builders.get(key);
        if (!builder) throw new Error(`"${key}" cannot be updated from the panel`);
        const channel = await this.client.channels.fetch(String(channelId));
        const msg = await channel.messages.fetch(String(messageId));
        if (msg.author?.id !== this.client.user.id) throw new Error("That message was not sent by this bot");
        await msg.edit(await builder());
        await this.track(key, msg);
        return { adopted: true, url: msg.url };
    }
}

MessageTemplates.userVars = userVars;
MessageTemplates.memberVars = memberVars;
MessageTemplates.guildVars = guildVars;
MessageTemplates.channelVars = channelVars;

module.exports = MessageTemplates;
