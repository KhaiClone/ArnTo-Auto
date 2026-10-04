/**
 * AutoDecoGift.js
 * Auto Deco Gift — buyers pick decors on a Discord panel (/dg-setup), pay by QR,
 * an admin hands over the gift links.
 *  - Catalog / cart / views (Components V2, every view ephemeral)
 *  - Payment (AutoBank, like AutoRobux)
 *  - Orders: the shop's order through the bot-panel, the staff-channel message,
 *    approve (links → ArnTo-assistant DMs them) / cancel, retries
 *
 * The other half is the bot-panel (server/services/decorGiftService.js): it reads
 * the decor data, asks ArnTo-Shop to open / complete / cancel the order and
 * ArnTo-assistant to DM the links, all over its Discord bus.
 */

const { nanoid } = require("nanoid");
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    MessageFlags,
    ModalBuilder,
    SectionBuilder,
    SeparatorBuilder,
    StringSelectMenuBuilder,
    TextDisplayBuilder,
    TextInputBuilder,
    TextInputStyle,
    ThumbnailBuilder,
} = require("discord.js");
const panel = require("./PanelDecoGift");

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_ITEMS = 5; // one approve form holds at most 5 inputs
const EXPIRE_MS = 10 * 60 * 1000; // QR window, as AutoBank
const CART_TTL_MS = 30 * 60 * 1000;
const CATS_PER_PAGE = 25;
const DECOS_PER_PAGE = 6;
const SEARCH_MAX = 8;
const RETRY_AFTER_MS = 2 * 60 * 1000;
const MAX_TRIES = 24; // automatic retries of one step (~2h at the 5-minute sweep)
const PAY_DB = "dg_payments"; // waiting for the transfer
const ORDER_DB = "dg_orders"; // paid
const GIFT_LINK =
    /^(?:https?:\/\/)?(?:www\.)?(?:discord\.gift|discord(?:app)?\.com\/gifts)\/([A-Za-z0-9]{8,32})\/?$/i;

// In memory: lost on restart, which only costs an unpaid cart.
const _carts = new Map(); // userId → { skus, at, search: { skus, query } }
const _locks = new Set(); // order / payment ids being worked on
const _linkDrafts = new Map(); // order id → links typed in a form that failed validation

// quick.db rewrites a whole key per write: two read-modify-writes of dg_orders
// (or dg_payments) running at once would lose one. Every write goes through here.
let _dbChain = Promise.resolve();
const _serial = (fn) => {
    const run = _dbChain.then(fn, fn);
    _dbChain = run.catch(() => {});
    return run;
};

// ── Small helpers ──────────────────────────────────────────────────────────────

const money = (n) => `${Number(n || 0).toLocaleString("vi-VN")}đ`;
const trunc = (s, n) => {
    s = String(s ?? "");
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const ts = (ms) => `<t:${Math.floor(ms / 1000)}:f>`;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : 0));
const text = (s) => new TextDisplayBuilder().setContent(s);
const sep = () => new SeparatorBuilder();
const settings = (client) => client.configs.settings;
const accent = (client) => client.funcs.hexToInt(client.configs.embed.color);
const shopUrl = (sku) => `https://discord.com/shop#itemSkuId=${sku}`;
const v2 = (container) => ({ components: [container], flags: MessageFlags.IsComponentsV2 });

function isEnabled(client) {
    const s = settings(client);
    return panel.isEnabled() && !!s.decoGiftStaffChannelId && !!s.bankAccount;
}

/** What is missing before the panel can sell (for /dg-setup). */
function missingConfig(client) {
    const s = settings(client);
    const out = [];
    if (!panel.isEnabled()) out.push("PANEL_API_URL / PANEL_API_KEY");
    if (!s.decoGiftStaffChannelId) out.push("DECO_GIFT_STAFF_CHANNEL_ID");
    if (!s.bankAccount) out.push("BANK_CODE / BANK_ACCOUNT / BANK_HOLDER");
    return out;
}

function parseGiftLink(raw) {
    const m = GIFT_LINK.exec(String(raw || "").trim());
    return m ? `https://discord.gift/${m[1]}` : null;
}
const maskLink = (link) => {
    const code = String(link).split("/").pop();
    return `discord.gift/${code.slice(0, 4)}…${code.slice(-4)}`;
};

// Discord refuses the WHOLE message over one bad media URL (an imported decor
// may carry anything), so a picture is shown only when it is plainly usable.
const usableUrl = (url) => typeof url === "string" && url.length <= 2000 && /^https?:\/\/\S+$/.test(url);

/** A decor line with its picture beside it (text only when there is none). */
function addDecor(container, d, line) {
    if (!usableUrl(d.thumb)) return container.addTextDisplayComponents(text(line));
    return container.addSectionComponents(
        new SectionBuilder()
            .addTextDisplayComponents(text(line))
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(d.thumb).setDescription(trunc(d.name, 1000))),
    );
}

function decorLine(d, { inCart = false, index = null } = {}) {
    const head = `**${index != null ? `${index}. ` : ""}${d.name}**${inCart ? " ✓" : ""}`;
    const members = d.members?.length ? `\n-# Gồm: ${trunc(d.members.join(", "), 160)}` : "";
    return `${head}\n${d.typeLabel} · **${money(d.price)}**${members}`;
}

const cartButton = (cart) =>
    new ButtonBuilder()
        .setCustomId("dg:cart")
        .setLabel(`Giỏ hàng (${cart.skus.length}/${MAX_ITEMS})`)
        .setEmoji("🛒")
        .setStyle(ButtonStyle.Success);

// ── Cart ───────────────────────────────────────────────────────────────────────

