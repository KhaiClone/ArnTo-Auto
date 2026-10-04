const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const pricing = require("../../../functions/pricing");
const emojis = require("../../../configs/badgeEmojis");
const { UNIT_VI } = require("../../../functions/autoBadgeHelpers");

// Ảnh banner của panel. Để trống thì embed không có ảnh.
const BANNER_URL = process.env.BADGE_PANEL_IMAGE || "";

const BADGE_TITLE = {
    game_time: "Game Time - Giờ chơi game",
    game_variety: "Game Variety - Số game đã chơi",
    hypesquad: "HypeSquad - Đổi nhà",
};

/** Các badge đang bán, kèm mốc (type badgeOffer[]). Badge không còn mốc nào thì bỏ. */
async function offers(client) {
    const out = [];
    for (const b of await pricing.sellableBadges(client)) {
        // Giá hiển thị là giá gốc (khách có Nitro). Khách không Nitro thấy giá đã
        // phụ thu ở bước chọn mốc, sau khi bot biết token của họ.
        const tiers = await pricing.badgeTiers(client, b.key, { hasNitro: true });
        if (!tiers.length) continue;
        out.push({
            key: b.key,
            title: BADGE_TITLE[b.key] ?? b.label,
            label: b.label,
            tag: emojis.badgeTag(b.key),
            kind: b.kind,
            tiers: tiers.map((t) => ({
                key: t.key,
                name: t.name,
                tag: emojis.tierTag(b.key, t.key),
                threshold: t.threshold ?? null,
                unitText: UNIT_VI(t.unit),
                price: t.finalPrice,
                rarityName: t.rarityName ?? "",
                isChoice: t.kind === "choice",
                already: false,
                __text: t.name,
            })),
            __text: b.label,
        });
    }
    return out;
}

/** Panel Auto Badge (template auto.badge.panel) — cũng là thứ "cập nhật panel đã gửi" dựng lại. */
async function panel(client, badges) {
    badges ??= await offers(client);
    return client.ui.message(
        "auto.badge.panel",
        {
            badges,
            // Cùng một emoji hai bên tiêu đề, như panel Gift Badge.
            crown: badges[0]?.tag ?? "",
            hasTiered: badges.some((b) => b.kind !== "choice"),
            hasChoice: badges.some((b) => b.kind === "choice"),
            banner: BANNER_URL || null,
        },
        { buttons: { start: { customId: "bg:start" } } },
    );
}

module.exports = {
    panel,
    deferReply: {},
    data: new SlashCommandBuilder()
        .setName("badge-setup")
        .setDescription("Gửi panel Auto Badge vào kênh hiện tại")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(client, interaction) {
        const cmd = client.ui.card("auto.badge.cmd");
        const badges = await offers(client);
        if (!badges.length) return interaction.editReply({ content: cmd.text("noOffers") });

        const message = await interaction.channel.send(await panel(client, badges));
        await client.ui.track("auto.badge.panel", message);
        return interaction.editReply({ content: cmd.text("setupDone") });
    },
};
