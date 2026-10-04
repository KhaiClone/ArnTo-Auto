// ─────────────────────────────────────────────────────────────────────────────
//  uiTemplate — the message-template language of the whole system.
//
//  Shared by the bot-panel (Embeds page: live preview, checks on save) and
//  every bot (bot-lib/MessageTemplates.js renders with it). Canonical copy
//  here; client/src/lib/uiTemplate.js is GENERATED from it by
//  scripts/sync-ui-template.js — edit this file, then run that script.
//  Pure JavaScript, no dependencies, no Node APIs.
//
//  In any string of a template:
//    {order.orderId}            a variable (unknown names stay as typed)
//    {price|money}              filters, chained: {name|upper|trunc:20}
//    {note|default:"Không có"}  arguments: quoted text, numbers or variables
//    {#if paid}…{#elseif x}…{#else}…{/if}   conditions: ! && || == != > < >= <=
//    {#each items}{@number}. {name}{#else}trống{/each}   lists ({#each items as it})
//    \{ \}                      literal braces
//
//  A message template is Discohook-shaped:
//    { content, embeds: [{ author, title, url, description, color, fields,
//      thumbnail, image, footer, timestamp, if }], components: [[button…]…] }
//  Embeds, fields and buttons take an "if" condition; a field takes "each".
//  Buttons are code "slots" (the bot owns what they do — a template sets their
//  label / emoji / style and places them) or plain link buttons.
// ─────────────────────────────────────────────────────────────────────────────

const LIMITS = {
    content: 2000,
    embeds: 10,
    title: 256,
    description: 4096,
    fields: 25,
    fieldName: 256,
    fieldValue: 1024,
    footer: 2048,
    author: 256,
    embedTotal: 6000,
    buttonLabel: 80,
    rows: 5,
    perRow: 5,
    placeholder: 150,
    optionLabel: 100,
    optionDescription: 100,
};

class TemplateError extends Error {}

// ── Tokenizer ────────────────────────────────────────────────────────────────

const VALUE_TAG = /^\s*(?:[A-Za-z_@][\w@]*(?:\.[\w@]+)*|"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?)\s*(?:\|.*)?$/s;

/** Index of the "}" closing a tag opened before `from` — quotes respected; -1 if none on this line. */
function findClose(src, from) {
    let quote = null;
    for (let i = from; i < src.length; i++) {
        const ch = src[i];
        if (ch === "\n") return -1;
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === "{") return -1;
        else if (ch === "}") return i;
    }
    return -1;
}

const isTag = (inner) => {
    const t = inner.trim();
    return /^[#/]\s*\w/.test(t) || VALUE_TAG.test(t);
};

function tokenize(src) {
    const out = [];
    let buf = "";
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (ch === "\\" && (src[i + 1] === "{" || src[i + 1] === "}")) {
            buf += src[++i];
            continue;
        }
        if (ch === "{") {
            const end = findClose(src, i + 1);
            if (end > 0) {
                const inner = src.slice(i + 1, end);
                if (isTag(inner)) {
                    if (buf) out.push({ t: "text", v: buf });
                    buf = "";
                    out.push({ t: "tag", v: inner.trim(), raw: src.slice(i, end + 1) });
                    i = end;
                    continue;
                }
            }
        }
        buf += ch;
    }
    if (buf) out.push({ t: "text", v: buf });
    return out;
}

// ── Parser → tree ────────────────────────────────────────────────────────────

const _cache = new Map();

