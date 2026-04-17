const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
} = require("discord.js");

const {
    getRunningMap,
    setAllowedQuests,
    getSelectableQuests,
    resolveDiscordAccount,
    startAccount,
} = require("../../../extensions/accounts");
const {
    createQuestPayment,
    getPaymentById,
    getOpenPendingPayment,
    cancelPayment,
    upsertPendingActivation,
    removeActivationByPaymentId,
    buildVietQrUrl,
} = require("../../../extensions/payments");
const { getTokenRefreshRecord } = require("../../../extensions/storage");
const { normalizeDiscordTokenInput } = require("../../../bot/utils");

module.exports = {
    name: "interactionCreate",
    async execute(client, interaction) {
        if (!interaction.guild) return;

        try {
            // ── Slash commands ─────────────────────────────────────────────────
            if (interaction.isChatInputCommand()) {
                const command = client.slashCommands.find(
                    (e) => e.data.name === interaction.commandName
                );
                if (!command) {
                    return interaction.reply({
                        ephemeral: true,
                        content: "Không tìm thấy lệnh, vui lòng thử lại sau.",
                    });
                }
                if (command.deferReply) await interaction.deferReply(command.deferReply);
                return await command.execute(client, interaction);
            }

            // ── Autocomplete ───────────────────────────────────────────────────
            if (interaction.isAutocomplete()) {
                const command = client.slashCommands.find(
                    (e) => e.data.name === interaction.commandName
                );
                if (command?.autoComplete) await command.autoComplete(client, interaction);
                return;
            }

            // ── Buttons ────────────────────────────────────────────────────────
            if (interaction.isButton()) return await _handleButton(client, interaction);

            // ── Select menus ───────────────────────────────────────────────────
            if (interaction.isStringSelectMenu()) return await _handleSelectMenu(client, interaction);

            // ── Modals ─────────────────────────────────────────────────────────
            if (interaction.isModalSubmit()) return await _handleModal(client, interaction);

        } catch (err) {
            console.error("[interaction] error:", err);
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

    // "Nhập token" from quest panel
    if (customId === "quest:enter_token") {
        const refreshRecord = await getTokenRefreshRecord(client, interaction.user.id);
        if (refreshRecord) {
            return interaction.showModal(
                _buildTokenModal(`quest:refresh_modal:${refreshRecord.accountId}`, "Nhập lại token Discord")
            );
        }
        return interaction.showModal(_buildTokenModal("quest:token_modal", "Nhập token Discord"));
    }

    // Refresh token button (sent via DM)
    if (customId.startsWith("quest:refresh_token:")) {
        const accountId = customId.split(":")[2];
        const refreshRecord = await getTokenRefreshRecord(client, interaction.user.id);
        if (!refreshRecord || refreshRecord.accountId !== accountId) {
            return interaction.reply({
                ephemeral: true,
                embeds: [client.embed("Account này không còn ở trạng thái chờ nhập lại token.", { title: "Không thể nhập lại token" })],
            });
        }
        return interaction.showModal(
            _buildTokenModal(`quest:refresh_modal:${accountId}`, "Nhập lại token Discord")
        );
    }

    // Cancel payment
    if (customId.startsWith("quest:cancel_payment:")) {
        const paymentId = customId.split(":")[2];
        const payment = await getPaymentById(client, paymentId);
        if (!payment) {
            return interaction.reply({
                ephemeral: true,
                embeds: [client.embed("Không tìm thấy đơn thanh toán.", { title: "Lỗi" })],
            });
        }
        if (payment.userId !== interaction.user.id) {
            return interaction.reply({
                ephemeral: true,
                embeds: [client.embed("Bạn không thể hủy đơn của người khác.", { title: "Không có quyền" })],
            });
        }
        if (payment.status !== "pending") {
            return interaction.reply({
                ephemeral: true,
                embeds: [client.embed("Đơn này đã được xử lý (paid/expired).", { title: "Không thể hủy" })],
            });
        }
        await interaction.deferUpdate();
        await cancelPayment(client, paymentId);
        await removeActivationByPaymentId(client, paymentId);
        const user = await client.users.fetch(payment.userId).catch(() => null);
        if (user) {
            await user.send({
                embeds: [client.embed("", { title: "Đã hủy đơn thanh toán", color: 0xed4245 })],
            }).catch(() => null);
        }
        return;
    }
}

// ── Select menu handler ────────────────────────────────────────────────────────
async function _handleSelectMenu(client, interaction) {
    if (!interaction.customId.startsWith("quest:select:")) return;

    const accountId = interaction.customId.split(":")[2];
    const selectedQuestIds = interaction.values ?? [];
    const runningEntry = getRunningMap(interaction.user.id).get(accountId);

    if (!runningEntry) {
        return interaction.reply({
            ephemeral: true,
            embeds: [client.embed("Account này không còn chạy hoặc không thuộc về bạn.", { title: "Không tìm thấy account" })],
        });
    }

    const existed = await getOpenPendingPayment(client, interaction.user.id, accountId);
    if (existed) {
        return interaction.update({
            embeds: [_buildPaymentEmbed(client, existed, "Bạn đã có đơn chờ thanh toán. Thanh toán đơn hiện tại hoặc chờ hết hạn để tạo đơn mới.")],
            components: existed.status === "pending" ? [_buildPaymentActionRow(existed.id)] : [],
        });
    }

    const payment = await createQuestPayment(client, {
        userId: interaction.user.id,
        accountId,
        questIds: selectedQuestIds,
    });

    await upsertPendingActivation(client, {
        paymentId: payment.id,
        userId: interaction.user.id,
        accountId,
        token: runningEntry.token,
        selectedQuestIds,
    });

    return interaction.update({
        embeds: [_buildPaymentEmbed(client, payment, `Đã tạo QR cho ${selectedQuestIds.length} quest. Thanh toán xong bot tự chạy quest.`)],
        components: [_buildPaymentActionRow(payment.id)],
    });
}

// ── Modal handler ──────────────────────────────────────────────────────────────
async function _handleModal(client, interaction) {
    // New token
    if (interaction.customId === "quest:token_modal") {
        const token = normalizeDiscordTokenInput(
            interaction.fields.getTextInputValue("token")
        );
        await interaction.deferReply({ ephemeral: true });

        const result = await startAccount(client, interaction.user.id, token, {
            allowRestartIfRunning: false,
            rejectDuplicateStoredAccount: true,
            notifyStarted: true,
            forceNotifyQuestBatch: true,
            source: "activate",
            requireQuestSelection: true,
        });

        if (!result.ok) {
            // If already running, reopen quest selection
            if (/đang chạy rồi/i.test(String(result.reason ?? ""))) {
                const resolved = await resolveDiscordAccount(token);
                if (resolved?.ok) {
                    const existing = getRunningMap(interaction.user.id).get(resolved.accountId);
                    if (existing) {
                        return _replyWithQuestSelection(client, interaction, {
                            accountId: resolved.accountId,
                            username: resolved.username,
                            buildNumber: resolved.buildNumber,
                        });
                    }
                }
            }
            return interaction.editReply({
                embeds: [client.embed(result.reason, { title: "Kích hoạt thất bại" })],
            });
        }

        return _replyWithQuestSelection(client, interaction, result);
    }

    // Refresh token
    if (interaction.customId.startsWith("quest:refresh_modal:")) {
        const accountId = interaction.customId.split(":")[2];
        const token = normalizeDiscordTokenInput(
            interaction.fields.getTextInputValue("token")
        );
        await interaction.deferReply({ ephemeral: true });

        const refreshRecord = await getTokenRefreshRecord(client, interaction.user.id);
        if (!refreshRecord || refreshRecord.accountId !== accountId) {
            return interaction.editReply({
                embeds: [client.embed("Account này không còn ở trạng thái chờ nhập lại token.", { title: "Không thể nhập lại token" })],
            });
        }

        const resolved = await resolveDiscordAccount(token);
        if (!resolved.ok) {
            return interaction.editReply({
                embeds: [client.embed(resolved.reason, { title: "Kích hoạt thất bại" })],
            });
        }
        if (resolved.accountId !== accountId) {
            return interaction.editReply({
                embeds: [client.embed(`Bạn chỉ được nhập lại token của account \`${accountId}\`.`, { title: "Sai account" })],
            });
        }

        const result = await startAccount(client, interaction.user.id, token, {
            resolvedAccount: resolved,
            allowRestartIfRunning: false,
            addedAt: refreshRecord.addedAt,
            month: refreshRecord.month,
            notifyStarted: true,
            forceNotifyQuestBatch: true,
            source: "refresh",
            requireQuestSelection: true,
        });

        if (!result.ok) {
            return interaction.editReply({
                embeds: [client.embed(result.reason, { title: "Kích hoạt thất bại" })],
            });
        }

        return _replyWithQuestSelection(client, interaction, result);
    }
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
                    .setRequired(true)
            )
        );
}

