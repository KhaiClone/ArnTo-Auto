const { MessageFlags } = require("discord.js");
const AutoBank = require("../../../extensions/AutoBank");
const {
    restoreAccounts,
    setAccountNotifier,
    expireStalePayments,
    sweepStaleAccounts,
    getRecoverablePaidActivations,
    markPaymentAsPaid,
    getRunningMap,
    runMonthlyBatch,
    runMonthlyEnrollScan,
    expireStaleMonthlyPayments,
    activateMonthlyFromPayment,
    warmBuildNumber,
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

            // ── Panel quest webhook ──────────────────────────────────────────────
            // The bot-panel runs quests for us (payment stays here) and POSTs quest
            // events back here. ref = the buyer's Discord user id.
            app.post("/api/quest-event", async (req, res) => {
                const key = process.env.PANEL_API_KEY;
                if (!key) return res.status(503).json({ error: "disabled" });
                if (req.header("x-api-key") !== key)
                    return res.status(401).json({ error: "unauthorized" });
                res.json({ ok: true }); // ack immediately; handle async
                try {
                    const { type, accountId, ref, status, error, taskType } =
                        req.body || {};
                    // Single-quest events (questEngine) send the quest name as `name`;
                    // the monthly runner sends it as `questName`. Accept either so the
                    // completion DM fires for both flows.
                    const questName = req.body?.questName ?? req.body?.name;
                    const userId = ref;
                    if (!userId) return;
                    const user = await client.users.fetch(userId).catch(() => null);

                    if (type === "quest_done" && questName && user) {
                        await user
                            .send({
                                embeds: [
                                    client.embed(
                                        `Đã hoàn thành quest: **${questName}**${taskType ? ` [${taskType}]` : ""}`,
                                        {
                                            title: "✅ Đã hoàn thành 1 quest",
                                            color: 0x57f287,
                                            timestamp: true,
                                        },
                                    ),
                                ],
                                flags: MessageFlags.SuppressNotifications,
                            })
                            .catch(() => null);
                    } else if (type === "status" && status === "done") {
                        if (user)
                            await user
                                .send({
                                    embeds: [
                                        client.embed(
                                            "Tất cả quest đã chọn đã hoàn thành.",
                                            {
                                                title: "Đã xong đơn quest",
                                                color: 0x57f287,
                                            },
                                        ),
                                    ],
                                })
                                .catch(() => null);
                    } else if (type === "status" && status === "token_dead") {
                        await cancelOrderLog(
                            client,
                            userId,
                            accountId,
                            "⏸️ Token account bị dead. Nhập lại token để tiếp tục.",
                        ).catch(() => null);
                        if (user)
                            await user
                                .send({
                                    embeds: [
                                        client.embed(
                                            "Token account đã dead. Vào panel nhập token để tiếp tục chạy quest đã mua.",
                                            {
                                                title: "Cần nhập lại token",
                                                color: 0xfee75c,
                                            },
                                        ),
                                    ],
                                })
                                .catch(() => null);
                    } else if (type === "status" && status === "error" && error) {
                        console.warn(`[quest-event] ${userId} error: ${error}`);
                    }
                } catch (e) {
                    console.warn(`[quest-event] handler error: ${e.message}`);
                }
            });


            app.post("/api/badge-event", async (req, res) => {
                const key = process.env.PANEL_API_KEY;
                if (!key) return res.status(503).json({ error: "disabled" });
                if (req.header("x-api-key") !== key)
                    return res.status(401).json({ error: "unauthorized" });
                res.json({ ok: true }); // ack immediately; handle async
                try {
                    const {
                        handlePanelEvent,
                    } = require("../../../extensions/AutoBadge");
                    await handlePanelEvent(client, req.body || {});
                } catch (e) {
                    console.warn(`[badge-event] handler error: ${e.message}`);
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

        // Pre-warm the Discord build number cache in the background so the first
        // token entry doesn't wait on the (multi-request) build-number fetch.
        warmBuildNumber();

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

                const unlockResult = await unlockPaymentIfPaid(
                    client,
                    paidPayment,
                ).catch(() => false);
                const pendingToken = unlockResult === "pending_token";

                const user = await client.users.fetch(userId).catch(() => null);
                if (user) {
                    await user
                        .send({
                            embeds: [
                                client.embed(
                                    [
                                        `Mã đơn: \`${paymentId}\``,
                                        `Số tiền: ${Number(entry.amount).toLocaleString("vi-VN")}đ`,
                                        pendingToken
                                            ? "⚠️ Token account đã die. **Nhập lại token** để chạy quest đã mua (đã lưu, không mất)."
                                            : "Đã xác nhận thanh toán. Đã mở chạy quest đã chọn.",
                                    ].join("\n"),
                                    {
                                        title: pendingToken
                                            ? "Đã thanh toán — cần nhập lại token"
                                            : "Đã xác nhận thanh toán",
                                        color: pendingToken ? 0xfee75c : 0x57f287,
                                    },
                                ),
                            ],
                        })
                        .catch(() => null);
                }
            },
        );

        // Register recovery handler for monthly-subscription payments
        client.autoBank.registerMissedHandler(
            "quest_monthly_payment",
            async (client, entry) => {
                await activateMonthlyFromPayment(
                    client,
                    entry.context.paymentId,
                );
            },
        );

        // Register recovery handler for Auto Badge payments
        client.autoBank.registerMissedHandler(
            "badge_payment",
            async (client, entry) => {
                const {
                    markPaid,
                    runOrder,
                } = require("../../../extensions/AutoBadge");
                await markPaid(client, entry.context.paymentId);
                await runOrder(client, entry.context);
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
                questName,
                taskType,
                months,
                monthlyExpiresAt,
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
                                        "Vào panel Auto Quest và bấm nút **🔑 Cập nhật token** để gửi lại token — quest đã mua vẫn được giữ, không mất phí.",
                                    ]
                                        .filter(Boolean)
                                        .join("\n"),
                                    {
                                        title: "Cần cập nhật token",
                                        color: 0xfee75c,
                                        timestamp: true,
                                    },
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

                    // Per-quest completion DM (quest lẻ): fires as each quest finishes
                    // so a restart mid-order never drops earlier quests from the DMs.
                    if (type === "quest_completed_one") {
                        return user.send({
                            embeds: [
                                client.embed(
                                    [
                                        `Account: **${username}** (\`${accountId}\`)`,
                                        `Đã hoàn thành quest: **${questName}**${taskType ? ` [${taskType}]` : ""}`,
                                    ].join("\n"),
                                    {
                                        title: "✅ Đã hoàn thành 1 quest",
                                        color: 0x57f287,
                                        timestamp: true,
                                    },
                                ),
                            ],
                            flags: MessageFlags.SuppressNotifications,
                        });
                    }

                    // Batch completion now only updates the staff order log — the
                    // per-quest DMs above replace the (previously batch) user DM.
                    if (type === "quest_batch_completed") {
                        await editOrderLog(
                            client,
                            userId,
                            accountId,
                            username,
                            completedQuestNames,
                        );
                        return;
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

                    // ── Monthly subscription events ────────────────────────────
                    if (type === "monthly_activated") {
                        const until = monthlyExpiresAt
                            ? `<t:${Math.floor(new Date(monthlyExpiresAt).getTime() / 1000)}:f>`
                            : "—";
                        return user.send({
                            embeds: [
                                client.embed(
                                    [
                                        `Account: **${username}** (\`${accountId}\`)`,
                                        `Số tháng: **${months}**`,
                                        `Hạn tới: ${until}`,
                                        "Bot sẽ tự chạy toàn bộ quest vào Thứ 3 & Thứ 7.",
                                    ].join("\n"),
                                    {
                                        title: "Đã kích hoạt gói tháng",
                                        color: 0x9b59b6,
                                        timestamp: true,
                                    },
                                ),
                            ],
                        });
                    }

                    if (type === "monthly_quest_done") {
                        return user.send({
                            embeds: [
                                client.embed(
                                    [
                                        `Account: **${username}** (\`${accountId}\`)`,
                                        `Đã hoàn thành quest: **${questName}**${taskType ? ` [${taskType}]` : ""}`,
                                    ].join("\n"),
                                    {
                                        title: "Đã xong 1 quest (gói tháng)",
                                        color: 0x57f287,
                                        timestamp: true,
                                    },
                                ),
                            ],
                            flags: MessageFlags.SuppressNotifications,
                        });
                    }

                    if (type === "monthly_token_dead") {
                        return user.send({
                            embeds: [
                                client.embed(
                                    [
                                        `Account: **${username}** (\`${accountId}\`)`,
                                        "Token của account gói tháng đã hết hạn/không hợp lệ.",
                                        "Bấm **Gia hạn theo tháng** trên panel và nhập lại token — gói của bạn vẫn còn hạn, không mất phí.",
                                    ].join("\n"),
                                    {
                                        title: "Cần cập nhật token (gói tháng)",
                                        color: 0xfee75c,
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
                    const unlockResult = paidPayment
                        ? await unlockPaymentIfPaid(client, paidPayment).catch(
                              () => false,
                          )
                        : false;
                    const pendingToken = unlockResult === "pending_token";
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
                                            pendingToken
                                                ? "⚠️ Token account đã die. **Nhập lại token** để chạy quest đã mua (đã lưu, không mất)."
                                                : "Bot phát hiện thanh toán khi khởi động lại. Đã mở chạy quest đã chọn.",
                                        ].join("\n"),
                                        {
                                            title: pendingToken
                                                ? "Đã thanh toán — cần nhập lại token"
                                                : "Đã xác nhận thanh toán (khôi phục)",
                                            color: pendingToken
                                                ? 0xfee75c
                                                : 0x57f287,
                                        },
                                    ),
                                ],
                            })
                            .catch(() => null);

                    // ── AutoQuest monthly subscription ─────────────────────────
                } else if (handler === "quest_monthly_payment") {
                    await activateMonthlyFromPayment(client, paymentId).catch(
                        (e) =>
                            console.warn(
                                `[ready] monthly recovery failed: ${e.message}`,
                            ),
                    );

                    // ── AutoBadge ──────────────────────────────────────────────
                } else if (handler === "badge_payment") {
                    const {
                        markPaid,
                        runOrder,
                    } = require("../../../extensions/AutoBadge");
                    const paid = await markPaid(client, paymentId);
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
                                                "Bot phát hiện thanh toán khi khởi động lại. Đang tiến hành xử lý badge...",
                                            ].join("\n"),
                                            {
                                                title: "Đã xác nhận thanh toán (khôi phục)",
                                                color: 0x57f287,
                                            },
                                        ),
                                    ],
                                })
                                .catch(() => null);
                        await runOrder(client, entry.context);
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

                    // ── AutoBadge ──────────────────────────────────────────────
                } else if (handler === "badge_payment") {
                    await user
                        .send({
                            embeds: [
                                client.embed(
                                    [
                                        `Mã đơn: \`${paymentId}\``,
                                        `Số tiền: ${Number(entry.amount).toLocaleString("vi-VN")}đ`,
                                        "QR Auto Badge đã hết hạn. Hãy tạo đơn mới.",
                                    ].join("\n"),
                                    {
                                        title: "QR thanh toán đã hết hạn",
                                        color: 0xfee75c,
                                    },
                                ),
                            ],
                        })
                        .catch(() => null);
                    // Lật log đơn sang "hết hạn" ngay, thay vì đợi vòng quét định kỳ.
                    {
                        const {
                            getPaymentById,
                        } = require("../../../extensions/AutoBadge");
                        const badgeLog = require("../../../functions/autoBadgeHelpers");
                        const pm = await getPaymentById(client, paymentId);
                        if (pm) await badgeLog.updateOrderLog(client, pm, "expired");
                    }

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
                    expireStale,
                    purgeExpiredSessions,
                } = require("../../../extensions/AutoBadge");
                await expireStale(client);
                await purgeExpiredSessions(client);
            } catch (e) {
                console.warn("[maintenance] badge payments:", e.message);
            }
            try {
                await expireStaleMonthlyPayments(client);
            } catch (e) {
                console.warn("[maintenance] monthly payments:", e.message);
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

        // ── Monthly Auto Quest scheduler ───────────────────────────────────────
        // On the configured days (Tue & Sat) at the configured VN hour, run ALL
        // quests for every active subscriber. A per-day guard key prevents a double
        // run after a restart, and lets a late start still catch that day's slot.
        const MONTHLY_LAST_RUN_DB = "quest_monthly_last_run";
        const MONTHLY_LAST_ENROLL_DB = "quest_monthly_last_enroll";
        const runDays = client.configs.settings.monthlyRunDays ?? [2, 6];
        const runHour = client.configs.settings.monthlyRunHour ?? 9;
        const enrollHour = client.configs.settings.monthlyEnrollHour ?? 3;
        const vnParts = () => {
            // Get VN (Asia/Ho_Chi_Minh) weekday + hour + date string.
            const fmt = new Intl.DateTimeFormat("en-US", {
                timeZone: "Asia/Ho_Chi_Minh",
                weekday: "short",
                hour: "numeric",
                hour12: false,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
            });
            const parts = Object.fromEntries(
                fmt.formatToParts(new Date()).map((p) => [p.type, p.value]),
            );
            const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
            return {
                weekday: dayMap[parts.weekday],
                hour: parseInt(parts.hour, 10) % 24,
                dateStr: `${parts.year}-${parts.month}-${parts.day}`,
            };
        };
        // In-memory guards so the minute-interval never starts a second run/scan
        // while one is already going in this process (a batch can take hours).
        let monthlyRunInProgress = false;
        let monthlyEnrollInProgress = false;

        const checkMonthlySchedule = async () => {
            try {
                const { weekday, hour, dateStr } = vnParts();
                if (!runDays.includes(weekday) || hour < runHour) return;
                if (monthlyRunInProgress) return;
                const lastRun = await client.db.get(MONTHLY_LAST_RUN_DB);
                if (lastRun === dateStr) return; // already COMPLETED today
                monthlyRunInProgress = true;
                try {
                    console.log(`[Monthly] Scheduled run start (${dateStr})`);
                    const res = await runMonthlyBatch(client);
                    // Mark done only AFTER the batch finishes. If the bot crashes
                    // mid-run the guard stays unset, so the next start re-runs and
                    // finishes the remaining accounts — already-done accounts are quick
                    // no-ops (completed quests are skipped), and a quest that was mid-
                    // progress resumes from where Discord has it.
                    await client.db.set(MONTHLY_LAST_RUN_DB, dateStr);
                    console.log(
                        `[Monthly] Done: ${res.processedAccounts}/${res.totalAccounts} account(s), ${res.completedQuests} quest(s).`,
                    );
                } finally {
                    monthlyRunInProgress = false;
                }
            } catch (e) {
                console.warn("[Monthly] scheduler error:", e.message);
            }
        };
        // Daily enroll-only scan (every day at enrollHour), decoupled from the
        // Tue/Sat completion run — enrolling early speeds up video completion later.
        const checkMonthlyEnrollSchedule = async () => {
            try {
                const { hour, dateStr } = vnParts();
                if (hour < enrollHour) return;
                if (monthlyEnrollInProgress) return;
                const last = await client.db.get(MONTHLY_LAST_ENROLL_DB);
                if (last === dateStr) return; // already COMPLETED today
                monthlyEnrollInProgress = true;
                try {
                    console.log(
                        `[MonthlyEnroll] Daily enroll scan start (${dateStr})`,
                    );
                    const res = await runMonthlyEnrollScan(client);
                    // Mark done only after the scan finishes (crash-safe; enroll is
                    // idempotent, so a full re-run is harmless).
                    await client.db.set(MONTHLY_LAST_ENROLL_DB, dateStr);
                    console.log(
                        `[MonthlyEnroll] Done: ${res.processed}/${res.totalAccounts} account(s).`,
                    );
                } finally {
                    monthlyEnrollInProgress = false;
                }
            } catch (e) {
                console.warn("[MonthlyEnroll] scheduler error:", e.message);
            }
        };

        // Kick off once now so a bot that starts AFTER the scheduled hour still
        // catches that day's slot. Do NOT await — runMonthlyBatch can take a long
        // time (quests complete in real time) and awaiting would block the rest of
        // ready(). The per-day guard key prevents a duplicate/concurrent run.
        checkMonthlySchedule().catch(() => {});
        checkMonthlyEnrollSchedule().catch(() => {});
        setInterval(checkMonthlySchedule, 60 * 1000); // check every minute
        setInterval(checkMonthlyEnrollSchedule, 60 * 1000);
    },
};
