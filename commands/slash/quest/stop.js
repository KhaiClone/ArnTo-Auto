const { SlashCommandBuilder } = require("discord.js");
const { getRunningMap, stopAccount } = require("../../../extensions/AutoQuest");
const { accountVars } = require("../../../functions/autoQuestHelpers");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("quest-stop")
        .setDescription("Dừng một account đang chạy")
        .addStringOption((o) =>
            o
                .setName("account_id")
                .setDescription("Discord ID cần dừng")
                .setRequired(true),
        ),
    async execute(client, interaction) {
        const accountId = interaction.options.getString("account_id", true);
        const entry = getRunningMap(interaction.user.id).get(accountId);
        if (!entry) return interaction.editReply(client.ui.message("auto.quest.cmd.stopNotFound", { accountId }));
        stopAccount(interaction.user.id, accountId);
        return interaction.editReply(
            client.ui.message("auto.quest.cmd.stopped", { account: accountVars(accountId, entry.username), user: client.ui.user(interaction.user) }),
        );
    },
};
