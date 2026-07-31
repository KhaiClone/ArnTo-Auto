/**
 * autoQuestHelpers.js
 * Shared helper functions for the Auto Quest feature.
 * Extracted here so they can be imported by multiple files
 * without circular dependency or duplication.
 */

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");

// Shared builder for the quest panel components. Two rows of buttons:
//   Row 1: Quest lẻ, Quest tháng   (the two service types → open token modals)
//   Row 2: Kiểm tra trạng thái, Cập nhật token
// Used by /quest-setup. Buttons are stateless, so — unlike the old string select —
// the same button can be pressed repeatedly without needing to reset the panel.
function buildQuestPanelComponents() {
    const topRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("quest:enter_token")
            .setLabel("Quest lẻ")
            .setEmoji("⚡")
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId("quest:enter_token_monthly")
            .setLabel("Quest tháng")
            .setEmoji("♾️")
            .setStyle(ButtonStyle.Primary),
    );
    const bottomRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("quest:check_token")
            .setLabel("Kiểm tra trạng thái")
            .setEmoji("📊")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId("quest:update_token")
            .setLabel("Cập nhật token")
            .setEmoji("🔑")
            .setStyle(ButtonStyle.Secondary),
    );
    return [topRow, bottomRow];
}
const {
    getRunningMap,
    setAllowedQuests,
    startAccount,
    stopAccount,
    getActivationByPaymentId,
    removeActivationByPaymentId,
    getOrderLogPending,
    setOrderLogPending,
    markTokenRefreshRequired,
    getStoredSelectedQuestIds,
} = require("../extensions/AutoQuest");
const PanelQuest = require("../extensions/PanelQuest");

// In-memory registry: `${userId}:${accountId}` → { messageId, footerText }
const orderLogRegistry = new Map();

// ── Order log ──────────────────────────────────────────────────────────────────

