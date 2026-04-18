const { SlashCommandBuilder } = require("discord.js");
const { getRunningMap } = require("../../../extensions/AutoQuest");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("status")
        .setDescription("Xem trạng thái các account đang chạy"),
    async execute(client, interaction) {
        const userMap = getRunningMap(interaction.user.id);
        if (userMap.size === 0) {
            return interaction.editReply({
                embeds: [
                    client.embed("Bạn chưa có account nào đang chạy.", {
                        title: "Trạng thái",
                        color: 0xfee75c,
                    }),
                ],
            });
        }
        const fields = [];
        for (const [accountId, entry] of userMap) {
            fields.push({
                name: entry.username,
                value: [
                    `ID: \`${accountId}\``,
                    `Uptime: ${client.funcs.formatUptime(entry.startedAt)}`,
                    `Quest hoàn thành: ${entry.completedCount}`,
                ].join("\n"),
                inline: true,
            });
        }
        return interaction.editReply({
            embeds: [
                client.embed("", {
                    title: `Trạng thái — ${userMap.size} account đang chạy`,
                    color: 0x5865f2,
                    fields,
                    timestamp: true,
                }),
            ],
        });
    },
};
