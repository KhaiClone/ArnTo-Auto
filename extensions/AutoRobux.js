/**
 * AutoRobux.js
 * All Robux order logic:
 *  - Payment DB (create, mark paid, cancel)
 *  - AutoBank integration
 *  - Order log (send / edit)
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

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

// ── Internal helpers ───────────────────────────────────────────────────────────

function _now() {
    return Date.now();
}
function _newPaymentId() {
    return `RB${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
function _randomTransferCode() {
    return `Robux${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`;
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
    return `Robux${Date.now() % 100000}`;
}

// ── Public payment API ─────────────────────────────────────────────────────────

async function createRobuxPayment(
    client,
    { userId, robux, price, gamepaxLink },
) {
    const transferCode = await _generateUniqueCode(client);

    const payment = {
        id: _newPaymentId(),
        type: "robux",
        userId,
        robux,
        price,
        gamepaxLink,
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
            gamepaxLink,
            transferCode,
        };

        client.autoBank.createQR(price, transferCode, context, async (err) => {
            if (err) return; // timeout
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
    const { paymentId, userId, robux, gamepaxLink } = context;

    // Edit order log to show pending admin action
    await editRobuxOrderLog(client, paymentId, robux, gamepaxLink);

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
                            `Link Gamepass: ${gamepaxLink}`,
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

// ── Order log ──────────────────────────────────────────────────────────────────

async function sendRobuxOrderLog(
    client,
    paymentId,
    userId,
    robux,
    price,
    gamepaxLink,
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
                { name: "🔗 Link Gamepass", value: gamepaxLink, inline: false },
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

async function editRobuxOrderLog(client, paymentId, robux, gamepaxLink) {
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
                    name: "💎 Số Robux",
                    value: `**${robux.toLocaleString()} Robux**`,
                    inline: true,
                },
                { name: "🔗 Link Gamepass", value: gamepaxLink, inline: false },
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
        _orderLogRegistry.delete(paymentId);
    } catch (e) {
        console.warn(`[AutoRobux] editRobuxOrderLog error: ${e.message}`);
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
                name: "Link Gamepass",
                value: payment.gamepaxLink,
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
    createRobuxPayment,
    markRobuxPaymentPaid,
    cancelRobuxPayment,
    getOpenRobuxPayment,
    getRobuxPaymentById,
    handleRobuxPaid,
    sendRobuxOrderLog,
    editRobuxOrderLog,
    buildRobuxPaymentEmbed,
    buildRobuxCancelRow,
};