async function sendOrderLog(client, userId, accountId, username, quests) {
    if (!client.configs.settings.questOrderLogChannelId) return;
    try {
        const channel = await client.channels.fetch(
            client.configs.settings.questOrderLogChannelId,
        );
        if (!channel?.isTextBased?.()) return;
        const isStaffFree =
            getRunningMap(userId).get(accountId)?.staffFree === true;
        const footerText = `QUEST | Tạo lúc ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false })}`;
        const embed = client.embed("", {
            title: "📦 Đơn hàng",
            color: isStaffFree ? 0x9b59b6 : 0x5865f2,
            fields: [
                { name: "👤 Khách hàng", value: `<@${userId}>`, inline: true },
                { name: "🎮 Account", value: username, inline: true },
                {
                    name: "📋 Số lượng",
                    value: `**${quests.length}** quest`,
                    inline: true,
                },
                {
                    name: "📋 Trạng thái",
                    value: isStaffFree
                        ? "🆓 Miễn phí (Staff) — Đang chạy"
                        : "⏳ Chờ thanh toán",
                    inline: true,
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
    if (!client.configs.settings.questOrderLogChannelId) return;
    const key = `${userId}:${accountId}`;
    const entry =
        orderLogRegistry.get(key) ||
        (await getOrderLogPending(client, userId, accountId));
    if (!entry) return;
    try {
        const channel = await client.channels.fetch(
            client.configs.settings.questOrderLogChannelId,
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

async function editOrderLogPaid(client, userId, accountId, username, questCount) {
    if (!client.configs.settings.questOrderLogChannelId) return;
    const key = `${userId}:${accountId}`;
    const entry =
        orderLogRegistry.get(key) ||
        (await getOrderLogPending(client, userId, accountId));
    if (!entry) return;
    try {
        const channel = await client.channels.fetch(
            client.configs.settings.questOrderLogChannelId,
        );
        if (!channel?.isTextBased?.()) return;
        const msg = await channel.messages.fetch(entry.messageId);
        const embed = client.embed("", {
            title: "📦 Đơn hàng",
            color: 0xf39c12,
            fields: [
                { name: "👤 Khách hàng", value: `<@${userId}>`, inline: true },
                { name: "🎮 Account", value: username, inline: true },
                {
                    name: "📋 Số lượng",
                    value: `**${questCount}** quest`,
                    inline: true,
                },
                {
                    name: "📋 Trạng thái",
                    value: "✅ Đã thanh toán — Đang chạy quest",
                    inline: true,
                },
            ],
            footer: { text: entry.footerText },
            timestamp: true,
        });
        await msg.edit({ embeds: [embed] });
        // Keep registry entry alive so editOrderLog (completion) can still find it
    } catch (e) {
        console.warn(`[autoQuestHelpers] editOrderLogPaid error: ${e.message}`);
    }
}

async function cancelOrderLog(client, userId, accountId, reason) {
    if (!client.configs.settings.questOrderLogChannelId) return;
    const key = `${userId}:${accountId}`;
    const entry =
        orderLogRegistry.get(key) ||
        (await getOrderLogPending(client, userId, accountId));
    if (!entry) return;
    try {
        const channel = await client.channels.fetch(
            client.configs.settings.questOrderLogChannelId,
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

// Persist paid quests into the account's token-refresh record so they are NOT lost
// when the account can't start (token died while waiting for payment). After the
// user re-enters their token, the refresh flow reads these and resumes the run.
async function _stashPaidQuestsForReset(client, userId, accountId, questIds) {
    const existing = await getStoredSelectedQuestIds(client, userId, accountId);
    const merged = [
        ...new Set(
            [...existing, ...(questIds ?? [])].map(String).filter(Boolean),
        ),
    ];
    await markTokenRefreshRequired(client, userId, accountId, {
        selectedQuestIds: merged,
    });
    return merged;
}

/**
 * After a payment is confirmed as paid, unlock the quest run for the user.
 * Returns "unlocked" (running now), "pending_token" (paid quests saved, waiting for
 * the user to re-enter a dead token), or false (nothing to do).
 */
async function unlockPaymentIfPaid(client, payment) {
    if (!payment || payment.status !== "paid") return false;

    const activation = await getActivationByPaymentId(client, payment.id);

    // Delegate execution to the panel when enabled: stop the idle local loop (it was
    // started at token entry and never got quests) and let the panel run + webhook
    // completions back. Payment itself stays here in arnto-auto.
    if (PanelQuest.isEnabled()) {
        const token = activation?.token;
        const ids = activation?.selectedQuestIds ?? payment.selectedQuestIds ?? [];
        if (token) {
            try {
                stopAccount(payment.userId, payment.accountId);
                await PanelQuest.start({
                    token,
                    mode: "select",
                    selectedQuestIds: ids,
                    ref: payment.userId,
                });
                if (activation) await removeActivationByPaymentId(client, payment.id);
                return "unlocked";
            } catch (err) {
                if (err.tokenDead) {
                    await _stashPaidQuestsForReset(
                        client,
                        payment.userId,
                        payment.accountId,
                        ids,
                    );
                    if (activation)
                        await removeActivationByPaymentId(client, payment.id);
                    return "pending_token";
                }
                console.warn(
                    `[PanelQuest] start failed, fallback to local: ${err.message}`,
                );
                // fall through to local execution below
            }
        }
    }

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
            return unlocked ? "unlocked" : false;
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
            // Token dead / can't start — stash the paid quests so they resume after
            // the user re-enters their token, instead of being silently lost.
            console.warn(
                `[autoQuestHelpers] Cannot start account for payment ${payment.id} (${started.reason}) — lưu quest chờ reset token.`,
            );
            await _stashPaidQuestsForReset(
                client,
                payment.userId,
                payment.accountId,
                activation.selectedQuestIds,
            );
            await removeActivationByPaymentId(client, payment.id);
            return "pending_token";
        }
        const unlocked = await setAllowedQuests(
            client,
            payment.userId,
            started.accountId ?? payment.accountId,
            activation.selectedQuestIds,
        );
        if (unlocked) await removeActivationByPaymentId(client, payment.id);
        return unlocked ? "unlocked" : false;
    }

    // Case 3: no activation record — try a running account, else stash for reset.
    const unlocked = await setAllowedQuests(
        client,
        payment.userId,
        payment.accountId,
        payment.selectedQuestIds,
    );
    if (unlocked) return "unlocked";
    await _stashPaidQuestsForReset(
        client,
        payment.userId,
        payment.accountId,
        payment.selectedQuestIds,
    );
    return "pending_token";
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

// ── Monthly subscription payment UI ──────────────────────────────────────────────

function buildMonthlyPaymentEmbed(client, payment, note) {
    const s = client.configs.settings;
    return {
        title: "Gia hạn Auto Quest theo tháng",
        color: 0x9b59b6,
        description: note || null,
        fields: [
            { name: "Mã đơn", value: `\`${payment.paymentId}\``, inline: false },
            {
                name: "Số tháng",
                value: `**${payment.months}** tháng`,
                inline: true,
            },
            {
                name: "Đơn giá",
                value: `${s.monthlyQuestPrice.toLocaleString("vi-VN")}đ/tháng`,
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
        image: payment.qrUrl ? { url: payment.qrUrl } : null,
        footer: {
            text: "Chuyển đúng nội dung để tự động kích hoạt gói. Bot chạy toàn bộ quest vào Thứ 3 & Thứ 7.",
        },
        timestamp: new Date().toISOString(),
    };
}

function buildMonthlyCancelRow(paymentId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`quest:cancel_monthly:${paymentId}`)
            .setLabel("Hủy đơn")
            .setStyle(ButtonStyle.Danger),
    );
}

module.exports = {
    sendOrderLog,
    editOrderLog,
    editOrderLogPaid,
    cancelOrderLog,
    unlockPaymentIfPaid,
    buildPaymentEmbed,
    buildPaymentActionRow,
    buildMonthlyPaymentEmbed,
    buildMonthlyCancelRow,
    buildQuestPanelComponents,
};
