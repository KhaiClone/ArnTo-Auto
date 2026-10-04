/**
 * AutoRobux.js
 * All Robux order logic:
 *  - Payment DB (create, mark paid, cancel)
 *  - AutoBank integration
 *  - Order log (send / edit)
 * Every message is a template (templates/robux.js), editable on the bot-panel.
 */

const { nanoid } = require("nanoid");

// ── Constants ──────────────────────────────────────────────────────────────────

const EXPIRE_MS = 10 * 60 * 1000; // 10 minutes
const RB_DB = "robux_payments";

const ROBUX_PACKAGES = [
    { robux: 250, price: 50000 },
    { robux: 500, price: 95000 },
    { robux: 750, price: 145000 },
    { robux: 1000, price: 175000 },
];

// In-memory order log registry: paymentId → { messageId, footerText }
const _orderLogRegistry = new Map();

const RB_QUEUE_DB = "robux_queue"; // paid orders waiting for admin
const RB_REFUND_DB = "robux_refunds"; // refund codes for failed orders
const RB_QUEUE_MSG_DB = "robux_queue_msg"; // persisted { channelId, messageId } for the live queue embed
// In-memory queue message: { channelId, messageId } for the live queue embed
let _queueMessageRef = null;

// ── Template variables ─────────────────────────────────────────────────────────

/** A payment / queue entry / refund record as templates see it (type robuxOrder). */
function orderVars(o = {}) {
    const links = Array.isArray(o.gamepassLinks) ? o.gamepassLinks : [];
    return {
        paymentId: o.paymentId ?? o.id ?? "",
        userId: o.userId ?? null,
        robux: o.robux ?? 0,
        robuxText: Number(o.robux ?? 0).toLocaleString(),
        price: o.price ?? 0,
        accountName: o.accountName ?? "",
        gamepassLinks: links.join("\n"),
        linkCount: links.length,
        transferCode: o.transferCode ?? "",
        qrUrl: o.qrUrl ?? null,
        status: o.status ?? "",
        __text: o.paymentId ?? o.id ?? "",
    };
}

const packageVars = (p) => ({ robux: p.robux, robuxText: p.robux.toLocaleString(), price: p.price });

// ── Internal helpers ───────────────────────────────────────────────────────────

function _now() {
    return Date.now();
}
function _newPaymentId() {
    return `RB${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
function _randomTransferCode() {
    return `${nanoid(8).replaceAll("-", "").replaceAll("_", "")} Chuyen tien`;
}

function _generateRefundCode() {
    // 8-char uppercase alphanumeric code, easy to type in a ticket
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from(
        { length: 8 },
        () => chars[Math.floor(Math.random() * chars.length)],
    ).join("");
}

function _buildVietQrUrl(client, amount, transferCode) {
    const s = client.configs.settings;
    return `https://img.vietqr.io/image/${s.bankCode}-${s.bankAccount}-qr_only.png?addInfo=${encodeURIComponent(transferCode)}&accountName=${encodeURIComponent(s.bankHolder)}&amount=${amount}`;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function _readPayments(client) {
    return (await client.db.get(RB_DB)) ?? [];
}
async function _savePayments(client, list) {
    await client.db.set(RB_DB, list);
}

async function _generateUniqueCode(client) {
    const list = await _readPayments(client);
    const active = new Set(
        list
            .filter(
                (i) => i.status === "pending" && Number(i.expiresAt) > _now(),
            )
            .map((i) => i.transferCode),
    );
    for (let i = 0; i < 100; i++) {
        const code = _randomTransferCode();
        if (!active.has(code)) return code;
    }
    return `${nanoid(8).replaceAll("-", "").replaceAll("_", "")} Chuyen tien`;
}

// ── Queue DB helpers ──────────────────────────────────────────────────────────

async function _readQueue(client) {
    return (await client.db.get(RB_QUEUE_DB)) ?? [];
}
async function _saveQueue(client, list) {
    await client.db.set(RB_QUEUE_DB, list);
}
async function _readRefunds(client) {
    return (await client.db.get(RB_REFUND_DB)) ?? [];
}
async function _saveRefunds(client, list) {
    await client.db.set(RB_REFUND_DB, list);
}

async function _addToQueue(client, payment) {
    const queue = await _readQueue(client);
    queue.push({
        paymentId: payment.id,
        userId: payment.userId,
        robux: payment.robux,
        price: payment.price,
        accountName: payment.accountName,
        gamepassLinks: payment.gamepassLinks,
        paidAt: Date.now(),
    });
    await _saveQueue(client, queue);
}

