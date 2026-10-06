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
// Trùng bảng màu của Auto Quest để hai kênh log nhìn như một hệ.

const COLOR = {
    pending: 0x5865f2, // xanh Discord — đang chờ tiền
    paid: 0xf39c12, // cam — tiền về, đang chạy
    done: 0x57f287, // xanh lá — xong
    warn: 0xfee75c, // vàng — cần người nhìn vào
    bad: 0xed4245, // đỏ — hỏng / huỷ / tịch thu
};

const STATE = {
    pending: { text: "⏳ Chờ thanh toán", color: COLOR.pending },
    paid: { text: "💸 Đã thanh toán — đang gửi", color: COLOR.paid },
    sent: { text: "✅ Hoàn tất", color: COLOR.done },
    manual_review: { text: "⏳ Chờ admin duyệt", color: COLOR.warn },
    forfeited: { text: "🔴 Tịch thu", color: COLOR.bad },
    refund_due: { text: "↩️ Cần hoàn tiền", color: COLOR.bad },
    failed: { text: "❌ Lỗi", color: COLOR.bad },
    cancelled: { text: "🚫 Đã huỷ", color: COLOR.bad },
    expired: { text: "⌛ Hết hạn QR", color: COLOR.bad },
};

// ── Log đơn ở kênh admin ─────────────────────────────────────────────────────────

function _tierLine(p) {
    return p.threshold == null
        ? String(p.tierName)
        : `${p.tierName} — ${fmt(p.threshold)} ${UNIT_VI(p.unit)}`;
}

function _footer(payment) {
    const at = new Date(payment.createdAt ?? Date.now()).toLocaleString("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        hour12: false,
    });
    return `BADGE · ${payment.id} | Tạo lúc ${at}`;
}

/**
 * @param {object} payment  bản ghi badge_payments
 * @param {string} state    khoá trong STATE
 * @param {string} [note]   một dòng mô tả thêm (lý do huỷ, thông báo lỗi…)
 */
function buildOrderLogEmbed(client, payment, state, note) {
    const st = STATE[state] ?? STATE.pending;
    const fields = [
        { name: "👤 Khách hàng", value: `<@${payment.userId}>`, inline: true },
        { name: "🎖️ Badge", value: BADGE_VI(payment.badgeKey), inline: true },
        { name: "🎯 Mốc", value: _tierLine(payment), inline: true },
        { name: "💰 Số tiền", value: `${fmt(payment.amount)}đ`, inline: true },
        { name: "💎 Nitro", value: payment.hasNitro ? "Có" : "Không", inline: true },
        { name: "📋 Trạng thái", value: st.text, inline: true },
    ];
    // Khách không Nitro tự khai — ghi lại con số họ khai để đối chiếu khi tranh chấp.
    if (!payment.hasNitro && payment.declaredValue != null) {
        fields.push({
            name: "✍️ Khách khai",
            value: `${fmt(payment.declaredValue)} ${UNIT_VI(payment.unit)}`,
            inline: true,
        });
    }
    if (payment.orderId) {
        fields.push({ name: "🧾 Mã đơn panel", value: `\`${payment.orderId}\``, inline: false });
    }
    return client.embed(note || "", {
        title: "🎖️ Đơn Auto Badge",
        color: st.color,
        fields,
        footer: { text: payment.logFooter || _footer(payment) },
        timestamp: true,
    });
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
        const embed = buildOrderLogEmbed(client, { ...payment, logFooter: footerText }, "pending");
        const msg = await ch.send({ embeds: [embed] });
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
        await msg.edit({ embeds: [buildOrderLogEmbed(client, payment, state, note)] });
    } catch (e) {
        console.warn(`[autoBadgeHelpers] updateOrderLog: ${e.message}`);
    }
}

// ── DM cho khách ─────────────────────────────────────────────────────────────────

/** Gửi một embed vào DM. Khách chặn DM thì im lặng bỏ qua, không làm hỏng luồng đơn. */
async function dm(client, userId, embed) {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return false;
    return user
        .send({ embeds: [embed] })
        .then(() => true)
        .catch(() => false);
}

module.exports = {
    UNIT_VI,
    BADGE_VI,
    fmt,
    COLOR,
    buildOrderLogEmbed,
    sendOrderLog,
    updateOrderLog,
    dm,
};
