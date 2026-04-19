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
        .setName("quest-setup")
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

        embed.setThumbnail(
            "https://cdn.discordapp.com/attachments/1245991899450572912/1472842442083532922/1771223400597.png?ex=69e51f2a&is=69e3cdaa&hm=5cd91378b2cb945d82504bede11e04f1aa633510668895d7202b5adb19fe3937&",
        );
        embed.setImage(
            "https://cdn.discordapp.com/attachments/1245991899450572912/1495136698206785597/1776538764448.png?ex=69e5260f&is=69e3d48f&hm=daaf336b476311fe623beaa951ade085c33336ef2c403252bd85b93fc586b23b&",
        );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("quest:enter_token")
                .setLabel("Nhập token")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId("quest:check_token")
                .setLabel("Kiểm tra")
                .setStyle(ButtonStyle.Primary),
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        await interaction.editReply({
            content: "✅ Đã gửi panel vào kênh này.",
            ephemeral: true,
        });
    },
};
