const { SlashCommandBuilder } = require("discord.js");
const {
    stopAccount,
    removeStoredAccount,
} = require("../../../extensions/AutoQuest");
const { accountVars } = require("../../../functions/autoQuestHelpers");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("quest-removeaccount")
        .setDescription("Xóa account đã lưu")
        .addStringOption((o) =>
            o
                .setName("account_id")
                .setDescription("Discord ID cần xóa")
                .setRequired(true),
        ),
    async execute(client, interaction) {
        const accountId = interaction.options.getString("account_id", true);
        const removed = await removeStoredAccount(
            client,
            interaction.user.id,
            accountId,
        );
        stopAccount(interaction.user.id, accountId);
        if (!removed) return interaction.editReply(client.ui.message("auto.quest.cmd.removeNotFound", { accountId }));
        return interaction.editReply(
            client.ui.message("auto.quest.cmd.removed", { account: accountVars(accountId, removed.username), user: client.ui.user(interaction.user) }),
        );
    },
};
