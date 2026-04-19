const { SlashCommandBuilder } = require("discord.js");
const {
    getRunningMap,
    stopAccount,
    removeStoredAccount,
} = require("../../../extensions/AutoQuest");

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
        if (!removed)
            return interaction.editReply({
                embeds: [
                    client.embed(
                        `Không tìm thấy account \`${accountId}\` trong storage.`,
                    ),
                ],
            });
        return interaction.editReply({
            embeds: [
                client.embed("", {
                    title: "Đã xóa account",
                    color: 0xed4245,
                    fields: [
                        {
                            name: "Tài khoản",
                            value: removed.username,
                            inline: true,
                        },
                        { name: "ID", value: `\`${accountId}\``, inline: true },
                    ],
                    timestamp: true,
                }),
            ],
        });
    },
};