function cartOf(userId) {
    let cart = _carts.get(userId);
    if (!cart || Date.now() - cart.at > CART_TTL_MS) {
        cart = { skus: [], search: null };
        _carts.set(userId, cart);
    }
    cart.at = Date.now();
    return cart;
}

function purgeCarts() {
    for (const [id, cart] of _carts) if (Date.now() - cart.at > CART_TTL_MS) _carts.delete(id);
}

/** → { added: names, full: names } — never past MAX_ITEMS, never twice. */
function addToCart(userId, skus, catalog) {
    const cart = cartOf(userId);
    const added = [];
    const full = [];
    for (const sku of skus) {
        const d = catalog.index.get(sku);
        if (!d || cart.skus.includes(sku)) continue;
        if (cart.skus.length >= MAX_ITEMS) {
            full.push(d.name);
            continue;
        }
        cart.skus.push(sku);
        added.push(d.name);
    }
    return { added, full };
}

function removeFromCart(userId, skus) {
    const cart = cartOf(userId);
    cart.skus = cart.skus.filter((s) => !skus.includes(s));
}

function clearCart(userId) {
    cartOf(userId).skus = [];
}

/** From an add menu → the note to show above the list. */
async function addSkus(userId, skus) {
    const catalog = await panel.getCatalog();
    return addedNote(addToCart(userId, skus, catalog)) || "Các deco này đã có trong giỏ.";
}

const addedNote = ({ added, full }) =>
    [
        added.length ? `✅ Đã thêm vào giỏ: ${trunc(added.join(", "), 300)}` : null,
        full.length ? `⚠️ Giỏ đã đủ ${MAX_ITEMS} deco, chưa thêm: ${trunc(full.join(", "), 200)}` : null,
    ]
        .filter(Boolean)
        .join("\n");

// ── Views ──────────────────────────────────────────────────────────────────────

function loadingView() {
    return v2(new ContainerBuilder().addTextDisplayComponents(text("⏳ Đang tải…")));
}

function messageView(client, content) {
    return v2(new ContainerBuilder().setAccentColor(accent(client)).addTextDisplayComponents(text(content)));
}

/** The public panel /dg-setup posts (embed + three buttons). */
function panelMessage(client) {
    return {
        embeds: [
            client.embed(
                [
                    "Mua **Deco Discord dạng quà tặng (Gift)** — avatar, hiệu ứng hồ sơ, nameplate, khung, bundle. Chọn deco, quét QR là xong, không cần gõ lệnh.",
                    "",
                    "**Cách mua**",
                    "1. Bấm **Bộ sưu tập** để xem theo bộ, hoặc **Tìm / dán link** để gõ tên deco hay dán link shop Discord.",
                    `2. Chọn tối đa **${MAX_ITEMS} deco** mỗi đơn, xem lại ảnh trong **Giỏ hàng**.`,
                    "3. Bấm **Thanh toán** và quét QR (hết hạn sau 10 phút).",
                    "4. Admin duyệt đơn, link quà được gửi qua **tin nhắn riêng** — nhớ mở DM.",
                ].join("\n"),
                { title: "🎁 Deco Gift — Mua tự động" },
            ),
        ],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("dg:browse").setLabel("Bộ sưu tập").setEmoji("🛍️").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("dg:search").setLabel("Tìm / dán link").setEmoji("🔎").setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId("dg:cart").setLabel("Giỏ hàng").setEmoji("🛒").setStyle(ButtonStyle.Success),
            ),
        ],
    };
}