function parse(src) {
    src = String(src ?? "");
    if (_cache.has(src)) return _cache.get(src);
    const root = { body: [] };
    const stack = [{ node: root, body: root.body }];
    const top = () => stack[stack.length - 1];
    for (const tok of tokenize(src)) {
        if (tok.t === "text") {
            top().body.push({ type: "text", v: tok.v });
            continue;
        }
        const tag = tok.v;
        let m;
        if ((m = /^#if\s+(.+)$/s.exec(tag))) {
            const node = { type: "if", branches: [{ cond: m[1].trim(), body: [] }], elseBody: null };
            top().body.push(node);
            stack.push({ node, body: node.branches[0].body });
        } else if ((m = /^#else\s*if\s+(.+)$/s.exec(tag)) || (m = /^#elseif\s+(.+)$/s.exec(tag))) {
            const f = top();
            if (f.node.type !== "if" || f.node.elseBody) throw new TemplateError(`"{${tag}}" phải nằm trong {#if} và trước {#else}`);
            const branch = { cond: m[1].trim(), body: [] };
            f.node.branches.push(branch);
            f.body = branch.body;
        } else if (/^#else$/.test(tag)) {
            const f = top();
            if (!["if", "each"].includes(f.node.type) || f.node.elseBody) throw new TemplateError("{#else} phải nằm trong {#if} hoặc {#each}");
            f.node.elseBody = [];
            f.body = f.node.elseBody;
        } else if ((m = /^#each\s+(.+?)(?:\s+as\s+([A-Za-z_]\w*))?$/s.exec(tag))) {
            const node = { type: "each", expr: m[1].trim(), alias: m[2] || null, body: [], elseBody: null };
            top().body.push(node);
            stack.push({ node, body: node.body });
        } else if ((m = /^\/(if|each)$/.exec(tag))) {
            const f = top();
            if (f.node.type !== m[1]) throw new TemplateError(`"{/${m[1]}}" không khớp với thẻ mở nào`);
            stack.pop();
        } else if (/^[#/]/.test(tag)) {
            throw new TemplateError(`Thẻ không hợp lệ: {${tag}}`);
        } else {
            top().body.push({ type: "var", expr: tag, raw: tok.raw });
        }
    }
    if (stack.length > 1) throw new TemplateError(`Thiếu {/${top().node.type}}`);
    if (_cache.size > 2000) _cache.clear();
    _cache.set(src, root.body);
    return root.body;
}

// ── Scope ────────────────────────────────────────────────────────────────────

const MISSING = Symbol("missing");

/** Scope = array of frames, innermost last. */
function lookup(frames, path) {
    const parts = path.split(".");
    let value = MISSING;
    for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i];
        if (f && typeof f === "object" && Object.prototype.hasOwnProperty.call(f, parts[0])) {
            value = f[parts[0]];
            break;
        }
    }
    if (value === MISSING) return MISSING;
    for (let i = 1; i < parts.length; i++) {
        if (value == null) return undefined;
        if (parts[i] === "length" && (Array.isArray(value) || typeof value === "string")) value = value.length;
        else value = value[parts[i]];
    }
    return value;
}

// ── Expressions ──────────────────────────────────────────────────────────────

/** Split on `sep` outside quotes. */
function splitOutside(s, sep) {
    const out = [];
    let quote = null;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (s.startsWith(sep, i)) {
            out.push(s.slice(start, i));
            start = i + sep.length;
            i += sep.length - 1;
        }
    }
    out.push(s.slice(start));
    return out;
}

function literal(token) {
    const t = token.trim();
    if (/^"[^"]*"$|^'[^']*'$/.test(t)) return { ok: true, v: t.slice(1, -1) };
    if (/^-?\d+(?:\.\d+)?$/.test(t)) return { ok: true, v: Number(t) };
    if (t === "true") return { ok: true, v: true };
    if (t === "false") return { ok: true, v: false };
    if (t === "null") return { ok: true, v: null };
    return { ok: false };
}

/** A value expression: operand | filter:arg | … → value (MISSING when its variable is unknown). */
function evalValue(expr, frames) {
    const [head, ...filters] = splitOutside(expr, "|");
    const lit = literal(head);
    let value;
    if (lit.ok) value = lit.v;
    else {
        const name = head.trim();
        if (!/^[A-Za-z_@][\w@]*(?:\.[\w@]+)*$/.test(name)) throw new TemplateError(`Biểu thức không hợp lệ: ${expr}`);
        value = lookup(frames, name);
        if (value === MISSING) return MISSING;
    }
    for (const f of filters) {
        const [fname, ...rawArgs] = splitOutside(f, ":");
        const fn = FILTERS[fname.trim()];
        if (!fn) throw new TemplateError(`Không có bộ lọc "${fname.trim()}"`);
        const args = rawArgs.map((a) => {
            const l = literal(a);
            if (l.ok) return l.v;
            const v = lookup(frames, a.trim());
            return v === MISSING ? a.trim() : v;
        });
        value = fn(value, ...args);
    }
    return value;
}

const truthy = (v) => (Array.isArray(v) ? v.length > 0 : v !== MISSING && !!v);

function evalCond(expr, frames) {
    return splitOutside(expr, "||").some((or) =>
        splitOutside(or, "&&").every((term) => {
            let t = term.trim();
            let negate = false;
            while (t.startsWith("!")) {
                negate = !negate;
                t = t.slice(1).trim();
            }
            let result;
            const m = /^(.*?)\s*(==|!=|>=|<=|>|<)\s*(.*)$/s.exec(t);
            if (m && splitOutside(t, m[2]).length === 2) {
                const a = evalValue(m[1], frames);
                const b = evalValue(m[3], frames);
                const x = a === MISSING ? undefined : a;
                const y = b === MISSING ? undefined : b;
                const num = (v) => (typeof v === "number" ? v : Number(v));
                switch (m[2]) {
                    case "==":
                        result = x == y;
                        break;
                    case "!=":
                        result = x != y;
                        break;
                    case ">":
                        result = num(x) > num(y);
                        break;
                    case "<":
                        result = num(x) < num(y);
                        break;
                    case ">=":
                        result = num(x) >= num(y);
                        break;
                    default:
                        result = num(x) <= num(y);
                }
            } else {
                result = truthy(evalValue(t, frames));
            }
            return negate ? !result : result;
        }),
    );
}

// ── Output ───────────────────────────────────────────────────────────────────

function stringify(v) {
    if (v === MISSING || v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(stringify).join(", ");
    if (typeof v === "object") return typeof v.__text === "string" ? v.__text : JSON.stringify(v);
    return String(v);
}

function renderNodes(nodes, frames) {
    let out = "";
    for (const n of nodes) {
        if (n.type === "text") out += n.v;
        else if (n.type === "var") {
            const v = evalValue(n.expr, frames);
            out += v === MISSING ? n.raw : stringify(v);
        } else if (n.type === "if") {
            const hit = n.branches.find((b) => evalCond(b.cond, frames));
            if (hit) out += renderNodes(hit.body, frames);
            else if (n.elseBody) out += renderNodes(n.elseBody, frames);
        } else if (n.type === "each") {
            let list = evalValue(n.expr, frames);
            if (list === MISSING || list == null) list = [];
            if (!Array.isArray(list)) list = typeof list === "object" ? Object.values(list) : [list];
            if (!list.length) {
                if (n.elseBody) out += renderNodes(n.elseBody, frames);
                continue;
            }
            list.forEach((item, i) => {
                const meta = { "@index": i, "@number": i + 1, "@first": i === 0, "@last": i === list.length - 1, "@count": list.length, this: item };
                const frame = n.alias ? { ...meta, [n.alias]: item } : item && typeof item === "object" && !Array.isArray(item) ? { ...item, ...meta } : meta;
                out += renderNodes(n.body, [...frames, frame]);
            });
        }
    }
    return out;
}

const toFrames = (scope) => (Array.isArray(scope) ? scope : [scope || {}]);

/** Render one template string. Throws TemplateError on a malformed template. */
function interpolate(src, scope) {
    if (src == null || src === "") return "";
    return renderNodes(parse(src), toFrames(scope));
}

/** Throws TemplateError if `src` does not parse; returns the variable roots it uses. */
function check(src) {
    const used = new Set();
    const walk = (nodes) => {
        for (const n of nodes) {
            if (n.type === "var") used.add(n.expr.split("|")[0].trim().split(".")[0]);
            if (n.type === "if") n.branches.forEach((b) => walk(b.body));
            if (n.type === "each") walk(n.body);
            if (n.elseBody) walk(n.elseBody);
        }
    };
    walk(parse(src));
    return [...used];
}

// ── Filters ──────────────────────────────────────────────────────────────────

const TZ = "Asia/Ho_Chi_Minh";
const num = (v) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d.-]/g, "")));
const toMs = (v) => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
    if (/^\d+$/.test(String(v ?? ""))) return toMs(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
};

