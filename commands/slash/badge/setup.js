const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require("discord.js");

const pricing = require("../../../functions/pricing");

const UNIT_VI = (u) => (u === "hours" ? "giờ" : "game");
const fmt = (n) => Number(n).toLocaleString("vi-VN");

module.exports = {
    deferReply: {},
    data: new SlashCommandBuilder()
        .setName("badge-setup")
        .setDescription("Gửi panel Auto Badge Game vào kênh hiện tại")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(client, interaction) {
        const badges = await pricing.sellableBadges(client);
        if (!badges.length) {
            return interaction.editReply({
                content:
                    "Chưa có mốc nào mở bán. Vào trang `/pricing` của panel để đặt giá và bật Auto Badge.",
            });
        }

        // Giá hiển thị trên panel là giá gốc (khách có Nitro). Khách không Nitro
        // thấy giá đã phụ thu ở bước chọn mốc, sau khi bot biết token của họ.
        const fields = [];
        for (const b of badges) {
            const tiers = await pricing.badgeTiers(client, b.key, { hasNitro: true });
            fields.push({
                name: b.label + (b.kind === "choice" ? " — ăn ngay" : ""),
                value:
                    tiers
                        .map((t) =>
                            t.threshold == null
                                ? `\`${t.name}\` · **${fmt(t.finalPrice)}đ**`
                                : `\`${t.name}\` — ${fmt(t.threshold)} ${UNIT_VI(t.unit)} · **${fmt(t.finalPrice)}đ**`,
                        )
                        .join("\n") || "—",
                inline: false,
            });
        }

        const embed = new EmbedBuilder()
            .setColor(client.funcs.hexToInt(client.configs.embed.color))
            .setTitle("Auto Badge — badge Discord tự động")
            .setDescription(
                [
                    "**Game Time** (giờ chơi game) · **Game Variety** (số game đã chơi) · **HypeSquad** (đổi nhà).",
                    "",
                    "**Quy trình:**",
                    "1) Bấm `Mua badge` và dán token Discord",
                    "2) Chọn loại badge và mốc muốn đạt",
                    "3) Thanh toán qua QR",
                    "4) HypeSquad lên **ngay lập tức**; Game Time / Game Variety lên sau khoảng **1 ngày** — bot nhắn xác nhận khi xong",
                ].join("\n"),
            )
            .addFields(...fields)
            .addFields({
                name: "⚠️ Lưu ý quan trọng",
                value: [
                    "• **Game Time / Game Variety** chỉ hiển thị với người xem **có Nitro**. Không có Nitro thì bạn không tự nhìn thấy badge của mình — bot gửi thông tin xác minh thay.",
                    "• Hai badge đó: tài khoản **không có Nitro** phải tự khai tình trạng hiện tại và chịu phụ phí. Mua nhầm mốc **đã đạt từ trước** thì **không hoàn tiền**.",
                    "• **HypeSquad** thì ai cũng thấy, không phụ phí, không phải khai gì — bot đọc được nhà bạn đang ở và ẩn sẵn khỏi danh sách.",
                ].join("\n"),
                inline: false,
            });

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
