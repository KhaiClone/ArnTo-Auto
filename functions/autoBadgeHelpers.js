/**
 * autoBadgeHelpers.js
 * Embed cho Auto Badge: log đơn ở kênh admin và DM báo khách.
 *
 * Cùng khuôn với autoQuestHelpers.js — MỘT tin nhắn log cho mỗi đơn, sửa tại chỗ
 * theo từng bước (chờ thanh toán → đã trả → hoàn tất), thay vì mỗi bước một dòng
 * mới. Một đơn = một dòng trong kênh log, đọc lướt là biết nó đang ở đâu.
 *
 * File này KHÔNG require AutoBadge.js: nó chỉ dựng embed và gửi/sửa tin nhắn,
 * còn việc lưu messageId vào bản ghi payment là của bên gọi. Nhờ vậy chiều phụ
 * thuộc chỉ có một hướng (AutoBadge → helpers), không vòng như bên quest.
 */

// ── Nhãn ─────────────────────────────────────────────────────────────────────────

const UNIT_VI = (u) => (u === "hours" ? "giờ" : u === "house" ? "nhà" : "game");

const BADGE_VI = (k) =>
    ({
        game_time: "Game Time",
        game_variety: "Game Variety",
        hypesquad: "HypeSquad",
        streaming: "Streaming",
    })[k] ?? k;

const fmt = (n) => Number(n).toLocaleString("vi-VN");

// ── Màu ──────────────────────────────────────────────────────────────────────────
// Trùng bảng màu của Auto Quest để hai kênh log nhìn như một hệ. Chữ và màu của log
// / DM nằm ở templates/badge.js (sửa được trên trang Embeds của bot-panel).

const COLOR = {
    pending: 0x5865f2, // xanh Discord — đang chờ tiền
    paid: 0xf39c12, // cam — tiền về, đang chạy
    done: 0x57f287, // xanh lá — xong
    warn: 0xfee75c, // vàng — cần người nhìn vào
    bad: 0xed4245, // đỏ — hỏng / huỷ / tịch thu
};

// ── Biến cho template ────────────────────────────────────────────────────────────

/** Một đơn badge như template thấy (type badgePayment). */
function paymentVars(p = {}, extra = {}) {
    return {
        id: p.id ?? "",
        orderId: p.orderId ?? "",
        userId: p.userId ?? null,
        badgeKey: p.badgeKey ?? "",
        badgeName: BADGE_VI(p.badgeKey),
        tierKey: p.tierKey ?? "",
        tierName: p.tierName ?? "",
        isChoice: p.threshold == null,
        threshold: p.threshold ?? null,
        unitText: UNIT_VI(p.unit),
        amount: p.amount ?? 0,
        hasNitro: !!p.hasNitro,
        declaredValue: p.declaredValue ?? null,
        transferCode: p.transferCode ?? "",
        qrUrl: p.qrUrl ?? null,
        __text: p.orderId || p.id || "",
        ...extra,
    };
}

// ── Log đơn ở kênh admin ─────────────────────────────────────────────────────────

function _footer(payment) {
    const at = new Date(payment.createdAt ?? Date.now()).toLocaleString("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        hour12: false,
    });
    return `BADGE · ${payment.id} | Tạo lúc ${at}`;
}

/**
 * Tin log của một đơn (template auto.badge.log).
 * @param {object} payment  bản ghi badge_payments
 * @param {string} state    pending / paid / sent / manual_review / forfeited / refund_due / failed / cancelled / expired
 * @param {string} [note]   một dòng mô tả thêm (lý do huỷ, thông báo lỗi…)
 */
function orderLogMessage(client, payment, state, note) {
    return client.ui.message(
        "auto.badge.log",
        { payment: paymentVars(payment), state: state || "pending", note: note || "", footer: payment.logFooter || _footer(payment) },
        { edit: true },
    );
}

async function _logChannel(client) {
    const id = client.configs.settings.badgeOrderLogChannelId;
    if (!id) return null;
    const ch = await client.channels.fetch(id).catch(() => null);
    return ch?.isTextBased?.() ? ch : null;
}

/**
 * Đăng log lần đầu, lúc vừa dựng QR.
 * @returns {{messageId: string, footerText: string} | null} bên gọi tự lưu vào payment
 */
async function sendOrderLog(client, payment) {
    try {
        const ch = await _logChannel(client);
        if (!ch) return null;
        const footerText = _footer(payment);
        const msg = await ch.send(orderLogMessage(client, { ...payment, logFooter: footerText }, "pending"));
        return { messageId: msg.id, footerText };
    } catch (e) {
        console.warn(`[autoBadgeHelpers] sendOrderLog: ${e.message}`);
        return null;
    }
}

/** Sửa log tại chỗ. Không có messageId (log tắt, hoặc tin bị xoá) thì bỏ qua im lặng. */
async function updateOrderLog(client, payment, state, note) {
    if (!payment?.logMessageId) return;
    try {
        const ch = await _logChannel(client);
        if (!ch) return;
        const msg = await ch.messages.fetch(payment.logMessageId).catch(() => null);
        if (!msg) return;
        await msg.edit(orderLogMessage(client, payment, state, note));
    } catch (e) {
        console.warn(`[autoBadgeHelpers] updateOrderLog: ${e.message}`);
    }
}

// ── DM cho khách ─────────────────────────────────────────────────────────────────

/** DM template `key` cho khách. Khách chặn DM thì im lặng bỏ qua, không làm hỏng luồng đơn. */
async function dm(client, userId, key, vars = {}) {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return false;
    return user
        .send(client.ui.message(key, { user: client.ui.user(user), ...vars }))
        .then(() => true)
        .catch(() => false);
}

module.exports = {
    UNIT_VI,
    BADGE_VI,
    fmt,
    COLOR,
    paymentVars,
    orderLogMessage,
    sendOrderLog,
    updateOrderLog,
    dm,
};
