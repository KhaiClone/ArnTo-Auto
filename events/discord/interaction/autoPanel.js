const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require("discord.js");
const { nanoid } = require("nanoid");
const AutoPanel = require("../../../extensions/AutoPanel");

// Every word here lives in templates/panelBot.js (auto.panelbot.*).

const QR_MINUTES = 10;

const generateVietQR = (client, amount, transferCode) => {
    const s = client.configs.settings;
    return `https://img.vietqr.io/image/${s.bankCode}-${s.bankAccount}-qr_only.png?addInfo=${encodeURIComponent(transferCode)}&accountName=${encodeURIComponent(s.bankHolder)}&amount=${amount}`;
};

/** Words of the panel-bot flow (template auto.panelbot.flow). */
const flow = (client, vars = {}) => client.ui.card("auto.panelbot.flow", { user: null, ...vars });
const cut = (s, n, fallback) => (s || fallback).slice(0, n);
const say = (client, slot, vars) => ({ content: flow(client, vars).text(slot) });

/** One bot's details (template auto.panelbot.status). */
const statusMessage = (client, bot) => client.ui.message("auto.panelbot.status", { customerBot: AutoPanel.botVars(bot) });

function _botSelect(client, actionType, bots) {
    const t = flow(client, { action: actionType });
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`panel_select:${actionType}`)
            .setPlaceholder(t.placeholder("bot") || "Bot")
            .addOptions(
                bots.slice(0, 25).map((b) => ({
                    ...t.option("bot", { customerBot: AutoPanel.botVars(b) }),
                    value: b._id,
                })),
            ),
    );
}

function _manageRow(client, botId) {
    const t = flow(client);
    const button = (slot, style) => t.applyButton(new ButtonBuilder().setCustomId(`panel_action:${slot}:${botId}`).setStyle(style), slot);
    return new ActionRowBuilder().addComponents(
        button("status", ButtonStyle.Secondary),
        button("start", ButtonStyle.Success),
        button("restart", ButtonStyle.Primary),
        button("stop", ButtonStyle.Danger),
    );
}

function _extendModal(client, botId) {
    const t = flow(client);
    return new ModalBuilder()
        .setCustomId(`panel_modal:extend:${botId}`)
        .setTitle(cut(t.text("extendTitle"), 45, "Gia hạn"))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("months")
                    .setLabel(cut(t.text("extendLabel"), 45, "Số tháng"))
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(cut(t.text("extendDefault"), 100, "1")),
            ),
        );
}

function _upgradeModal(client, botId) {
    const t = flow(client);
    return new ModalBuilder()
        .setCustomId(`panel_modal:upgrade:${botId}`)
        .setTitle(cut(t.text("upgradeTitle"), 45, "Nâng cấp"))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("additionalRam")
                    .setLabel(cut(t.text("upgradeLabel"), 45, "MB RAM"))
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder(cut(t.text("upgradePlaceholder"), 100, "64")),
            ),
        );
}

module.exports = {
    name: "interactionCreate",
    async execute(client, interaction) {
        if (!client.autoPanel?.isConfigured) return;

        // ── 1. Buttons (Manage, Extend, Upgrade) ────────────────────────────────
        if (
            interaction.isButton() &&
            interaction.customId.startsWith("panel:")
        ) {
            const actionType = interaction.customId.split(":")[1]; // status, manage, extend, upgrade

            await interaction.deferReply({ ephemeral: true });

            const bots = await client.autoPanel.fetchBots(interaction.user.id);
            if (!bots || bots.length === 0) {
                return interaction.editReply(say(client, "noBots"));
            }

            return interaction.editReply({
                ...say(client, "chooseBot", { action: actionType }),
                components: [_botSelect(client, actionType, bots)],
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
                    return interaction.reply({ ...say(client, "botNotFound"), ephemeral: true });
                }

                return interaction.reply({ ...statusMessage(client, bot), ephemeral: true });
            }

            if (actionType === "manage") {
                return interaction.reply({
                    ...say(client, "chooseAction"),
                    components: [_manageRow(client, botId)],
                    ephemeral: true,
                });
            }

            if (actionType === "extend") return interaction.showModal(_extendModal(client, botId));
            if (actionType === "upgrade") return interaction.showModal(_upgradeModal(client, botId));
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
                    return interaction.editReply(say(client, "botNotFound"));
                }

                return interaction.editReply(statusMessage(client, bot));
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                const result = await client.autoPanel.performAction(
                    botId,
                    action,
                );
                return interaction.editReply(say(client, "actionOk", { action, message: result.message }));
            } catch (err) {
                return interaction.editReply(say(client, "actionFailed", { action, error: err.message }));
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
                return interaction.editReply(say(client, "botNotFound"));
            }

            let amount = 0;
            let value = 0; // months or additionalRam

            if (actionType === "extend") {
                const monthsStr =
                    interaction.fields.getTextInputValue("months");
                value = parseInt(monthsStr, 10);
                if (isNaN(value) || value <= 0) {
                    return interaction.editReply(say(client, "badMonths"));
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
            } else if (actionType === "upgrade") {
                const ramStr =
                    interaction.fields.getTextInputValue("additionalRam");
                value = parseInt(ramStr, 10);
                if (isNaN(value) || value <= 0 || value % 64 !== 0) {
                    return interaction.editReply(say(client, "badRam"));
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
            }

            // Create pending payment in AutoBank
            const transferCode = `${nanoid(8).replaceAll("-", "").replaceAll("_", "")} Chuyen tien`;
            const expireAt = Date.now() + QR_MINUTES * 60 * 1000;

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
                    // An expiry is handled by recovery or DM in ready.js/AutoBank.js.
                    if (err) return;
                    // It succeeded while the bot is online.
                    await client.autoPanel.applyPayment(data.context, "live");
                },
            );

            // Send QR code to user
            const payment = AutoPanel.paymentVars(pendingData.context, {
                botName: bot.name || bot.botID,
                amount,
                transferCode,
                qrUrl: generateVietQR(client, amount, transferCode),
                expireMinutes: QR_MINUTES,
            });
            return interaction.editReply(client.ui.message("auto.panelbot.payment", { payment }));
        }
    },
};
