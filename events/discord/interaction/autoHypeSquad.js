/**
 * autoHypeSquad.js (interactionCreate event)
 * Thin interaction handler — all logic lives in extensions/AutoHypeSquad.js
 * All custom IDs are namespaced with "hs:" prefix.
 */

const {
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
} = require("discord.js");

const { resolveDiscordAccount } = require("../../../extensions/AutoQuest");
const {
    HOUSES,
    createHsPayment,
    cancelHsPayment,
    cancelHsOrderLog,
    getOpenHsPayment,
    getHsPaymentById,
    sendHsOrderLog,
    buildHsPaymentEmbed,
    buildHsCancelRow,
} = require("../../../extensions/AutoHypeSquad");

// DB key for persistent token sessions (survives restarts)
const HS_TOKEN_SESSIONS_DB = "hs_token_sessions";
const HS_TOKEN_SESSION_TTL = 15 * 60 * 1000; // 15 minutes

/** Read all active (non-expired) token sessions from DB */
async function _readTokenSessions(client) {
    return (await client.db.get(HS_TOKEN_SESSIONS_DB)) ?? [];
}

/** Persist token sessions to DB */
async function _saveTokenSessions(client, list) {
    await client.db.set(HS_TOKEN_SESSIONS_DB, list);
}

/** Store a token session, purging any already-expired sessions in the same pass */
async function _setTokenSession(client, sessionId, token) {
    const now = Date.now();
    const list = (await _readTokenSessions(client)).filter(
        (s) => s.expiresAt > now,
    );
    list.push({ sessionId, token, expiresAt: now + HS_TOKEN_SESSION_TTL });
    await _saveTokenSessions(client, list);
}

/** Retrieve and immediately delete a token session (one-shot use) */
async function _popTokenSession(client, sessionId) {
    const now = Date.now();
    const list = await _readTokenSessions(client);
    const idx = list.findIndex(
        (s) => s.sessionId === sessionId && s.expiresAt > now,
    );
    if (idx < 0) return null;
    const token = list[idx].token;
    list.splice(idx, 1);
    await _saveTokenSessions(client, list);
    return token;
}

module.exports = {
    name: "interactionCreate",
    async execute(client, interaction) {
        const id = interaction.customId ?? "";
        if (!id.startsWith("hs:")) return;
        if (!interaction.guild) return;

        try {
            if (interaction.isButton())
                return await _handleButton(client, interaction);
            if (interaction.isStringSelectMenu())
                return await _handleSelectMenu(client, interaction);
            if (interaction.isModalSubmit())
                return await _handleModal(client, interaction);
        } catch (err) {
            console.error("[autoHypeSquad interaction] error:", err);
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

    if (customId === "hs:enter_token") {
        return interaction.showModal(_buildTokenModal());
    }

    if (customId.startsWith("hs:cancel_payment:")) {
        const paymentId = customId.split(":")[2];
        const payment = await getHsPaymentById(client, paymentId);

        if (!payment)
            return interaction.reply({
                ephemeral: true,
                embeds: [
                    client.embed("Không tìm thấy đơn thanh toán.", {
                        title: "Lỗi",
                    }),
                ],
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
        await cancelHsPayment(client, paymentId);
        await cancelHsOrderLog(client, paymentId);

        const user = await client.users.fetch(payment.userId).catch(() => null);
        if (user)
            await user
                .send({
                    embeds: [
                        client.embed("", {
                            title: "Đã hủy đơn HypeSquad",
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
    if (!interaction.customId.startsWith("hs:select:")) return;

    const sessionId = interaction.customId.split(":")[2];
    const token = await _popTokenSession(client, sessionId);

    if (!token) {
        return interaction.update({
            embeds: [
                client.embed(
                    "Phiên làm việc đã hết hạn. Vui lòng nhập lại token.",
                    { title: "Lỗi phiên" },
                ),
            ],
            components: [],
        });
    }

    const houseId = parseInt(interaction.values[0]);
    const house = HOUSES.find((h) => h.id === houseId);
    if (!house) return;

    const existed = await getOpenHsPayment(client, interaction.user.id);
    if (existed) {
        return interaction.update({
            embeds: [
                buildHsPaymentEmbed(
                    client,
                    existed,
                    "Bạn đã có đơn chờ thanh toán. Thanh toán hoặc chờ hết hạn để tạo đơn mới.",
                ),
            ],
            components: [buildHsCancelRow(existed.id)],
        });
    }

    const payment = await createHsPayment(client, {
        userId: interaction.user.id,
        token,
        houseId: house.id,
        houseName: house.name,
    });

    // Send order log
    await sendHsOrderLog(
        client,
        payment.id,
        interaction.user.id,
        house.name,
        house.emoji,
    );

    return interaction.update({
        embeds: [
            buildHsPaymentEmbed(
                client,
                payment,
                `Đã tạo QR thanh toán để đổi badge **${house.emoji} ${house.name}**.`,
            ),
        ],
        components: [buildHsCancelRow(payment.id)],
    });
}

// ── Modal handler ──────────────────────────────────────────────────────────────

async function _handleModal(client, interaction) {
    if (interaction.customId !== "hs:token_modal") return;

    const token = client.funcs.normalizeDiscordTokenInput(
        interaction.fields.getTextInputValue("token"),
    );
    await interaction.deferReply({ ephemeral: true });

    const resolved = await resolveDiscordAccount(token);
    if (!resolved.ok) {
        return interaction.editReply({
            embeds: [
                client.embed(resolved.reason, { title: "Token không hợp lệ" }),
            ],
        });
    }

    const sessionId = Math.random().toString(36).slice(2, 12);
    await _setTokenSession(client, sessionId, token);

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`hs:select:${sessionId}`)
        .setPlaceholder("Chọn badge HypeSquad muốn đổi")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
            HOUSES.map((h) => ({
                label: h.name,
                emoji: h.emoji,
                value: String(h.id),
                description: h.description,
            })),
        );

    return interaction.editReply({
        embeds: [
            client.embed("", {
                title: "Chọn badge HypeSquad",
                color: 0x5865f2,
                fields: [
                    {
                        name: "Tài khoản",
                        value: resolved.username,
                        inline: true,
                    },
                    {
                        name: "ID",
                        value: `\`${resolved.accountId}\``,
                        inline: true,
                    },
                ],
                description: "Chọn badge HypeSquad bạn muốn đổi bên dưới:",
                timestamp: true,
            }),
        ],
        components: [new ActionRowBuilder().addComponents(menu)],
    });
}

function _buildTokenModal() {
    return new ModalBuilder()
        .setCustomId("hs:token_modal")
        .setTitle("Nhập token Discord")
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
