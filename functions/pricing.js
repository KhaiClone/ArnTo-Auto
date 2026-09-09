/**
 * pricing.js
 * Bảng giá lấy từ panel (/api/external/pricing) thay vì hardcode trong .env.
 *
 * Ba tầng, theo thứ tự ưu tiên:
 *   1. Cache trong RAM (60s)  — panel không bị hỏi lại cho mỗi lần bấm nút.
 *   2. Panel                  — nguồn thật, sửa trên /pricing là áp dụng ngay.
 *   3. configs/settings.js    — dự phòng khi panel sập.
 *
 * Tầng 3 quan trọng: panel chết KHÔNG được làm bot ngừng bán. Giá cache cũ vẫn
 * đúng hơn là không bán được gì. Chỉ Auto Badge là bắt buộc phải có panel, vì
 * panel mới là nơi chạy engine.
 */

const axios = require("axios");

const TTL = 60_000;
let cache = { data: null, at: 0 };

const BASE = () => process.env.PANEL_API_URL;
const KEY = () => process.env.PANEL_API_KEY;

function isEnabled() {
    return !!BASE() && !!KEY();
}

/** Giá dự phòng dựng từ .env, dùng khi panel không với tới được. */
function _fallback(client) {
    const s = client?.configs?.settings ?? {};
    return {
        autoBadge: { enabled: false, badges: {}, nonNitroSurcharge: 1.5, overshoot: 1.1 },
        autoQuest: {
            pricePerItem: s.questPricePerItem ?? 2000,
            monthlyPrice: s.monthlyQuestPrice ?? 50000,
        },
        _stale: true,
    };
}

/**
 * @param {object} client
 * @param {boolean} [force] bỏ qua cache (dùng sau khi vừa sửa giá trên panel)
 */
async function getPricing(client, force = false) {
    if (!force && cache.data && Date.now() - cache.at < TTL) return cache.data;
    if (!isEnabled()) return _fallback(client);

    try {
        const res = await axios.get(`${BASE()}/api/external/pricing`, {
            headers: { "x-api-key": KEY() },
            timeout: 8000,
            validateStatus: () => true,
        });
        if (res.status !== 200 || !res.data?.autoBadge) throw new Error(`HTTP ${res.status}`);
        cache = { data: res.data, at: Date.now() };
        return res.data;
    } catch {
        // Cache cũ còn hơn không có gì — giá đổi rất ít khi.
        if (cache.data) return cache.data;
        return _fallback(client);
    }
}

/** Các mốc đang mở bán của một badge, đã áp hệ số non-Nitro. */
async function badgeTiers(client, badgeKey, { hasNitro = true } = {}) {
    const pricing = await getPricing(client);
    const badge = pricing.autoBadge?.badges?.[badgeKey];
    if (!pricing.autoBadge?.enabled || !badge) return [];
    // Phu phi non-Nitro chi ap cho badge phai doc bang reader. HypeSquad khong
    // dung reader nen khong chiu phu phi.
    const mult = hasNitro || !badge.usesReader ? 1 : (pricing.autoBadge.nonNitroSurcharge ?? 1);
    return badge.tiers
        .filter((t) => t.enabled)
        .map((t) => ({
            ...t,
            unit: badge.unit,
            badgeKey,
            kind: badge.kind ?? "tiered",
            usesReader: badge.usesReader !== false,
            finalPrice: Math.round(t.price * mult),
        }));
}

/** Badge nào đang có ít nhất một mốc mở bán. */
async function sellableBadges(client) {
    const pricing = await getPricing(client);
    if (!pricing.autoBadge?.enabled) return [];
    return Object.entries(pricing.autoBadge.badges ?? {})
        .filter(([, b]) => b.supported && b.tiers.some((t) => t.enabled))
        .map(([key, b]) => ({
            key,
            label: b.label,
            unit: b.unit,
            kind: b.kind ?? "tiered",
            usesReader: b.usesReader !== false,
        }));
}

/**
 * Giá của một hệ thống auto, lấy từ panel, tự lùi về .env khi panel không với tới.
 *
 * Luôn trả về một số dương hợp lệ: giá 0 hoặc NaN lọt xuống AutoBank là tạo QR
 * 0đ, tức bán không công. Thà dùng giá .env cũ còn hơn.
 *
 * @param {"autoQuest"} feature
 * @param {string} field
 * @param {number} fallback  giá trong configs/settings.js
 */
async function priceOf(client, feature, field, fallback) {
    try {
        const pricing = await getPricing(client);
        const value = Number(pricing?.[feature]?.[field]);
        if (Number.isFinite(value) && value > 0) return Math.round(value);
    } catch {
        // rơi xuống fallback
    }
    return fallback;
}

/** Giá một quest lẻ. */
async function questPricePerItem(client) {
    return priceOf(
        client,
        "autoQuest",
        "pricePerItem",
        client?.configs?.settings?.questPricePerItem ?? 2000,
    );
}

/** Giá gói Auto Quest tháng. */
async function questMonthlyPrice(client) {
    return priceOf(
        client,
        "autoQuest",
        "monthlyPrice",
        client?.configs?.settings?.monthlyQuestPrice ?? 50000,
    );
}

function invalidate() {
    cache = { data: null, at: 0 };
}

module.exports = {
    isEnabled,
    getPricing,
    badgeTiers,
    sellableBadges,
    priceOf,
    questPricePerItem,
    questMonthlyPrice,
    invalidate,
};
