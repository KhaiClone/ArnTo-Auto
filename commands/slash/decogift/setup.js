const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const dg = require("../../../extensions/AutoDecoGift");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("dg-setup")
        .setDescription("Gửi panel mua Deco Gift vào kênh hiện tại")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(client, interaction) {
        const missing = dg.missingConfig(client);
        if (missing.length) {
            return interaction.editReply({
                content: `Deco Gift chưa bật được — thiếu trong .env: ${missing.map((m) => `\`${m}\``).join(", ")}.`,
            });
        }
        await interaction.channel.send(dg.panelMessage(client));
        await interaction.editReply({ content: "✅ Đã gửi panel Deco Gift vào kênh này." });
    },
};
