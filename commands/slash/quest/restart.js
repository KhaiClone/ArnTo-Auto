const { SlashCommandBuilder } = require("discord.js");
const {
    getRunningMap,
    stopAllAccounts,
    startAccount,
    loadAccounts,
} = require("../../../extensions/AutoQuest");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("restart")
        .setDescription("Khởi động lại các account đã lưu"),
    async execute(client, interaction) {
        stopAllAccounts(interaction.user.id);
        await client.funcs.wait(1);
        const data = await loadAccounts(client);
        const accounts = Object.entries(data[interaction.user.id] ?? {});
        if (!accounts.length)
            return interaction.editReply({
                embeds: [
                    client.embed("Bạn chưa có account nào để restart.", {
                        color: 0xfee75c,
                    }),
                ],
            });
        const results = [];
        let ok = 0;
        for (const [, record] of accounts) {
            const result = await startAccount(
                client,
                interaction.user.id,
                record.token,
                {
                    allowRestartIfRunning: false,
                    addedAt: record.addedAt,
                    month: record.month,
                    notifyStarted: true,
                    source: "restart",
                    requireQuestSelection: true,
                },
            );
            if (result.ok) {
                ok++;
                results.push(`✅ ${result.username}`);
            } else results.push(`❌ ${record.username}: ${result.reason}`);
        }
        return interaction.editReply({
            embeds: [
                client.embed(results.join("\n"), {
                    title: `Restart xong — ${ok}/${accounts.length}`,
                    color: ok > 0 ? 0x57f287 : 0xed4245,
                    timestamp: true,
                }),
            ],
        });
    },
};
