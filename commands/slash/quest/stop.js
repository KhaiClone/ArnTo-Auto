const { SlashCommandBuilder } = require("discord.js");
const { getRunningMap, stopAccount } = require("../../../extensions/AutoQuest");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("stop")
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
        if (!entry)
            return interaction.editReply({
                embeds: [
                    client.embed(
                        `Không tìm thấy account \`${accountId}\` đang chạy.`,
                        { title: "Không tìm thấy" },
                    ),
                ],
            });
        stopAccount(interaction.user.id, accountId);
        return interaction.editReply({
            embeds: [
                client.embed("", {
                    title: "Đã dừng account",
                    color: 0xed4245,
                    fields: [
                        {
                            name: "Tài khoản",
                            value: entry.username,
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