const FILTERS = {
    money: (v) => (v === "" || v == null ? "" : `${num(v).toLocaleString("vi-VN")}đ`),
    vnd: (v) => (v === "" || v == null ? "" : num(v).toLocaleString("vi-VN", { style: "currency", currency: "VND" })),
    number: (v) => (v === "" || v == null ? "" : num(v).toLocaleString("vi-VN")),
    round: (v, d = 0) => Number(num(v).toFixed(num(d))),
    abs: (v) => Math.abs(num(v)),
    plus: (v, n) => num(v) + num(n),
    minus: (v, n) => num(v) - num(n),
    times: (v, n) => num(v) * num(n),
    div: (v, n) => (num(n) ? num(v) / num(n) : 0),
    upper: (v) => stringify(v).toUpperCase(),
    lower: (v) => stringify(v).toLowerCase(),
    capitalize: (v) => {
        const s = stringify(v);
        return s.charAt(0).toUpperCase() + s.slice(1);
    },
    trim: (v) => stringify(v).trim(),
    trunc: (v, n = 100) => {
        const s = stringify(v);
        return s.length > num(n) ? `${s.slice(0, Math.max(0, num(n) - 1))}…` : s;
    },
    replace: (v, a = "", b = "") => stringify(v).split(stringify(a)).join(stringify(b)),
    default: (v, d = "") => (v === MISSING || v == null || v === "" || (Array.isArray(v) && !v.length) ? d : v),
    yesno: (v, yes = "Có", no = "Không") => (truthy(v) ? yes : no),
    time: (v, style = "f") => {
        const ms = toMs(v);
        return ms == null ? "" : `<t:${Math.floor(ms / 1000)}:${style}>`;
    },
    date: (v) => {
        const ms = toMs(v);
        return ms == null ? "" : new Date(ms).toLocaleDateString("vi-VN", { timeZone: TZ });
    },
    datetime: (v) => {
        const ms = toMs(v);
        return ms == null ? "" : new Date(ms).toLocaleString("vi-VN", { timeZone: TZ, hour12: false });
    },
    join: (v, sep = ", ") => (Array.isArray(v) ? v.map(stringify).join(stringify(sep).replace(/\\n/g, "\n")) : stringify(v)),
    length: (v) => (Array.isArray(v) || typeof v === "string" ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0),
    first: (v) => (Array.isArray(v) ? v[0] : v),
    last: (v) => (Array.isArray(v) ? v[v.length - 1] : v),
    map: (v, key) => (Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? x[key] : x)) : v),
    mention: (v) => (v ? `<@${typeof v === "object" ? v.id : v}>` : ""),
    channel: (v) => (v ? `<#${typeof v === "object" ? v.id : v}>` : ""),
    role: (v) => (v ? `<@&${typeof v === "object" ? v.id : v}>` : ""),
    code: (v) => (stringify(v) ? `\`${stringify(v)}\`` : ""),
    codeblock: (v, lang = "") => `\`\`\`${lang}\n${stringify(v)}\n\`\`\``,
    bold: (v) => (stringify(v) ? `**${stringify(v)}**` : ""),
    italic: (v) => (stringify(v) ? `*${stringify(v)}*` : ""),
    json: (v) => JSON.stringify(v === MISSING ? null : v),
    url: (v) => encodeURIComponent(stringify(v)),
};