async function _replyWithQuestSelection(client, interaction, result) {
    const quests = await getSelectableQuests(interaction.user.id, result.accountId);

    const successEmbed = client.embed("", {
        title: "Kích hoạt thành công",
        color: 0x57f287,
        fields: [
            { name: "Tài khoản", value: result.username, inline: true },
            { name: "ID", value: `\`${result.accountId}\``, inline: true },
        ],
        footer: { text: "Bot đã bắt đầu chạy quest. Dùng /status để theo dõi." },
        timestamp: true,
    });

    if (!quests.length) {
        return interaction.editReply({
            embeds: [
                successEmbed,
                client.embed("Hiện chưa có quest phù hợp. Khi có quest mới, dùng nút Nhập token để chọn lại.", {
                    title: "Chưa có quest để chọn",
                    color: 0xfee75c,
                }),
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
            }))
        );

    return interaction.editReply({
        embeds: [
            successEmbed,
            client.embed("Chọn một hoặc nhiều quest bên dưới. Bot chỉ chạy các quest bạn chọn.", {
                title: "Chọn quest để chạy",
                color: 0x5865f2,
            }),
        ],
        components: [new ActionRowBuilder().addComponents(menu)],
    });
}

function _buildPaymentEmbed(client, payment, note) {
    const s = client.configs.settings;
    const embed = {
        title: "Thanh toán quest",
        color: payment.status === "paid" ? 0x57f287 : 0x5865f2,
        description: note || null,
        fields: [
            { name: "Mã đơn", value: `\`${payment.id}\``, inline: false },
            { name: "Số lượng quest", value: String((payment.selectedQuestIds ?? []).length), inline: true },
            { name: "Đơn giá", value: `${s.questPricePerItem.toLocaleString("vi-VN")}đ/quest`, inline: true },
            { name: "Tổng tiền", value: `\`${Number(payment.amount).toLocaleString("vi-VN")} VNĐ\``, inline: true },
            { name: "Chủ tài khoản", value: `\`${s.bankHolder}\``, inline: false },
            { name: "Ngân hàng", value: `\`${s.bankCode}\``, inline: true },
            { name: "Số tài khoản", value: `\`\`\`\n${s.bankAccount}\n\`\`\``, inline: false },
            { name: "Nội dung chuyển khoản", value: `\`\`\`\n${payment.transferCode}\n\`\`\``, inline: false },
        ],
        image: payment.status === "pending" && payment.qrUrl ? { url: payment.qrUrl } : null,
        footer: {
            text: payment.status === "pending"
                ? "Bot tự kiểm tra qua VietQR webhook. Chuyển đúng nội dung."
                : payment.status === "paid"
                ? "Đã xác nhận thanh toán. Bot bắt đầu chạy quest đã chọn."
                : "Đơn đã hủy hoặc hết hạn.",
        },
        timestamp: new Date().toISOString(),
    };
    return embed;
}

function _buildPaymentActionRow(paymentId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`quest:cancel_payment:${paymentId}`)
            .setLabel("Hủy đơn")
            .setStyle(ButtonStyle.Danger)
    );
}
