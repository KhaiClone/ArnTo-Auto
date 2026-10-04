/**
 * AutoBadge.js
 * Toàn bộ phần thanh toán của Auto Badge Game. Việc chạy thật nằm ở bot-panel
 * (badgeService) — ở đây chỉ giữ tiền, và khi tiền về thì gọi panel.
 *
 * LUỒNG
 *   1. Khách chọn badge + mốc, dán token
 *   2. quote() — panel kiểm token, báo giá. Khách có Nitro thì panel đọc luôn
 *      tiến độ bằng token của chính khách và cảnh báo nếu đã đạt mốc.
 *      Khách không Nitro thì phải TỰ KHAI số hiện tại.
 *   3. Hiện QR (không có bước xác nhận riêng — theo quyết định thiết kế)
 *   4. Tiền về → PanelBadge.start() → panel đọc bằng reader, so mốc, gửi
 *   5. Panel báo qua Discord (badge.event, extensions/panelLink.js) → DM khách
 *
 * TẠI SAO KHÔNG ĐỌC BẰNG READER TRƯỚC KHI THU TIỀN: reader là acc Nitro cá nhân,
 * mỗi lượt đọc là một request phát ra từ nó. Nếu báo giá cũng dùng reader thì bất
 * kỳ ai cũng spam đốt tài nguyên acc đó miễn phí. Đặt reader sau cổng thanh toán
 * thì kẻ spam không với tới được.
 */

const { nanoid } = require("nanoid");
const PanelBadge = require("./PanelBadge");
const pricing = require("../functions/pricing");
const badgeLog = require("../functions/autoBadgeHelpers");

const EXPIRE_MS = 10 * 60 * 1000;
const DB = "badge_payments";

// Session giữ token của khách giữa các bước chọn badge. Interaction handler ghi
// vào đây; khai báo ở file này để maintenance loop dọn được mà không phải nạp cả
// module interaction.
const SESSIONS_DB = "bg_token_sessions";
const SESSION_TTL = 15 * 60 * 1000;

function _now() {
    return Date.now();
}
function _newPaymentId() {
    return `BG${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
function _randomTransferCode() {
    return `${nanoid(8).replaceAll("-", "").replaceAll("_", "")} Chuyen tien`;
}

function buildVietQrUrl(client, amount, transferCode) {
    const s = client.configs.settings;
    return `https://img.vietqr.io/image/${s.bankCode}-${s.bankAccount}-qr_only.png?addInfo=${encodeURIComponent(transferCode)}&accountName=${encodeURIComponent(s.bankHolder)}&amount=${amount}`;
}

// ── DB ───────────────────────────────────────────────────────────────────────────

async function _read(client) {
    return (await client.db.get(DB)) ?? [];
}
async function _save(client, list) {
    await client.db.set(DB, list);
}

async function _uniqueCode(client) {
    const list = await _read(client);
    for (let i = 0; i < 10; i++) {
        const code = _randomTransferCode();
        if (!list.some((p) => p.transferCode === code)) return code;
    }
    return _randomTransferCode();
}

// ── Báo giá ──────────────────────────────────────────────────────────────────────

/** Danh sách badge + mốc đang bán, giá đã áp hệ số theo Nitro của khách. */
async function listOffers(client, { hasNitro = true } = {}) {
    const badges = await pricing.sellableBadges(client);
    const out = [];
    for (const b of badges) {
        out.push({ ...b, tiers: await pricing.badgeTiers(client, b.key, { hasNitro }) });
    }
    return out.filter((b) => b.tiers.length);
}

/** Kiểm token + báo giá qua panel. Không đụng reader. */
async function quote(client, { token, badgeKey, tierKey }) {
    if (!PanelBadge.isEnabled()) throw new Error("Auto Badge chưa được bật (PANEL_BADGE).");
    return PanelBadge.quote({ token, badgeKey, tierKey });
}

// ── Thanh toán ───────────────────────────────────────────────────────────────────

/**
 * Tạo đơn chờ thanh toán.
 * `declaredValue` chỉ có với khách không Nitro. Nó KHÔNG dùng để tính tiền (giá
 * phẳng theo mốc) và cũng không dùng để tính số cần gửi — panel luôn lấy số
 * reader đọc được. Nó chỉ để cảnh báo sớm và làm bằng chứng khi tranh chấp.
 */
