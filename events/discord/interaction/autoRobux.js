/**
 * autoRobux.js (interactionCreate event)
 * Thin interaction handler — all logic lives in extensions/AutoRobux.js, every
 * word in templates/robux.js. All custom IDs are namespaced with "rb:" prefix.
 */

const {
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require("discord.js");

const {
    ROBUX_PACKAGES,
    createRobuxPayment,
    cancelRobuxPayment,
    cancelRobuxOrderLog,
    getOpenRobuxPayment,
    getRobuxPaymentById,
    sendRobuxOrderLog,
    robuxPaymentMessage,
} = require("../../../extensions/AutoRobux");

// In-memory session cache: sessionId → { robux, price }
// Stores the selected package between select menu and modal submit
const sessionCache = new Map();

const ephemeral = (client, key, vars = {}) => client.ui.message(key, vars, { ephemeral: true });

module.exports = {
    name: "interactionCreate",
    async execute(client, interaction) {
        const id = interaction.customId ?? "";
        if (!id.startsWith("rb:")) return;
        if (!interaction.guild) return;

        try {
            if (interaction.isButton())
                return await _handleButton(client, interaction);
            if (interaction.isStringSelectMenu())
                return await _handleSelectMenu(client, interaction);
            if (interaction.isModalSubmit())
                return await _handleModal(client, interaction);
        } catch (err) {
            console.error("[autoRobux interaction] error:", err);
            const payload = ephemeral(client, "auto.robux.error", { error: err.message });
            if (interaction.deferred || interaction.replied)
                await interaction.followUp(payload).catch(() => null);
            else await interaction.reply(payload).catch(() => null);
        }
    },
};

// ── Button handler ─────────────────────────────────────────────────────────────

async function _handleButton(client, interaction) {
    const { customId } = interaction;

    // "Hủy đơn" button
    if (customId.startsWith("rb:cancel_payment:")) {
        const paymentId = customId.split(":")[2];
        const payment = await getRobuxPaymentById(client, paymentId);

        if (!payment) return interaction.reply(ephemeral(client, "auto.robux.cancel.notFound"));
        if (payment.userId !== interaction.user.id) return interaction.reply(ephemeral(client, "auto.robux.cancel.notYours"));
        if (payment.status !== "pending") return interaction.reply(ephemeral(client, "auto.robux.cancel.handled"));

        await interaction.deferUpdate();
        await cancelRobuxPayment(client, paymentId);
        await cancelRobuxOrderLog(client, paymentId);

        const user = await client.users.fetch(payment.userId).catch(() => null);
        if (user) await user.send(client.ui.message("auto.robux.dm.cancelled", { user: client.ui.user(user) })).catch(() => null);
        return;
    }
}

// ── Select menu handler ────────────────────────────────────────────────────────

async function _handleSelectMenu(client, interaction) {
    if (interaction.customId !== "rb:select_package") return;

    const robux = parseInt(interaction.values[0]);
    const pkg = ROBUX_PACKAGES.find((p) => p.robux === robux);
    if (!pkg) return;

    // Check existing pending payment
    const existed = await getOpenRobuxPayment(client, interaction.user.id);
    if (existed) {
        return interaction.update(robuxPaymentMessage(client, existed, "existed", { edit: true }));
    }

    // Store package in session, show modal for gamepass link
    const sessionId = Math.random().toString(36).slice(2, 12);
    sessionCache.set(sessionId, { robux: pkg.robux, price: pkg.price });
    setTimeout(() => sessionCache.delete(sessionId), 15 * 60 * 1000);
    return interaction.showModal(_buildGamepassModal(client, sessionId, pkg));
}

// ── Modal handler ──────────────────────────────────────────────────────────────

async function _handleModal(client, interaction) {
    if (!interaction.customId.startsWith("rb:gamepass_modal:")) return;

    const sessionId = interaction.customId.split(":")[2];
    const session = sessionCache.get(sessionId);
    await interaction.update({});
    if (!session) return interaction.followUp(ephemeral(client, "auto.robux.sessionExpired"));
    sessionCache.delete(sessionId);

    const accountName = interaction.fields
        .getTextInputValue("account_name")
        .trim();

    const gamepassLinkCount = Math.min(session.robux / 250, 4);
    const gamepassLinks = [];
    for (let i = 1; i <= gamepassLinkCount; i++) {
        const link = interaction.fields
            .getTextInputValue(`gamepass_link_${i}`)
            .trim();

        // Basic URL validation
        if (
            !link.startsWith("https://www.roblox.com/") &&
            !link.startsWith("https://roblox.com/")
        ) {
            return interaction.followUp(ephemeral(client, "auto.robux.badLink", { index: i }));
        }

        gamepassLinks.push(link);
    }

    // Check existing pending payment again (race condition safety)
    const existed = await getOpenRobuxPayment(client, interaction.user.id);
    if (existed) return interaction.followUp(robuxPaymentMessage(client, existed, "existed", { ephemeral: true }));

    const payment = await createRobuxPayment(client, {
        userId: interaction.user.id,
        robux: session.robux,
        price: session.price,
        accountName,
        gamepassLinks,
    });

    // Send order log
    await sendRobuxOrderLog(
        client,
        payment.id,
        interaction.user.id,
        session.robux,
        session.price,
        accountName,
        gamepassLinks,
    );

    return interaction.followUp(robuxPaymentMessage(client, payment, "created", { ephemeral: true }));
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

/** The gamepass form (template auto.robux.form): 1 link per 250 Robux, max 4, plus the account name. */
function _buildGamepassModal(client, sessionId, pkg) {
    const linkCount = Math.min(pkg.robux / 250, 4);
    const vars = { robux: pkg.robux, robuxText: pkg.robux.toLocaleString(), price: pkg.price, linkCount };
    const card = client.ui.card("auto.robux.form", vars);
    const cut = (s, n, fallback) => (s || fallback).slice(0, n);

    const gamepassRows = [];
    for (let i = 1; i <= linkCount; i++) {
        gamepassRows.push(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId(`gamepass_link_${i}`)
                    .setLabel(cut(card.text(linkCount === 1 ? "linkLabelOne" : "linkLabelMany", { index: i }), 45, `Link #${i}`))
                    .setPlaceholder(cut(card.text("linkPlaceholder"), 100, " "))
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
    }

    const accountRow = new ActionRowBuilder().addComponents(
        new TextInputBuilder()
            .setCustomId("account_name")
            .setLabel(cut(card.text("accountLabel"), 45, "Roblox"))
            .setPlaceholder(cut(card.text("accountPlaceholder"), 100, " "))
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
    );

    return new ModalBuilder()
        .setCustomId(`rb:gamepass_modal:${sessionId}`)
        .setTitle(cut(card.text("title"), 45, "Robux"))
        .addComponents(...gamepassRows, accountRow);
}
