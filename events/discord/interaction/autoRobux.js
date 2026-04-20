/**
 * autoRobux.js (interactionCreate event)
 * Thin interaction handler — all logic lives in extensions/AutoRobux.js
 * All custom IDs are namespaced with "rb:" prefix.
 */

const {
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
} = require("discord.js");

const {
    ROBUX_PACKAGES,
    createRobuxPayment,
    cancelRobuxPayment,
    getOpenRobuxPayment,
    getRobuxPaymentById,
    sendRobuxOrderLog,
    buildRobuxPaymentEmbed,
    buildRobuxCancelRow,
} = require("../../../extensions/AutoRobux");

// In-memory session cache: sessionId → { robux, price }
// Stores the selected package between select menu and modal submit
const sessionCache = new Map();

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
            const payload = {
                embeds: [client.embed(err.message, { title: "Có lỗi xảy ra" })],
                ephemeral: true,
            };
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

        if (!payment)
            return interaction.reply({
                ephemeral: true,
                embeds: [client.embed("Không tìm thấy đơn.", { title: "Lỗi" })],
            });
        if (payment.userId !== interaction.user.id)
            return interaction.reply({
                ephemeral: true,
                embeds: [
                    client.embed("Bạn không thể hủy đơn của người khác.", {
                        title: "Không có quyền",
                    }),
                ],
            });
        if (payment.status !== "pending")
            return interaction.reply({
                ephemeral: true,
                embeds: [
                    client.embed("Đơn này đã được xử lý.", {
                        title: "Không thể hủy",
                    }),
                ],
            });

        await interaction.deferUpdate();
        await cancelRobuxPayment(client, paymentId);

        const user = await client.users.fetch(payment.userId).catch(() => null);
        if (user)
            await user
                .send({
                    embeds: [
                        client.embed("", {
                            title: "Đã hủy đơn Robux",
                            color: 0xed4245,
                        }),
                    ],
                })
                .catch(() => null);
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
        return interaction.update({
            embeds: [
                buildRobuxPaymentEmbed(
                    client,
                    existed,
                    "Bạn đã có đơn chờ thanh toán. Thanh toán hoặc chờ hết hạn để tạo đơn mới.",
                ),
            ],
            components: [buildRobuxCancelRow(existed.id)],
        });
    }

    // Store package in session, show modal for gamepass link
    const sessionId = Math.random().toString(36).slice(2, 12);
    sessionCache.set(sessionId, { robux: pkg.robux, price: pkg.price });
    setTimeout(() => sessionCache.delete(sessionId), 15 * 60 * 1000);
    await interaction.deferUpdate();
    return interaction.showModal(_buildGamepassModal(sessionId, pkg));
}

// ── Modal handler ──────────────────────────────────────────────────────────────

async function _handleModal(client, interaction) {
    if (!interaction.customId.startsWith("rb:gamepass_modal:")) return;

    const sessionId = interaction.customId.split(":")[2];
    const session = sessionCache.get(sessionId);

    if (!session) {
        await interaction.deferReply({ ephemeral: true });
        return interaction.editReply({
            embeds: [
                client.embed(
                    "Phiên làm việc đã hết hạn. Vui lòng chọn lại gói.",
                    { title: "Lỗi phiên" },
                ),
            ],
        });
    }
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
            await interaction.deferReply({ ephemeral: true });
            return interaction.editReply({
                embeds: [
                    client.embed(
                        `Link Gamepass #${i} không hợp lệ. Vui lòng nhập đúng link từ Roblox.`,
                        { title: "Link không hợp lệ" },
                    ),
                ],
            });
        }

        gamepassLinks.push(link);
    }

    await interaction.deferReply({ ephemeral: true });

    // Check existing pending payment again (race condition safety)
    const existed = await getOpenRobuxPayment(client, interaction.user.id);
    if (existed) {
        return interaction.editReply({
            embeds: [
                buildRobuxPaymentEmbed(
                    client,
                    existed,
                    "Bạn đã có đơn chờ thanh toán. Thanh toán hoặc chờ hết hạn để tạo đơn mới.",
                ),
            ],
            components: [buildRobuxCancelRow(existed.id)],
        });
    }

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

    return interaction.editReply({
        embeds: [
            buildRobuxPaymentEmbed(
                client,
                payment,
                `Đã tạo QR thanh toán cho **${session.robux.toLocaleString()} Robux**. Chuyển khoản xong admin sẽ xử lý cho bạn.`,
            ),
        ],
        components: [buildRobuxCancelRow(payment.id)],
    });
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function _buildGamepassModal(sessionId, pkg) {
    // 1 gamepass input per 250 Robux, capped at 4 (pkg.robux max = 1000)
    const linkCount = Math.min(pkg.robux / 250, 4);

    const gamepaxRows = [];
    for (let i = 1; i <= linkCount; i++) {
        gamepaxRows.push(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId(`gamepass_link_${i}`)
                    .setLabel(
                        linkCount === 1
                            ? "Link Gamepass Roblox của bạn"
                            : `Link Gamepass #${i} (250 Robux)`,
                    )
                    .setPlaceholder("https://www.roblox.com/game-pass/...")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
    }

    const accountRow = new ActionRowBuilder().addComponents(
        new TextInputBuilder()
            .setCustomId("account_name")
            .setLabel("Tên tài khoản Roblox của bạn")
            .setPlaceholder("Nhập username Roblox...")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
    );

    return new ModalBuilder()
        .setCustomId(`rb:gamepass_modal:${sessionId}`)
        .setTitle(
            `Mua ${pkg.robux.toLocaleString()} Robux — ${pkg.price.toLocaleString("vi-VN")}đ`,
        )
        .addComponents(...gamepaxRows, accountRow);
}
