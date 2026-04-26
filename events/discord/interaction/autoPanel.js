const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    EmbedBuilder,
    AttachmentBuilder,
} = require("discord.js");
const crypto = require("crypto");
const { nanoid } = require("nanoid");

const generateVietQR = (client, amount, transferCode) => {
    const s = client.configs.settings;
    return `https://img.vietqr.io/image/${s.bankCode}-${s.bankAccount}-qr_only.png?addInfo=${encodeURIComponent(transferCode)}&accountName=${encodeURIComponent(s.bankHolder)}&amount=${amount}`;
};

const renderBotStatus = (bot) => {
    const live = bot.live || {};
    const statusEmoji = live.status === "online" ? "🟢" : "🔴";
    const statusText = live.status ? live.status.toUpperCase() : "NGOẠI TUYẾN";

    const embed = new EmbedBuilder()
        .setTitle(`📊 CHI TIẾT BOT: ${bot.name || bot.botID}`)
        .setColor(live.status === "online" ? 0x2ecc71 : 0xe74c3c)
        .addFields(
            {
                name: "📌 Tên Bot",
                value: `\`${bot.name || "N/A"}\``,
                inline: true,
            },
            {
                name: "🆔 Bot ID",
                value: `\`${bot.botID}\``,
                inline: true,
            },
            {
                name: "📡 Trạng thái",
                value: `${statusEmoji} **${statusText}**`,
                inline: true,
            },
            {
                name: "💾 RAM tối đa",
                value: `\`${bot.maxMemory || "128M"}\``,
                inline: true,
            },
            {
                name: "🔄 Khởi động lại",
                value: `\`${live.restarts || 0}\` lần`,
                inline: true,
            },
        );

    if (live.uptime) {
        embed.addFields({
            name: "⏱️ Thời gian chạy",
            value: `<t:${Math.floor(live.uptime / 1000)}:R>`,
            inline: true,
        });
    }

    if (bot.expiresAt) {
        embed.addFields({
            name: "📅 Ngày hết hạn",
            value: `🕒 <t:${Math.floor(bot.expiresAt / 1000)}:f>\n⏳ (<t:${Math.floor(bot.expiresAt / 1000)}:R>)`,
            inline: false,
        });
    }

    embed
        .setFooter({ text: "Dữ liệu được cập nhật thời gian thực" })
        .setTimestamp();

    return embed;
};