async function categoriesView(client, userId, page = 0, note = "") {
    const catalog = await panel.getCatalog();
    const cart = cartOf(userId);
    const cats = catalog.categories;
    const pages = Math.max(1, Math.ceil(cats.length / CATS_PER_PAGE));
    page = clamp(page, 0, pages - 1);
    const slice = cats.slice(page * CATS_PER_PAGE, (page + 1) * CATS_PER_PAGE);

    const c = new ContainerBuilder()
        .setAccentColor(accent(client))
        .addTextDisplayComponents(
            text(
                `## 🛍️ Bộ sưu tập\nChọn một bộ để xem deco và giá Gift — bộ mới nhất ở trên.${note ? `\n${note}` : ""}`,
            ),
        );
    if (!slice.length) {
        c.addTextDisplayComponents(text("*Hiện chưa có deco nào bán dạng Gift.*"));
    } else {
        c.addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId("dg:cat")
                    .setPlaceholder(`Chọn bộ sưu tập (trang ${page + 1}/${pages})`)
                    .addOptions(
                        slice.map((k) => {
                            const prices = (catalog.byCategory.get(k.sku_id) || []).map((d) => d.price);
                            return {
                                label: trunc(k.name, 100),
                                value: k.sku_id,
                                description: trunc(`${k.count} deco · từ ${money(Math.min(...prices))}`, 100),
                            };
                        }),
                    ),
            ),
        );
    }
    c.addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dg:cats:${page - 1}`).setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId(`dg:cats:${page + 1}`).setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
            new ButtonBuilder().setCustomId("dg:search").setLabel("Tìm / dán link").setEmoji("🔎").setStyle(ButtonStyle.Secondary),
            cartButton(cart),
        ),
    );
    return v2(c);
}

/** One add-to-cart menu for a list of decors on screen. */
function addMenu(customId, decors, cart) {
    const room = MAX_ITEMS - cart.skus.length;
    const menu = new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(room > 0 ? `Chọn deco để thêm vào giỏ (còn ${room} chỗ)` : `Giỏ đã đủ ${MAX_ITEMS} deco`)
        .setMinValues(1)
        .setMaxValues(Math.max(1, Math.min(decors.length, room)))
        .setDisabled(room <= 0)
        .addOptions(
            decors.map((d) => ({
                label: trunc(d.name, 100),
                value: d.sku_id,
                description: trunc(`${cart.skus.includes(d.sku_id) ? "✓ Đã trong giỏ · " : ""}${d.typeLabel} · ${money(d.price)}`, 100),
            })),
        );
    return new ActionRowBuilder().addComponents(menu);
}

async function categoryView(client, userId, catSku, page = 0, note = "") {
    const catalog = await panel.getCatalog();
    const cart = cartOf(userId);
    const list = catalog.byCategory.get(catSku) || [];
    const catIndex = catalog.categories.findIndex((k) => k.sku_id === catSku);
    if (!list.length || catIndex < 0) {
        return categoriesView(client, userId, 0, "⚠️ Bộ này không còn deco bán dạng Gift.");
    }
    const pages = Math.ceil(list.length / DECOS_PER_PAGE);
    page = clamp(page, 0, pages - 1);
    const slice = list.slice(page * DECOS_PER_PAGE, (page + 1) * DECOS_PER_PAGE);

    const c = new ContainerBuilder()
        .setAccentColor(accent(client))
        .addTextDisplayComponents(
            text(
                `## ${catalog.categories[catIndex].name}\n${list.length} deco · trang ${page + 1}/${pages} · giỏ ${cart.skus.length}/${MAX_ITEMS}${note ? `\n${note}` : ""}`,
            ),
        );
    for (const d of slice) addDecor(c, d, decorLine(d, { inCart: cart.skus.includes(d.sku_id) }));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(addMenu(`dg:add:c:${catSku}:${page}`, slice, cart));
    c.addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dg:catv:${catSku}:${page - 1}`).setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId(`dg:catv:${catSku}:${page + 1}`).setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
            new ButtonBuilder()
                .setCustomId(`dg:cats:${Math.floor(catIndex / CATS_PER_PAGE)}`)
                .setLabel("Bộ khác")
                .setEmoji("↩️")
                .setStyle(ButtonStyle.Secondary),
            cartButton(cart),
        ),
    );
    return v2(c);
}

/** Ranked sku list for one search line: exact > prefix > contains > all words > its collection's name. */
function rank(query, catalog) {
    const q = panel.normalize(query);
    if (!q) return [];
    const words = q.split(" ");
    const catNorm = new Map(catalog.categories.map((k) => [k.sku_id, k.norm]));
    return catalog.decors
        .map((d) => {
            const n = d.norm;
            let score = 0;
            if (n === q) score = 100;
            else if (n.startsWith(q)) score = 80;
            else if (n.includes(q)) score = 60;
            else if (words.every((w) => n.includes(w))) score = 40;
            else {
                const cn = catNorm.get(d.category) || "";
                if (cn && (cn.includes(q) || words.every((w) => cn.includes(w)))) score = 30;
            }
            return [score, d];
        })
        .filter(([score]) => score > 0)
        .sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length)
        .map(([, d]) => d.sku_id);
}

/**
 * The search form: a shop link / SKU on a line goes straight into the cart,
 * a name becomes results to pick from.
 * → { view: "cart" | "search", note }
 */
async function runSearch(client, userId, input) {
    const catalog = await panel.getCatalog();
    const cart = cartOf(userId);
    const lines = String(input || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 10);
    const notes = [];
    const linked = [];
    const names = [];
    for (const line of lines) {
        const sku = (line.match(/itemSkuId=(\d+)/i) || line.match(/\b(\d{17,20})\b/))?.[1];
        if (!sku) {
            names.push(line);
            continue;
        }
        if (catalog.index.has(sku)) linked.push(sku);
        else notes.push(`⚠️ \`${trunc(line, 60)}\`: deco này không bán dạng Gift.`);
    }
    const added = addToCart(userId, linked, catalog);

    const perLine = names.map((q) => {
        const hits = rank(q, catalog);
        if (!hits.length) notes.push(`⚠️ Không tìm thấy “${trunc(q, 60)}”.`);
        return hits;
    });
    // Round robin, so every line gets its best matches on screen.
    const merged = [];
    for (let i = 0; merged.length < SEARCH_MAX && perLine.some((h) => h.length > i); i++) {
        for (const hits of perLine) {
            if (hits[i] && !merged.includes(hits[i]) && merged.length < SEARCH_MAX) merged.push(hits[i]);
        }
    }
    const note = [addedNote(added), ...notes].filter(Boolean).join("\n");
    if (!names.length) return { view: "cart", note };
    cart.search = { skus: merged, query: names.join(", ") };
    return { view: "search", note };
}

async function searchView(client, userId, note = "") {
    const catalog = await panel.getCatalog();
    const cart = cartOf(userId);
    const skus = (cart.search?.skus || []).filter((s) => catalog.index.has(s));
    const decors = skus.map((s) => catalog.index.get(s));

    const c = new ContainerBuilder()
        .setAccentColor(accent(client))
        .addTextDisplayComponents(
            text(
                `## 🔎 Kết quả tìm${cart.search?.query ? `: ${trunc(cart.search.query, 80)}` : ""}\ngiỏ ${cart.skus.length}/${MAX_ITEMS}${note ? `\n${note}` : ""}`,
            ),
        );
    if (!decors.length) {
        c.addTextDisplayComponents(
            text("Không có kết quả — thử gõ ngắn hơn (không cần dấu), tên bộ sưu tập, hoặc dán link shop Discord của deco."),
        );
    } else {
        for (const d of decors) addDecor(c, d, decorLine(d, { inCart: cart.skus.includes(d.sku_id) }));
        c.addSeparatorComponents(sep());
        c.addActionRowComponents(addMenu("dg:add:s", decors, cart));
    }
    c.addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("dg:search").setLabel("Tìm tiếp").setEmoji("🔎").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("dg:browse").setLabel("Bộ sưu tập").setEmoji("🛍️").setStyle(ButtonStyle.Secondary),
            cartButton(cart),
        ),
    );
    return v2(c);
}

