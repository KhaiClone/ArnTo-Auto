const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require("discord.js");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("panel-setup")
        .setDescription("Set up the bot management panel")
        .setDefaultMemberPermissions(8), // Admin only
    async execute(client, interaction) {
        if (!client.autoPanel?.isConfigured) {
            return interaction.followUp({
                content:
                    "⚠️ Tích hợp Panel chưa được cấu hình. Vui lòng kiểm tra PANEL_API_URL và PANEL_API_KEY trong file .env.",
            });
        }

        const embed = new EmbedBuilder()
            .setTitle("🎮 TRUNG TÂM QUẢN LÝ BOT")
            .setDescription(
                "Chào mừng bạn đến với hệ thống quản lý bot tự động. Sử dụng các chức năng bên dưới để theo dõi và điều chỉnh bot của bạn một cách nhanh chóng.",
            )
            .setColor(0x5865f2)
            .setThumbnail(client.user.displayAvatarURL())
            .addFields(
                {
                    name: "📊 Trạng thái",
                    value: "Xem chi tiết thông số và tình trạng hoạt động.",
                    inline: true,
                },
                {
                    name: "⚙️ Quản lý",
                    value: "Bật, Tắt hoặc Khởi động lại bot của bạn.",
                    inline: true,
                },
                {
                    name: "⏳ Gia hạn",
                    value: "Kéo dài thời gian sử dụng bot.",
                    inline: true,
                },
                {
                    name: "🚀 Nâng cấp",
                    value: "Tăng dung lượng RAM để bot chạy mượt hơn.",
                    inline: true,
                },
            )
            .setFooter({
                text: "ArnTo Auto Tool • Hệ thống quản lý chuyên nghiệp",
                iconURL: client.user.displayAvatarURL(),
            })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("panel:status")
                .setLabel("Trạng thái")
                .setStyle(ButtonStyle.Secondary)
                .setEmoji("📊"),
            new ButtonBuilder()
                .setCustomId("panel:manage")
                .setLabel("Quản lý")
                .setStyle(ButtonStyle.Primary)
                .setEmoji("⚙️"),
            new ButtonBuilder()
                .setCustomId("panel:extend")
                .setLabel("Gia hạn")
                .setStyle(ButtonStyle.Success)
                .setEmoji("⏳"),
            new ButtonBuilder()
                .setCustomId("panel:upgrade")
                .setLabel("Nâng cấp")
                .setStyle(ButtonStyle.Danger)
                .setEmoji("🚀"),
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        return interaction.followUp({
            content: "✅ Đã thiết lập Panel quản lý thành công.",
            ephemeral: true,
        });
    },
};
