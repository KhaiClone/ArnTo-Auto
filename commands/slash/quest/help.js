const { SlashCommandBuilder } = require("discord.js");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("quest-help")
        .setDescription("Hướng dẫn sử dụng bot"),
    async execute(client, interaction) {
        return interaction.editReply(client.ui.message("auto.quest.cmd.help", { user: client.ui.user(interaction.user) }));
    },
};