async function cartView(client, userId, note = "") {
    const catalog = await panel.getCatalog();
    const cart = cartOf(userId);
    const gone = cart.skus.filter((s) => !catalog.index.has(s)).length;
    if (gone) {
        cart.skus = cart.skus.filter((s) => catalog.index.has(s));
        note = [note, `⚠️ ${gone} deco vừa ngừng bán dạng Gift nên đã được bỏ khỏi giỏ.`].filter(Boolean).join("\n");
    }
    const items = cart.skus.map((s) => catalog.index.get(s));
    const total = items.reduce((sum, d) => sum + d.price, 0);
    const full = items.length >= MAX_ITEMS;

    const c = new ContainerBuilder()
        .setAccentColor(accent(client))
        .addTextDisplayComponents(text(`## 🛒 Giỏ Deco Gift\n${items.length}/${MAX_ITEMS} deco${note ? `\n${note}` : ""}`));
    if (!items.length) {
        c.addTextDisplayComponents(text("Giỏ đang trống — chọn deco từ **Bộ sưu tập** hoặc **Tìm / dán link**."));
        c.addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("dg:browse").setLabel("Bộ sưu tập").setEmoji("🛍️").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("dg:search").setLabel("Tìm / dán link").setEmoji("🔎").setStyle(ButtonStyle.Secondary),
            ),
        );
        return v2(c);
    }
    items.forEach((d, i) => addDecor(c, d, decorLine(d, { index: i + 1 })));
    const pictures = items.filter((d) => usableUrl(d.image));
    if (pictures.length) {
        c.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                pictures.map((d) => new MediaGalleryItemBuilder().setURL(d.image).setDescription(trunc(d.name, 1000))),
            ),
        );
    }
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(
        text(
            `### Tổng: ${money(total)}\n-# Sau khi thanh toán, admin duyệt đơn và link quà được gửi qua tin nhắn riêng — nhớ mở DM.`,
        ),
    );
    c.addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId("dg:rm")
                .setPlaceholder("Bỏ bớt deco…")
                .setMinValues(1)
                .setMaxValues(items.length)
                .addOptions(items.map((d, i) => ({ label: trunc(`${i + 1}. ${d.name}`, 100), value: d.sku_id }))),
        ),
    );
    c.addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("dg:pay").setLabel(`Thanh toán ${money(total)}`).setEmoji("💳").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("dg:browse").setLabel("Chọn thêm").setEmoji("🛍️").setStyle(ButtonStyle.Secondary).setDisabled(full),
            new ButtonBuilder().setCustomId("dg:search").setLabel("Tìm / dán link").setEmoji("🔎").setStyle(ButtonStyle.Secondary).setDisabled(full),
            new ButtonBuilder().setCustomId("dg:clear").setLabel("Xóa giỏ").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
        ),
    );
    return v2(c);
}

function searchModal() {
    return new ModalBuilder()
        .setCustomId("dg:searchm")
        .setTitle("Tìm deco")
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("q")
                    .setLabel("Tên deco hoặc link shop (mỗi dòng 1 cái)")
                    .setPlaceholder("VD: Mèo Galaxy\nhttps://discord.com/shop#itemSkuId=...")
                    .setStyle(TextInputStyle.Paragraph)
                    .setMaxLength(1000)
                    .setRequired(true),
            ),
        );
}

// ── Payments ───────────────────────────────────────────────────────────────────

const _newPaymentId = () => `DG${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const _transferCode = () => `${nanoid(8).replaceAll("-", "").replaceAll("_", "")} Chuyen tien`;

function _vietQrUrl(client, amount, transferCode) {
    const s = settings(client);
    return `https://img.vietqr.io/image/${s.bankCode}-${s.bankAccount}-qr_only.png?addInfo=${encodeURIComponent(transferCode)}&accountName=${encodeURIComponent(s.bankHolder)}&amount=${amount}`;
}

async function _readPayments(client) {
    return (await client.db.get(PAY_DB)) ?? [];
}
async function _savePayments(client, list) {
    await client.db.set(PAY_DB, list);
}

async function getPayment(client, paymentId) {
    return (await _readPayments(client)).find((p) => p.id === paymentId) ?? null;
}

async function getOpenPayment(client, userId) {
    return (
        (await _readPayments(client)).find(
            (p) => p.userId === userId && p.status === "pending" && Number(p.expiresAt) > Date.now(),
        ) ?? null
    );
}

/**
 * The cart becomes a QR, at today's prices. A decor that stopped selling is
 * dropped from the cart and nothing is created — the buyer looks again.
 * → { payment } | { existed } | { removed: names } | { empty: true }
 */