async function _removeFromQueue(client, paymentId) {
    const queue = await _readQueue(client);
    const next = queue.filter((i) => i.paymentId !== paymentId);
    await _saveQueue(client, next);
    return queue.find((i) => i.paymentId === paymentId) ?? null;
}

async function getQueue(client) {
    return _readQueue(client);
}

// ── Public payment API ─────────────────────────────────────────────────────────

async function createRobuxPayment(
    client,
    { userId, robux, price, gamepassLinks, accountName },
) {
    const transferCode = await _generateUniqueCode(client);

    const payment = {
        id: _newPaymentId(),
        type: "robux",
        userId,
        robux,
        price,
        gamepassLinks,
        accountName,
        transferCode,
        status: "pending",
        createdAt: _now(),
        expiresAt: _now() + EXPIRE_MS,
    };

    const list = await _readPayments(client);
    list.push(payment);
    await _savePayments(client, list);

    if (client.autoBank) {
        const context = {
            _handler: "rb_payment",
            paymentId: payment.id,
            userId,
            robux,
            price,
            gamepassLinks,
            accountName,
            transferCode,
        };

        client.autoBank.createQR(price, transferCode, context, async (err) => {
            if (err) {
                // Timeout — payment expired without being paid. Remove the pending
                // record so it is not left dangling in the DB, then update log.
                await cancelRobuxPayment(client, payment.id).catch(() => null);
                await cancelRobuxOrderLog(client, payment.id).catch(() => null);
                return;
            }
            const paid = await markRobuxPaymentPaid(client, payment.id);
            if (paid) await _onPaymentPaid(client, context);
        });

        await client.db.create("autobank_pending", {
            customId: transferCode,
            amount: price,
            expireAt: payment.expiresAt,
            context,
        });
    }

    return { ...payment, qrUrl: _buildVietQrUrl(client, price, transferCode) };
}

async function markRobuxPaymentPaid(client, paymentId) {
    const list = await _readPayments(client);
    const idx = list.findIndex((i) => i.id === paymentId);
    if (idx < 0) return null;
    const paid = { ...list[idx], status: "paid" };
    list.splice(idx, 1);
    await _savePayments(client, list);
    return paid;
}

async function cancelRobuxPayment(client, paymentId) {
    const list = await _readPayments(client);
    const idx = list.findIndex((i) => i.id === paymentId);
    if (idx < 0) return null;
    const removed = list[idx];
    list.splice(idx, 1);
    await _savePayments(client, list);
    return removed;
}

async function getOpenRobuxPayment(client, userId) {
    return (
        (await _readPayments(client)).find(
            (i) =>
                i.status === "pending" &&
                Number(i.expiresAt) > _now() &&
                i.userId === userId,
        ) ?? null
    );
}

async function getRobuxPaymentById(client, paymentId) {
    return (
        (await _readPayments(client)).find((i) => i.id === paymentId) ?? null
    );
}

/**
 * Remove pending Robux payments whose QR window has elapsed. Robux payments are
 * only cleared on pay/cancel otherwise, so without a sweep expired pending rows
 * accumulate in the DB forever. Called on startup and on an interval.
 *
 * @returns {Promise<Array>} the payments that were expired
 */
async function expireStaleRobuxPayments(client) {
    const current = _now();
    const list = await _readPayments(client);
    const expiredNow = [];
    const nextList = list.filter((item) => {
        if (item.status === "pending" && Number(item.expiresAt) <= current) {
            expiredNow.push({ ...item, status: "expired" });
            return false;
        }
        return true;
    });
    if (expiredNow.length) await _savePayments(client, nextList);
    return expiredNow;
}

// ── On payment paid ────────────────────────────────────────────────────────────

async function _onPaymentPaid(client, context) {
    const { paymentId, userId, robux, gamepassLinks, accountName, price } =
        context;

    // Edit order log to show pending admin action
    await editRobuxOrderLog(
        client,
        paymentId,
        robux,
        accountName,
        gamepassLinks,
    );

    // Add to queue + update live queue message
    await _addToQueue(client, {
        id: paymentId,
        userId,
        robux,
        price,
        accountName,
        gamepassLinks,
    });
    await updateQueueMessage(client);

    // DM user
    const user = await client.users.fetch(userId).catch(() => null);
    if (user) {
        await user
            .send(client.ui.message("auto.robux.dm.paid", { order: orderVars({ ...context, paymentId }), user: client.ui.user(user) }))
            .catch(() => null);
    }
}

