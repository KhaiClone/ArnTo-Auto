/**
 * autoQuest.js (interactionCreate event)
 * Handles all Auto Quest interactions: buttons, select menus, modals.
 * All custom IDs are namespaced with "quest:" prefix.
 */

const {
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
} = require("discord.js");

const {
    getRunningMap,
    getSelectableQuests,
    resolveDiscordAccount,
    startAccount,
    setAllowedQuests,
    cancelPayment,
    createQuestPayment,
    getPaymentById,
    getOpenPendingPayment,
    upsertPendingActivation,
    removeActivationByPaymentId,
    getTokenRefreshRecord,
    getStoredAccountOwner,
    createMonthlyPayment,
    getOpenMonthlyPayment,
    getMonthlyPaymentById,
    getMonthlySubscriptionRaw,
    cancelMonthlyPayment,
    activateMonthlySubscription,
    getUserAccountsStatus,
    buildVietQrUrl,
} = require("../../../extensions/AutoQuest");

// Owner/dev users run Auto Quest for free — no payment step.
function _isStaffFree(client, userId) {
    const s = client.configs.settings;
    return (
        (s.ownerUserIds ?? []).includes(userId) ||
        (s.devUserIds ?? []).includes(userId)
    );
}

const {
    sendOrderLog,
    buildPaymentEmbed,
    buildPaymentActionRow,
    buildMonthlyPaymentEmbed,
    buildMonthlyCancelRow,
    cancelOrderLog,
} = require("../../../functions/autoQuestHelpers");

module.exports = {
    name: "interactionCreate",
    async execute(client, interaction) {
        // Only handle quest-namespaced interactions
        const id = interaction.customId ?? "";
        if (!id.startsWith("quest:")) return;

        // Allow DM interactions for the dead-token re-entry flow: the button
        // (refresh_token) AND its modal submit (refresh_modal). Without the modal
        // in this list, submitting the re-entered token from a DM was silently
        // dropped here, so the button appeared broken. Everything else needs a guild.
        const isDmAllowed =
            id.startsWith("quest:refresh_token:") ||
            id.startsWith("quest:refresh_modal:");
        if (!interaction.guild && !isDmAllowed) return;

        try {
            if (interaction.isButton())
                return await _handleButton(client, interaction);
            if (interaction.isStringSelectMenu())
                return await _handleSelectMenu(client, interaction);
            if (interaction.isModalSubmit())
                return await _handleModal(client, interaction);
        } catch (err) {
            console.error("[autoQuest interaction] error:", err);
            const payload = {
                embeds: [client.embed(err.message, { title: "Có lỗi xảy ra" })],
                ephemeral: true,
            };
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp(payload).catch(() => null);
            } else {
                await interaction.reply(payload).catch(() => null);
            }
        }
    },
};

