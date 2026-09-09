/**
 * PanelBadge.js
 * Client gọi API Auto Badge của bot-panel. Thanh toán ở lại arnto-auto; panel
 * đọc tiến độ thật, gửi /science, rồi webhook kết quả về /api/badge-event.
 *
 * Khác PanelQuest ở một điểm quan trọng: `quote` gọi được thoải mái vì nó KHÔNG
 * đụng tới acc reader (khách có Nitro thì đọc bằng token của chính họ, khách
 * không Nitro thì chưa đọc gì). `start` mới là chỗ reader vào cuộc — nên chỉ
 * được gọi sau khi tiền đã về.
 */

const axios = require("axios");

const BASE = () => process.env.PANEL_API_URL;
const KEY = () => process.env.PANEL_API_KEY;
const WEBHOOK = () => process.env.PANEL_BADGE_WEBHOOK_URL || null;

function isEnabled() {
    return process.env.PANEL_BADGE === "true" && !!BASE() && !!KEY();
}

function _headers() {
    return { "Content-Type": "application/json", "x-api-key": KEY() };
}

function _throw(res, what) {
    const e = new Error(res.data?.error || `${what} thất bại (${res.status})`);
    e.tokenDead = res.status === 400 && /token/i.test(res.data?.error ?? "");
    e.status = res.status;
    throw e;
}

/**
 * Kiểm token + lấy tình trạng tài khoản trước khi dựng bảng giá.
 * @returns {Promise<{accountId,username,hasNitro,premiumType,values,needsDeclaration}>}
 *   `values` chỉ có khi khách có Nitro (đọc bằng token của chính họ); không thì null.
 */
async function check({ token }) {
    const res = await axios.post(
        `${BASE()}/api/external/badges/check`,
        { token },
        { headers: _headers(), timeout: 25000, validateStatus: () => true },
    );
    if (res.status >= 400) _throw(res, "Kiểm tra token");
    return res.data;
}

/**
 * Kiểm token + báo giá. Không tốn tài nguyên reader.
 * @returns {Promise<{accountId,username,hasNitro,price,threshold,unit,tierName,
 *   currentValue,alreadyOwned,needsDeclaration}>}
 */
async function quote({ token, badgeKey, tierKey }) {
    const res = await axios.post(
        `${BASE()}/api/external/badges/quote`,
        { token, badgeKey, tierKey },
        { headers: _headers(), timeout: 25000, validateStatus: () => true },
    );
    if (res.status >= 400) _throw(res, "Báo giá");
    return res.data;
}

/**
 * CHỈ gọi sau khi thanh toán thành công. Panel đọc bằng reader, so với mốc đã
 * mua rồi mới gửi.
 */
async function start({ token, badgeKey, tierKey, declaredValue = null, ref, paymentId }) {
    const res = await axios.post(
        `${BASE()}/api/external/badges/start`,
        {
            token,
            badgeKey,
            tierKey,
            declaredValue,
            ref: ref ?? null,
            paymentId: paymentId ?? null,
            webhookUrl: WEBHOOK(),
        },
        { headers: _headers(), timeout: 25000, validateStatus: () => true },
    );
    if (res.status >= 400) _throw(res, "Tạo đơn");
    return res.data;
}

/** Đơn của một người mua. */
async function listByRef(ref) {
    return axios
        .get(`${BASE()}/api/external/badges`, {
            headers: _headers(),
            params: { ref },
            timeout: 10000,
        })
        .then((r) => r.data)
        .catch(() => []);
}

async function getOrder(orderId) {
    return axios
        .get(`${BASE()}/api/external/badges/${orderId}`, { headers: _headers(), timeout: 10000 })
        .then((r) => r.data)
        .catch(() => null);
}

module.exports = { isEnabled, check, quote, start, listByRef, getOrder };
