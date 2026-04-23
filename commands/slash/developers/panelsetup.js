const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("panelsetup")
        .setDescription("Set up the bot management panel")
        .setDefaultMemberPermissions(8), // Admin only
    async execute(interaction, client) {
        if (!client.autoPanel?.isConfigured) {
            return interaction.reply({
                content: "Panel integration is not configured. Please check PANEL_API_URL and PANEL_API_KEY in .env.",
                ephemeral: true,
            });
        }

        const embed = new EmbedBuilder()
            .setTitle("🎮 QUẢN LÝ BOT CỦA BẠN")
            .setDescription("Sử dụng các nút bên dưới để quản lý, gia hạn, hoặc nâng cấp cấu hình cho bot của bạn.")
            .setColor(0x5865F2)
            .addFields(
                { name: "Manage", value: "Bật, Tắt, hoặc Khởi động lại bot.", inline: true },
                { name: "Extend", value: "Gia hạn thời gian hoạt động của bot.", inline: true },
                { name: "Upgrade", value: "Nâng cấp dung lượng RAM cho bot.", inline: true }
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("panel:manage")
                .setLabel("Manage")
                .setStyle(ButtonStyle.Primary)
                .setEmoji("⚙️"),
            new ButtonBuilder()
                .setCustomId("panel:extend")
                .setLabel("Extend")
                .setStyle(ButtonStyle.Success)
                .setEmoji("⏳"),
            new ButtonBuilder()
                .setCustomId("panel:upgrade")
                .setLabel("Upgrade")
                .setStyle(ButtonStyle.Danger)
                .setEmoji("🚀")
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "Panel setup successfully.", ephemeral: true });
    },
};
