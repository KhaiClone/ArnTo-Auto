const {
    SlashCommandBuilder,
    PermissionFlagsBits,
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
        const monthlyStr = s.monthlyQuestPrice.toLocaleString("vi-VN");

        const embed = new EmbedBuilder()
            .setColor(client.funcs.hexToInt(client.configs.embed.color))
            .setTitle("Auto Quest - Tự động làm nhiệm vụ Discord")
            .setDescription(
                [
                    "Chọn loại dịch vụ trong menu bên dưới để bắt đầu.",
                    `Cách lấy token: <#1485326007308386556>`,
                ].join("\n"),
            )
            .addFields(
                {
                    name: "⚡ Quest lẻ - done nhanh",
                    value: [
                        `Chọn số quest cần làm, trả **${priceStr}đ/quest**.`,
                        "Bot chạy đúng số quest bạn đã chọn rồi dừng.",
                    ].join("\n"),
                    inline: false,
                },
                {
                    name: "♾️ Quest tháng - bot tự động",
                    value: [
                        `Trả **${monthlyStr}đ/tháng**, không giới hạn số quest.`,
                        "Bot tự làm **toàn bộ** quest trên account theo lịch **Thứ 3 & Thứ 7** hằng tuần, xong quest nào báo về DM.",
                    ].join("\n"),
                    inline: false,
                },
                {
                    name: "📊 Kiểm tra trạng thái",
                    value: "Xem tất cả account bạn đã nhập: loại gói, thời hạn, tình trạng token, quest đang chạy.",
                    inline: false,
                },
                {
                    name: "⏱ Lưu ý thanh toán",
                    value: "QR có hạn 10 phút. Chuyển **đúng nội dung** để hệ thống tự xác nhận.",
                    inline: false,
                },
            );

        embed.setThumbnail(
            "https://cdn.discordapp.com/attachments/1245991899450572912/1472842442083532922/1771223400597.png?ex=69e51f2a&is=69e3cdaa&hm=5cd91378b2cb945d82504bede11e04f1aa633510668895d7202b5adb19fe3937&",
        );
        embed.setImage(
            "https://cdn.discordapp.com/attachments/1245991899450572912/1495136698206785597/1776538764448.png?ex=69e5260f&is=69e3d48f&hm=daaf336b476311fe623beaa951ade085c33336ef2c403252bd85b93fc586b23b&",
        );

        const {
            buildQuestPanelComponents,
        } = require("../../../functions/autoQuestHelpers");

        await interaction.channel.send({
            embeds: [embed],
            components: buildQuestPanelComponents(),
        });
        await interaction.editReply({
            content: "✅ Đã gửi panel vào kênh này.",
            ephemeral: true,
        });
    },
};