/** Documented for the Embeds page. */
const FILTER_DOCS = {
    money: "50000 → 50.000đ",
    vnd: "50000 → 50.000 ₫ (kiểu formatMoney)",
    number: "1234567 → 1.234.567",
    round: "round:2 — làm tròn",
    "plus / minus / times / div": "plus:1 — cộng/trừ/nhân/chia",
    "upper / lower / capitalize / trim": "đổi chữ hoa/thường",
    trunc: "trunc:50 — cắt còn 50 ký tự",
    replace: 'replace:"a":"b"',
    default: 'default:"Không có" — khi rỗng',
    yesno: 'yesno:"Có":"Không"',
    time: "time:f / time:R / time:d … — mốc giờ Discord",
    "date / datetime": "ngày (giờ VN)",
    join: 'join:", " — nối danh sách',
    "length / first / last": "danh sách",
    map: "map:name — lấy một trường của mỗi phần tử",
    "mention / channel / role": "id → <@id> <#id> <@&id>",
    "code / codeblock / bold / italic": "định dạng",
    "json / url": "JSON / mã hóa cho URL",
};

// ── Colors, emoji ────────────────────────────────────────────────────────────

function parseColor(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return v >= 0 && v <= 0xffffff ? Math.floor(v) : null;
    const s = String(v).trim();
    if (/^#?[0-9a-f]{6}$/i.test(s)) return parseInt(s.replace("#", ""), 16);
    if (/^#?[0-9a-f]{3}$/i.test(s)) return parseInt(s.replace("#", "").replace(/./g, (c) => c + c), 16);
    if (/^\d+$/.test(s)) return parseColor(Number(s));
    return null;
}

/** "✅" | "<:name:id>" | "<a:name:id>" | "id" → API emoji object, or null. */
function parseEmoji(v) {
    const s = String(v ?? "").trim();
    if (!s) return null;
    const m = /^<(a?):([\w~]+):(\d{15,25})>$/.exec(s);
    if (m) return { animated: !!m[1], name: m[2], id: m[3] };
    if (/^\d{15,25}$/.test(s)) return { id: s };
    return { name: s };
}

const STYLES = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };
const styleOf = (s, fallback = 2) => {
    if (typeof s === "number") return s >= 1 && s <= 4 ? s : fallback;
    return STYLES[String(s || "").toLowerCase()] && STYLES[String(s).toLowerCase()] !== 5 ? STYLES[String(s).toLowerCase()] : fallback;
};

const isUrl = (u) => typeof u === "string" && /^(https?:\/\/|attachment:\/\/)\S+$/.test(u);

// ── Messages ─────────────────────────────────────────────────────────────────

const tidy = (s) => s.replace(/^\s*\n|\n\s*$/g, "").replace(/[ \t]+$/gm, "");
const str = (src, frames) => tidy(interpolate(src, frames));

function renderEmbed(e, frames) {
    const out = {};
    const author = e.author && { name: str(e.author.name, frames), url: str(e.author.url, frames), icon_url: str(e.author.icon_url, frames) };
    if (author?.name) out.author = { name: author.name, ...(isUrl(author.url) ? { url: author.url } : {}), ...(isUrl(author.icon_url) ? { icon_url: author.icon_url } : {}) };
    const title = str(e.title, frames);
    if (title) out.title = title;
    const url = str(e.url, frames);
    if (url && isUrl(url) && title) out.url = url;
    const description = str(e.description, frames);
    if (description) out.description = description;
    const color = parseColor(typeof e.color === "string" ? str(e.color, frames) : e.color);
    if (color != null) out.color = color;
    const fields = [];
    for (const f of e.fields || []) {
        const items = f.each ? evalValue(f.each, frames) : [null];
        const list = f.each ? (Array.isArray(items) ? items : items && items !== MISSING ? [items] : []) : items;
        list.forEach((item, i) => {
            const fr = f.each
                ? [...frames, { ...(item && typeof item === "object" ? item : {}), "@index": i, "@number": i + 1, "@first": i === 0, "@last": i === list.length - 1, this: item }]
                : frames;
            if (f.if && !evalCond(f.if, fr)) return;
            const name = str(f.name, fr);
            const value = str(f.value, fr);
            if (!name && !value) return;
            fields.push({ name: name || "​", value: value || "​", inline: !!f.inline });
        });
    }
    if (fields.length) out.fields = fields;
    const thumb = str(e.thumbnail?.url, frames);
    if (isUrl(thumb)) out.thumbnail = { url: thumb };
    const image = str(e.image?.url, frames);
    if (isUrl(image)) out.image = { url: image };
    const footer = e.footer && { text: str(e.footer.text, frames), icon_url: str(e.footer.icon_url, frames) };
    if (footer?.text) out.footer = { text: footer.text, ...(isUrl(footer.icon_url) ? { icon_url: footer.icon_url } : {}) };
    if (e.timestamp === true) out.timestamp = new Date().toISOString();
    else if (typeof e.timestamp === "string" && e.timestamp) {
        const ms = toMs(str(e.timestamp, frames));
        if (ms != null) out.timestamp = new Date(ms).toISOString();
    }
    const visible = ["author", "title", "description", "fields", "thumbnail", "image", "footer"].some((k) => out[k]);
    return visible ? out : null;
}

/**
 * Buttons of a message.
 * spec   the template's components: [[{ slot, label, emoji, style, if } | { type: "link", label, emoji, url, if }], …]
 * slots  the catalog's slot defaults { name: { label, emoji, style } }
 * present what the code offers this time { name: { customId | url, disabled, style } } — a slot
 *        not offered is skipped; one offered but not placed by the template is appended,
 *        so a template can never remove a button the bot needs.
 */
function renderComponents(spec, frames, slots = {}, present = {}) {
    const rows = [];
    const used = new Set();
    const button = (item, data, d) => {
        const label = str(item.label ?? d.label ?? "", frames).slice(0, LIMITS.buttonLabel);
        const emoji = parseEmoji(str(item.emoji ?? d.emoji ?? "", frames));
        const url = data?.url ? (item.url ? str(item.url, frames) : data.url) : item.type === "link" ? str(item.url, frames) : null;
        const b = { type: 2 };
        if (url != null) {
            if (!/^https?:\/\/\S+$/.test(url)) return null;
            b.style = 5;
            b.url = url;
        } else {
            b.style = styleOf(item.style ?? d.style ?? data.style);
            b.custom_id = data.customId;
        }
        if (label) b.label = label;
        if (emoji) b.emoji = emoji;
        if (!label && !emoji) b.label = d.label || "•";
        if (data?.disabled) b.disabled = true;
        return b;
    };
    for (const row of Array.isArray(spec) ? spec : []) {
        const out = [];
        for (const item of Array.isArray(row) ? row : [row]) {
            if (!item || (item.if && !evalCond(item.if, frames))) continue;
            if (item.slot) {
                const data = present[item.slot];
                if (!data || used.has(item.slot)) continue;
                used.add(item.slot);
                const b = button(item, data, slots[item.slot] || {});
                if (b) out.push(b);
            } else if (item.type === "link" || item.url) {
                const b = button({ ...item, type: "link" }, null, {});
                if (b) out.push(b);
            }
        }
        for (let i = 0; i < out.length; i += LIMITS.perRow) rows.push({ type: 1, components: out.slice(i, i + LIMITS.perRow) });
    }
    const rest = Object.keys(present)
        .filter((k) => !used.has(k))
        .map((k) => button({}, present[k], slots[k] || {}))
        .filter(Boolean);
    for (let i = 0; i < rest.length; i += LIMITS.perRow) rows.push({ type: 1, components: rest.slice(i, i + LIMITS.perRow) });
    return rows;
}

/**
 * A message template + scope → { content?, embeds, components } in Discord API
 * shape. Throws TemplateError on a malformed template.
 */
function renderMessage(tpl, scope, { slots = {}, present = {} } = {}) {
    const frames = toFrames(scope);
    const msg = { embeds: [], components: [] };
    const content = str(tpl?.content, frames);
    if (content) msg.content = content;
    for (const e of tpl?.embeds || []) {
        if (e.if && !evalCond(e.if, frames)) continue;
        const out = renderEmbed(e, frames);
        if (out) msg.embeds.push(out);
    }
    msg.components = renderComponents(tpl?.components, frames, slots, present);
    return msg;
}

const embedChars = (e) =>
    (e.title || "").length +
    (e.description || "").length +
    (e.footer?.text || "").length +
    (e.author?.name || "").length +
    (e.fields || []).reduce((s, f) => s + f.name.length + f.value.length, 0);

/** Discord's limits on a RENDERED message → list of problems (empty = sendable). */
function validateMessage(msg, { allowEmpty = false } = {}) {
    const errs = [];
    if (!allowEmpty && !msg.content && !(msg.embeds || []).length) errs.push("Tin nhắn trống — cần nội dung hoặc ít nhất một embed");
    if ((msg.content || "").length > LIMITS.content) errs.push(`Nội dung dài ${msg.content.length}/${LIMITS.content} ký tự`);
    if ((msg.embeds || []).length > LIMITS.embeds) errs.push(`Tối đa ${LIMITS.embeds} embed`);
    let total = 0;
    (msg.embeds || []).forEach((e, i) => {
        const n = `Embed ${i + 1}`;
        if ((e.title || "").length > LIMITS.title) errs.push(`${n}: tiêu đề quá ${LIMITS.title} ký tự`);
        if ((e.description || "").length > LIMITS.description) errs.push(`${n}: mô tả quá ${LIMITS.description} ký tự`);
        if ((e.fields || []).length > LIMITS.fields) errs.push(`${n}: quá ${LIMITS.fields} field`);
        (e.fields || []).forEach((f, j) => {
            if (f.name.length > LIMITS.fieldName) errs.push(`${n}, field ${j + 1}: tên quá ${LIMITS.fieldName} ký tự`);
            if (f.value.length > LIMITS.fieldValue) errs.push(`${n}, field ${j + 1}: giá trị quá ${LIMITS.fieldValue} ký tự`);
        });
        if ((e.footer?.text || "").length > LIMITS.footer) errs.push(`${n}: footer quá ${LIMITS.footer} ký tự`);
        if ((e.author?.name || "").length > LIMITS.author) errs.push(`${n}: tác giả quá ${LIMITS.author} ký tự`);
        total += embedChars(e);
    });
    if (total > LIMITS.embedTotal) errs.push(`Tổng chữ trong các embed ${total}/${LIMITS.embedTotal}`);
    if ((msg.components || []).length > LIMITS.rows) errs.push(`Tối đa ${LIMITS.rows} hàng nút`);
    return errs;
}

/** Every template string in a message template parses → list of problems. */
function checkMessage(tpl) {
    const errs = [];
    const at = (where, src) => {
        if (src == null || src === "") return;
        try {
            check(src);
        } catch (e) {
            errs.push(`${where}: ${e.message}`);
        }
    };
    at("Nội dung", tpl?.content);
    (tpl?.embeds || []).forEach((e, i) => {
        const n = `Embed ${i + 1}`;
        at(`${n} · điều kiện`, e.if && `{#if ${e.if}}{/if}`);
        at(`${n} · tác giả`, e.author?.name);
        at(`${n} · link tác giả`, e.author?.url);
        at(`${n} · ảnh tác giả`, e.author?.icon_url);
        at(`${n} · tiêu đề`, e.title);
        at(`${n} · link tiêu đề`, e.url);
        at(`${n} · mô tả`, e.description);
        at(`${n} · màu`, typeof e.color === "string" ? e.color : null);
        (e.fields || []).forEach((f, j) => {
            at(`${n} · field ${j + 1}`, f.name);
            at(`${n} · field ${j + 1}`, f.value);
            at(`${n} · field ${j + 1} · điều kiện`, f.if && `{#if ${f.if}}{/if}`);
            at(`${n} · field ${j + 1} · lặp`, f.each && `{${f.each}}`);
        });
        at(`${n} · thumbnail`, e.thumbnail?.url);
        at(`${n} · ảnh`, e.image?.url);
        at(`${n} · footer`, e.footer?.text);
        at(`${n} · ảnh footer`, e.footer?.icon_url);
        at(`${n} · thời gian`, typeof e.timestamp === "string" ? e.timestamp : null);
    });
    (Array.isArray(tpl?.components) ? tpl.components : []).forEach((row, r) =>
        (Array.isArray(row) ? row : [row]).forEach((b, i) => {
            const n = `Nút ${r + 1}.${i + 1}`;
            at(n, b?.label);
            at(`${n} · emoji`, b?.emoji);
            at(`${n} · link`, b?.url);
            at(`${n} · điều kiện`, b?.if && `{#if ${b.if}}{/if}`);
        }),
    );
    errs.push(...checkSelects(tpl?.selects));
    return errs;
}

// ── Cards (Components V2 views) ──────────────────────────────────────────────
// The layout is built by the bot (it holds dynamic lists); a card template is
// its words: { color, texts: { slot: "…" }, buttons: { slot: { label, emoji, style } },
// selects: { slot: { placeholder, label, description } } } — an override sets any subset.

/** Select menus (of a message or a card): placeholder, the label / description of each
 * dynamic option, and fixed options by value: { options: { value: { label, description, emoji } } }. */
function checkSelects(selects) {
    const errs = [];
    const at = (where, src) => {
        if (src == null || src === "") return;
        try {
            check(src);
        } catch (e) {
            errs.push(`${where}: ${e.message}`);
        }
    };
    for (const [k, v] of Object.entries(selects || {})) {
        at(`Menu "${k}"`, v?.placeholder);
        at(`Menu "${k}" · nhãn`, v?.label);
        at(`Menu "${k}" · mô tả`, v?.description);
        for (const [val, o] of Object.entries(v?.options || {})) {
            at(`Menu "${k}" · lựa chọn "${val}"`, o?.label);
            at(`Menu "${k}" · lựa chọn "${val}" · mô tả`, o?.description);
            at(`Menu "${k}" · lựa chọn "${val}" · emoji`, o?.emoji);
        }
    }
    return errs;
}

/** Deep-merge select menus per slot (and fixed options per value). */
function mergeSelects(def = {}, over = {}) {
    const out = {};
    for (const k of new Set([...Object.keys(def || {}), ...Object.keys(over || {})])) {
        const d = def?.[k] || {};
        const o = over?.[k] || {};
        const options = {};
        for (const v of new Set([...Object.keys(d.options || {}), ...Object.keys(o.options || {})])) options[v] = { ...(d.options?.[v] || {}), ...(o.options?.[v] || {}) };
        out[k] = { ...d, ...o, ...(Object.keys(options).length ? { options } : {}) };
    }
    return out;
}

function mergeCard(def = {}, over = {}) {
    const pick = (a = {}, b = {}) => {
        const out = { ...a };
        for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...(a[k] || {}), ...v } : v;
        return out;
    };
    return {
        color: over.color ?? def.color ?? null,
        texts: { ...(def.texts || {}), ...(over.texts || {}) },
        buttons: pick(def.buttons, over.buttons),
        selects: mergeSelects(def.selects, over.selects),
    };
}