// ── Button handler ─────────────────────────────────────────────────────────────
async function _handleButton(client, interaction) {
    const { customId } = interaction;

    // "Nhập token" button on the quest panel
    if (customId === "quest:enter_token") {
        const refreshRecord = await getTokenRefreshRecord(
            client,
            interaction.user.id,
        );
        if (refreshRecord) {
            return interaction.showModal(
                _buildTokenModal(
                    `quest:refresh_modal:${refreshRecord.accountId}`,
                    "Nhập lại token Discord",
                ),
            );
        }
        return interaction.showModal(
            _buildTokenModal("quest:token_modal", "Nhập token Discord"),
        );
    }

    // "Gia hạn theo tháng" button on the quest panel
    if (customId === "quest:enter_token_monthly") {
        return interaction.showModal(
            _buildTokenModal(
                "quest:monthly_token_modal",
                "Nhập token Discord (gói tháng)",
            ),
        );
    }

    if (customId === "quest:check_token") {
        await interaction.deferReply({ ephemeral: true });
        const list = await getUserAccountsStatus(client, interaction.user.id);
        if (!list.length) {
            return interaction.editReply({
                embeds: [
                    client.embed("Bạn chưa nhập account nào.", {
                        title: "Trạng thái tài khoản",
                        color: 0xfee75c,
                    }),
                ],
            });
        }
        const rel = (iso) =>
            `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;
        const fields = list.slice(0, 25).map((a) => {
            const lines = [
                `ID: \`${a.accountId}\``,
                `Loại: ${a.type === "monthly" ? "♾️ Quest tháng" : "⚡ Quest lẻ"}`,
                `Token: ${a.tokenAlive ? "✅ Hoạt động" : "⚠️ Cần nhập lại"}`,
            ];
            if (a.type === "monthly" && a.monthlyExpiresAt)
                lines.push(`Hạn: ${rel(a.monthlyExpiresAt)}`);
            if (a.running) {
                lines.push(
                    `Đang chạy: ${a.runningQuestCount ?? "toàn bộ"} quest | Đã xong: ${a.completedCount}`,
                );
                if (a.startedAt)
                    lines.push(
                        `Uptime: ${client.funcs.formatUptime(a.startedAt)}`,
                    );
            } else if (a.type === "monthly") {
                lines.push("Trạng thái: ⏳ Chờ lịch (Thứ 3 & Thứ 7)");
            } else if (!a.tokenAlive) {
                lines.push("Trạng thái: Tạm dừng — chờ nhập lại token");
            } else {
                lines.push("Trạng thái: Không chạy");
            }
            return {
                name: a.username,
                value: lines.join("\n"),
                inline: true,
            };
        });
        const note =
            list.length > 25
                ? `Hiển thị 25/${list.length} account.`
                : "";
        return interaction.editReply({
            embeds: [
                client.embed(note, {
                    title: `Trạng thái tài khoản — ${list.length} account`,
                    color: 0x5865f2,
                    fields,
                    timestamp: true,
                }),
            ],
        });
    }

    // "Nhập token ngay" button sent via DM when token is dead
    if (customId.startsWith("quest:refresh_token:")) {
        const accountId = customId.split(":")[2];
        const refreshRecord = await getTokenRefreshRecord(
            client,
            interaction.user.id,
        );
        if (!refreshRecord || refreshRecord.accountId !== accountId) {
            return interaction.reply({
                ephemeral: true,
                embeds: [
                    client.embed(
                        "Account này không còn ở trạng thái chờ nhập lại token.",
                        { title: "Không thể nhập lại token" },
                    ),
                ],
            });
        }
        return interaction.showModal(
            _buildTokenModal(
                `quest:refresh_modal:${accountId}`,
                "Nhập lại token Discord",
            ),
        );
    }

    // "Hủy đơn" button on the payment embed
    if (customId.startsWith("quest:cancel_payment:")) {
        const paymentId = customId.split(":")[2];
        const payment = await getPaymentById(client, paymentId);

        if (!payment) {
            return interaction.reply({
                ephemeral: true,
                embeds: [
                    client.embed("Không tìm thấy đơn thanh toán.", {
                        title: "Lỗi",
                    }),
                ],
            });
        }
        if (payment.userId !== interaction.user.id) {
            return interaction.reply({
                ephemeral: true,
                embeds: [
                    client.embed("Bạn không thể hủy đơn của người khác.", {
                        title: "Không có quyền",
                    }),
                ],
            });
        }
        if (payment.status !== "pending") {
            return interaction.reply({
                ephemeral: true,
                embeds: [
                    client.embed("Đơn này đã được xử lý (paid/expired).", {
                        title: "Không thể hủy",
                    }),
                ],
            });
        }

        await interaction.deferUpdate();
        await cancelPayment(client, paymentId);
        await removeActivationByPaymentId(client, paymentId);
        await cancelOrderLog(client, payment.userId, payment.accountId, "🚫 Đã hủy bởi khách / Hết hạn");

        const user = await client.users.fetch(payment.userId).catch(() => null);
        if (user) {
            await user
                .send({
                    embeds: [
                        client.embed("", {
                            title: "Đã hủy đơn thanh toán",
                            color: 0xed4245,
                        }),
                    ],
                })
                .catch(() => null);
        }
        return;
    }

    // "Hủy đơn" button on the monthly-subscription payment embed
    if (customId.startsWith("quest:cancel_monthly:")) {
        const paymentId = customId.split(":")[2];
        const payment = await getMonthlyPaymentById(client, paymentId);
        if (!payment || payment.status !== "pending") {
            return interaction.reply({
                ephemeral: true,
                embeds: [
                    client.embed("Đơn này không tồn tại hoặc đã được xử lý.", {
                        title: "Không thể hủy",
                    }),
                ],
            });
        }
        if (payment.userId !== interaction.user.id) {
            return interaction.reply({
                ephemeral: true,
                embeds: [
                    client.embed("Bạn không thể hủy đơn của người khác.", {
                        title: "Không có quyền",
                    }),
                ],
            });
        }
        await interaction.deferUpdate();
        await cancelMonthlyPayment(client, paymentId);
        const user = await client.users.fetch(payment.userId).catch(() => null);
        if (user)
            await user
                .send({
                    embeds: [
                        client.embed("", {
                            title: "Đã hủy đơn gia hạn theo tháng",
                            color: 0xed4245,
                        }),
                    ],
                })
                .catch(() => null);
        return;
    }
}

