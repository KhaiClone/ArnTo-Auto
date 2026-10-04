const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { questPanelMessage } = require("../../../functions/autoQuestHelpers");

module.exports = {
    deferReply: {},
    data: new SlashCommandBuilder()
        .setName("quest-setup")
        .setDescription("Gửi panel Auto Quest vào kênh hiện tại")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(client, interaction) {
        // Template auto.quest.panel; prices from the panel (/pricing), falling back to .env.
        const message = await interaction.channel.send(await questPanelMessage(client));
        // The Embeds page can re-render every panel posted this way.
        await client.ui.track("auto.quest.panel", message);
        await interaction.editReply(client.ui.message("auto.quest.cmd.setupDone"));
    },
};
