/**
 * AutoRobux.js
 * All Robux order logic:
 *  - Payment DB (create, mark paid, cancel)
 *  - AutoBank integration
 *  - Order log (send / edit)
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
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
                // Timeout — payment expired without being paid; update order log
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
            .send({
                embeds: [
                    client.embed(
                        [
                            `Mã đơn: \`${paymentId}\``,
                            `Số Robux: **${robux.toLocaleString()} Robux**`,
                            `Tên tài khoản: ${accountName}`,
                            `Link Gamepass:`,
                            `${gamepassLinks.join("\n")}`,
                            "✅ Đã xác nhận thanh toán! Admin sẽ xử lý đơn của bạn sớm nhất.",
                        ].join("\n"),
                        {
                            title: "Đã xác nhận thanh toán Robux",
                            color: 0x57f287,
                        },
                    ),
                ],
            })
            .catch(() => null);
    }
}

// Exported for use by missed handler in ready.js
async function handleRobuxPaid(client, context) {
    await _onPaymentPaid(client, context);
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
    const logEntry = _orderLogRegistry.get(paymentId);
    if (logEntry && client.configs.settings.robuxOrderLogChannelId) {
        try {
            const ch = await client.channels.fetch(
                client.configs.settings.robuxOrderLogChannelId,
            );
            const msg = await ch.messages.fetch(logEntry.messageId);
            const embed = client.embed("", {
                title: "🎮 Đơn Robux",
                color: 0x57f287,
                fields: [
                    {
                        name: "💎 Số Robux",
                        value: `**${entry.robux.toLocaleString()} Robux**`,
                        inline: true,
                    },
                    {
                        name: "👤 Tài khoản",
                        value: entry.accountName,
                        inline: true,
                    },
                    {
                        name: "🔗 Link Gamepass",
                        value: entry.gamepassLinks.join("\n"),
                        inline: false,
                    },
                    {
                        name: "📋 Trạng thái",
                        value: "✅ Đã hoàn thành",
                        inline: true,
                    },
                ],
                footer: { text: logEntry.footerText },
                timestamp: true,
            });
            await msg.edit({ embeds: [embed] });
            _orderLogRegistry.delete(paymentId);
        } catch {}
    }

    // Update queue
    await updateQueueMessage(client);

    // DM buyer
    const user = await client.users.fetch(entry.userId).catch(() => null);
    if (user) {
        await user
            .send({
                embeds: [
                    client.embed(
                        [
                            `Mã đơn: \`${paymentId}\``,
                            `💎 **${entry.robux.toLocaleString()} Robux** đã được nạp vào tài khoản **${entry.accountName}**.`,
                            "✅ Đơn hàng của bạn đã hoàn thành!",
                        ].join("\n"),
                        { title: "Đơn Robux hoàn thành", color: 0x57f287 },
                    ),
                ],
            })
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
    const logEntry = _orderLogRegistry.get(paymentId);
    if (logEntry && client.configs.settings.robuxOrderLogChannelId) {
        try {
            const ch = await client.channels.fetch(
                client.configs.settings.robuxOrderLogChannelId,
            );
            const msg = await ch.messages.fetch(logEntry.messageId);
            const embed = client.embed("", {
                title: "🎮 Đơn Robux",
                color: 0xed4245,
                fields: [
                    {
                        name: "📦 Mã đơn (Queue)",
                        value: `\`${paymentId}\``,
                        inline: false,
                    },
                    {
                        name: "💎 Số Robux",
                        value: `**${entry.robux.toLocaleString()} Robux**`,
                        inline: true,
                    },
                    {
                        name: "👤 Tài khoản",
                        value: entry.accountName,
                        inline: true,
                    },
                    {
                        name: "📋 Trạng thái",
                        value: "❌ Thất bại — Đã cấp mã hoàn tiền",
                        inline: true,
                    },
                ],
                footer: { text: logEntry.footerText },
                timestamp: true,
            });
            await msg.edit({ embeds: [embed] });
            _orderLogRegistry.delete(paymentId);
        } catch {}
    }

    // Update queue
    await updateQueueMessage(client);

    // DM buyer with refund code
    const user = await client.users.fetch(entry.userId).catch(() => null);
    if (user) {
        await user
            .send({
                embeds: [
                    client.embed(
                        [
                            `Mã đơn: \`${paymentId}\``,
                            `❌ Rất tiếc, đơn **${entry.robux.toLocaleString()} Robux** của bạn không thể xử lý.`,
                            "",
                            "**Mã hoàn tiền của bạn:**",
                            `\`\`\`${refundCode}\`\`\``,
                            "Hãy tạo ticket và gửi mã này để được hoàn tiền.",
                            "Mã chỉ dùng được một lần.",
                        ].join("\n"),
                        {
                            title: "Đơn Robux thất bại — Mã hoàn tiền",
                            color: 0xed4245,
                        },
                    ),
                ],
            })
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
 * Update the live queue message in ROBUX_QUEUE_CHANNEL_ID.
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
        const embed = _buildQueueEmbed(client, queue);

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
                await msg.edit({ embeds: [embed] });
                return;
            } catch {
                // Message was deleted — clear both in-memory and DB refs
                _queueMessageRef = null;
                await client.db.delete(RB_QUEUE_MSG_DB).catch(() => null);
            }
        }

        // Send new queue message, pin it, and persist the ref
        const msg = await channel.send({ embeds: [embed] });
        _queueMessageRef = { channelId: channel.id, messageId: msg.id };
        await client.db.set(RB_QUEUE_MSG_DB, _queueMessageRef);
        await msg.pin().catch(() => null);
    } catch (e) {
        console.warn(`[AutoRobux] updateQueueMessage error: ${e.message}`);
    }
}

function _buildQueueEmbed(client, queue) {
    const lines =
        queue.length === 0
            ? ["*Không có đơn nào đang chờ xử lý.*"]
            : queue.map(
                  (item, i) =>
                      `**#${i + 1}** | \`${item.paymentId}\` | 💎 ${item.robux.toLocaleString()} Robux | <@${item.userId}>`,
              );

    return {
        title: "🎮 Hàng chờ Robux",
        color: 0xe74c3c,
        description: lines.join("\n"),
        fields:
            queue.length > 0
                ? [
                      {
                          name: "Tổng đơn chờ",
                          value: `**${queue.length}**`,
                          inline: true,
                      },
                  ]
                : [],
        footer: { text: "Cập nhật lúc" },
        timestamp: new Date().toISOString(),
    };
}

// ── Order log ──────────────────────────────────────────────────────────────────

async function sendRobuxOrderLog(
    client,
    paymentId,
    userId,
    robux,
    price,
    accountName,
    gamepassLinks,
) {
    if (!client.configs.settings.robuxOrderLogChannelId) return;
    try {
        const channel = await client.channels.fetch(
            client.configs.settings.robuxOrderLogChannelId,
        );
        if (!channel?.isTextBased?.()) return;

        const footerText = `ROBUX | Tạo lúc ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false })}`;
        const embed = client.embed("", {
            title: "🎮 Đơn Robux",
            color: 0xe74c3c,
            fields: [
                {
                    name: "📦 Mã đơn (Queue)",
                    value: `\`${paymentId}\``,
                    inline: false,
                },
                { name: "👤 Khách hàng", value: `<@${userId}>`, inline: true },
                {
                    name: "💎 Số Robux",
                    value: `**${robux.toLocaleString()} Robux**`,
                    inline: true,
                },
                {
                    name: "💰 Số tiền",
                    value: `**${price.toLocaleString("vi-VN")}đ**`,
                    inline: true,
                },
                {
                    name: "👤 Tên tài khoản",
                    value: accountName,
                    inline: true,
                },
                {
                    name: "🔗 Link Gamepass",
                    value: gamepassLinks.join("\n"),
                    inline: false,
                },
                {
                    name: "📋 Trạng thái",
                    value: "⏳ Chờ thanh toán",
                    inline: true,
                },
            ],
            footer: { text: footerText },
            timestamp: true,
        });

        const msg = await channel.send({ embeds: [embed] });
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
    if (!client.configs.settings.robuxOrderLogChannelId) return;
    const entry = _orderLogRegistry.get(paymentId);
    if (!entry) return;
    try {
        const channel = await client.channels.fetch(
            client.configs.settings.robuxOrderLogChannelId,
        );
        if (!channel?.isTextBased?.()) return;
        const msg = await channel.messages.fetch(entry.messageId);
        const embed = client.embed("", {
            title: "🎮 Đơn Robux",
            color: 0xf39c12,
            fields: [
                {
                    name: "📦 Mã đơn (Queue)",
                    value: `\`${paymentId}\``,
                    inline: false,
                },
                {
                    name: "💎 Số Robux",
                    value: `**${robux.toLocaleString()} Robux**`,
                    inline: true,
                },
                {
                    name: "👤 Tên tài khoản",
                    value: accountName,
                    inline: true,
                },
                {
                    name: "🔗 Link Gamepass",
                    value: gamepassLinks.join("\n"),
                    inline: false,
                },
                {
                    name: "📋 Trạng thái",
                    value: "✅ Đã thanh toán — Chờ admin xử lý",
                    inline: true,
                },
            ],
            footer: { text: entry.footerText },
            timestamp: true,
        });
        await msg.edit({ embeds: [embed] });
        // Do NOT delete the registry entry here — completeOrder / failOrder
        // still need it to perform their final edits on this message.
    } catch (e) {
        console.warn(`[AutoRobux] editRobuxOrderLog error: ${e.message}`);
    }
}

async function cancelRobuxOrderLog(client, paymentId) {
    if (!client.configs.settings.robuxOrderLogChannelId) return;
    const entry = _orderLogRegistry.get(paymentId);
    if (!entry) return;
    try {
        const channel = await client.channels.fetch(
            client.configs.settings.robuxOrderLogChannelId,
        );
        if (!channel?.isTextBased?.()) return;
        const msg = await channel.messages.fetch(entry.messageId);
        const embed = client.embed("", {
            title: "🎮 Đơn Robux",
            color: 0x95a5a6,
            fields: [
                {
                    name: "📦 Mã đơn (Queue)",
                    value: `\`${paymentId}\``,
                    inline: false,
                },
                {
                    name: "📋 Trạng thái",
                    value: "🚫 Đã hủy bởi khách / Hết hạn",
                    inline: true,
                },
            ],
            footer: { text: entry.footerText },
            timestamp: true,
        });
        await msg.edit({ embeds: [embed] });
        _orderLogRegistry.delete(paymentId);
    } catch (e) {
        console.warn(`[AutoRobux] cancelRobuxOrderLog error: ${e.message}`);
    }
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function buildRobuxPaymentEmbed(client, payment, note) {
    const s = client.configs.settings;
    return {
        title: "Thanh toán Robux",
        color: 0xe74c3c,
        description: note || null,
        fields: [
            { name: "Mã đơn", value: `\`${payment.id}\``, inline: false },
            {
                name: "Số Robux",
                value: `**${payment.robux.toLocaleString()} Robux**`,
                inline: true,
            },
            {
                name: "Tổng tiền",
                value: `\`${Number(payment.price).toLocaleString("vi-VN")} VNĐ\``,
                inline: true,
            },
            {
                name: "Tên tài khoản Roblox",
                value: payment.accountName,
                inline: true,
            },
            {
                name: "Link Gamepass",
                value: payment.gamepassLinks.join("\n"),
                inline: false,
            },
            {
                name: "Chủ tài khoản",
                value: `\`${s.bankHolder}\``,
                inline: false,
            },
            { name: "Ngân hàng", value: `\`${s.bankCode}\``, inline: true },
            {
                name: "Số tài khoản",
                value: `\`\`\`\n${s.bankAccount}\n\`\`\``,
                inline: false,
            },
            {
                name: "Nội dung chuyển khoản",
                value: `\`\`\`\n${payment.transferCode}\n\`\`\``,
                inline: false,
            },
        ],
        image:
            payment.status === "pending" && payment.qrUrl
                ? { url: payment.qrUrl }
                : null,
        footer: {
            text: "Bot tự kiểm tra qua VietQR webhook. Chuyển đúng nội dung.",
        },
        timestamp: new Date().toISOString(),
    };
}

function buildRobuxCancelRow(paymentId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`rb:cancel_payment:${paymentId}`)
            .setLabel("Hủy đơn")
            .setStyle(ButtonStyle.Danger),
    );
}

module.exports = {
    ROBUX_PACKAGES,
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
    handleRobuxPaid,
    sendRobuxOrderLog,
    editRobuxOrderLog,
    cancelRobuxOrderLog,
    buildRobuxPaymentEmbed,
    buildRobuxCancelRow,
};