function checkCard(card) {
    const errs = [];
    const at = (where, src) => {
        if (src == null || src === "") return;
        try {
            check(src);
        } catch (e) {
            errs.push(`${where}: ${e.message}`);
        }
    };
    if (typeof card?.color === "string") at("Màu", card.color);
    for (const [k, v] of Object.entries(card?.texts || {})) at(`Chữ "${k}"`, v);
    for (const [k, v] of Object.entries(card?.buttons || {})) {
        at(`Nút "${k}"`, v?.label);
        at(`Nút "${k}" · emoji`, v?.emoji);
    }
    errs.push(...checkSelects(card?.selects));
    return errs;
}

// ── Variables: types, samples, docs ──────────────────────────────────────────
// A catalog (what a bot announces) names the variables of each template with
// types: "user", "order?", "decoItem[]", or { type, label, example }. Types are
// the standard ones below plus the bot's own ({ label, fields: { name: { type?,
// label, example } } }). Samples drive the preview; docs drive the variable list.

const PRIMITIVES = {
    string: { label: "Chữ", example: "Ví dụ" },
    text: { label: "Đoạn chữ", example: "Dòng 1\nDòng 2" },
    number: { label: "Số", example: 3 },
    money: { label: "Số tiền (VND)", example: 150000 },
    time: { label: "Thời điểm (ms)", example: 1791100800000 },
    boolean: { label: "Đúng/sai", example: true },
    url: { label: "Link", example: "https://discord.com" },
    id: { label: "ID Discord", example: "871329074046435338" },
    color: { label: "Màu", example: "#9f92ff" },
    any: { label: "Bất kỳ", example: "…" },
};