async function startPayment(client, userId) {
    const existed = await getOpenPayment(client, userId);
    if (existed) return { existed: { ...existed, qrUrl: _vietQrUrl(client, existed.total, existed.transferCode) } };

    const catalog = await panel.getCatalog({ force: true });
    const cart = cartOf(userId);
    const missing = cart.skus.filter((s) => !catalog.index.has(s));
    if (missing.length) {
        cart.skus = cart.skus.filter((s) => catalog.index.has(s));
        return { removed: missing.length };
    }
    if (!cart.skus.length) return { empty: true };

    const items = cart.skus.map((s) => {
        const d = catalog.index.get(s);
        return { sku_id: d.sku_id, name: d.name, type: d.type, typeLabel: d.typeLabel, price: d.price, thumb: d.thumb || null, image: d.image || null };
    });
    const total = items.reduce((sum, i) => sum + i.price, 0);
    const payment = await _serial(async () => {
        const list = await _readPayments(client);
        const active = new Set(list.filter((p) => Number(p.expiresAt) > Date.now()).map((p) => p.transferCode));
        let transferCode = _transferCode();
        for (let i = 0; i < 100 && active.has(transferCode); i++) transferCode = _transferCode();
        const created = {
            id: _newPaymentId(),
            userId,
            items,
            total,
            transferCode,
            status: "pending",
            createdAt: Date.now(),
            expiresAt: Date.now() + EXPIRE_MS,
        };
        list.push(created);
        await _savePayments(client, list);
        return created;
    });
    const { transferCode } = payment;

    const context = { _handler: "dg_payment", paymentId: payment.id, userId, transferCode };
    client.autoBank.createQR(total, transferCode, context, async (err, data) => {
        if (err) {
            // QR window over without a transfer.
            await removePayment(client, payment.id).catch(() => null);
            return;
        }
        await handlePaid(client, payment.id, data?.message).catch((e) =>
            console.error(`[AutoDecoGift] paid ${payment.id}: ${e.message}`),
        );
    });
    await client.db.create("autobank_pending", {
        customId: transferCode,
        amount: total,
        expireAt: payment.expiresAt,
        context,
    });

    clearCart(userId);
    return { payment: { ...payment, qrUrl: _vietQrUrl(client, total, transferCode) } };
}

/**
 * The buyer pressed Hủy. The record stays (marked cancelled) until the QR window
 * ends, so a transfer made anyway is still honoured instead of lost.
 */
function cancelPayment(client, paymentId) {
    return _serial(async () => {
        const list = await _readPayments(client);
        const p = list.find((i) => i.id === paymentId);
        if (!p) return null;
        p.status = "cancelled";
        await _savePayments(client, list);
        return p;
    });
}

function removePayment(client, paymentId) {
    return _serial(async () => {
        const list = await _readPayments(client);
        const next = list.filter((p) => p.id !== paymentId);
        if (next.length !== list.length) await _savePayments(client, next);
    });
}

/** Drop payments whose QR window has passed (pending or cancelled). */
function expireStale(client) {
    return _serial(async () => {
        const list = await _readPayments(client);
        const next = list.filter((p) => Number(p.expiresAt) > Date.now());
        if (next.length !== list.length) await _savePayments(client, next);
        return list.length - next.length;
    });
}

function paymentEmbed(client, payment, note) {
    const s = settings(client);
    const open = payment.status === "pending";
    return {
        title: "Thanh toán Deco Gift",
        color: open ? accent(client) : 0x95a5a6,
        description: note || null,
        fields: [
            { name: "Mã thanh toán", value: `\`${payment.id}\``, inline: false },
            {
                name: `Deco (${payment.items.length})`,
                value: trunc(
                    payment.items.map((i, n) => `${n + 1}. **${i.name}** · ${i.typeLabel} — ${money(i.price)}`).join("\n"),
                    1024,
                ),
                inline: false,
            },
            { name: "Tổng tiền", value: `\`${money(payment.total)}\``, inline: true },
            ...(open
                ? [
                      { name: "Chủ tài khoản", value: `\`${s.bankHolder}\``, inline: true },
                      { name: "Ngân hàng", value: `\`${s.bankCode}\``, inline: true },
                      { name: "Số tài khoản", value: `\`\`\`\n${s.bankAccount}\n\`\`\``, inline: false },
                      { name: "Nội dung chuyển khoản", value: `\`\`\`\n${payment.transferCode}\n\`\`\``, inline: false },
                  ]
                : []),
        ],
        image: open && payment.qrUrl ? { url: payment.qrUrl } : null,
        footer: { text: open ? "QR hết hạn sau 10 phút. Bot tự xác nhận khi nhận được tiền — chuyển đúng nội dung." : "Deco Gift" },
        timestamp: new Date().toISOString(),
    };
}

function paymentCancelRow(paymentId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`dg:cancelpay:${paymentId}`).setLabel("Hủy đơn").setStyle(ButtonStyle.Danger),
    );
}

// ── Orders ─────────────────────────────────────────────────────────────────────

async function getOrder(client, id) {
    return (await client.db.findOne(ORDER_DB, { id })) ?? null;
}

function _update(client, id, patch) {
    return _serial(() => client.db.findOneAndUpdate(ORDER_DB, { id }, { ...patch, updatedAt: Date.now() }));
}

async function _withLock(id, fn) {
    if (_locks.has(id)) return null;
    _locks.add(id);
    try {
        return await fn();
    } finally {
        _locks.delete(id);
    }
}

/**
 * Money arrived (live, or found after a restart): the order is recorded, the
 * shop opens its order (waiting list + bill DM), the staff channel gets the card.
 */
async function handlePaid(client, paymentId, bankMessage) {
    return _withLock(paymentId, async () => {
        const known = await getOrder(client, paymentId);
        if (known) return known;
        const payment = await getPayment(client, paymentId);
        if (!payment) {
            console.warn(`[AutoDecoGift] payment ${paymentId} paid but not found`);
            return null;
        }
        await _serial(() => client.db.create(ORDER_DB, {
            id: payment.id,
            userId: payment.userId,
            items: payment.items,
            total: payment.total,
            transferCode: payment.transferCode,
            bankMessage: bankMessage ? String(bankMessage).slice(0, 800) : null,
            paidAt: Date.now(),
            status: "paid",
            shopOrderId: null,
            waitingUrl: null,
            shopError: null,
            tries: 0,
            links: null,
            updatedAt: Date.now(),
        }));
        await removePayment(client, paymentId);

        const order = await _ensureShopOrder(client, paymentId);
        await refreshStaff(client, order);
        if (!order.shopOrderId) {
            // The shop's bill DM did not go out — tell the buyer the money is in.
            const user = await client.users.fetch(order.userId).catch(() => null);
            await user
                ?.send({
                    embeds: [
                        client.embed(
                            [
                                `Mã thanh toán: \`${order.id}\``,
                                `Số tiền: **${money(order.total)}**`,
                                "✅ Đã nhận thanh toán Deco Gift. Admin sẽ duyệt và gửi link quà qua tin nhắn riêng.",
                            ].join("\n"),
                            { title: "Đã xác nhận thanh toán", color: 0x57f287 },
                        ),
                    ],
                })
                .catch(() => null);
        }
        return order;
    });
}

