const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require("discord.js");

const pricing = require("../../../functions/pricing");
const emojis = require("../../../configs/badgeEmojis");

// Ảnh banner của panel. Để trống thì embed không có ảnh.
const BANNER_URL = process.env.BADGE_PANEL_IMAGE || "";

const UNIT_VI = (u) => (u === "hours" ? "giờ" : u === "house" ? "nhà" : "game");
const fmt = (n) => Number(n).toLocaleString("vi-VN");

const BADGE_TITLE = {
    game_time: "Game Time - Giờ chơi game",
    game_variety: "Game Variety - Số game đã chơi",
    hypesquad: "HypeSquad - Đổi nhà",
};

module.exports = {
    deferReply: {},
    data: new SlashCommandBuilder()
        .setName("badge-setup")
        .setDescription("Gửi panel Auto Badge vào kênh hiện tại")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(client, interaction) {
        const badges = await pricing.sellableBadges(client);
        if (!badges.length) {
            return interaction.editReply({
                content:
                    "Chưa có mốc nào mở bán. Vào trang `/pricing` của panel để đặt giá và bật Auto Badge.",
            });
        }

        // Giá hiển thị là giá gốc (khách có Nitro). Khách không Nitro thấy giá đã
        // phụ thu ở bước chọn mốc, sau khi bot biết token của họ.
        const lines = [];
        // Cùng một emoji hai bên tiêu đề, như panel Gift Badge.
        const crown = emojis.badgeTag(badges[0].key);
        lines.push(`# ${crown} Auto Badge Discord ${crown}`);

        for (const b of badges) {
            const tiers = await pricing.badgeTiers(client, b.key, { hasNitro: true });
            if (!tiers.length) continue;
            lines.push(`### ${emojis.badgeTag(b.key)} ${BADGE_TITLE[b.key] ?? b.label}`);
            for (const t of tiers) {
                const icon = emojis.tierTag(b.key, t.key);
                // Giữ nhịp hai chỗ in đậm như mẫu (tên - giá); mốc để thường.
                const amount =
                    t.threshold == null ? "" : ` - ${fmt(t.threshold)} ${UNIT_VI(t.unit)}`;
                lines.push(
                    `- ${icon} **${t.name}**${amount} - **${fmt(t.finalPrice)} VNĐ**`.replace(
                        /\s{2,}/g,
                        " ",
                    ),
                );
            }
        }

        const hasTiered = badges.some((b) => b.kind !== "choice");
        const hasChoice = badges.some((b) => b.kind === "choice");

        lines.push("### ⚠️ Lưu ý ⚠️");
        if (hasTiered) {
            lines.push(
                "- **Game Time** và **Game Variety** chỉ người xem có **Nitro** mới thấy.",
                "- Acc không Nitro: tự khai mốc đang có, chịu phụ phí. Mua mốc **đã đạt rồi** thì **không hoàn tiền**.",
                "- Badge lên sau **~1 ngày** (chu kỳ của Discord). Bot nhắn ngay khi gửi xong.",
            );
        }
        if (hasChoice) {
            lines.push("- **HypeSquad**: ai cũng thấy, không phụ phí, **ăn ngay**.");
        }
        lines.push(
            "- Cách lấy token: <#1485326007308386556>",
            "### Liên hệ trực tiếp với shop qua <#1246028759597846650>",
        );

        const embed = new EmbedBuilder()
            .setColor(client.funcs.hexToInt(client.configs.embed.color))
            .setDescription(lines.join("\n"));
        if (BANNER_URL) embed.setImage(BANNER_URL);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("bg:start")
                .setLabel("Mua badge")
                .setStyle(ButtonStyle.Success),
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        return interaction.editReply({ content: "Đã gửi panel Auto Badge." });
    },
};
