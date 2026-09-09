/**
 * autoBadge.js (interactionCreate event)
 * Handler mỏng — logic nằm ở extensions/AutoBadge.js và bên panel.
 * Mọi customId có tiền tố "bg:".
 *
 * LUỒNG
 *   bg:start                        → modal nhập token
 *   bg:token (modal)                → check token, lưu session, hiện chọn badge
 *   bg:badge:<sid>                  → hiện chọn mốc, giá đã áp hệ số Nitro
 *   bg:tier:<sid>:<badgeKey>        → có Nitro: ra QR luôn
 *                                     không Nitro: modal bắt khai số hiện tại
 *   bg:declare:<sid>:<bk>:<tk>      → ra QR
 *   bg:cancel:<paymentId>           → huỷ
 *
 * Token đi qua session lưu trong DB (không nhét vào customId — customId hiện ra
 * trong devtools của client và bị log lại).
 */

const {
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");

const PanelBadge = require("../../../extensions/PanelBadge");
const pricing = require("../../../functions/pricing");
const {
    createPayment,
    cancelPayment,
    getOpenPayment,
    getPaymentById,
    EXPIRE_MS,
    SESSIONS_DB,
    SESSION_TTL,
} = require("../../../extensions/AutoBadge");
const normalizeToken = require("../../../functions/normalizeDiscordTokenInput");
const emojis = require("../../../configs/badgeEmojis");

const UNIT_VI = (u) =>
    u === "hours" ? "giờ" : u === "house" ? "nhà" : "game";
const fmt = (n) => Number(n).toLocaleString("vi-VN");
const BADGE_VI = (k) =>
    ({
        game_time: "Game Time",
        game_variety: "Game Variety",
        hypesquad: "HypeSquad",
        streaming: "Streaming",
    })[k] ?? k;

// ── Session token ────────────────────────────────────────────────────────────────

async function _setSession(client, sid, data) {
    const now = Date.now();
    const list = ((await client.db.get(SESSIONS_DB)) ?? []).filter((s) => s.expiresAt > now);
    list.push({ sid, ...data, expiresAt: now + SESSION_TTL });
    await client.db.set(SESSIONS_DB, list);
}

async function _getSession(client, sid) {
    const now = Date.now();
    const list = (await client.db.get(SESSIONS_DB)) ?? [];
    return list.find((s) => s.sid === sid && s.expiresAt > now) ?? null;
}

const _newSid = () => Math.random().toString(36).slice(2, 10);

// ── Dựng UI ──────────────────────────────────────────────────────────────────────

function _tokenModal() {
    return new ModalBuilder()
        .setCustomId("bg:token")
        .setTitle("Auto Badge — nhập token")
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("token")
                    .setLabel("Token Discord của bạn")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder("Dán token vào đây"),
            ),
        );
}

async function _badgeSelect(client, sid, hasNitro) {
    const badges = await pricing.sellableBadges(client);
    if (!badges.length) return null;
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`bg:badge:${sid}`)
            .setPlaceholder("Chọn loại badge")
            .addOptions(
                badges.map((b) => ({
                    label: b.label,
                    value: b.key,
                    emoji: emojis.badgeEmoji(b.key),
                    description:
                        b.key === "game_time"
                            ? "Số giờ chơi game tích luỹ"
                            : b.key === "game_variety"
                              ? "Số lượng game đã chơi"
                              : b.key === "hypesquad"
                                ? "Đổi nhà HypeSquad — ăn ngay"
                                : b.label,
                })),
            ),
    );
}

async function _tierSelect(client, sid, badgeKey, hasNitro, values, currentHouse) {
    const tiers = await pricing.badgeTiers(client, badgeKey, { hasNitro });
    if (!tiers.length) return null;

    const isChoice = tiers[0]?.kind === "choice";
    // Badge choice (HypeSquad): so theo nhà đang ở, đọc được cho mọi khách.
    // Badge tiered: so theo giá trị, chỉ biết được khi khách có Nitro.
    const owned = values?.[badgeKey]?.value ?? null;
    const options = tiers
        .map((t) => {
            const already = isChoice
                ? currentHouse !== null && currentHouse === t.houseId
                : owned !== null && t.threshold != null && owned >= t.threshold;
            return {
                label: isChoice
                    ? t.name
                    : `${t.name} — ${fmt(t.threshold)} ${UNIT_VI(t.unit)}`,
                value: t.key,
                emoji: emojis.tierEmoji(badgeKey, t.key),
                description: already
                    ? isChoice
                        ? "Bạn đang ở nhà này rồi"
                        : "Bạn đã đạt mốc này rồi"
                    : `${fmt(t.finalPrice)}đ · ${t.rarityName}`,
                // Ẩn thứ khách đã có — mua nhầm là tiền vứt đi.
                _skip: already,
            };
        })
        .filter((o) => !o._skip)
        .map(({ _skip, ...o }) => o);

    if (!options.length) return null;
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`bg:tier:${sid}:${badgeKey}`)
            .setPlaceholder("Chọn mốc muốn mua")
            .addOptions(options.slice(0, 25)),
    );
}