async function createPayment(
    client,
    { userId, token, badgeKey, tierKey, tierName, unit, threshold, amount, hasNitro, declaredValue = null },
) {
    const transferCode = await _uniqueCode(client);
    const payment = {
        id: _newPaymentId(),
        type: "badge",
        userId,
        badgeKey,
        tierKey,
        tierName,
        unit,
        threshold,
        hasNitro,
        declaredValue,
        amount,
        transferCode,
        status: "pending",
        orderId: null,
        createdAt: _now(),
        expiresAt: _now() + EXPIRE_MS,
    };

    const list = await _read(client);
    list.push(payment);
    await _save(client, list);

    // Log đơn ngay lúc dựng QR, kể cả khi khách bỏ ngang — một đơn bị bỏ dở vẫn là
    // thông tin đáng nhìn. Gửi hỏng thì thôi, không chặn việc tạo QR.
    const entry = await badgeLog.sendOrderLog(client, payment);
    if (entry) {
        payment.logMessageId = entry.messageId;
        payment.logFooter = entry.footerText;
        await _patchPayment(client, payment.id, {
            logMessageId: entry.messageId,
            logFooter: entry.footerText,
        });
    }

    if (client.autoBank) {
        const context = {
            _handler: "badge_payment",
            paymentId: payment.id,
            userId,
            token,
            badgeKey,
            tierKey,
            declaredValue,
            transferCode,
        };

        client.autoBank.createQR(amount, transferCode, context, async (err) => {
            if (err) {
                await cancelPayment(client, payment.id).catch(() => null);
                return;
            }
            await markPaid(client, payment.id).catch(() => null);
            await runOrder(client, context).catch(() => null);
        });

        await client.db.create("autobank_pending", {
            customId: transferCode,
            amount,
            expireAt: payment.expiresAt,
            context,
        });
    }

    return { ...payment, qrUrl: buildVietQrUrl(client, amount, transferCode) };
}

async function markPaid(client, paymentId) {
    const list = await _read(client);
    const idx = list.findIndex((p) => p.id === paymentId);
    if (idx < 0) return null;
    list[idx] = { ...list[idx], status: "paid", paidAt: _now() };
    await _save(client, list);
    return list[idx];
}

async function cancelPayment(client, paymentId) {
    const list = await _read(client);
    const next = list.filter((p) => p.id !== paymentId);
    if (next.length !== list.length) await _save(client, next);
    return next.length !== list.length;
}

async function _patchPayment(client, paymentId, patch) {
    const list = await _read(client);
    const idx = list.findIndex((p) => p.id === paymentId);
    if (idx < 0) return null;
    list[idx] = { ...list[idx], ...patch };
    await _save(client, list);
    return list[idx];
}

async function attachOrder(client, paymentId, orderId) {
    return _patchPayment(client, paymentId, { orderId });
}

async function getPaymentById(client, paymentId) {
    return (await _read(client)).find((p) => p.id === paymentId) ?? null;
}

async function getPaymentByOrderId(client, orderId) {
    return (await _read(client)).find((p) => p.orderId === orderId) ?? null;
}

async function getOpenPayment(client, userId) {
    return (
        (await _read(client)).find(
            (p) => p.userId === userId && p.status === "pending" && p.expiresAt > _now(),
        ) ?? null
    );
}

async function expireStale(client) {
    const now = _now();
    const list = await _read(client);
    const expired = [];
    const next = list.filter((p) => {
        if (p.status === "pending" && Number(p.expiresAt) <= now) {
            expired.push({ ...p, status: "expired" });
            return false;
        }
        return true;
    });
    if (expired.length) {
        await _save(client, next);
        for (const p of expired) await badgeLog.updateOrderLog(client, p, "expired");
    }
    return expired;
}

/**
 * Xoá session token đã hết hạn.
 *
 * Session chứa token Discord của khách ở dạng thô. Handler đã tự dọn mỗi lần
 * ghi, nhưng nếu không ai mua trong một thời gian dài thì bản ghi cũ nằm lại
 * trong DB vô thời hạn. Maintenance loop gọi hàm này để token không tồn lâu hơn
 * mức cần thiết.
 */
async function purgeExpiredSessions(client) {
    const now = _now();
    const list = (await client.db.get(SESSIONS_DB)) ?? [];
    const kept = list.filter((s) => Number(s.expiresAt) > now);
    if (kept.length !== list.length) await client.db.set(SESSIONS_DB, kept);
    return list.length - kept.length;
}

