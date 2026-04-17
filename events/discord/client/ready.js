const { AttachmentBuilder } = require("discord.js");
const AutoBank = require("../../../extensions/AutoBank");
const {
    restoreAccounts,
    setAccountNotifier,
    getRunningMap,
    setAllowedQuests,
    getSelectableQuests,
} = require("../../../extensions/accounts");
const {
    expireStalePayments,
    getRecoverablePaidActivations,
    getActivationByPaymentId,
    removeActivationByPaymentId,
} = require("../../../extensions/payments");
const storage = require("../../../extensions/storage");

module.exports = {
    name: "clientReady",
    async execute(client) {
        if (!client.configs.settings.guildIds[0])
            throw new Error("Missing guild id.");
        if (!client.configs.settings.ownerUserIds[0])
            throw new Error("Missing owner bot.");

        client.guilds.cache.forEach((e) => {
            if (!client.configs.settings.guildIds.includes(e.id)) e.leave();
        });
        require("../../../handlers/antiCrash");

        if (process.env.EXPRESS === "true") {
            const express = require("express");
            const app = express();
            app.get("/", (req, res) => res.send(`Ping: ${client.ws.ping} ms`));
            app.listen(client.configs.settings.port, () =>
                console.log(
                    `Server listening on port ${client.configs.settings.port}`,
                ),
            );
        }

        console.log(`Username: ${client.user.username}`);
        console.log(`Client ID: ${client.user.id}`);

        // ── AutoBank init ──────────────────────────────────────────────────────
        const s = client.configs.settings;
        client.autoBank = new AutoBank(
            client,
            s.vietqrChannelId,
            s.logWebhookUrl,
        );

        // ── Account notifier ───────────────────────────────────────────────────
        setAccountNotifier(
            async ({
                type,
                userId,
                accountId,
                username,
                source,
                reason,
                quests,
                completedQuestNames,
            }) => {
                try {
                    const user = await client.users.fetch(userId);

                    if (type === "token_dead") {
                        await _cancelOrderLog(
                            client,
                            userId,
                            accountId,
                            username,
                            "Đơn **bị hủy**: token account bị dead.",
                        );
                        return user.send({
                            embeds: [
                                client.embed(
                                    [
                                        "Bot phát hiện token không còn hợp lệ.",
                                        `Account bị gỡ: **${username}** (\`${accountId}\`)`,
                                        reason ? `Chi tiết: ${reason}` : null,
                                        "Bấm nút bên dưới để nhập lại token.",
                                    ]
                                        .filter(Boolean)
                                        .join("\n"),
                                    {
                                        title: "Nhắc lại token",
                                        color: 0xfee75c,
                                        timestamp: true,
                                    },
                                ),
                            ],
                            components: [
                                {
                                    type: 1,
                                    components: [
                                        {
                                            type: 2,
                                            style: 1,
                                            label: "Nhập token ngay",
                                            custom_id: `quest:refresh_token:${accountId}`,
                                        },
                                    ],
                                },
                            ],
                        });
                    }

                    if (type === "quest_batch_started") {
                        await _sendOrderLog(
                            client,
                            userId,
                            accountId,
                            username,
                            quests,
                            true,
                        );
                        return user.send({
                            embeds: [
                                client.embed(
                                    [
                                        `Account: **${username}** (\`${accountId}\`)`,
                                        `Số quest: ${quests.length}`,
                                        ...quests.map(
                                            (q) =>
                                                `- ${q.name}${q.taskType ? ` [${q.taskType}]` : ""}`,
                                        ),
                                    ].join("\n"),
                                    {
                                        title: "Bắt đầu xử lý quest",
                                        color: 0x5865f2,
                                        timestamp: true,
                                    },
                                ),
                            ],
                        });
                    }

                    if (type === "quest_batch_completed") {
                        await _editOrderLog(
                            client,
                            userId,
                            accountId,
                            username,
                            completedQuestNames,
                        );
                        return user.send({
                            embeds: [
                                client.embed(
                                    [
                                        `Account: **${username}** (\`${accountId}\`)`,
                                        `Đã xong ${completedQuestNames.length} quest.`,
                                        ...completedQuestNames.map(
                                            (n) =>
                                                `- ${typeof n === "string" ? n : n.name}`,
                                        ),
                                    ].join("\n"),
                                    {
                                        title: "Đã xử lý xong quest",
                                        color: 0x57f287,
                                        timestamp: true,
                                    },
                                ),
                            ],
                        });
                    }

                    if (type === "account_started") {
                        return user.send({
                            embeds: [
                                client.embed(
                                    [
                                        `Account: **${username}** (\`${accountId}\`)`,
                                        "Dùng `/status` để theo dõi tiến trình.",
                                    ].join("\n"),
                                    {
                                        title: "Bắt đầu chạy quest",
                                        color: 0x57f287,
                                        timestamp: true,
                                    },
                                ),
                            ],
                        });
                    }
                } catch (e) {
                    console.warn(
                        `[ready] notify error for ${userId}: ${e.message}`,
                    );
                }
            },
        );

        // ── Restore accounts ───────────────────────────────────────────────────
        const totalRestored = await restoreAccounts(client);
        if (totalRestored > 0)
            console.log(`Restored ${totalRestored} accounts`);

        // ── Recover missed payments ────────────────────────────────────────────
        const { paid, expired } = await client.autoBank.recover();

        for (const entry of paid) {
            try {
                const user = await client.users
                    .fetch(entry.context.userId)
                    .catch(() => null);
                if (user)
                    await user.send({
                        embeds: [
                            client.embed(
                                [
                                    `Mã đơn: \`${entry.context.paymentId}\``,
                                    `Số tiền: ${Number(entry.amount).toLocaleString("vi-VN")}đ`,
                                    "Bot phát hiện thanh toán khi khởi động lại. Đang xử lý quest...",
                                ].join("\n"),
                                {
                                    title: "Đã xác nhận thanh toán (khôi phục)",
                                    color: 0xfee75c,
                                },
                            ),
                        ],
                    });
            } catch (e) {
                console.warn(`[ready] DM paid recovery failed: ${e.message}`);
            }
        }

        for (const entry of expired) {
            try {
                const user = await client.users
                    .fetch(entry.context.userId)
                    .catch(() => null);
                if (user)
                    await user.send({
                        embeds: [
                            client.embed(
                                [
                                    `Mã đơn: \`${entry.context.paymentId}\``,
                                    `Số tiền: ${Number(entry.amount).toLocaleString("vi-VN")}đ`,
                                    "QR đã hết hạn. Hãy chọn lại quest để tạo QR mới.",
                                ].join("\n"),
                                {
                                    title: "QR thanh toán đã hết hạn",
                                    color: 0xfee75c,
                                },
                            ),
                        ],
                    });
            } catch (e) {
                console.warn(
                    `[ready] DM expired recovery failed: ${e.message}`,
                );
            }
        }

        // ── Expire stale & recover paid activations ────────────────────────────
        const stale = await expireStalePayments(client);
        for (const p of stale) {
            try {
                const user = await client.users
                    .fetch(p.userId)
                    .catch(() => null);
                if (user)
                    await user.send({
                        embeds: [
                            client.embed(
                                [
                                    `Mã đơn: \`${p.id}\``,
                                    `Số tiền: ${Number(p.amount).toLocaleString("vi-VN")}đ`,
                                    "Đơn đã quá 10 phút. Hãy chọn lại quest.",
                                ].join("\n"),
                                {
                                    title: "QR thanh toán đã hết hạn",
                                    color: 0xfee75c,
                                },
                            ),
                        ],
                    });
            } catch (e) {}
        }

        const recoverable = await getRecoverablePaidActivations(client);
        for (const item of recoverable) {
            try {
                await _unlockPaymentIfPaid(client, item.payment);
            } catch (e) {
                console.warn(
                    `[ready] Recovery error ${item.payment.id}: ${e.message}`,
                );
            }
        }

        // ── Backup interval ────────────────────────────────────────────────────
        setInterval(
            () => {
                if (process.env.WEBHOOK_BACKUP) {
                    client.sendWebhook(process.env.WEBHOOK_BACKUP, {
                        files: [
                            new AttachmentBuilder(".env", { name: ".env" }),
                            new AttachmentBuilder("json.sqlite", {
                                name: "json.sqlite",
                            }),
                        ],
                    });
                }
            },
            60 * 60 * 1000,
        );
    },
};

