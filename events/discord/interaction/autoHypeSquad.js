/**
 * autoHypeSquad.js (interactionCreate event)
 * Handles all Auto HypeSquad interactions: buttons, select menus, modals.
 * All custom IDs are namespaced with "hs:" prefix.
 */

const {
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");

const { resolveDiscordAccount } = require("../../../extensions/AutoQuest");
const setHypeSquadBadge = require("../../../functions/setHypeSquadBadge");

// ── Constants ──────────────────────────────────────────────────────────────────

const EXPIRE_MS = 10 * 60 * 1000; // 10 minutes
const HS_DB = "hypesquad_payments";

const HOUSES = [
    {
        id: 1,
        name: "Bravery",
        emoji: "<:1_:1495429339959787582>",
        description: "House of Bravery",
    },
    {
        id: 2,
        name: "Brilliance",
        emoji: "<:2_:1495429363871514776>",
        description: "House of Brilliance",
    },
    {
        id: 3,
        name: "Balance",
        emoji: "<:3_:1495429264013660291>",
        description: "House of Balance",
    },
];

// ── Cache ──────────────────────────────────────────────────────────────────────
// Lưu token tạm thời để tránh lỗi customId dài quá 100 ký tự
const tokenCache = new Map();

// ── DB helpers ─────────────────────────────────────────────────────────────────

function _now() {
    return Date.now();
}
function _newPaymentId() {
    return `HS${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
function _randomTransferCode() {
    return `Badge${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`;
}

async function _readPayments(client) {
    return (await client.db.get(HS_DB)) ?? [];
}
async function _savePayments(client, list) {
    await client.db.set(HS_DB, list);
}

async function _generateUniqueCode(client) {
    const list = await _readPayments(client);
    const active = new Set(
        list
            .filter(
                (i) => i.status === "pending" && Number(i.expiresAt) > _now(),
            )
            .map((i) => i.transferCode),
    );
    for (let i = 0; i < 100; i++) {
        const code = _randomTransferCode();
        if (!active.has(code)) return code;
    }
    return `Badge${Date.now() % 100000}`;
}

async function _createPayment(client, { userId, token, houseId, houseName }) {
    const amount = client.configs.settings.hypeSquadPrice;
    const transferCode = await _generateUniqueCode(client);

    const payment = {
        id: _newPaymentId(),
        type: "hypesquad",
        userId,
        houseId,
        houseName,
        amount,
        transferCode,
        status: "pending",
        createdAt: _now(),
        expiresAt: _now() + EXPIRE_MS,
    };

    const list = await _readPayments(client);
    list.push(payment);
    await _savePayments(client, list);

    // Register with AutoBank
    if (client.autoBank) {
        const context = {
            _handler: "hs_payment",
            paymentId: payment.id,
            userId,
            token,
            houseId,
            houseName,
            transferCode,
        };

        client.autoBank.createQR(amount, transferCode, context, async (err) => {
            if (err) return; // timeout — cleanup handled by expireHsPayments
            await _markPaid(client, payment.id);
            await _runBadgeChange(client, context);
        });

        await client.db.create("autobank_pending", {
            customId: transferCode,
            amount,
            expireAt: payment.expiresAt,
            context,
        });
    }

    const qrUrl = _buildVietQrUrl(client, amount, transferCode);
    return { ...payment, qrUrl };
}

async function _markPaid(client, paymentId) {
    const list = await _readPayments(client);
    const idx = list.findIndex((i) => i.id === paymentId);
    if (idx < 0) return null;
    const paid = { ...list[idx], status: "paid" };
    list.splice(idx, 1); // remove immediately after paid
    await _savePayments(client, list);
    return paid;
}

async function _cancelPayment(client, paymentId) {
    const list = await _readPayments(client);
    const idx = list.findIndex((i) => i.id === paymentId);
    if (idx < 0) return null;
    const removed = list[idx];
    list.splice(idx, 1);
    await _savePayments(client, list);
    return removed;
}

async function _getOpenPendingPayment(client, userId) {
    return (
        (await _readPayments(client)).find(
            (i) =>
                i.status === "pending" &&
                Number(i.expiresAt) > _now() &&
                i.userId === userId,
        ) ?? null
    );
}

async function _getPaymentById(client, paymentId) {
    return (
        (await _readPayments(client)).find((i) => i.id === paymentId) ?? null
    );
}

function _buildVietQrUrl(client, amount, transferCode) {
    const s = client.configs.settings;
    return `https://img.vietqr.io/image/${s.bankCode}-${s.bankAccount}-qr_only.png?addInfo=${encodeURIComponent(transferCode)}&accountName=${encodeURIComponent(s.bankHolder)}&amount=${amount}`;
}

// ── Badge change logic ─────────────────────────────────────────────────────────

async function _runBadgeChange(client, context) {
    const { paymentId, userId, token, houseId, houseName } = context;

    const result = await setHypeSquadBadge(token, houseId);

    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;

    if (result.success) {
        await user
            .send({
                embeds: [
                    client.embed(
                        [
                            `Mã đơn: \`${paymentId}\``,
                            `Badge: **${houseName}**`,
                            "✅ Đã đổi badge HypeSquad thành công!",
                        ].join("\n"),
                        { title: "Đổi badge thành công", color: 0x57f287 },
                    ),
                ],
            })
            .catch(() => null);
    } else {
        await user
            .send({
                embeds: [
                    client.embed(
                        [
                            `Mã đơn: \`${paymentId}\``,
                            `Badge: **${houseName}**`,
                            `❌ Đổi badge thất bại: ${result.message}`,
                            "Vui lòng liên hệ admin để được hỗ trợ.",
                        ].join("\n"),
                        { title: "Đổi badge thất bại", color: 0xed4245 },
                    ),
                ],
            })
            .catch(() => null);
    }
}

// ── Payment embed builder ──────────────────────────────────────────────────────

function _buildPaymentEmbed(client, payment, note) {
    const s = client.configs.settings;
    const house = HOUSES.find((h) => h.id === payment.houseId);
    return {
        title: "Thanh toán HypeSquad",
        color: 0x5865f2,
        description: note || null,
        fields: [
            { name: "Mã đơn", value: `\`${payment.id}\``, inline: false },
            {
                name: "Badge",
                value: `${house?.emoji ?? ""} **${payment.houseName}**`,
                inline: true,
            },
            {
                name: "Tổng tiền",
                value: `\`${Number(payment.amount).toLocaleString("vi-VN")} VNĐ\``,
                inline: true,
            },
            {
                name: "Chủ tài khoản",
                value: `\`${s.bankHolder}\``,
                inline: false,
            },
            { name: "Ngân hàng", value: `\`${s.bankCode}\``, inline: true },
            {
                name: "Số tài khoản",
                value: `\`\`\`\n${s.bankAccount}\n\`\`\``,
                inline: false,
            },
            {
                name: "Nội dung chuyển khoản",
                value: `\`\`\`\n${payment.transferCode}\n\`\`\``,
                inline: false,
            },
        ],
        image:
            payment.status === "pending" && payment.qrUrl
                ? { url: payment.qrUrl }
                : null,
        footer: {
            text: "Bot tự kiểm tra qua VietQR webhook. Chuyển đúng nội dung.",
        },
        timestamp: new Date().toISOString(),
    };
}

function _buildCancelRow(paymentId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`hs:cancel_payment:${paymentId}`)
            .setLabel("Hủy đơn")
            .setStyle(ButtonStyle.Danger),
    );
}

