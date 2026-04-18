/**
 * autoQuestHelpers.js
 * Shared helper functions for the Auto Quest feature.
 * Extracted here so they can be imported by multiple files
 * without circular dependency or duplication.
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const {
    getRunningMap,
    setAllowedQuests,
    startAccount,
    getActivationByPaymentId,
    removeActivationByPaymentId,
    getOrderLogPending,
    setOrderLogPending,
} = require("../extensions/AutoQuest");

// In-memory registry: `${userId}:${accountId}` → { messageId, footerText }
const orderLogRegistry = new Map();

// ── Order log ──────────────────────────────────────────────────────────────────

async function sendOrderLog(client, userId, accountId, username, quests) {
    if (!client.configs.settings.orderLogChannelId) return;
    try {
        const channel = await client.channels.fetch(
            client.configs.settings.orderLogChannelId,
        );
        if (!channel?.isTextBased?.()) return;
        const footerText = `QUEST | Tạo lúc ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false })}`;
        const embed = client.embed("", {
            title: "📦 Đơn hàng",
            color: 0x5865f2,
            fields: [
                { name: "👤 Khách hàng", value: `<@${userId}>`, inline: true },
                { name: "🎮 Account", value: username, inline: true },
                {
                    name: "📋 Số lượng",
                    value: `**${quests.length}** quest`,
                    inline: true,
                },
                {
                    name: "🏷️ Ticket",
                    value: client.configs.settings.orderLogTicketLabel || "—",
                    inline: false,
                },
            ],
            footer: { text: footerText },
            timestamp: true,
        });
        const msg = await channel.send({ embeds: [embed] });
        const entry = { messageId: msg.id, footerText };
        orderLogRegistry.set(`${userId}:${accountId}`, entry);
        await setOrderLogPending(client, userId, accountId, entry);
    } catch (e) {
        console.warn(`[autoQuestHelpers] sendOrderLog error: ${e.message}`);
    }
}

async function editOrderLog(
    client,
    userId,
    accountId,
    username,
    completedNames,
) {
    if (!client.configs.settings.orderLogChannelId) return;
    const key = `${userId}:${accountId}`;
    const entry =
        orderLogRegistry.get(key) ||
        (await getOrderLogPending(client, userId, accountId));
    if (!entry) return;
    try {
        const channel = await client.channels.fetch(
            client.configs.settings.orderLogChannelId,
        );
        if (!channel?.isTextBased?.()) return;
        const msg = await channel.messages.fetch(entry.messageId);
        const embed = client.embed("", {
            title: "📦 Đơn hàng",
            color: 0x57f287,
            fields: [
                { name: "👤 Khách hàng", value: `<@${userId}>`, inline: true },
                { name: "🎮 Account", value: username, inline: true },
                {
                    name: "✅ Đã xử lý",
                    value: `**${completedNames.length}** quest`,
                    inline: true,
                },
                {
                    name: "🏷️ Ticket",
                    value: client.configs.settings.orderLogTicketLabel || "—",
                    inline: false,
                },
            ],
            footer: { text: entry.footerText },
            timestamp: true,
        });
        await msg.edit({ embeds: [embed] });
        orderLogRegistry.delete(key);
        await setOrderLogPending(client, userId, accountId, null);
    } catch (e) {
        console.warn(`[autoQuestHelpers] editOrderLog error: ${e.message}`);
    }
}

async function cancelOrderLog(client, userId, accountId, reason) {
    if (!client.configs.settings.orderLogChannelId) return;
    const key = `${userId}:${accountId}`;
    const entry =
        orderLogRegistry.get(key) ||
        (await getOrderLogPending(client, userId, accountId));
    if (!entry) return;
    try {
        const channel = await client.channels.fetch(
            client.configs.settings.orderLogChannelId,
        );
        if (!channel?.isTextBased?.()) return;
        const msg = await channel.messages.fetch(entry.messageId);
        const embed = client.embed(reason ?? "Đơn **bị hủy**.", {
            title: "📦 Đơn hàng",
            color: 0xed4245,
            footer: { text: entry.footerText },
            timestamp: true,
        });
        await msg.edit({ embeds: [embed] });
        orderLogRegistry.delete(key);
        await setOrderLogPending(client, userId, accountId, null);
    } catch (e) {
        console.warn(`[autoQuestHelpers] cancelOrderLog error: ${e.message}`);
    }
}

// ── Payment unlock ─────────────────────────────────────────────────────────────

/**
 * After a payment is confirmed as paid, unlock the quest run for the user.
 * Handles 3 cases: account already running, account not running (start it), no activation record.
 */
async function unlockPaymentIfPaid(client, payment) {
    if (!payment || payment.status !== "paid") return false;

    const activation = await getActivationByPaymentId(client, payment.id);

    if (activation) {
        const userMap = getRunningMap(payment.userId);

        // Case 1: account is already running — just unlock the quests
        if (userMap.has(payment.accountId)) {
            const unlocked = await setAllowedQuests(
                client,
                payment.userId,
                payment.accountId,
                activation.selectedQuestIds,
            );
            if (unlocked) await removeActivationByPaymentId(client, payment.id);
            return unlocked;
        }

        // Case 2: account not running — start it, then unlock
        const started = await startAccount(
            client,
            payment.userId,
            activation.token,
            {
                allowRestartIfRunning: false,
                notifyStarted: true,
                forceNotifyQuestBatch: true,
                source: "activate",
                requireQuestSelection: true,
            },
        );
        if (!started.ok) {
            console.warn(
                `[autoQuestHelpers] Cannot start account for payment ${payment.id}: ${started.reason}`,
            );
            return false;
        }
        const unlocked = await setAllowedQuests(
            client,
            payment.userId,
            started.accountId ?? payment.accountId,
            activation.selectedQuestIds,
        );
        if (unlocked) await removeActivationByPaymentId(client, payment.id);
        return unlocked;
    }

    // Case 3: no activation record — fallback to payment's own selectedQuestIds
    return setAllowedQuests(
        client,
        payment.userId,
        payment.accountId,
        payment.selectedQuestIds,
    );
}

// ── Payment embed ──────────────────────────────────────────────────────────────

function buildPaymentEmbed(client, payment, note) {
    const s = client.configs.settings;
    return {
        title: "Thanh toán quest",
        color: payment.status === "paid" ? 0x57f287 : 0x5865f2,
        description: note || null,
        fields: [
            { name: "Mã đơn", value: `\`${payment.id}\``, inline: false },
            {
                name: "Số lượng quest",
                value: String((payment.selectedQuestIds ?? []).length),
                inline: true,
            },
            {
                name: "Đơn giá",
                value: `${s.questPricePerItem.toLocaleString("vi-VN")}đ/quest`,
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
            text:
                payment.status === "pending"
                    ? "Chuyển đúng nội dung để tự động xác nhận giao dịch."
                    : payment.status === "paid"
                      ? "Đã xác nhận thanh toán. Bot bắt đầu chạy quest đã chọn."
                      : "Đơn đã hủy hoặc hết hạn.",
        },
        timestamp: new Date().toISOString(),
    };
}

function buildPaymentActionRow(paymentId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`quest:cancel_payment:${paymentId}`)
            .setLabel("Hủy đơn")
            .setStyle(ButtonStyle.Danger),
    );
}

module.exports = {
    sendOrderLog,
    editOrderLog,
    cancelOrderLog,
    unlockPaymentIfPaid,
    buildPaymentEmbed,
    buildPaymentActionRow,
};
