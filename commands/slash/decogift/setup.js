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
                content: dg.adminText(client, "setupMissing", { error: missing.map((m) => `\`${m}\``).join(", ") }),
            });
        }
        const message = await interaction.channel.send(dg.panelMessage(client));
        // The Embeds page can re-render every panel posted this way.
        await client.ui.track("auto.dg.panel", message);
        await interaction.editReply({ content: dg.adminText(client, "setupDone") });
    },
};