const STANDARD_TYPES = {
    user: {
        label: "Người dùng Discord",
        text: "mention",
        fields: {
            id: { type: "id", label: "ID", example: "1133037157527859230" },
            mention: { label: "Nhắc (@)", example: "<@1133037157527859230>" },
            tag: { label: "Tag", example: "khachhang" },
            username: { label: "Username", example: "khachhang" },
            displayName: { label: "Tên hiển thị", example: "Khách Hàng" },
            avatar: { type: "url", label: "Ảnh đại diện", example: "https://cdn.discordapp.com/embed/avatars/1.png" },
            bot: { type: "boolean", label: "Là bot", example: false },
            createdAt: { type: "time", label: "Ngày tạo tài khoản", example: 1600000000000 },
        },
    },
    member: {
        label: "Thành viên server",
        text: "mention",
        fields: {
            id: { type: "id", label: "ID", example: "1133037157527859230" },
            mention: { label: "Nhắc (@)", example: "<@1133037157527859230>" },
            tag: { label: "Tag", example: "khachhang" },
            username: { label: "Username", example: "khachhang" },
            displayName: { label: "Tên trong server", example: "Khách Hàng" },
            avatar: { type: "url", label: "Ảnh đại diện", example: "https://cdn.discordapp.com/embed/avatars/1.png" },
            joinedAt: { type: "time", label: "Ngày vào server", example: 1700000000000 },
            roles: { type: "string", label: "Các role (tên)", example: "Buyer, Member" },
        },
    },
    guild: {
        label: "Server",
        text: "name",
        fields: {
            id: { type: "id", label: "ID", example: "1103736775815471257" },
            name: { label: "Tên", example: "ArnTo Shop" },
            icon: { type: "url", label: "Icon", example: "https://cdn.discordapp.com/embed/avatars/0.png" },
            invite: { label: "Mã mời", example: "v36HEnJPsN" },
            inviteUrl: { type: "url", label: "Link mời", example: "https://discord.gg/v36HEnJPsN" },
            memberCount: { type: "number", label: "Số thành viên", example: 1234 },
        },
    },
    channel: {
        label: "Kênh",
        text: "mention",
        fields: {
            id: { type: "id", label: "ID", example: "1237378538173370399" },
            name: { label: "Tên", example: "hang-cho" },
            mention: { label: "Nhắc (#)", example: "<#1237378538173370399>" },
            url: { type: "url", label: "Link", example: "https://discord.com/channels/1/2" },
        },
    },
    role: {
        label: "Role",
        text: "mention",
        fields: {
            id: { type: "id", label: "ID", example: "1205054627016343563" },
            name: { label: "Tên", example: "Buyer" },
            mention: { label: "Nhắc", example: "<@&1205054627016343563>" },
        },
    },
};

