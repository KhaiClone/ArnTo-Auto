const {
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");
const AutoBank = require("../../../extensions/AutoBank");
const {
    restoreAccounts,
    setAccountNotifier,
    expireStalePayments,
    sweepStaleAccounts,
    getRecoverablePaidActivations,
    markPaymentAsPaid,
    getRunningMap,
} = require("../../../extensions/AutoQuest");
const {
    editOrderLog,
    editOrderLogPaid,
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
        // require("../../../handlers/antiCrash");

        if (process.env.EXPRESS === "true" || process.env.DM_API_KEY) {
            const express = require("express");
            const app = express();
            app.use(express.json({ limit: "1mb" }));
            app.get("/", (req, res) => res.send(`Ping: ${client.ws.ping} ms`));

            // ── DM API ─────────────────────────────────────────────────────────
            // Panel (or any authorized service) can POST here to deliver a DM
            // to a buyer. Webhook alerts remain independent.
            app.post("/api/dm", async (req, res) => {
                const key = process.env.DM_API_KEY;
                if (!key) return res.status(503).json({ error: "dm_disabled" });
                if (req.header("x-api-key") !== key)
                    return res.status(401).json({ error: "unauthorized" });

                const { buyerID, content, embeds, components } = req.body || {};
                if (!buyerID || (!content && !embeds))
                    return res.status(400).json({ error: "invalid_payload" });

                try {
                    const user = await client.users.fetch(buyerID);
                    await user.send({ content, embeds, components });
                    return res.json({ ok: true });
                } catch (err) {
                    const code = err?.code;
                    if (code === 10013)
                        return res.status(404).json({ error: "user_not_found" });
                    if (code === 50007)
                        return res.status(403).json({ error: "dm_closed" });
                    console.warn(`[DM API] send failed for ${buyerID}: ${err.message}`);
                    return res.status(500).json({ error: "send_failed" });
                }
            });

            app.listen(client.configs.settings.port, () =>
                console.log(
                    `Server listening on port ${client.configs.settings.port}`,
                ),
            );
        }

        console.log(`Username: ${client.user.username}`);
        console.log(`Client ID: ${client.user.id}`);

        // ── Init AutoBank & AutoPanel ──────────────────────────────────────────
        const s = client.configs.settings;
        client.autoBank = new AutoBank(
            client,
            s.vietqrChannelId,
            s.logWebhookUrl,
        );
        const AutoPanel = require("../../../extensions/AutoPanel");
        client.autoPanel = new AutoPanel(client);

        // Register recovery handler for quest payments
        // Called when a payment arrives after bot restart (in-memory callback is gone)
        client.autoBank.registerMissedHandler(
            "quest_payment",
            async (client, entry) => {
                const { paymentId, userId } = entry.context;
                const paidPayment = await markPaymentAsPaid(client, paymentId);
                if (!paidPayment) return;

                const user = await client.users.fetch(userId).catch(() => null);
                if (user) {
                    await user
                        .send({
                            embeds: [
                                client.embed(
                                    [
                                        `Mã đơn: \`${paymentId}\``,
                                        `Số tiền: ${Number(entry.amount).toLocaleString("vi-VN")}đ`,
                                        "Đã xác nhận thanh toán. Đã mở chạy quest đã chọn.",
                                    ].join("\n"),
                                    {
                                        title: "Đã xác nhận thanh toán",
                                        color: 0x57f287,
                                    },
                                ),
                            ],
                        })
                        .catch(() => null);
                    await unlockPaymentIfPaid(client, paidPayment);
                }
            },
        );

        // Register recovery handler for HypeSquad payments
        client.autoBank.registerMissedHandler(
            "hs_payment",
            async (client, entry) => {
                const {
                    markHsPaymentPaid,
                    runBadgeChange,
                } = require("../../../extensions/AutoHypeSquad");
                await markHsPaymentPaid(client, entry.context.paymentId);
                await runBadgeChange(client, entry.context);
            },
        );

        // Register recovery handler for Robux payments
        client.autoBank.registerMissedHandler(
            "rb_payment",
            async (client, entry) => {
                const {
                    markRobuxPaymentPaid,
                    handleRobuxPaid,
                } = require("../../../extensions/AutoRobux");
                await markRobuxPaymentPaid(client, entry.context.paymentId);
                await handleRobuxPaid(client, entry.context);
            },
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
                        // Update order log to show paused state (not cancelled — quest may resume after token refresh)
                        await cancelOrderLog(
                            client,
                            userId,
                            accountId,
                            "⏸️ Đơn **tạm dừng**: token account bị dead. Nhập lại token để tiếp tục.",
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
                                new ActionRowBuilder().addComponents(
                                    new ButtonBuilder()
                                        .setCustomId(
                                            `quest:refresh_token:${accountId}`,
                                        )
                                        .setLabel("Nhập token ngay")
                                        .setStyle(ButtonStyle.Primary),
                                ),
                            ],
                        });
                    }

                    if (type === "quest_batch_started") {
                        // The order log is created at QR creation now. When the run
                        // actually starts, reflect the paid state — unless this is a
                        // free staff order (keep its "Miễn phí" status). This also
                        // covers the restart-recovery path, where the paid callback
                        // did not run to update the log.
                        const entry = getRunningMap(userId).get(accountId);
                        if (!entry?.staffFree) {
                            await editOrderLogPaid(
                                client,
                                userId,
                                accountId,
                                username,
                                quests.length,
                            );
                        }
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

        // ── Init Robux queue message ───────────────────────────────────────────
        try {
            const {
                updateQueueMessage,
            } = require("../../../extensions/AutoRobux");
            await updateQueueMessage(client);
        } catch (e) {
            console.warn("[ready] updateQueueMessage error:", e.message);
        }

        // ── Restore stored accounts (resume quest runs after restart) ──────────
        // Runs before the maintenance sweep so restored accounts are in the
        // running map and are never mistaken for stale/idle entries.
        try {
            const restored = await restoreAccounts(client);
            if (restored)
                console.log(`[ready] Restored ${restored} account(s).`);
        } catch (e) {
            console.warn("[ready] restoreAccounts error:", e.message);
        }

        // ── Recover missed payments (bot was offline) ──────────────────────────
        const { paid, expired } = await client.autoBank.recover();

        for (const entry of paid) {
            try {
                const handler = entry.context?._handler;
                const { paymentId, userId } = entry.context;

                // ── AutoQuest ──────────────────────────────────────────────
                if (handler === "quest_payment") {
                    const paidPayment = await markPaymentAsPaid(
                        client,
                        paymentId,
                    );
                    const user = await client.users
                        .fetch(userId)
                        .catch(() => null);
                    if (user)
                        await user
                            .send({
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
                            })
                            .catch(() => null);
                    if (paidPayment)
                        await unlockPaymentIfPaid(client, paidPayment).catch(
                            () => {},
                        );

                    // ── AutoHypeSquad ──────────────────────────────────────────
                } else if (handler === "hs_payment") {
                    const {
                        markHsPaymentPaid,
                        runBadgeChange,
                    } = require("../../../extensions/AutoHypeSquad");
                    const paid = await markHsPaymentPaid(client, paymentId);
                    if (paid) {
                        const user = await client.users
                            .fetch(userId)
                            .catch(() => null);
                        if (user)
                            await user
                                .send({
                                    embeds: [
                                        client.embed(
                                            [
                                                `Mã đơn: \`${paymentId}\``,
                                                `Số tiền: ${Number(entry.amount).toLocaleString("vi-VN")}đ`,
                                                "Bot phát hiện thanh toán khi khởi động lại. Đang tiến hành đổi badge...",
                                            ].join("\n"),
                                            {
                                                title: "Đã xác nhận thanh toán (khôi phục)",
                                                color: 0x57f287,
                                            },
                                        ),
                                    ],
                                })
                                .catch(() => null);
                        await runBadgeChange(client, entry.context);
                    }

                    // ── AutoRobux ──────────────────────────────────────────────
                } else if (handler === "rb_payment") {
                    const {
                        markRobuxPaymentPaid,
                        handleRobuxPaid,
                    } = require("../../../extensions/AutoRobux");
                    const paid = await markRobuxPaymentPaid(client, paymentId);
                    if (paid) {
                        const user = await client.users
                            .fetch(userId)
                            .catch(() => null);
                        if (user)
                            await user
                                .send({
                                    embeds: [
                                        client.embed(
                                            [
                                                `Mã đơn: \`${paymentId}\``,
                                                `Số tiền: ${Number(entry.amount).toLocaleString("vi-VN")}đ`,
                                                "Bot phát hiện thanh toán khi khởi động lại. Admin sẽ xử lý đơn sớm nhất.",
                                            ].join("\n"),
                                            {
                                                title: "Đã xác nhận thanh toán (khôi phục)",
                                                color: 0x57f287,
                                            },
                                        ),
                                    ],
                                })
                                .catch(() => null);
                        await handleRobuxPaid(client, entry.context);
                    }

                    // ── AutoPanel ──────────────────────────────────────────────
                } else if (handler === "panel_payment") {
                    // Handled automatically by the registerMissedHandler in AutoPanel
                    // But we can leave a log here if needed
                    console.log(
                        `[ready] Recovered panel_payment for bot: ${entry.context.botId}`,
                    );
                } else {
                    console.warn(
                        `[ready] Unknown paid handler: ${handler} (paymentId: ${paymentId})`,
                    );
                }
            } catch (e) {
                console.warn(`[ready] paid recovery failed: ${e.message}`);
            }
        }

        for (const entry of expired) {
            try {
                const handler = entry.context?._handler;
                const { paymentId, userId } = entry.context;
                const user = await client.users.fetch(userId).catch(() => null);
                if (!user) continue;

                // ── AutoQuest ──────────────────────────────────────────────
                if (handler === "quest_payment") {
                    await user
                        .send({
                            embeds: [
                                client.embed(
                                    [
                                        `Mã đơn: \`${paymentId}\``,
                                        `Số tiền: ${Number(entry.amount).toLocaleString("vi-VN")}đ`,
                                        "QR đã hết hạn. Hãy chọn lại quest để tạo QR mới.",
                                    ].join("\n"),
                                    {
                                        title: "QR thanh toán đã hết hạn",
                                        color: 0xfee75c,
                                    },
                                ),
                            ],
                        })
                        .catch(() => null);

                    // ── AutoHypeSquad ──────────────────────────────────────────
                } else if (handler === "hs_payment") {
                    await user
                        .send({
                            embeds: [
                                client.embed(
                                    [
                                        `Mã đơn: \`${paymentId}\``,
                                        `Số tiền: ${Number(entry.amount).toLocaleString("vi-VN")}đ`,
                                        "QR HypeSquad đã hết hạn. Hãy tạo đơn mới.",
                                    ].join("\n"),
                                    {
                                        title: "QR thanh toán đã hết hạn",
                                        color: 0xfee75c,
                                    },
                                ),
                            ],
                        })
                        .catch(() => null);

                    // ── AutoRobux ──────────────────────────────────────────────
                } else if (handler === "rb_payment") {
                    await user
                        .send({
                            embeds: [
                                client.embed(
                                    [
                                        `Mã đơn: \`${paymentId}\``,
                                        `Số tiền: ${Number(entry.amount).toLocaleString("vi-VN")}đ`,
                                        "QR Robux đã hết hạn. Hãy tạo đơn mới.",
                                    ].join("\n"),
                                    {
                                        title: "QR thanh toán đã hết hạn",
                                        color: 0xfee75c,
                                    },
                                ),
                            ],
                        })
                        .catch(() => null);
                } else {
                    console.warn(
                        `[ready] Unknown expired handler: ${handler} (paymentId: ${paymentId})`,
                    );
                }
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

        // ── Periodic maintenance sweep ─────────────────────────────────────────
        // Startup-only cleanup is not enough: a bot that stays up for days would
        // never clear expired-pending payments or stale stored accounts. This
        // interval expires stale payments across all features and prunes stale
        // accounts (dead-token records past their TTL, idle unselected accounts).
        const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
        const runMaintenance = async () => {
            try {
                await expireStalePayments(client);
            } catch (e) {
                console.warn("[maintenance] quest payments:", e.message);
            }
            try {
                const {
                    expireStaleRobuxPayments,
                } = require("../../../extensions/AutoRobux");
                await expireStaleRobuxPayments(client);
            } catch (e) {
                console.warn("[maintenance] robux payments:", e.message);
            }
            try {
                const {
                    expireStaleHsPayments,
                } = require("../../../extensions/AutoHypeSquad");
                await expireStaleHsPayments(client);
            } catch (e) {
                console.warn("[maintenance] hypesquad payments:", e.message);
            }
            try {
                const removed = await sweepStaleAccounts(client);
                if (removed.length)
                    console.log(
                        `[maintenance] pruned ${removed.length} stale account(s)`,
                    );
            } catch (e) {
                console.warn("[maintenance] account sweep:", e.message);
            }
        };
        await runMaintenance();
        setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);

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