// ── Panel service-type menu ──────────────────────────────────────────────────────
async function _handleMenuSelect(client, interaction) {
    const choice = interaction.values?.[0];
    if (choice === "monthly") {
        return interaction.showModal(
            _buildTokenModal(
                "quest:monthly_token_modal",
                "Nhập token Discord (gói tháng)",
            ),
        );
    }
    // "single" (quest lẻ): mirror the fresh-token flow; if the user has a dead-token
    // account waiting, prompt a re-entry instead.
    const refreshRecord = await getTokenRefreshRecord(client, interaction.user.id);
    if (refreshRecord) {
        return interaction.showModal(
            _buildTokenModal(
                `quest:refresh_modal:${refreshRecord.accountId}`,
                "Nhập lại token Discord",
            ),
        );
    }
    return interaction.showModal(
        _buildTokenModal("quest:token_modal", "Nhập token Discord"),
    );
}

// ── Select menu handler ────────────────────────────────────────────────────────
async function _handleSelectMenu(client, interaction) {
    // Panel service-type menu: route to the matching token flow.
    if (interaction.customId === "quest:menu")
        return _handleMenuSelect(client, interaction);

    if (!interaction.customId.startsWith("quest:select:")) return;

    const accountId = interaction.customId.split(":")[2];
    const selectedQuestIds = interaction.values ?? [];
    const runningEntry = getRunningMap(interaction.user.id).get(accountId);

    if (!runningEntry) {
        return interaction.reply({
            ephemeral: true,
            embeds: [
                client.embed(
                    "Account này không còn chạy hoặc không thuộc về bạn.",
                    { title: "Không tìm thấy account" },
                ),
            ],
        });
    }

    // Owner/dev: unlock the selected quests immediately, no payment.
    if (_isStaffFree(client, interaction.user.id)) {
        runningEntry.staffFree = true;
        await setAllowedQuests(
            client,
            interaction.user.id,
            accountId,
            selectedQuestIds,
        );
        // Create the order log now (marked "Miễn phí (Staff)" via the staffFree flag).
        await sendOrderLog(
            client,
            interaction.user.id,
            accountId,
            runningEntry.username,
            selectedQuestIds,
        );
        return interaction.update({
            embeds: [
                client.embed(
                    `Đã mở chạy **${selectedQuestIds.length}** quest đã chọn (miễn phí — Staff).`,
                    {
                        title: "Đã kích hoạt miễn phí",
                        color: 0x57f287,
                        footer: {
                            text: "Bot bắt đầu chạy quest. Dùng /status để theo dõi.",
                        },
                        timestamp: true,
                    },
                ),
            ],
            components: [],
        });
    }

    // Check if user already has a pending payment for this account
    const existed = await getOpenPendingPayment(
        client,
        interaction.user.id,
        accountId,
    );
    if (existed) {
        return interaction.update({
            embeds: [
                buildPaymentEmbed(
                    client,
                    existed,
                    "Bạn đã có đơn chờ thanh toán. Thanh toán đơn hiện tại hoặc chờ hết hạn để tạo đơn mới.",
                ),
            ],
            components:
                existed.status === "pending"
                    ? [buildPaymentActionRow(existed.id)]
                    : [],
        });
    }

    // Create new payment and register with AutoBank
    const payment = await createQuestPayment(client, {
        userId: interaction.user.id,
        accountId,
        questIds: selectedQuestIds,
    });

    // Create the order log immediately at QR creation ("⏳ Chờ thanh toán"),
    // consistent with HypeSquad/Robux. It is edited to paid/cancelled later.
    await sendOrderLog(
        client,
        interaction.user.id,
        accountId,
        runningEntry.username,
        selectedQuestIds,
    );

    // Save activation so we can restore it if bot restarts before payment is confirmed
    await upsertPendingActivation(client, {
        paymentId: payment.id,
        userId: interaction.user.id,
        accountId,
        token: runningEntry.token,
        selectedQuestIds,
    });

    return interaction.update({
        embeds: [
            buildPaymentEmbed(
                client,
                payment,
                `Đã tạo QR cho ${selectedQuestIds.length} quest. Thanh toán xong bot tự chạy quest.`,
            ),
        ],
        components: [buildPaymentActionRow(payment.id)],
    });
}