/** The shop's order for this payment (the panel makes it idempotent). */
async function _ensureShopOrder(client, id) {
    const order = await getOrder(client, id);
    if (!order || order.shopOrderId) return order;
    try {
        const res = await panel.createOrder({
            paymentId: order.id,
            buyerId: order.userId,
            sellerId: settings(client).decoGiftSellerId,
            items: order.items.map(({ sku_id, name, type, price }) => ({ sku_id, name, type, price })),
            total: order.total,
        });
        if (!res?.orderId) throw new Error("panel không trả về mã đơn");
        return _update(client, id, { shopOrderId: res.orderId, waitingUrl: res.waitingUrl || null, shopError: null, tries: 0 });
    } catch (e) {
        return _update(client, id, { shopError: trunc(e.message, 300), tries: (order.tries || 0) + 1 });
    }
}

/**
 * Hand the links to ArnTo-assistant (through the panel) and have the shop
 * complete the order. With `links`, an admin just typed them; without, it is a
 * retry of what was stored.
 * → the order after it
 */
async function _deliver(client, id, { adminId, links } = {}) {
    let order = await getOrder(client, id);
    if (links) {
        order = await _update(client, id, { status: "delivering", links, deliveredBy: adminId, lastError: null, tries: 0 });
        await refreshStaff(client, order);
    }
    if (!order?.links?.length || !order.shopOrderId) return order;
    try {
        const res = await panel.deliver(order.shopOrderId, {
            buyerId: order.userId,
            items: order.items.map((it, i) => ({ name: it.name, type: it.type, link: order.links[i] })),
        });
        if (!res.delivered) {
            // Kept so "Gửi lại DM" needs no retyping.
            order = await _update(client, id, { status: "dm_failed", lastError: res.reason || "not_delivered" });
        } else {
            // Delivered: only a masked copy stays (this database is backed up).
            order = await _update(client, id, {
                status: res.completed ? "completed" : "delivered",
                links: null,
                linksMasked: order.links.map(maskLink),
                deliveredAt: Date.now(),
                ...(res.completed ? { completedAt: Date.now() } : {}),
                lastError: res.completed ? null : trunc(res.error || "", 300) || null,
                tries: 0,
            });
        }
    } catch (e) {
        // No answer: maybe delivered, maybe not — the assistant sends each order once, so retrying is safe.
        order = await _update(client, id, { lastError: trunc(e.message, 300), tries: (order.tries || 0) + 1 });
    }
    await refreshStaff(client, order);
    return order;
}

async function _complete(client, id) {
    let order = await getOrder(client, id);
    try {
        await panel.complete(order.shopOrderId);
        order = await _update(client, id, { status: "completed", completedAt: Date.now(), lastError: null, tries: 0 });
    } catch (e) {
        order = await _update(client, id, { lastError: trunc(e.message, 300), tries: (order.tries || 0) + 1 });
    }
    await refreshStaff(client, order);
    return order;
}

async function _cancelShop(client, id) {
    let order = await getOrder(client, id);
    if (!order?.shopCancelPending) return order;
    if (!order.shopOrderId) {
        // A create request may still land on the shop: make sure of the order, then cancel it.
        order = await _ensureShopOrder(client, id);
        if (!order.shopOrderId) {
            await refreshStaff(client, order);
            return order;
        }
    }
    try {
        await panel.cancel(order.shopOrderId);
        order = await _update(client, id, { shopCancelPending: false, lastError: null, tries: 0 });
    } catch (e) {
        order = await _update(client, id, { lastError: trunc(e.message, 300), tries: (order.tries || 0) + 1 });
    }
    await refreshStaff(client, order);
    return order;
}

/** Admin: the gift links typed in the form, one per decor. → order */
async function approve(client, id, adminId, links) {
    const res = await _withLock(id, async () => {
        const order = await getOrder(client, id);
        if (!order) throw new Error("Không tìm thấy đơn.");
        if (!["paid", "dm_failed"].includes(order.status)) throw new Error("Đơn này đã được xử lý.");
        if (!order.shopOrderId) throw new Error("Đơn Shop chưa được tạo — bấm Thử lại trên tin đơn rồi duyệt.");
        _linkDrafts.delete(id);
        return _deliver(client, id, { adminId, links });
    });
    if (!res) throw new Error("Đơn đang được xử lý, thử lại sau ít giây.");
    return res;
}

