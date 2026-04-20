/**
 * AutoHypeSquad.js
 * All HypeSquad payment logic in one place:
 *  - Payment DB (create, mark paid, cancel, expire)
 *  - AutoBank integration
 *  - Badge change execution
 *  - Order log (send / edit / cancel)
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const setHypeSquadBadge = require("../functions/setHypeSquadBadge");
const { nanoid } = require("nanoid");

// ── Constants ──────────────────────────────────────────────────────────────────

const EXPIRE_MS = 10 * 60 * 1000; // 10 minutes
const HS_DB = "hypesquad_payments";

const HOUSES = [
    {
        id: 1,
        name: "Bravery",
        emoji: "<:1_:1495429339959787582>",
        description: "House of Bravery",
    },
    {
        id: 2,
        name: "Brilliance",
        emoji: "<:2_:1495429363871514776>",
        description: "House of Brilliance",
    },
    {
        id: 3,
        name: "Balance",
        emoji: "<:3_:1495429264013660291>",
        description: "House of Balance",
    },
];

// In-memory order log registry: paymentId → { messageId, footerText }
const _orderLogRegistry = new Map();

// ── Internal helpers ───────────────────────────────────────────────────────────

function _now() {
    return Date.now();
}
function _newPaymentId() {
    return `HS${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
function _randomTransferCode() {
    return `${nanoid(8).replaceAll("-", "").replaceAll("_", "")} Chuyen tien`;
}

function _buildVietQrUrl(client, amount, transferCode) {
    const s = client.configs.settings;
    return `https://img.vietqr.io/image/${s.bankCode}-${s.bankAccount}-qr_only.png?addInfo=${encodeURIComponent(transferCode)}&accountName=${encodeURIComponent(s.bankHolder)}&amount=${amount}`;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function _readPayments(client) {
    return (await client.db.get(HS_DB)) ?? [];
}
async function _savePayments(client, list) {
    await client.db.set(HS_DB, list);
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

// ── Public payment API ─────────────────────────────────────────────────────────

async function createHsPayment(client, { userId, token, houseId, houseName }) {
    const amount = client.configs.settings.hypeSquadPrice;
    const transferCode = await _generateUniqueCode(client);

    const payment = {
        id: _newPaymentId(),
        type: "hypesquad",
        userId,
        houseId,
        houseName,
        amount,
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
            _handler: "hs_payment",
            paymentId: payment.id,
            userId,
            token,
            houseId,
            houseName,
            transferCode,
        };

        client.autoBank.createQR(amount, transferCode, context, async (err) => {
            if (err) return;
            const paid = await markHsPaymentPaid(client, payment.id);
            if (paid) await runBadgeChange(client, context);
        });

        await client.db.create("autobank_pending", {
            customId: transferCode,
            amount,
            expireAt: payment.expiresAt,
            context,
        });
    }

    return { ...payment, qrUrl: _buildVietQrUrl(client, amount, transferCode) };
}

async function markHsPaymentPaid(client, paymentId) {
    const list = await _readPayments(client);
    const idx = list.findIndex((i) => i.id === paymentId);
    if (idx < 0) return null;
    const paid = { ...list[idx], status: "paid" };
    list.splice(idx, 1);
    await _savePayments(client, list);
    return paid;
}

async function cancelHsPayment(client, paymentId) {
    const list = await _readPayments(client);
    const idx = list.findIndex((i) => i.id === paymentId);
    if (idx < 0) return null;
    const removed = list[idx];
    list.splice(idx, 1);
    await _savePayments(client, list);
    return removed;
}

async function getOpenHsPayment(client, userId) {
    return (
        (await _readPayments(client)).find(
            (i) =>
                i.status === "pending" &&
                Number(i.expiresAt) > _now() &&
                i.userId === userId,
        ) ?? null
    );
}

async function getHsPaymentById(client, paymentId) {
    return (
        (await _readPayments(client)).find((i) => i.id === paymentId) ?? null
    );
}

// ── Badge change ───────────────────────────────────────────────────────────────

async function runBadgeChange(client, context) {
    const { paymentId, userId, token, houseId, houseName } = context;
    const result = await setHypeSquadBadge(token, houseId);
    const house = HOUSES.find((h) => h.id === houseId);

    // Edit order log to completed
    await editHsOrderLog(client, paymentId, houseName, result.success);

    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;

    if (result.success) {
        await user
            .send({
                embeds: [
                    client.embed(
                        [
                            `Mã đơn: \`${paymentId}\``,
                            `Badge: ${house?.emoji ?? ""} **${houseName}**`,
                            "✅ Đã đổi badge HypeSquad thành công!",
                        ].join("\n"),
                        { title: "Đổi badge thành công", color: 0x57f287 },
                    ),
                ],
            })
            .catch(() => null);
    } else {
        await user
            .send({
                embeds: [
                    client.embed(
                        [
                            `Mã đơn: \`${paymentId}\``,
                            `Badge: ${house?.emoji ?? ""} **${houseName}**`,
                            `❌ Thất bại: ${result.message}`,
                            "Vui lòng liên hệ admin.",
                        ].join("\n"),
                        { title: "Đổi badge thất bại", color: 0xed4245 },
                    ),
                ],
            })
            .catch(() => null);
    }
}

// ── Order log ──────────────────────────────────────────────────────────────────

async function sendHsOrderLog(
    client,
    paymentId,
    userId,
    houseName,
    houseEmoji,
) {
    if (!client.configs.settings.hypeSquadOrderLogChannelId) return;
    try {
        const channel = await client.channels.fetch(
            client.configs.settings.hypeSquadOrderLogChannelId,
        );
        if (!channel?.isTextBased?.()) return;

        const footerText = `HYPESQUAD | Tạo lúc ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false })}`;
        const embed = client.embed("", {
            title: "🏅 Đơn HypeSquad",
            color: 0x5865f2,
            fields: [
                { name: "👤 Khách hàng", value: `<@${userId}>`, inline: true },
                {
                    name: "🎖️ Badge",
                    value: `${houseEmoji} **${houseName}**`,
                    inline: true,
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
        console.warn(`[AutoHypeSquad] sendHsOrderLog error: ${e.message}`);
    }
}

async function editHsOrderLog(client, paymentId, houseName, success) {
    if (!client.configs.settings.hypeSquadOrderLogChannelId) return;
    const entry = _orderLogRegistry.get(paymentId);
    if (!entry) return;
    try {
        const channel = await client.channels.fetch(
            client.configs.settings.hypeSquadOrderLogChannelId,
        );
        if (!channel?.isTextBased?.()) return;
        const msg = await channel.messages.fetch(entry.messageId);
        const statusText = success
            ? "✅ Đã đổi badge thành công"
            : "❌ Đổi badge thất bại";
        const embed = client.embed("", {
            title: "🏅 Đơn HypeSquad",
            color: success ? 0x57f287 : 0xed4245,
            fields: [
                { name: "🎖️ Badge", value: `**${houseName}**`, inline: true },
                { name: "📋 Trạng thái", value: statusText, inline: true },
            ],
            footer: { text: entry.footerText },
            timestamp: true,
        });
        await msg.edit({ embeds: [embed] });
        _orderLogRegistry.delete(paymentId);
    } catch (e) {
        console.warn(`[AutoHypeSquad] editHsOrderLog error: ${e.message}`);
    }
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function buildHsPaymentEmbed(client, payment, note) {
    const s = client.configs.settings;
    const house = HOUSES.find((h) => h.id === payment.houseId);
    return {
        title: "Thanh toán HypeSquad",
        color: 0x5865f2,
        description: note || null,
        fields: [
            { name: "Mã đơn", value: `\`${payment.id}\``, inline: false },
            {
                name: "Badge",
                value: `${house?.emoji ?? ""} **${payment.houseName}**`,
                inline: true,
            },
            {
                name: "Tổng tiền",
                value: `\`${Number(payment.amount).toLocaleString("vi-VN")} VNĐ\``,
                inline: true,
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

function buildHsCancelRow(paymentId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`hs:cancel_payment:${paymentId}`)
            .setLabel("Hủy đơn")
            .setStyle(ButtonStyle.Danger),
    );
}

module.exports = {
    HOUSES,
    createHsPayment,
    markHsPaymentPaid,
    cancelHsPayment,
    getOpenHsPayment,
    getHsPaymentById,
    runBadgeChange,
    sendHsOrderLog,
    editHsOrderLog,
    buildHsPaymentEmbed,
    buildHsCancelRow,
};
