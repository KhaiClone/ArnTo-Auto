const { SlashCommandBuilder } = require("discord.js");
const {
    getRunningMap,
    stopAllAccounts,
} = require("../../../extensions/AutoQuest");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("quest-stopall")
        .setDescription("Dừng tất cả account đang chạy"),
    async execute(client, interaction) {
        const count = getRunningMap(interaction.user.id).size;
        if (count === 0) return interaction.editReply(client.ui.message("auto.quest.cmd.stopAllNone"));
        stopAllAccounts(interaction.user.id);
        return interaction.editReply(client.ui.message("auto.quest.cmd.stoppedAll", { count }));
    },
};