// Exported for use by missed handler in ready.js
async function handleRobuxPaid(client, context) {
    await _onPaymentPaid(client, context);
}

// ── Order log ──────────────────────────────────────────────────────────────────

async function _logChannel(client) {
    const id = client.configs.settings.robuxOrderLogChannelId;
    if (!id) return null;
    const channel = await client.channels.fetch(id).catch(() => null);
    return channel?.isTextBased?.() ? channel : null;
}

/** Edit the order's log message to template `key` (the entry is kept unless `forget`). */
async function _editLog(client, paymentId, key, order, { forget = false } = {}) {
    const entry = _orderLogRegistry.get(paymentId);
    if (!entry) return;
    try {
        const channel = await _logChannel(client);
        if (!channel) return;
        const msg = await channel.messages.fetch(entry.messageId);
        await msg.edit(client.ui.message(key, { order: orderVars({ ...order, paymentId }), footer: entry.footerText }, { edit: true }));
        if (forget) _orderLogRegistry.delete(paymentId);
    } catch (e) {
        console.warn(`[AutoRobux] ${key} error: ${e.message}`);
    }
}

// ── Admin order actions ───────────────────────────────────────────────────────

/**
 * Admin marks order as done. Removes from queue, edits order log, DMs buyer.
 */
async function completeOrder(client, paymentId) {
    const entry = await _removeFromQueue(client, paymentId);
    if (!entry)
        return { ok: false, reason: "Không tìm thấy đơn trong hàng chờ." };

    // Edit order log to ✅ done
    await _editLog(client, paymentId, "auto.robux.log.done", entry, { forget: true });

    // Update queue
    await updateQueueMessage(client);

    // DM buyer
    const user = await client.users.fetch(entry.userId).catch(() => null);
    if (user) {
        await user
            .send(client.ui.message("auto.robux.dm.done", { order: orderVars(entry), user: client.ui.user(user) }))
            .catch(() => null);
    }

    return { ok: true, entry };
}

/**
 * Admin marks order as failed. Removes from queue, generates refund code, DMs buyer.
 */
async function failOrder(client, paymentId, refundAmount) {
    const entry = await _removeFromQueue(client, paymentId);
    if (!entry)
        return { ok: false, reason: "Không tìm thấy đơn trong hàng chờ." };

    // Generate unique refund code
    const refunds = await _readRefunds(client);
    let refundCode;
    const existing = new Set(refunds.map((r) => r.code));
    for (let i = 0; i < 100; i++) {
        const c = _generateRefundCode();
        if (!existing.has(c)) {
            refundCode = c;
            break;
        }
    }
    if (!refundCode) refundCode = _generateRefundCode();

    // Save refund record
    const resolvedRefundAmount =
        refundAmount != null && !isNaN(refundAmount)
            ? Number(refundAmount)
            : entry.price;
    refunds.push({
        code: refundCode,
        paymentId,
        userId: entry.userId,
        robux: entry.robux,
        price: resolvedRefundAmount,
        accountName: entry.accountName,
        createdAt: Date.now(),
        used: false,
    });
    await _saveRefunds(client, refunds);

    // Edit order log to ❌ failed
    await _editLog(client, paymentId, "auto.robux.log.failed", entry, { forget: true });

    // Update queue
    await updateQueueMessage(client);

    // DM buyer with refund code
    const user = await client.users.fetch(entry.userId).catch(() => null);
    if (user) {
        await user
            .send(
                client.ui.message("auto.robux.dm.failed", {
                    order: orderVars(entry),
                    refund: { code: refundCode, amount: resolvedRefundAmount },
                    user: client.ui.user(user),
                }),
            )
            .catch(() => null);
    }

    return { ok: true, entry, refundCode };
}

/**
 * Admin checks a refund code — returns buyer info + amount.
 */
async function checkRefundCode(client, code) {
    const refunds = await _readRefunds(client);
    const record = refunds.find((r) => r.code === code.toUpperCase());
    if (!record) return { ok: false, reason: "Mã hoàn tiền không tồn tại." };
    if (record.used)
        return {
            ok: false,
            reason: "Mã hoàn tiền này đã được sử dụng rồi.",
            record,
        };
    return { ok: true, record };
}

/**
 * Remove a refund code from the database once admin has processed the refund.
 */
