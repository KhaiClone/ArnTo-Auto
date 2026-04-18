const { SlashCommandBuilder } = require("discord.js");
const {
    getRunningMap,
    stopAllAccounts,
} = require("../../../extensions/AutoQuest");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("stopall")
        .setDescription("Dừng tất cả account đang chạy"),
    async execute(client, interaction) {
        const count = getRunningMap(interaction.user.id).size;
        if (count === 0)
            return interaction.editReply({
                embeds: [
                    client.embed("Không có account nào đang chạy.", {
                        color: 0xfee75c,
                    }),
                ],
            });
        stopAllAccounts(interaction.user.id);
        return interaction.editReply({
            embeds: [
                client.embed(`Đã dừng ${count} account.`, {
                    title: "Đã dừng tất cả",
                    color: 0xed4245,
                    timestamp: true,
                }),
            ],
        });
    },
};