// ── Giao cho panel chạy ──────────────────────────────────────────────────────────

/**
 * Tiền đã về → gọi panel. Panel là bên đọc reader và quyết định tịch thu hay
 * chạy tiếp, nên ở đây không phán xét gì cả, chỉ chuyển tiếp và báo khách.
 */
async function runOrder(client, context) {
    const { paymentId, userId, token, badgeKey, tierKey, declaredValue } = context;

    try {
        const order = await PanelBadge.start({
            token,
            badgeKey,
            tierKey,
            declaredValue,
            ref: userId,
            paymentId,
        });
        const payment = await attachOrder(client, paymentId, order.orderId);

        await badgeLog.updateOrderLog(client, payment, "paid");
        await badgeLog.dm(client, userId, "auto.badge.dm.paid", {
            payment: badgeLog.paymentVars(payment ?? context, { orderId: order.orderId }),
        });
        return order;
    } catch (err) {
        // Panel không với tới được: tiền đã thu mà chưa chạy được. Không im lặng —
        // báo khách và log để xử lý tay.
        const payment = await getPaymentById(client, paymentId);
        await badgeLog.updateOrderLog(client, payment, "failed", `Không khởi chạy được: ${err.message}`);
        await badgeLog.dm(client, userId, "auto.badge.dm.startFailed", {
            payment: badgeLog.paymentVars(payment ?? context, { id: paymentId }),
            error: err.message,
        });
        throw err;
    }
}

// ── Webhook từ panel ─────────────────────────────────────────────────────────────

const { UNIT_VI, fmt } = badgeLog;

/** Sự kiện badge.event từ panel (kênh Discord) → hàm này. Dịch sự kiện thành DM cho khách (templates auto.badge.dm.*). */
async function handlePanelEvent(client, event) {
    const { orderId, ref, type } = event;
    const userId = ref;
    if (!userId) return;
    const payment = await getPaymentByOrderId(client, orderId);
    const base = badgeLog.paymentVars(
        payment ?? { badgeKey: event.badgeKey, tierName: event.tierName, threshold: event.threshold, unit: event.unit },
        { orderId },
    );
    const send = (key, extra = {}) => badgeLog.dm(client, userId, key, { payment: base, ...extra });

    switch (type) {
        // Gửi xong là xong đơn. Panel không đọc lại badge sau đó nữa nên
        // "sent" là sự kiện kết thúc duy nhất cho mọi loại badge.
        case "sent": {
            await send("auto.badge.dm.sent", { payment: { ...base, badgeKey: event.badgeKey || base.badgeKey } });
            await badgeLog.updateOrderLog(client, payment, "sent");
            break;
        }

        case "forfeited":
            await send("auto.badge.dm.forfeited", {
                measuredValue: event.measuredValue,
                payment: { ...base, threshold: event.threshold ?? base.threshold, unitText: UNIT_VI(event.unit ?? payment?.unit) },
            });
            await badgeLog.updateOrderLog(
                client,
                payment,
                "forfeited",
                `Đã có sẵn ${fmt(event.measuredValue)}/${fmt(event.threshold)} ${UNIT_VI(event.unit)}`,
            );
            break;

        case "refund_due":
            await send("auto.badge.dm.refundDue");
            await badgeLog.updateOrderLog(client, payment, "refund_due");
            break;

        case "manual_review":
            await send("auto.badge.dm.manualReview");
            await badgeLog.updateOrderLog(client, payment, "manual_review", event.error ?? null);
            break;

        case "failed":
            await send("auto.badge.dm.failed", { error: event.error ?? "" });
            await badgeLog.updateOrderLog(client, payment, "failed", event.error ?? null);
            break;

        default:
            break; // order_created / status / progress: không cần làm phiền khách
    }
}

module.exports = {
    EXPIRE_MS,
    SESSIONS_DB,
    SESSION_TTL,
    purgeExpiredSessions,
    listOffers,
    quote,
    createPayment,
    markPaid,
    cancelPayment,
    attachOrder,
    patchPayment: _patchPayment,
    getPaymentById,
    getPaymentByOrderId,
    getOpenPayment,
    expireStale,
    runOrder,
    handlePanelEvent,
    buildVietQrUrl,
};
