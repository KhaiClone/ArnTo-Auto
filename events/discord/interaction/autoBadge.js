/**
 * autoBadge.js (interactionCreate event)
 * Handler mỏng — logic nằm ở extensions/AutoBadge.js và bên panel; mọi chữ ở
 * templates/badge.js (auto.badge.flow, auto.badge.payment).
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
    MessageFlags,
} = require("discord.js");

const PanelBadge = require("../../../extensions/PanelBadge");
const pricing = require("../../../functions/pricing");
const badgeLog = require("../../../functions/autoBadgeHelpers");
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

// Nhãn dùng chung với log đơn — một chỗ sửa, mọi nơi đổi theo.
const { UNIT_VI } = badgeLog;

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

/** Chữ của luồng mua (template auto.badge.flow). */
const flow = (client, vars = {}) => client.ui.card("auto.badge.flow", { user: null, ...vars });
const cut = (s, n, fallback) => (s || fallback).slice(0, n);

function _tokenModal(client) {
    const t = flow(client);
    return new ModalBuilder()
        .setCustomId("bg:token")
        .setTitle(cut(t.text("tokenTitle"), 45, "Auto Badge"))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("token")
                    .setLabel(cut(t.text("tokenLabel"), 45, "Token"))
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder(cut(t.text("tokenPlaceholder"), 100, " ")),
            ),
        );
}

async function _badgeSelect(client, sid) {
    const badges = await pricing.sellableBadges(client);
    if (!badges.length) return null;
    const t = flow(client);
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`bg:badge:${sid}`)
            .setPlaceholder(t.placeholder("badge") || "Badge")
            .addOptions(
                badges.map((b) => ({
                    emoji: emojis.badgeEmoji(b.key),
                    ...t.option("badge", { badge: { key: b.key, label: b.label, kind: b.kind, __text: b.label } }),
                    value: b.key,
                })),
            ),
    );
}

async function _tierSelect(client, sid, badgeKey, hasNitro, values, currentHouse) {
    const tiers = await pricing.badgeTiers(client, badgeKey, { hasNitro });
    if (!tiers.length) return null;

    const t = flow(client);
    const isChoice = tiers[0]?.kind === "choice";
    // Badge choice (HypeSquad): so theo nhà đang ở, đọc được cho mọi khách.
    // Badge tiered: so theo giá trị, chỉ biết được khi khách có Nitro.
    const owned = values?.[badgeKey]?.value ?? null;
    const options = tiers
        .map((tier) => {
            const already = isChoice
                ? currentHouse !== null && currentHouse === tier.houseId
                : owned !== null && tier.threshold != null && owned >= tier.threshold;
            const vars = {
                key: tier.key,
                name: tier.name,
                threshold: tier.threshold ?? null,
                unitText: UNIT_VI(tier.unit),
                price: tier.finalPrice,
                rarityName: tier.rarityName ?? "",
                isChoice,
                already,
                __text: tier.name,
            };
            return {
                emoji: emojis.tierEmoji(badgeKey, tier.key),
                ...t.option("tier", vars),
                value: tier.key,
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
            .setPlaceholder(t.placeholder("tier") || "Tier")
            .addOptions(options.slice(0, 25)),
    );
}

function _declareModal(client, sid, badgeKey, tierKey, unit) {
    const t = flow(client, { unitText: UNIT_VI(unit) });
    return new ModalBuilder()
        .setCustomId(`bg:declare:${sid}:${badgeKey}:${tierKey}`)
        .setTitle(cut(t.text("declareTitle"), 45, "Auto Badge"))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("value")
                    .setLabel(cut(t.text("declareLabel"), 45, "?"))
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder(cut(t.text("declarePlaceholder"), 100, " ")),
            ),
        );
}

/** Một câu của luồng mua, chỉ người bấm thấy; `edit` xoá embed/nút cũ của tin. */
const say = (client, slot, vars = {}, { edit = false } = {}) => ({
    content: flow(client, vars).text(slot),
    ...(edit ? { embeds: [], components: [] } : {}),
    flags: MessageFlags.Ephemeral,
});

// ── Tạo QR ───────────────────────────────────────────────────────────────────────

