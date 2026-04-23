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

const generateVietQR = (client, amount, transferCode) => {
    const s = client.configs.settings;
    return `https://img.vietqr.io/image/${s.bankCode}-${s.bankAccount}-qr_only.png?addInfo=${encodeURIComponent(transferCode)}&accountName=${encodeURIComponent(s.bankHolder)}&amount=${amount}`;
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
                    content: "You do not have any bots.",
                });
            }

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`panel_select:${actionType}`)
                .setPlaceholder("Select a bot")
                .addOptions(
                    bots.map((b) => ({
                        label: b.name || b.botID,
                        description: `RAM: ${b.maxMemory || "128M"} | Status: ${b.live?.status || "offline"}`,
                        value: b._id,
                    })),
                );

            const row = new ActionRowBuilder().addComponents(selectMenu);
            return interaction.editReply({
                content: `Please select the bot you want to **${actionType}**:`,
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

            if (actionType === "manage") {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`panel_action:start:${botId}`)
                        .setLabel("Start")
                        .setStyle(ButtonStyle.Success)
                        .setEmoji("▶️"),
                    new ButtonBuilder()
                        .setCustomId(`panel_action:restart:${botId}`)
                        .setLabel("Restart")
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji("🔄"),
                    new ButtonBuilder()
                        .setCustomId(`panel_action:stop:${botId}`)
                        .setLabel("Stop")
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji("⏹️"),
                );

                return interaction.reply({
                    content: "Choose an action for this bot:",
                    components: [row],
                    ephemeral: true,
                });
            }

            if (actionType === "extend") {
                const modal = new ModalBuilder()
                    .setCustomId(`panel_modal:extend:${botId}`)
                    .setTitle("Extend Bot Expiry");

                const input = new TextInputBuilder()
                    .setCustomId("months")
                    .setLabel("Number of months to extend")
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
                    .setTitle("Upgrade Bot RAM");

                const input = new TextInputBuilder()
                    .setCustomId("additionalRam")
                    .setLabel("Additional RAM (e.g. 64, 128, 192, ...)")
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
            await interaction.deferReply({ ephemeral: true });

            try {
                const result = await client.autoPanel.performAction(
                    botId,
                    action,
                );
                return interaction.editReply({
                    content: `✅ ${result.message}`,
                });
            } catch (err) {
                return interaction.editReply({
                    content: `❌ Failed: ${err.message}`,
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
                return interaction.editReply({ content: "Bot not found." });
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
                        content: "Invalid number of months.",
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
                description = `Extend bot **${bot.name || bot.botID}** by **${value}** months.`;
            } else if (actionType === "upgrade") {
                const ramStr =
                    interaction.fields.getTextInputValue("additionalRam");
                value = parseInt(ramStr, 10);
                if (isNaN(value) || value <= 0 || value % 64 !== 0) {
                    return interaction.editReply({
                        content:
                            "Invalid RAM amount. Must be divisible by 64 (e.g. 64, 128).",
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
                description = `Upgrade bot **${bot.name || bot.botID}** with **${value}MB** extra RAM.`;
            }

            // Create pending payment in AutoBank
            const transferCode = `PN${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
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
                    "Thanh toán " +
                        (actionType === "extend" ? "Gia hạn" : "Nâng cấp"),
                )
                .setDescription(
                    [
                        description,
                        "",
                        `**Số tiền:** ${Number(amount).toLocaleString("vi-VN")} VNĐ`,
                        `**Nội dung chuyển khoản:** \`${transferCode}\``,
                        "",
                        "Quét mã QR bên dưới bằng ứng dụng ngân hàng. Hệ thống sẽ tự động cập nhật sau vài giây.",
                    ].join("\n"),
                )
                .setImage(qrUrl)
                .setColor(0x5865f2)
                .setFooter({ text: "Mã QR sẽ hết hạn sau 10 phút." });

            return interaction.editReply({ embeds: [embed] });
        }
    },
};