async function markRefundUsed(client, code) {
    const refunds = await _readRefunds(client);
    const idx = refunds.findIndex((r) => r.code === code.toUpperCase());
    if (idx < 0) return false;
    refunds.splice(idx, 1);
    await _saveRefunds(client, refunds);
    return true;
}

// ── Queue message ──────────────────────────────────────────────────────────────

/**
 * Update the live queue message in ROBUX_QUEUE_CHANNEL_ID (template auto.robux.queue).
 * Creates it if it doesn't exist yet, edits it if it does.
 */
async function updateQueueMessage(client) {
    if (!client.configs.settings.robuxQueueChannelId) return;
    try {
        const channel = await client.channels.fetch(
            client.configs.settings.robuxQueueChannelId,
        );
        if (!channel?.isTextBased?.()) return;

        const queue = await _readQueue(client);
        const view = client.ui.message(
            "auto.robux.queue",
            {
                queue: queue.map((item, i) => ({
                    number: i + 1,
                    paymentId: item.paymentId,
                    robuxText: Number(item.robux).toLocaleString(),
                    userId: item.userId,
                })),
            },
            { edit: true },
        );

        // Restore from DB if in-memory ref was lost (e.g. after restart)
        if (!_queueMessageRef) {
            _queueMessageRef = (await client.db.get(RB_QUEUE_MSG_DB)) ?? null;
        }

        if (_queueMessageRef) {
            // Try to edit existing message
            try {
                const msg = await channel.messages.fetch(
                    _queueMessageRef.messageId,
                );
                await msg.edit(view);
                return;
            } catch {
                // Message was deleted — clear both in-memory and DB refs
                _queueMessageRef = null;
                await client.db.delete(RB_QUEUE_MSG_DB).catch(() => null);
            }
        }

        // Send new queue message, pin it, and persist the ref
        const msg = await channel.send(view);
        _queueMessageRef = { channelId: channel.id, messageId: msg.id };
        await client.db.set(RB_QUEUE_MSG_DB, _queueMessageRef);
        await msg.pin().catch(() => null);
    } catch (e) {
        console.warn(`[AutoRobux] updateQueueMessage error: ${e.message}`);
    }
}

// ── Order log messages ─────────────────────────────────────────────────────────

async function sendRobuxOrderLog(
    client,
    paymentId,
    userId,
    robux,
    price,
    accountName,
    gamepassLinks,
) {
    try {
        const channel = await _logChannel(client);
        if (!channel) return;
        const footerText = `ROBUX | Tạo lúc ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false })}`;
        const msg = await channel.send(
            client.ui.message("auto.robux.log.pending", {
                order: orderVars({ paymentId, userId, robux, price, accountName, gamepassLinks }),
                footer: footerText,
            }),
        );
        _orderLogRegistry.set(paymentId, { messageId: msg.id, footerText });
    } catch (e) {
        console.warn(`[AutoRobux] sendRobuxOrderLog error: ${e.message}`);
    }
}

async function editRobuxOrderLog(
    client,
    paymentId,
    robux,
    accountName,
    gamepassLinks,
) {
    // Do NOT forget the registry entry here — completeOrder / failOrder
    // still need it to perform their final edits on this message.
    await _editLog(client, paymentId, "auto.robux.log.paid", { robux, accountName, gamepassLinks });
}

async function cancelRobuxOrderLog(client, paymentId) {
    await _editLog(client, paymentId, "auto.robux.log.cancelled", {}, { forget: true });
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

/**
 * The QR message (template auto.robux.payment). `state` = created | existed.
 * A pending payment carries its Hủy đơn button.
 */
function robuxPaymentMessage(client, payment, state = "created", opts = {}) {
    return client.ui.message(
        "auto.robux.payment",
        { order: orderVars(payment), state },
        { buttons: payment.status === "pending" ? { cancel: { customId: `rb:cancel_payment:${payment.id}` } } : {}, ...opts },
    );
}

module.exports = {
    ROBUX_PACKAGES,
    orderVars,
    packageVars,
    getQueue,
    completeOrder,
    failOrder,
    checkRefundCode,
    markRefundUsed,
    updateQueueMessage,
    createRobuxPayment,
    markRobuxPaymentPaid,
    cancelRobuxPayment,
    getOpenRobuxPayment,
    getRobuxPaymentById,
    expireStaleRobuxPayments,
    handleRobuxPaid,
    sendRobuxOrderLog,
    editRobuxOrderLog,
    cancelRobuxOrderLog,
    robuxPaymentMessage,
};