/** Every template gets these. `custom` holds the panel's own variables. */
const GLOBAL_VARS = {
    bot: { type: "user", label: "Bot đang gửi" },
    guild: { type: "guild", label: "Server chính của bot" },
    now: { type: "time", label: "Lúc gửi" },
    custom: { type: "custom", label: "Biến tùy chỉnh (trang Embeds → Biến tùy chỉnh)" },
};

const parseType = (spec) => {
    const s = typeof spec === "string" ? { type: spec } : { ...(spec || {}) };
    let t = String(s.type || "any");
    s.optional = t.endsWith("?");
    t = t.replace(/\?$/, "");
    s.list = t.endsWith("[]");
    s.type = t.replace(/\[\]$/, "");
    return s;
};

function sampleOf(spec, types, depth = 0) {
    const s = parseType(spec);
    const one = () => {
        if (s.example !== undefined) return s.example;
        if (PRIMITIVES[s.type]) return PRIMITIVES[s.type].example;
        const t = types[s.type] || STANDARD_TYPES[s.type];
        if (!t || depth > 4) return "…";
        const obj = {};
        for (const [k, f] of Object.entries(t.fields || {})) obj[k] = sampleOf(f.type ? f : { ...f, type: "string" }, types, depth + 1);
        if (t.text && obj[t.text] !== undefined) obj.__text = String(obj[t.text]);
        return obj;
    };
    return s.list ? [one(), one()] : one();
}