function _declareModal(sid, badgeKey, tierKey, unit) {
    return new ModalBuilder()
        .setCustomId(`bg:declare:${sid}:${badgeKey}:${tierKey}`)
        .setTitle("Khai tình trạng hiện tại")
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("value")
                    .setLabel(`Bạn đang có bao nhiêu ${UNIT_VI(unit)}?`)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder("Không rõ thì ghi 0"),
            ),
        );
}

function _paymentEmbed(client, payment) {
    return new EmbedBuilder()
        .setColor(client.funcs.hexToInt(client.configs.embed.color))
        .setTitle("Thanh toán Auto Badge")
        .setImage(payment.qrUrl)
        .setDescription(
            [
                `**Badge:** ${BADGE_VI(payment.badgeKey)}`,
                payment.threshold == null
                    ? `**Lựa chọn:** ${payment.tierName}`
                    : `**Mốc:** ${payment.tierName} — ${fmt(payment.threshold)} ${UNIT_VI(payment.unit)}`,
                `**Số tiền:** ${fmt(payment.amount)}đ`,
                `**Nội dung CK:** \`${payment.transferCode}\``,
                "",
                `QR hết hạn sau ${Math.round(EXPIRE_MS / 60000)} phút.`,
            ].join("\n"),
        )
        .setFooter({ text: `Mã đơn: ${payment.id}` });
}

function _cancelRow(paymentId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`bg:cancel:${paymentId}`)
            .setLabel("Huỷ đơn")
            .setStyle(ButtonStyle.Danger),
    );
}

const _ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

// ── Tạo QR ───────────────────────────────────────────────────────────────────────

async function _startPayment(client, interaction, session, badgeKey, tierKey, declaredValue) {
    const q = await PanelBadge.quote({ token: session.token, badgeKey, tierKey });

    if (q.alreadyOwned === true) {
        return interaction.editReply(
            _ephemeral(
                q.kind === "choice"
                    ? `❌ Tài khoản của bạn **đang ở nhà ${q.tierName}** rồi. Hãy chọn nhà khác.`
                    : `❌ Tài khoản của bạn **đã đạt mốc ${q.tierName}** rồi ` +
                      `(${fmt(q.currentValue)}/${fmt(q.threshold)} ${UNIT_VI(q.unit)}). Hãy chọn mốc cao hơn.`,
            ),
        );
    }

    const payment = await createPayment(client, {
        userId: interaction.user.id,
        token: session.token,
        badgeKey,
        tierKey,
        tierName: q.tierName,
        unit: q.unit,
        threshold: q.threshold,
        amount: q.price,
        hasNitro: q.hasNitro,
        declaredValue,
    });

    // Chỉ badge tiered mới có thể "mua nhầm mốc đã có". HypeSquad đọc được nhà
    // hiện tại miễn phí nên không bao giờ rơi vào tình huống đó.
    const warn =
        q.hasNitro || q.kind === "choice"
            ? ""
            : "\n\n⚠️ Sau khi thanh toán, hệ thống sẽ kiểm tra tài khoản của bạn. " +
              "**Nếu bạn đã đạt mốc này từ trước, số tiền đã chuyển sẽ không được hoàn lại.**";

    return interaction.editReply({
        content: warn || null,
        embeds: [_paymentEmbed(client, payment)],
        components: [_cancelRow(payment.id)],
        flags: MessageFlags.Ephemeral,
    });
}

// ── Event ────────────────────────────────────────────────────────────────────────