// ── Order log helpers ──────────────────────────────────────────────────────────
const orderLogRegistry = new Map();

async function _sendOrderLog(
    client,
    userId,
    accountId,
    username,
    quests,
    processing,
) {
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
        await storage.setOrderLogPending(client, userId, accountId, entry);
    } catch (e) {
        console.warn(`[order log] send error: ${e.message}`);
    }
}

async function _editOrderLog(
    client,
    userId,
    accountId,
    username,
    completedNames,
) {
    if (!client.configs.settings.orderLogChannelId) return;
    const key = `${userId}:${accountId}`;
    let entry =
        orderLogRegistry.get(key) ||
        (await storage.getOrderLogPending(client, userId, accountId));
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
        await storage.setOrderLogPending(client, userId, accountId, null);
    } catch (e) {
        console.warn(`[order log] edit error: ${e.message}`);
    }
}

async function _cancelOrderLog(client, userId, accountId, username, reason) {
    if (!client.configs.settings.orderLogChannelId) return;
    const key = `${userId}:${accountId}`;
    const entry =
        orderLogRegistry.get(key) ||
        (await storage.getOrderLogPending(client, userId, accountId));
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
        await storage.setOrderLogPending(client, userId, accountId, null);
    } catch (e) {
        console.warn(`[order log] cancel error: ${e.message}`);
    }
}

async function _unlockPaymentIfPaid(client, payment) {
    if (!payment || payment.status !== "paid") return false;
    const {
        getActivationByPaymentId,
        removeActivationByPaymentId,
    } = require("../../../extensions/payments");
    const {
        getRunningMap,
        setAllowedQuests,
        startAccount,
        resolveDiscordAccount,
    } = require("../../../extensions/accounts");

    const activation = await getActivationByPaymentId(client, payment.id);
    if (activation) {
        const userMap = getRunningMap(payment.userId);
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
        if (!started.ok) return false;
        const unlocked = await setAllowedQuests(
            client,
            payment.userId,
            started.accountId ?? payment.accountId,
            activation.selectedQuestIds,
        );
        if (unlocked) await removeActivationByPaymentId(client, payment.id);
        return unlocked;
    }
    return setAllowedQuests(
        client,
        payment.userId,
        payment.accountId,
        payment.selectedQuestIds,
    );
}

module.exports._unlockPaymentIfPaid = _unlockPaymentIfPaid;
module.exports._cancelOrderLog = _cancelOrderLog;