// ── Modal handler ──────────────────────────────────────────────────────────────
async function _handleModal(client, interaction) {
    // Monthly subscription token submission
    if (interaction.customId === "quest:monthly_token_modal") {
        return _handleMonthlyModal(client, interaction);
    }

    // New token submission
    if (interaction.customId === "quest:token_modal") {
        const token = client.funcs.normalizeDiscordTokenInput(
            interaction.fields.getTextInputValue("token"),
        );
        await interaction.deferReply({ ephemeral: true });

        const result = await startAccount(client, interaction.user.id, token, {
            allowRestartIfRunning: false,
            rejectDuplicateStoredAccount: true,
            notifyStarted: true,
            forceNotifyQuestBatch: true,
            source: "activate",
            requireQuestSelection: true,
            // Fresh token entry: drop it if the user never selects/pays in time.
            autoRemoveIfInactive: true,
        });

        if (!result.ok) {
            // If account is already running, just reopen quest selection
            if (/đang chạy rồi/i.test(String(result.reason ?? ""))) {
                const resolved = await resolveDiscordAccount(token);
                if (
                    resolved?.ok &&
                    getRunningMap(interaction.user.id).get(resolved.accountId)
                ) {
                    return _replyWithQuestSelection(
                        client,
                        interaction,
                        resolved,
                    );
                }
            }
            return interaction.editReply({
                embeds: [
                    client.embed(result.reason, {
                        title: "Kích hoạt thất bại",
                    }),
                ],
            });
        }

        return _replyWithQuestSelection(client, interaction, result);
    }

    // Refresh token submission
    if (interaction.customId.startsWith("quest:refresh_modal:")) {
        const accountId = interaction.customId.split(":")[2];
        const token = client.funcs.normalizeDiscordTokenInput(
            interaction.fields.getTextInputValue("token"),
        );
        await interaction.deferReply({ ephemeral: true });

        const refreshRecord = await getTokenRefreshRecord(
            client,
            interaction.user.id,
        );
        if (!refreshRecord || refreshRecord.accountId !== accountId) {
            return interaction.editReply({
                embeds: [
                    client.embed(
                        "Account này không còn ở trạng thái chờ nhập lại token.",
                        { title: "Không thể nhập lại token" },
                    ),
                ],
            });
        }

        const resolved = await resolveDiscordAccount(token);
        if (!resolved.ok) {
            return interaction.editReply({
                embeds: [
                    client.embed(resolved.reason, {
                        title: "Kích hoạt thất bại",
                    }),
                ],
            });
        }
        if (resolved.accountId !== accountId) {
            return interaction.editReply({
                embeds: [
                    client.embed(
                        `Bạn chỉ được nhập lại token của account \`${accountId}\`.`,
                        { title: "Sai account" },
                    ),
                ],
            });
        }

        const result = await startAccount(client, interaction.user.id, token, {
            resolvedAccount: resolved,
            allowRestartIfRunning: false,
            addedAt: refreshRecord.addedAt,
            month: refreshRecord.month,
            notifyStarted: false,
            forceNotifyQuestBatch: true,
            source: "refresh",
            requireQuestSelection: true, // keeps stored quest selection
        });

        if (!result.ok) {
            return interaction.editReply({
                embeds: [
                    client.embed(result.reason, {
                        title: "Kích hoạt thất bại",
                    }),
                ],
            });
        }

        // Restore stored quest selection so the run loop resumes immediately
        const {
            setAllowedQuests,
            getStoredSelectedQuestIds,
        } = require("../../../extensions/AutoQuest");
        const storedIds = await getStoredSelectedQuestIds(
            client,
            interaction.user.id,
            result.accountId,
        );
        if (storedIds.length > 0) {
            await setAllowedQuests(
                client,
                interaction.user.id,
                result.accountId,
                storedIds,
            );
        }

        return interaction.editReply({
            embeds: [
                client.embed("", {
                    title: "Token đã được cập nhật",
                    color: 0x57f287,
                    fields: [
                        {
                            name: "Tài khoản",
                            value: result.username,
                            inline: true,
                        },
                        {
                            name: "ID",
                            value: `\`${result.accountId}\``,
                            inline: true,
                        },
                    ],
                    description:
                        storedIds.length > 0
                            ? "Bot đang tiếp tục chạy các quest đã chọn trước đó."
                            : "Token đã được cập nhật. Hãy chọn lại quest để tiếp tục.",
                    timestamp: true,
                }),
            ],
        });
    }
}