/** Admin: cancel with a reason; the shop cancels its order, the buyer is told how to get the money back. */
async function cancelOrder(client, id, adminId, reason) {
    const res = await _withLock(id, async () => {
        const order = await getOrder(client, id);
        if (!order) throw new Error("Không tìm thấy đơn.");
        if (!["paid", "dm_failed"].includes(order.status)) throw new Error("Chỉ hủy được đơn chưa giao link.");
        await _update(client, id, {
            status: "cancelled",
            cancelledBy: adminId,
            cancelReason: trunc(reason, 500),
            cancelledAt: Date.now(),
            links: null,
            // Nothing to cancel on the shop when it was never asked to create the order.
            shopCancelPending: !!(order.shopOrderId || order.tries),
            lastError: null,
            tries: 0,
        });
        _linkDrafts.delete(id);
        const done = await _cancelShop(client, id);
        const user = await client.users.fetch(order.userId).catch(() => null);
        await user
            ?.send({
                embeds: [
                    client.embed(
                        [
                            `Mã đơn: \`${done.shopOrderId || done.id}\`${done.shopOrderId ? ` (thanh toán \`${done.id}\`)` : ""}`,
                            `Lý do: ${trunc(reason, 500)}`,
                            "",
                            `Bạn sẽ được hoàn **${money(done.total)}**: hãy tạo ticket và gửi mã đơn này cho admin.`,
                        ].join("\n"),
                        { title: "Đơn Deco Gift đã bị hủy", color: 0xed4245 },
                    ),
                ],
            })
            .catch(() => null);
        await refreshStaff(client, done);
        return done;
    });
    if (!res) throw new Error("Đơn đang được xử lý, thử lại sau ít giây.");
    return res;
}

/** Whatever step is still owed — the Thử lại / Gửi lại buttons and the sweep. → order */
async function retry(client, id) {
    return _withLock(id, async () => {
        let order = await getOrder(client, id);
        if (!order) return null;
        if (order.status === "paid" && !order.shopOrderId) {
            order = await _ensureShopOrder(client, id);
            await refreshStaff(client, order);
            return order;
        }
        if (order.status === "delivering" || order.status === "dm_failed") return _deliver(client, id);
        if (order.status === "delivered") return _complete(client, id);
        if (order.status === "cancelled" && order.shopCancelPending) return _cancelShop(client, id);
        return order;
    });
}

/** Every 5 minutes: steps that failed on their own get another go (not the ones waiting for a person). */
async function sweep(client) {
    purgeCarts();
    await expireStale(client);
    const orders = (await client.db.get(ORDER_DB)) ?? [];
    for (const o of orders) {
        const owed =
            (o.status === "paid" && !o.shopOrderId) ||
            o.status === "delivering" ||
            o.status === "delivered" ||
            (o.status === "cancelled" && o.shopCancelPending);
        if (!owed || (o.tries || 0) >= MAX_TRIES) continue;
        if (Date.now() - (o.updatedAt || 0) < RETRY_AFTER_MS) continue;
        await retry(client, o.id).catch((e) => console.warn(`[AutoDecoGift] retry ${o.id}: ${e.message}`));
    }
}

// ── Staff channel ──────────────────────────────────────────────────────────────

const STATUS_COLOR = {
    paid: 0xfee75c,
    delivering: 0x5865f2,
    dm_failed: 0xed4245,
    delivered: 0x57f287,
    completed: 0x57f287,
    cancelled: 0x95a5a6,
};

const DM_REASON = {
    dm_blocked: "Khách chặn tin nhắn riêng (hoặc không còn chung server với bot gửi link)",
    unknown_user: "Không tìm thấy tài khoản khách",
};

function _statusText(o) {
    const err = o.lastError ? `\n-# Lỗi gần nhất: ${trunc(o.lastError, 200)}` : "";
    const stuck = (o.tries || 0) >= MAX_TRIES ? "\n-# Đã ngừng tự thử lại — bấm Thử lại." : "";
    switch (o.status) {
        case "paid":
            return o.shopOrderId
                ? "⏳ **Chờ admin duyệt** — bấm Duyệt rồi điền link quà cho từng deco."
                : `⏳ **Chờ admin duyệt** · ⚠️ chưa tạo được đơn Shop — bot tự thử lại mỗi 5 phút.${o.shopError ? `\n-# Lỗi: ${trunc(o.shopError, 200)}` : ""}${stuck}`;
        case "delivering":
            return `📨 **Đang giao link** (bởi <@${o.deliveredBy}>) — chưa có phản hồi, bot tự thử lại.${err}${stuck}`;
        case "dm_failed":
            return `⚠️ **Chưa giao được:** ${DM_REASON[o.lastError] || o.lastError}.\nNhờ khách mở tin nhắn riêng từ thành viên server rồi bấm **Gửi lại DM**.`;
        case "delivered":
            return `✅ **Đã giao link** bởi <@${o.deliveredBy}> lúc ${ts(o.deliveredAt)} · ⏳ đang chờ Shop hoàn thành đơn.${err}${stuck}`;
        case "completed":
            return `✅ **Hoàn thành** — giao bởi <@${o.deliveredBy}> lúc ${ts(o.deliveredAt || o.completedAt)}.${o.linksMasked?.length ? `\n-# ${o.linksMasked.join(" · ")}` : ""}`;
        case "cancelled":
            return `❌ **Đã hủy** bởi <@${o.cancelledBy}> lúc ${ts(o.cancelledAt)}\nLý do: ${o.cancelReason}${o.shopCancelPending ? `\n⏳ Đang hủy đơn Shop…${err}${stuck}` : ""}`;
        default:
            return o.status;
    }
}

function _staffButtons(o) {
    const b = [];
    const retryBtn = (label = "Thử lại") =>
        new ButtonBuilder().setCustomId(`dg:retry:${o.id}`).setLabel(label).setEmoji("🔁").setStyle(ButtonStyle.Secondary);
    const cancelBtn = new ButtonBuilder().setCustomId(`dg:reject:${o.id}`).setLabel("Hủy đơn").setEmoji("❌").setStyle(ButtonStyle.Danger);
    if (o.status === "paid") {
        if (o.shopOrderId)
            b.push(new ButtonBuilder().setCustomId(`dg:approve:${o.id}`).setLabel("Duyệt & giao link").setEmoji("✅").setStyle(ButtonStyle.Success));
        else b.push(retryBtn("Thử lại tạo đơn Shop"));
        b.push(cancelBtn);
    } else if (o.status === "dm_failed") {
        b.push(retryBtn("Gửi lại DM"));
        b.push(new ButtonBuilder().setCustomId(`dg:approve:${o.id}`).setLabel("Nhập lại link").setEmoji("✏️").setStyle(ButtonStyle.Secondary));
        b.push(cancelBtn);
    } else if (o.status === "delivering" || o.status === "delivered" || (o.status === "cancelled" && o.shopCancelPending)) {
        b.push(retryBtn());
    }
    return b;
}

function staffView(client, o) {
    const c = new ContainerBuilder().setAccentColor(STATUS_COLOR[o.status] ?? accent(client));
    c.addTextDisplayComponents(
        text(
            [
                "## 🎁 Đơn Deco Gift",
                `**Mã đơn:** ${o.shopOrderId ? `\`${o.shopOrderId}\`${o.waitingUrl ? ` · [hàng chờ](${o.waitingUrl})` : ""}` : "*chưa có*"} · thanh toán \`${o.id}\``,
                `**Khách:** <@${o.userId}> (\`${o.userId}\`)`,
                `**Tổng:** ${money(o.total)} · đã thanh toán lúc ${ts(o.paidAt)}`,
            ].join("\n"),
        ),
    );
    o.items.forEach((it, i) =>
        addDecor(c, it, `**${i + 1}. [${it.name}](${shopUrl(it.sku_id)})**\n${it.typeLabel} · ${money(it.price)}`),
    );
    c.addSeparatorComponents(sep());
    if (o.bankMessage) c.addTextDisplayComponents(text(`**Tin ngân hàng** (kiểm tra số tiền):\n\`\`\`\n${trunc(o.bankMessage, 600)}\n\`\`\``));
    c.addTextDisplayComponents(text(_statusText(o)));
    const buttons = _staffButtons(o);
    if (buttons.length) c.addActionRowComponents(new ActionRowBuilder().addComponents(...buttons));
    return { components: [c] };
}

/** Post or update the order's card in the staff channel. */
async function refreshStaff(client, order) {
    if (!order) return;
    const channelId = order.staffChannelId || settings(client).decoGiftStaffChannelId;
    if (!channelId) return console.warn("[AutoDecoGift] DECO_GIFT_STAFF_CHANNEL_ID is not set");
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased?.()) return;
        const view = { ...staffView(client, order), allowedMentions: { parse: [] } };
        if (order.staffMessageId) {
            const msg = await channel.messages.fetch(order.staffMessageId).catch(() => null);
            if (msg) return void (await msg.edit(view));
        }
        const msg = await channel.send({ ...view, flags: MessageFlags.IsComponentsV2 });
        await _update(client, order.id, { staffChannelId: channel.id, staffMessageId: msg.id });
    } catch (e) {
        console.warn(`[AutoDecoGift] staff message ${order.id}: ${e.message}`);
    }
}

function linksModal(order) {
    const draft = _linkDrafts.get(order.id) || order.links || [];
    const modal = new ModalBuilder().setCustomId(`dg:links:${order.id}`).setTitle(trunc(`Giao deco – ${order.shopOrderId}`, 45));
    order.items.forEach((it, i) => {
        const input = new TextInputBuilder()
            .setCustomId(`l${i}`)
            .setLabel(trunc(`#${i + 1} ${it.name}`, 45))
            .setPlaceholder("https://discord.gift/...")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(200)
            .setRequired(true);
        if (draft[i]) input.setValue(String(draft[i]).slice(0, 200));
        modal.addComponents(new ActionRowBuilder().addComponents(input));
    });
    return modal;
}

/**
 * The approve form's values → { links } or { error } (the typed values are kept
 * so the form opens filled in next time).
 */
function readLinks(order, fields) {
    const raw = order.items.map((_, i) => fields.getTextInputValue(`l${i}`) || "");
    const links = raw.map(parseGiftLink);
    const bad = links.map((l, i) => (l ? null : i + 1)).filter(Boolean);
    const codes = links.filter(Boolean);
    let error = null;
    if (bad.length) error = `Link #${bad.join(", #")} không phải link quà Discord (dạng \`https://discord.gift/...\`).`;
    else if (new Set(codes).size !== codes.length) error = "Có link bị trùng — mỗi deco cần một link riêng.";
    if (error) {
        _linkDrafts.set(order.id, raw);
        setTimeout(() => _linkDrafts.delete(order.id), 15 * 60 * 1000).unref?.();
        return { error };
    }
    return { links };
}

function rejectModal(order) {
    return new ModalBuilder()
        .setCustomId(`dg:rejectm:${order.id}`)
        .setTitle(trunc(`Hủy đơn – ${order.shopOrderId || order.id}`, 45))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("reason")
                    .setLabel("Lý do (gửi cho khách)")
                    .setStyle(TextInputStyle.Paragraph)
                    .setMaxLength(500)
                    .setRequired(true),
            ),
        );
}

module.exports = {
    MAX_ITEMS,
    isEnabled,
    missingConfig,
    // views
    loadingView,
    messageView,
    panelMessage,
    categoriesView,
    categoryView,
    searchView,
    cartView,
    searchModal,
    // cart
    cartOf,
    addSkus,
    addToCart,
    removeFromCart,
    clearCart,
    addedNote,
    runSearch,
    // payments
    startPayment,
    getPayment,
    cancelPayment,
    removePayment,
    expireStale,
    paymentEmbed,
    paymentCancelRow,
    handlePaid,
    // orders
    getOrder,
    approve,
    cancelOrder,
    retry,
    sweep,
    staffView,
    refreshStaff,
    linksModal,
    readLinks,
    rejectModal,
    parseGiftLink,
};
