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

/**
 * Decors sold as Gift, cached for a minute. While the panel is briefly away the
 * last list seen is served; with none yet, the error is thrown.
 */
async function getCatalog({ force = false } = {}) {
    if (!force && _catalog && Date.now() - _catalog.at < CATALOG_TTL_MS) return _catalog;
    try {
        const data = await _call("get", "/catalog", undefined, 20000);
        const decors = (data.decors || []).map((d) => ({ ...d, norm: normalize(d.name) }));
        const byCategory = new Map();
        for (const d of decors) {
            if (!byCategory.has(d.category)) byCategory.set(d.category, []);
            byCategory.get(d.category).push(d);
        }
        _catalog = {
            at: Date.now(),
            categories: (data.categories || []).map((c) => ({ ...c, norm: normalize(c.name) })),
            decors,
            index: new Map(decors.map((d) => [d.sku_id, d])),
            byCategory,
        };
        return _catalog;
    } catch (e) {
        if (_catalog) return _catalog;
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