// ── Monthly subscription modal ───────────────────────────────────────────────────
async function _handleMonthlyModal(client, interaction) {
    const token = client.funcs.normalizeDiscordTokenInput(
        interaction.fields.getTextInputValue("token"),
    );
    await interaction.update({});

    const resolved = await resolveDiscordAccount(token);
    if (!resolved.ok) {
        return interaction.followUp({
            embeds: [
                client.embed(resolved.reason, { title: "Kích hoạt thất bại" }),
            ],
        });
    }
    const userId = interaction.user.id;
    const accountId = resolved.accountId;
    const tsOf = (iso) => Math.floor(new Date(iso).getTime() / 1000);

    // Account ownership guard
    const ownerId = await getStoredAccountOwner(client, accountId);
    if (ownerId && ownerId !== userId) {
        return interaction.followUp({
            embeds: [
                client.embed(
                    "Discord account này đã được gán cho user khác.",
                    { title: "Không thể đăng ký" },
                ),
            ],
        });
    }

    // Already subscribed → refresh the stored token for free, keep current expiry.
    const activeUntil = await getMonthlySubscriptionRaw(client, userId, accountId);
    if (activeUntil) {
        await activateMonthlySubscription(client, {
            userId,
            accountId,
            token,
            username: resolved.username,
            months: 0,
        });
        return interaction.followUp({
            embeds: [
                client.embed(
                    [
                        `Account: **${resolved.username}** (\`${accountId}\`)`,
                        `Gói còn hạn tới: <t:${tsOf(activeUntil)}:f>`,
                        "Đã cập nhật token mới cho gói hiện tại (không mất phí).",
                    ].join("\n"),
                    {
                        title: "Đã cập nhật token gói tháng",
                        color: 0x57f287,
                        timestamp: true,
                    },
                ),
            ],
        });
    }

    // Owner/dev → activate 1 month free.
    if (_isStaffFree(client, userId)) {
        const result = await activateMonthlySubscription(client, {
            userId,
            accountId,
            token,
            username: resolved.username,
            months: 1,
        });
        return interaction.followUp({
            embeds: [
                client.embed(
                    [
                        `Account: **${resolved.username}** (\`${accountId}\`)`,
                        `Hạn tới: <t:${tsOf(result.monthlyExpiresAt)}:f>`,
                        "Đã kích hoạt gói tháng miễn phí (Staff). Bot chạy toàn bộ quest vào Thứ 3 & Thứ 7.",
                    ].join("\n"),
                    {
                        title: "Đã kích hoạt gói tháng (miễn phí)",
                        color: 0x57f287,
                        timestamp: true,
                    },
                ),
            ],
        });
    }

    // Existing pending monthly payment → show it again.
    const existed = await getOpenMonthlyPayment(client, userId, accountId);
    if (existed) {
        return interaction.followUp({
            embeds: [
                buildMonthlyPaymentEmbed(
                    client,
                    {
                        paymentId: existed.paymentId,
                        months: existed.months,
                        amount: existed.amount,
                        transferCode: existed.transferCode,
                        qrUrl: buildVietQrUrl(
                            client,
                            existed.amount,
                            existed.transferCode,
                        ),
                    },
                    "Bạn đã có đơn chờ thanh toán. Thanh toán hoặc chờ hết hạn để tạo đơn mới.",
                ),
            ],
            components: [buildMonthlyCancelRow(existed.paymentId)],
        });
    }

    // Create a new monthly payment (1 month; buy again to stack more).
    const payment = await createMonthlyPayment(client, {
        userId,
        accountId,
        token,
        username: resolved.username,
        months: 1,
    });
    return interaction.followUp({
        embeds: [
            buildMonthlyPaymentEmbed(
                client,
                payment,
                `Đã tạo QR gói **${payment.months}** tháng cho account **${resolved.username}**. Thanh toán xong bot tự kích hoạt.`,
            ),
        ],
        components: [buildMonthlyCancelRow(payment.paymentId)],
    });
}