/**
 * Preview data for a template: globals (the standard ones + the bot's own,
 * `catalogGlobals`) + its variables, from the examples.
 */
function buildSample(def, catalogTypes = {}, custom = {}, catalogGlobals = {}) {
    const types = { ...STANDARD_TYPES, ...catalogTypes };
    const scope = {};
    for (const [k, v] of Object.entries(GLOBAL_VARS)) if (k !== "custom") scope[k] = sampleOf(v, types);
    for (const [k, v] of Object.entries(catalogGlobals || {})) scope[k] = sampleOf(v, types);
    scope.now = Date.now();
    scope.custom = { ...custom };
    for (const [k, v] of Object.entries(def?.vars || {})) scope[k] = sampleOf(v, types);
    return scope;
}

/**
 * Preview data for one slot of a template (a card's text, a menu's options):
 * its slotVars on top — a type name spreads that type's fields (one list item),
 * a map adds named variables.
 */
function buildSlotSample(def, catalogTypes = {}, custom = {}, catalogGlobals = {}, slot = null) {
    const scope = buildSample(def, catalogTypes, custom, catalogGlobals);
    const extra = slot ? def?.slotVars?.[slot] : null;
    if (!extra) return scope;
    const types = { ...STANDARD_TYPES, ...catalogTypes };
    if (typeof extra === "string") {
        const item = sampleOf(extra, types);
        if (item && typeof item === "object") Object.assign(scope, item, { index: item.index ?? 1, "@index": 0, "@number": 1 });
    } else {
        for (const [k, v] of Object.entries(extra)) scope[k] = sampleOf(v, types);
    }
    return scope;
}

/** The extra variables one slot sees (see buildSlotSample), as variable-list nodes. */
function describeSlotVars(def, catalogTypes = {}, slot = null) {
    const extra = slot ? def?.slotVars?.[slot] : null;
    if (!extra) return [];
    const fake = typeof extra === "string" ? { vars: { __item: extra } } : { vars: extra };
    const { vars } = describeVars(fake, catalogTypes);
    if (typeof extra !== "string") return vars;
    const strip = (n) => ({ ...n, path: n.path.replace(/^__item./, ""), children: (n.children || []).map(strip) });
    return (vars[0]?.children || []).map(strip);
}

/** Tree of { path, label, type, list, optional, children } for the variable list. */
function describeVars(def, catalogTypes = {}, custom = {}, catalogGlobals = {}) {
    const types = { ...STANDARD_TYPES, ...catalogTypes };
    const node = (path, spec, depth) => {
        const s = parseType(spec);
        const t = types[s.type];
        const label = s.label || t?.label || PRIMITIVES[s.type]?.label || s.type;
        const children =
            t && depth < 4
                ? Object.entries(t.fields || {}).map(([k, f]) => node(s.list ? k : `${path}.${k}`, f.type ? f : { ...f, type: "string" }, depth + 1))
                : [];
        return { path, label, type: s.type, list: s.list, optional: s.optional, children };
    };
    const out = Object.entries(def?.vars || {}).map(([k, v]) => node(k, v, 0));
    const globals = Object.entries(GLOBAL_VARS)
        .filter(([k]) => k !== "custom")
        .map(([k, v]) => node(k, v, 0));
    for (const [k, v] of Object.entries(catalogGlobals || {})) globals.push(node(k, v, 0));
    globals.push({
        path: "custom",
        label: GLOBAL_VARS.custom.label,
        type: "custom",
        children: Object.keys(custom).map((k) => ({ path: `custom.${k}`, label: String(custom[k]).slice(0, 60), type: "string", children: [] })),
    });
    return { vars: out, globals };
}

const api = {
    LIMITS,
    TemplateError,
    FILTERS,
    FILTER_DOCS,
    STANDARD_TYPES,
    PRIMITIVES,
    GLOBAL_VARS,
    parse,
    check,
    interpolate,
    renderMessage,
    renderComponents,
    validateMessage,
    checkMessage,
    mergeCard,
    mergeSelects,
    checkCard,
    checkSelects,
    parseColor,
    parseEmoji,
    buildSample,
    buildSlotSample,
    describeVars,
    describeSlotVars,
};

module.exports = api;
