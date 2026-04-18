const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require("discord.js");

module.exports = {
    deferReply: {},
    data: new SlashCommandBuilder()
        .setName("setup")
        .setDescription("Gửi panel Auto Quest vào kênh hiện tại")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(client, interaction) {
        const s = client.configs.settings;
        const priceStr = s.questPricePerItem.toLocaleString("vi-VN");

        const embed = new EmbedBuilder()
            .setColor(client.funcs.hexToInt(client.configs.embed.color))
            .setTitle("Auto Quest - Tự động làm nhiệm vụ Discord")
            .setDescription(
                [
                    "Nhập token Discord để bot tự lấy quest khả dụng.",
                    "",
                    "**Quy trình:**",
                    "1) Bấm `Nhập token` (cách lấy token: <#1485326007308386556>)",
                    "2) Chọn quest (có thể chọn nhiều)",
                    `3) Bot tạo QR thanh toán: **${priceStr}đ/quest**`,
                    "4) Thanh toán xong bot tự chạy đúng quest đã chọn.",
                ].join("\n"),
            )
            .addFields(
                {
                    name: "⏱ Thời gian chờ QR",
                    value: "10 phút (quá thời gian sẽ hết hạn).",
                    inline: true,
                },
                {
                    name: "🏦 Thanh toán",
                    value: "Chuyển đúng mã nội dung để hệ thống tự xác nhận.",
                    inline: true,
                },
            );

        if (s.questPanelThumbUrl) embed.setThumbnail(s.questPanelThumbUrl);
        if (s.questPanelBannerUrl) embed.setImage(s.questPanelBannerUrl);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("quest:enter_token")
                .setLabel("Nhập token")
                .setStyle(ButtonStyle.Primary),
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        await interaction.editReply({
            content: "✅ Đã gửi panel vào kênh này.",
            ephemeral: true,
        });
    },
};