module.exports = {
    name: "interactionCreate",
    async execute(client, interaction) {
        const id = interaction.customId;
        if (!id || !id.startsWith("bg:")) return;

        if (!PanelBadge.isEnabled()) {
            const reply = _ephemeral("Auto Badge hiện chưa được bật.");
            return interaction.replied || interaction.deferred
                ? interaction.editReply(reply)
                : interaction.reply(reply);
        }

        try {
            // ── Bấm nút bắt đầu ────────────────────────────────────────────────
            if (id === "bg:start") {
                const open = await getOpenPayment(client, interaction.user.id);
                if (open) {
                    return interaction.reply(
                        _ephemeral(
                            `Bạn đang có một đơn chờ thanh toán (\`${open.id}\`). ` +
                                `Hãy thanh toán hoặc huỷ nó trước.`,
                        ),
                    );
                }
                return interaction.showModal(_tokenModal());
            }

            // ── Nhập token ─────────────────────────────────────────────────────
            if (id === "bg:token") {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const raw = interaction.fields.getTextInputValue("token");
                const token = normalizeToken(raw);
                if (!token) return interaction.editReply(_ephemeral("Token không hợp lệ."));

                const info = await PanelBadge.check({ token });
                const sid = _newSid();
                await _setSession(client, sid, {
                    token,
                    hasNitro: info.hasNitro,
                    values: info.values,
                    hypesquadHouse: info.hypesquadHouse ?? null,
                });

                const row = await _badgeSelect(client, sid, info.hasNitro);
                if (!row) return interaction.editReply(_ephemeral("Hiện chưa có mốc nào mở bán."));

                const note = info.hasNitro
                    ? "Tài khoản có Nitro — hệ thống đọc được tiến độ của bạn và đã ẩn những mốc bạn đã đạt."
                    : "Tài khoản không có Nitro — giá có phụ thu, và bạn sẽ cần tự khai tình trạng hiện tại.";

                return interaction.editReply({
                    content: `Đã xác thực **${info.username}**.\n${note}`,
                    components: [row],
                    flags: MessageFlags.Ephemeral,
                });
            }

            // ── Chọn badge ─────────────────────────────────────────────────────
            if (id.startsWith("bg:badge:")) {
                await interaction.deferUpdate();
                const sid = id.split(":")[2];
                const session = await _getSession(client, sid);
                if (!session) {
                    return interaction.editReply(
                        _ephemeral("Phiên đã hết hạn. Bấm lại nút để bắt đầu."),
                    );
                }
                const badgeKey = interaction.values[0];
                const row = await _tierSelect(
                    client,
                    sid,
                    badgeKey,
                    session.hasNitro,
                    session.values,
                    session.hypesquadHouse ?? null,
                );
                if (!row) {
                    return interaction.editReply({
                        content: "Không còn mốc nào bạn chưa đạt cho badge này.",
                        components: [],
                        flags: MessageFlags.Ephemeral,
                    });
                }
                return interaction.editReply({
                    content: "Chọn mốc bạn muốn mua:",
                    components: [row],
                    flags: MessageFlags.Ephemeral,
                });
            }

            // ── Chọn mốc ───────────────────────────────────────────────────────
            if (id.startsWith("bg:tier:")) {
                const [, , sid, badgeKey] = id.split(":");
                const session = await _getSession(client, sid);
                if (!session) {
                    return interaction.reply(
                        _ephemeral("Phiên đã hết hạn. Bấm lại nút để bắt đầu."),
                    );
                }
                const tierKey = interaction.values[0];

                const tiers = await pricing.badgeTiers(client, badgeKey, {
                    hasNitro: session.hasNitro,
                });
                const tier = tiers.find((t) => t.key === tierKey);

                // Không Nitro + badge tiered: bắt khai trước, vì ta chưa đọc được
                // gì của họ. Badge choice thì đọc được miễn phí, khỏi hỏi.
                if (!session.hasNitro && tier?.kind !== "choice") {
                    return interaction.showModal(
                        _declareModal(sid, badgeKey, tierKey, tier?.unit ?? "games"),
                    );
                }

                await interaction.deferUpdate();
                return _startPayment(client, interaction, session, badgeKey, tierKey, null);
            }

            // ── Khai tình trạng (không Nitro) ──────────────────────────────────
            if (id.startsWith("bg:declare:")) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const [, , sid, badgeKey, tierKey] = id.split(":");
                const session = await _getSession(client, sid);
                if (!session) {
                    return interaction.editReply(
                        _ephemeral("Phiên đã hết hạn. Bấm lại nút để bắt đầu."),
                    );
                }
                const declared = Number(interaction.fields.getTextInputValue("value"));
                if (!Number.isFinite(declared) || declared < 0) {
                    return interaction.editReply(_ephemeral("Vui lòng nhập một số hợp lệ."));
                }
                return _startPayment(client, interaction, session, badgeKey, tierKey, declared);
            }

            // ── Huỷ đơn ────────────────────────────────────────────────────────
            if (id.startsWith("bg:cancel:")) {
                await interaction.deferUpdate();
                const paymentId = id.split(":")[2];
                const payment = await getPaymentById(client, paymentId);
                if (payment && payment.userId !== interaction.user.id) return;
                if (payment && payment.status !== "pending") {
                    return interaction.editReply({
                        content: "Đơn này đã được thanh toán, không huỷ được.",
                        embeds: [],
                        components: [],
                        flags: MessageFlags.Ephemeral,
                    });
                }
                await cancelPayment(client, paymentId);
                return interaction.editReply({
                    content: "Đã huỷ đơn.",
                    embeds: [],
                    components: [],
                    flags: MessageFlags.Ephemeral,
                });
            }
        } catch (err) {
            const msg = err.tokenDead
                ? "Token không hợp lệ hoặc đã chết."
                : `Lỗi: ${err.message}`;
            const reply = _ephemeral(msg);
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(reply).catch(() => null);
            } else {
                await interaction.reply(reply).catch(() => null);
            }
        }
    },
};
