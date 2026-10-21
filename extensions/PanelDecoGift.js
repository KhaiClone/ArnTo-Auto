/**
 * PanelDecoGift.js
 * Client for the bot-panel's Deco Gift API (/api/external/decor-gift). This bot
 * only sells (panel, cart, QR, staff channel): the decor data lives on the panel
 * (owned by ArnTo-assistant), ArnTo-Shop opens / completes / cancels the order
 * when the panel asks it over Discord, and ArnTo-assistant DMs the gift links.
 *
 * Needs PANEL_API_URL + PANEL_API_KEY (this project's own key).
 */

const axios = require("axios");

const BASE = () => String(process.env.PANEL_API_URL || "").replace(/\/+$/, "");
const KEY = () => process.env.PANEL_API_KEY;
const CATALOG_TTL_MS = 60 * 1000;

// { at, categories, decors, index: Map sku → decor, byCategory: Map sku → decor[] }
let _catalog = null;

function isEnabled() {
    return !!BASE() && !!KEY();
}

async function _call(method, path, data, timeout) {
    const res = await axios({
        method,
        url: `${BASE()}/api/external/decor-gift${path}`,
        data,
        headers: { "Content-Type": "application/json", "x-api-key": KEY() },
        timeout,
        validateStatus: () => true,
    });
    if (res.status >= 400) {
        const e = new Error(res.data?.error || `Panel trả về lỗi ${res.status}`);
        e.status = res.status;
        throw e;
    }
    return res.data;
}

/** Same folding as the search uses: no accents, lower case, words only. */
function normalize(s) {
    return String(s || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/đ/gi, "d")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/** { at, categories, decors } → the cached shape, with its lookups. */
function _withLookups(at, categories, decors) {
    const byCategory = new Map();
    for (const d of decors) {
        if (!byCategory.has(d.category)) byCategory.set(d.category, []);
        byCategory.get(d.category).push(d);
    }
    return { at, categories, decors, index: new Map(decors.map((d) => [d.sku_id, d])), byCategory };
}

/**
 * The catalog a reseller (CTV) sees: each decor with a reseller price sells at
 * it (`reseller: true`, `regularPrice` kept); the others at the regular price.
 * Built once per fetched catalog.
 */
function _resellerView(cat) {
    if (!cat.ctv) {
        const decors = cat.decors.map((d) => (d.resellerPrice > 0 ? { ...d, price: d.resellerPrice, regularPrice: d.price, reseller: true } : d));
        cat.ctv = _withLookups(cat.at, cat.categories, decors);
    }
    return cat.ctv;
}

/**
 * Decors sold as Gift, cached for a minute. While the panel is briefly away the
 * last list seen is served; with none yet, the error is thrown. `reseller`: the
 * buyer is a CTV on the panel → their prices (_resellerView).
 */
async function getCatalog({ force = false, reseller = false } = {}) {
    const view = (cat) => (reseller ? _resellerView(cat) : cat);
    if (!force && _catalog && Date.now() - _catalog.at < CATALOG_TTL_MS) return view(_catalog);
    try {
        const data = await _call("get", "/catalog", undefined, 20000);
        _catalog = _withLookups(
            Date.now(),
            (data.categories || []).map((c) => ({ ...c, norm: normalize(c.name) })),
            (data.decors || []).map((d) => ({ ...d, norm: normalize(d.name) })),
        );
        return view(_catalog);
    } catch (e) {
        if (_catalog) return view(_catalog);
        throw e;
    }
}

/** After payment → the shop's order { orderId, messageId, waitingUrl }. Idempotent on paymentId. */
function createOrder(payload) {
    return _call("post", "/orders", payload, 60000);
}

/** Assistant DMs the links, shop completes → { delivered, completed, reason?, error? }. */
function deliver(orderId, payload) {
    return _call("post", `/orders/${encodeURIComponent(orderId)}/deliver`, payload, 110000);
}

function complete(orderId) {
    return _call("post", `/orders/${encodeURIComponent(orderId)}/complete`, {}, 60000);
}

function cancel(orderId) {
    return _call("post", `/orders/${encodeURIComponent(orderId)}/cancel`, {}, 60000);
}

module.exports = { isEnabled, normalize, getCatalog, createOrder, deliver, complete, cancel };