async function _startPayment(client, interaction, session, badgeKey, tierKey, declaredValue) {
    const q = await PanelBadge.quote({ token: session.token, badgeKey, tierKey });

    if (q.alreadyOwned === true) {
        return interaction.editReply(
            say(client, "alreadyOwned", {
                payment: badgeLog.paymentVars({ badgeKey, tierName: q.tierName, threshold: q.kind === "choice" ? null : q.threshold, unit: q.unit }),
                currentValue: q.currentValue,
            }),
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
    const warn = !(q.hasNitro || q.kind === "choice");

    return interaction.editReply({
        ...client.ui.message(
            "auto.badge.payment",
            { payment: badgeLog.paymentVars(payment, { expireMinutes: Math.round(EXPIRE_MS / 60000) }), warn },
            { buttons: { cancel: { customId: `bg:cancel:${payment.id}` } }, edit: true },
        ),
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
            const reply = say(client, "disabled");
            return interaction.replied || interaction.deferred
                ? interaction.editReply(reply)
                : interaction.reply(reply);
        }

        try {
            // ── Bấm nút bắt đầu ────────────────────────────────────────────────
            if (id === "bg:start") {
                const open = await getOpenPayment(client, interaction.user.id);
                if (open) return interaction.reply(say(client, "openPayment", { payment: badgeLog.paymentVars(open) }));
                return interaction.showModal(_tokenModal(client));
            }

            // ── Nhập token ─────────────────────────────────────────────────────
            if (id === "bg:token") {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const raw = interaction.fields.getTextInputValue("token");
                const token = normalizeToken(raw);
                if (!token) return interaction.editReply(say(client, "invalidToken"));

                const info = await PanelBadge.check({ token });
                const sid = _newSid();
                await _setSession(client, sid, {
                    token,
                    hasNitro: info.hasNitro,
                    values: info.values,
                    hypesquadHouse: info.hypesquadHouse ?? null,
                });

                const row = await _badgeSelect(client, sid);
                if (!row) return interaction.editReply(say(client, "noOffers"));

                return interaction.editReply({
                    ...say(client, "verified", { username: info.username, hasNitro: !!info.hasNitro }),
                    components: [row],
                });
            }

            // ── Chọn badge ─────────────────────────────────────────────────────
            if (id.startsWith("bg:badge:")) {
                await interaction.deferUpdate();
                const sid = id.split(":")[2];
                const session = await _getSession(client, sid);
                if (!session) return interaction.editReply(say(client, "sessionExpired"));
                const badgeKey = interaction.values[0];
                const row = await _tierSelect(
                    client,
                    sid,
                    badgeKey,
                    session.hasNitro,
                    session.values,
                    session.hypesquadHouse ?? null,
                );
                if (!row) return interaction.editReply({ ...say(client, "noTiersLeft"), components: [] });
                return interaction.editReply({ ...say(client, "chooseTier"), components: [row] });
            }

            // ── Chọn mốc ───────────────────────────────────────────────────────
            if (id.startsWith("bg:tier:")) {
                const [, , sid, badgeKey] = id.split(":");
                const session = await _getSession(client, sid);
                if (!session) return interaction.reply(say(client, "sessionExpired"));
                const tierKey = interaction.values[0];

                const tiers = await pricing.badgeTiers(client, badgeKey, {
                    hasNitro: session.hasNitro,
                });
                const tier = tiers.find((t) => t.key === tierKey);

                // Không Nitro + badge tiered: bắt khai trước, vì ta chưa đọc được
                // gì của họ. Badge choice thì đọc được miễn phí, khỏi hỏi.
                if (!session.hasNitro && tier?.kind !== "choice") {
                    return interaction.showModal(_declareModal(client, sid, badgeKey, tierKey, tier?.unit ?? "games"));
                }

                await interaction.deferUpdate();
                return _startPayment(client, interaction, session, badgeKey, tierKey, null);
            }

            // ── Khai tình trạng (không Nitro) ──────────────────────────────────
            if (id.startsWith("bg:declare:")) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const [, , sid, badgeKey, tierKey] = id.split(":");
                const session = await _getSession(client, sid);
                if (!session) return interaction.editReply(say(client, "sessionExpired"));
                const declared = Number(interaction.fields.getTextInputValue("value"));
                if (!Number.isFinite(declared) || declared < 0) return interaction.editReply(say(client, "invalidNumber"));
                return _startPayment(client, interaction, session, badgeKey, tierKey, declared);
            }

            // ── Huỷ đơn ────────────────────────────────────────────────────────
            if (id.startsWith("bg:cancel:")) {
                await interaction.deferUpdate();
                const paymentId = id.split(":")[2];
                const payment = await getPaymentById(client, paymentId);
                if (payment && payment.userId !== interaction.user.id) return;
                if (payment && payment.status !== "pending") return interaction.editReply(say(client, "paidNoCancel", {}, { edit: true }));
                await cancelPayment(client, paymentId);
                // cancelPayment xoá hẳn bản ghi, nên phải sửa log bằng bản đã đọc ở trên.
                if (payment) await badgeLog.updateOrderLog(client, payment, "cancelled", "Khách tự huỷ.");
                return interaction.editReply(say(client, "cancelled", {}, { edit: true }));
            }
        } catch (err) {
            const reply = err.tokenDead ? say(client, "tokenDead") : say(client, "error", { error: err.message });
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(reply).catch(() => null);
            } else {
                await interaction.reply(reply).catch(() => null);
            }
        }
    },
};
