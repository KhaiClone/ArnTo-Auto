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
        .setName("hs-setup")
        .setDescription("Gửi panel Auto HypeSquad vào kênh hiện tại")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(client, interaction) {
        const s = client.configs.settings;
        const priceStr = s.hypeSquadPrice.toLocaleString("vi-VN");

        const embed = new EmbedBuilder()
            .setColor(client.funcs.hexToInt(client.configs.embed.color))
            .setTitle("Auto HypeSquad - Đổi badge HypeSquad")
            .setDescription(
                [
                    "Nhập token Discord để bot đổi badge HypeSquad cho bạn.",
                    "",
                    "**Quy trình:**",
                    "1) Bấm `Nhập token`",
                    "2) Chọn badge HypeSquad muốn đổi",
                    `3) Bot tạo QR thanh toán: **${priceStr}đ/lần**`,
                    "4) Thanh toán xong bot tự đổi badge ngay lập tức.",
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

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("hs:enter_token")
                .setLabel("Nhập token")
                .setStyle(ButtonStyle.Primary),
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        await interaction.editReply({
            content: "✅ Đã gửi panel HypeSquad vào kênh này.",
            ephemeral: true,
        });
    },
};
