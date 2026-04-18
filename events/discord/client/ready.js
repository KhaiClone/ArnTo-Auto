const { AttachmentBuilder } = require("discord.js");
const AutoBank = require("../../../extensions/AutoBank");
const {
    restoreAccounts,
    setAccountNotifier,
    expireStalePayments,
    getRecoverablePaidActivations,
} = require("../../../extensions/AutoQuest");
const {
    sendOrderLog,
    editOrderLog,
    cancelOrderLog,
    unlockPaymentIfPaid,
} = require("../../../functions/autoQuestHelpers");

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

        // ── Init AutoBank ──────────────────────────────────────────────────────
        const s = client.configs.settings;
        client.autoBank = new AutoBank(
            client,
            s.vietqrChannelId,
            s.logWebhookUrl,
        );

        // ── Account event notifier ─────────────────────────────────────────────
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
                        await cancelOrderLog(
                            client,
                            userId,
                            accountId,
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
                        await sendOrderLog(
                            client,
                            userId,
                            accountId,
                            username,
                            quests,
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
                        await editOrderLog(
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

        // ── Restore accounts from DB ───────────────────────────────────────────
        const totalRestored = await restoreAccounts(client);
        if (totalRestored > 0)
            console.log(`Restored ${totalRestored} accounts`);

        // ── Recover missed payments (bot was offline) ──────────────────────────
        const { paid, expired } = await client.autoBank.recover();

        for (const entry of paid) {
            try {
                const { paymentId, userId } = entry.context;

                // 1. Mark payment as paid in DB
                const paidPayment = await markPaymentAsPaid(client, paymentId);

                // 2. Unlock quest run for the user
                if (paidPayment) {
                    await unlockPaymentIfPaid(client, paidPayment).catch((e) =>
                        console.warn(
                            `[ready] unlock error for ${paymentId}: ${e.message}`,
                        ),
                    );
                }

                // 3. Notify user
                const user = await client.users.fetch(userId).catch(() => null);
                if (user)
                    await user.send({
                        embeds: [
                            client.embed(
                                [
                                    `Mã đơn: \`${paymentId}\``,
                                    `Số tiền: ${Number(entry.amount).toLocaleString("vi-VN")}đ`,
                                    "Bot phát hiện thanh toán khi khởi động lại. Đã mở chạy quest đã chọn.",
                                ].join("\n"),
                                {
                                    title: "Đã xác nhận thanh toán (khôi phục)",
                                    color: 0x57f287,
                                },
                            ),
                        ],
                    });
            } catch (e) {
                console.warn(`[ready] paid recovery failed: ${e.message}`);
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

        // ── Expire stale pending payments ──────────────────────────────────────
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

        // ── Recover paid activations that weren't processed before shutdown ────
        const recoverable = await getRecoverablePaidActivations(client);
        for (const item of recoverable) {
            try {
                await unlockPaymentIfPaid(client, item.payment);
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