module.exports = {
    name: "interactionCreate",
    async execute(client, interaction) {
        if (!client.autoPanel?.isConfigured) return;

        // ── 1. Buttons (Manage, Extend, Upgrade) ────────────────────────────────
        if (
            interaction.isButton() &&
            interaction.customId.startsWith("panel:")
        ) {
            const actionType = interaction.customId.split(":")[1]; // manage, extend, upgrade

            await interaction.deferReply({ ephemeral: true });

            const bots = await client.autoPanel.fetchBots(interaction.user.id);
            if (!bots || bots.length === 0) {
                return interaction.editReply({
                    content: "❌ Bạn chưa có bot nào trong hệ thống.",
                });
            }

            const actionName =
                actionType === "manage"
                    ? "Quản lý"
                    : actionType === "extend"
                      ? "Gia hạn"
                      : actionType === "upgrade"
                        ? "Nâng cấp"
                        : "Trạng thái";

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`panel_select:${actionType}`)
                .setPlaceholder("Vui lòng chọn một Bot")
                .addOptions(
                    bots.map((b) => ({
                        label: b.name || b.botID,
                        description: `RAM: ${b.maxMemory || "128M"} | Trạng thái: ${b.live?.status || "offline"}`,
                        value: b._id,
                        emoji: "🤖",
                    })),
                );

            const row = new ActionRowBuilder().addComponents(selectMenu);
            return interaction.editReply({
                content: `🔍 Bạn đang chọn: **${actionName}**. Vui lòng chọn Bot:`,
                components: [row],
            });
        }

        // ── 2. Select Menus ─────────────────────────────────────────────────────
        if (
            interaction.isStringSelectMenu() &&
            interaction.customId.startsWith("panel_select:")
        ) {
            const actionType = interaction.customId.split(":")[1];
            const botId = interaction.values[0];

            if (actionType === "status") {
                const bots = await client.autoPanel.fetchBots(
                    interaction.user.id,
                );
                const bot = bots.find((b) => b._id === botId);
                if (!bot) {
                    return interaction.reply({
                        content: "❌ Không tìm thấy thông tin Bot.",
                        ephemeral: true,
                    });
                }

                const embed = renderBotStatus(bot);
                return interaction.reply({ embeds: [embed], ephemeral: true });
            }

            if (actionType === "manage") {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`panel_action:status:${botId}`)
                        .setLabel("Trạng thái")
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji("📊"),
                    new ButtonBuilder()
                        .setCustomId(`panel_action:start:${botId}`)
                        .setLabel("Khởi động")
                        .setStyle(ButtonStyle.Success)
                        .setEmoji("▶️"),
                    new ButtonBuilder()
                        .setCustomId(`panel_action:restart:${botId}`)
                        .setLabel("Khởi động lại")
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji("🔄"),
                    new ButtonBuilder()
                        .setCustomId(`panel_action:stop:${botId}`)
                        .setLabel("Dừng")
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji("⏹️"),
                );

                return interaction.reply({
                    content: "🎯 Chọn hành động cho Bot này:",
                    components: [row],
                    ephemeral: true,
                });
            }

            if (actionType === "extend") {
                const modal = new ModalBuilder()
                    .setCustomId(`panel_modal:extend:${botId}`)
                    .setTitle("Gia hạn thời gian chạy Bot");

                const input = new TextInputBuilder()
                    .setCustomId("months")
                    .setLabel("Số tháng muốn gia hạn")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue("1");

                modal.addComponents(
                    new ActionRowBuilder().addComponents(input),
                );
                return interaction.showModal(modal);
            }

            if (actionType === "upgrade") {
                const modal = new ModalBuilder()
                    .setCustomId(`panel_modal:upgrade:${botId}`)
                    .setTitle("Nâng cấp dung lượng RAM");

                const input = new TextInputBuilder()
                    .setCustomId("additionalRam")
                    .setLabel("Số MB RAM muốn thêm (vd: 64, 128, ...)")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder("64");

                modal.addComponents(
                    new ActionRowBuilder().addComponents(input),
                );
                return interaction.showModal(modal);
            }
        }

        // ── 3. Manage Actions (Start/Stop/Restart) ─────────────────────────────
        if (
            interaction.isButton() &&
            interaction.customId.startsWith("panel_action:")
        ) {
            const [, action, botId] = interaction.customId.split(":");

            if (action === "status") {
                await interaction.deferReply({ ephemeral: true });
                const bots = await client.autoPanel.fetchBots(
                    interaction.user.id,
                );
                const bot = bots.find((b) => b._id === botId);
                if (!bot) {
                    return interaction.editReply({
                        content: "❌ Không tìm thấy thông tin Bot.",
                    });
                }

                const embed = renderBotStatus(bot);
                return interaction.editReply({ embeds: [embed] });
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                const result = await client.autoPanel.performAction(
                    botId,
                    action,
                );
                return interaction.editReply({
                    content: `✅ Thành công: ${result.message}`,
                });
            } catch (err) {
                return interaction.editReply({
                    content: `❌ Thất bại: ${err.message}`,
                });
            }
        }

        // ── 4. Modals (Extend/Upgrade) ─────────────────────────────────────────
        if (
            interaction.isModalSubmit() &&
            interaction.customId.startsWith("panel_modal:")
        ) {
            const [, actionType, botId] = interaction.customId.split(":");

            await interaction.deferReply({ ephemeral: true });

            const bots = await client.autoPanel.fetchBots(interaction.user.id);
            const bot = bots.find((b) => b._id === botId);
            if (!bot) {
                return interaction.editReply({
                    content: "❌ Không tìm thấy Bot.",
                });
            }

            let amount = 0;
            let value = 0; // months or additionalRam
            let description = "";

            if (actionType === "extend") {
                const monthsStr =
                    interaction.fields.getTextInputValue("months");
                value = parseInt(monthsStr, 10);
                if (isNaN(value) || value <= 0) {
                    return interaction.editReply({
                        content: "❌ Số tháng không hợp lệ.",
                    });
                }

                let currentRam = 128;
                if (bot.maxMemory) {
                    const match = bot.maxMemory.match(/^(\d+)/);
                    if (match) currentRam = parseInt(match[1], 10);
                }
                const extraRam = Math.max(0, currentRam - 128);

                let pricePerMonth = bot.currentPrice;
                if (!pricePerMonth) {
                    pricePerMonth = 35000 + 5000 * (extraRam / 64);
                }

                amount = pricePerMonth * value;
                description = `Gia hạn bot **${bot.name || bot.botID}** thêm **${value}** tháng.`;
            } else if (actionType === "upgrade") {
                const ramStr =
                    interaction.fields.getTextInputValue("additionalRam");
                value = parseInt(ramStr, 10);
                if (isNaN(value) || value <= 0 || value % 64 !== 0) {
                    return interaction.editReply({
                        content:
                            "❌ Dung lượng RAM không hợp lệ. Phải là bội số của 64 (vd: 64, 128).",
                    });
                }

                let remainingMonths = 1;
                if (bot.expiresAt) {
                    const msRemaining = Math.max(0, bot.expiresAt - Date.now());
                    remainingMonths = Math.ceil(
                        msRemaining / (30 * 24 * 60 * 60 * 1000),
                    );
                    if (remainingMonths < 1) remainingMonths = 1;
                }
                amount = 5000 * (value / 64) * remainingMonths;
                description = `Nâng cấp bot **${bot.name || bot.botID}** thêm **${value}MB** RAM.`;
            }

            // Create pending payment in AutoBank
            const transferCode = `${nanoid(8).replaceAll("-", "").replaceAll("_", "")} Chuyen tien`;
            const expireAt = Date.now() + 10 * 60 * 1000; // 10 minutes

            const pendingData = {
                customId: transferCode,
                amount,
                expireAt,
                context: {
                    _handler: "panel_payment",
                    userId: interaction.user.id,
                    botId,
                    type: actionType,
                    value,
                },
            };

            await client.db.create("autobank_pending", pendingData);

            client.autoBank.createQR(
                amount,
                transferCode,
                pendingData.context,
                async (err, data) => {
                    if (err) {
                        // Handled by recovery or DM in ready.js/AutoBank.js if it expires
                        return;
                    }
                    // If it succeeds while bot is online:
                    try {
                        if (data.context.type === "extend") {
                            await client.autoPanel.extendBot(
                                data.context.botId,
                                data.context.value,
                            );
                            client.autoPanel._notifyUser(
                                data.context.userId,
                                `✅ Payment received! Your bot has been extended by **${data.context.value}** months.`,
                            );
                        } else if (data.context.type === "upgrade") {
                            await client.autoPanel.upgradeBot(
                                data.context.botId,
                                data.context.value,
                            );
                            client.autoPanel._notifyUser(
                                data.context.userId,
                                `✅ Payment received! Your bot's RAM has been upgraded by **${data.context.value}** MB.`,
                            );
                        }
                    } catch (e) {
                        client.autoPanel._notifyUser(
                            data.context.userId,
                            `❌ Payment received, but an error occurred while applying the upgrade. Please contact support. (Bot ID: ${data.context.botId})`,
                        );
                    }
                },
            );

            // Send QR code to user
            const qrUrl = generateVietQR(client, amount, transferCode);

            const embed = new EmbedBuilder()
                .setTitle(
                    "💳 THANH TOÁN: " +
                        (actionType === "extend" ? "GIA HẠN" : "NÂNG CẤP"),
                )
                .setDescription(
                    [
                        `💡 **Nội dung:** ${description}`,
                        "",
                        `💵 **Số tiền:** \`${Number(amount).toLocaleString("vi-VN")} VNĐ\``,
                        `📝 **Nội dung chuyển khoản:** \`${transferCode}\``,
                        "",
                        "👉 Quét mã QR bên dưới bằng ứng dụng ngân hàng của bạn. Hệ thống sẽ tự động cập nhật sau vài giây sau khi nhận được tiền.",
                    ].join("\n"),
                )
                .setImage(qrUrl)
                .setColor(0x5865f2)
                .setFooter({ text: "⚠️ Mã QR sẽ hết hạn sau 10 phút." })
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });
        }
    },
};