// ── Event handler ──────────────────────────────────────────────────────────────

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

    // "Nhập token" button on the HypeSquad panel
    if (customId === "hs:enter_token") {
        return interaction.showModal(_buildTokenModal());
    }

    // "Hủy đơn" button
    if (customId.startsWith("hs:cancel_payment:")) {
        const paymentId = customId.split(":")[2];
        const payment = await _getPaymentById(client, paymentId);

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
        await _cancelPayment(client, paymentId);

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

    // Lấy sessionId từ customId và lấy token từ cache
    const sessionId = interaction.customId.split(":")[2];
    const token = tokenCache.get(sessionId);

    // Xử lý trường hợp token không tồn tại hoặc đã hết hạn trong cache
    if (!token) {
        return interaction.update({
            embeds: [
                client.embed(
                    "Phiên làm việc đã hết hạn hoặc token không tồn tại. Vui lòng bấm hủy đơn và nhập lại token.",
                    { title: "Lỗi phiên" },
                ),
            ],
            components: [],
        });
    }

    // Xóa token khỏi cache sau khi dùng xong để dọn dẹp bộ nhớ
    tokenCache.delete(sessionId);

    const houseId = parseInt(interaction.values[0]);
    const house = HOUSES.find((h) => h.id === houseId);
    if (!house) return;

    // Check if user already has a pending hs payment
    const existed = await _getOpenPendingPayment(client, interaction.user.id);
    if (existed) {
        return interaction.update({
            embeds: [
                _buildPaymentEmbed(
                    client,
                    existed,
                    "Bạn đã có đơn chờ thanh toán. Thanh toán hoặc chờ hết hạn để tạo đơn mới.",
                ),
            ],
            components: [_buildCancelRow(existed.id)],
        });
    }

    const payment = await _createPayment(client, {
        userId: interaction.user.id,
        token,
        houseId: house.id,
        houseName: house.name,
    });

    return interaction.update({
        embeds: [
            _buildPaymentEmbed(
                client,
                payment,
                `Đã tạo QR thanh toán để đổi badge **${house.emoji} ${house.name}**.`,
            ),
        ],
        components: [_buildCancelRow(payment.id)],
    });
}

// ── Modal handler ──────────────────────────────────────────────────────────────

async function _handleModal(client, interaction) {
    if (interaction.customId !== "hs:token_modal") return;

    const rawToken = interaction.fields.getTextInputValue("token");
    const token = client.funcs.normalizeDiscordTokenInput(rawToken);
    await interaction.deferReply({ ephemeral: true });

    // Validate token
    const resolved = await resolveDiscordAccount(token);
    if (!resolved.ok) {
        return interaction.editReply({
            embeds: [
                client.embed(resolved.reason, { title: "Token không hợp lệ" }),
            ],
        });
    }

    // Tạo session ID và lưu token vào cache
    const sessionId = Math.random().toString(36).slice(2, 12);
    tokenCache.set(sessionId, token);

    // Tự động xóa khỏi cache sau 15 phút nếu người dùng không chọn
    setTimeout(
        () => {
            tokenCache.delete(sessionId);
        },
        15 * 60 * 1000,
    );

    // Gắn session ID vào customId thay vì toàn bộ token
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

// ── UI helpers ─────────────────────────────────────────────────────────────────

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

// ── Exported helpers for ready.js ──────────────────────────────────────────────

module.exports.runBadgeChange = _runBadgeChange;
module.exports.markHsPaymentPaid = _markPaid;