// ── UI helpers ─────────────────────────────────────────────────────────────────
function _buildTokenModal(customId, title) {
    return new ModalBuilder()
        .setCustomId(customId)
        .setTitle(title)
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("token")
                    .setLabel("Discord token")
                    .setPlaceholder("Dán token vào đây")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true),
            ),
        );
}

async function _replyWithQuestSelection(client, interaction, result) {
    const quests = await getSelectableQuests(
        interaction.user.id,
        result.accountId,
    );

    const successEmbed = client.embed("", {
        title: "Kích hoạt thành công",
        color: 0x57f287,
        fields: [
            { name: "Tài khoản", value: result.username, inline: true },
            { name: "ID", value: `\`${result.accountId}\``, inline: true },
        ],
        footer: {
            text: "Bot đã bắt đầu chạy quest. Dùng /status để theo dõi.",
        },
        timestamp: true,
    });

    if (!quests.length) {
        return interaction.editReply({
            embeds: [
                successEmbed,
                client.embed(
                    "Hiện chưa có quest phù hợp. Khi có quest mới, bấm Nhập token để chọn lại.",
                    {
                        title: "Chưa có quest để chọn",
                        color: 0xfee75c,
                    },
                ),
            ],
        });
    }

    const entry = getRunningMap(interaction.user.id).get(result.accountId);
    if (entry) entry.selectionShown = true;

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`quest:select:${result.accountId}`)
        .setPlaceholder("Chọn quest muốn chạy (có thể chọn nhiều)")
        .setMinValues(1)
        .setMaxValues(Math.min(quests.length, 25))
        .addOptions(
            quests.slice(0, 25).map((q) => ({
                label: q.name.slice(0, 100),
                value: String(q.id),
                description: q.taskType || undefined,
            })),
        );

    return interaction.editReply({
        embeds: [
            successEmbed,
            client.embed(
                "Chọn một hoặc nhiều quest bên dưới. Bot chỉ chạy các quest bạn chọn.",
                {
                    title: "Chọn quest để chạy",
                    color: 0x5865f2,
                },
            ),
        ],
        components: [new ActionRowBuilder().addComponents(menu)],
    });
}
