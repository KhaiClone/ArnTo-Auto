const { SlashCommandBuilder } = require("discord.js");
const {
    stopAllAccounts,
    startAccount,
    loadAccounts,
} = require("../../../extensions/AutoQuest");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("quest-restart")
        .setDescription("Khởi động lại các account đã lưu"),
    async execute(client, interaction) {
        stopAllAccounts(interaction.user.id);
        await client.funcs.wait(1);
        const data = await loadAccounts(client);
        const accounts = Object.entries(data[interaction.user.id] ?? {});
        if (!accounts.length) return interaction.editReply(client.ui.message("auto.quest.cmd.restartNone"));
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
                results.push({ ok: true, username: result.username, reason: "" });
            } else results.push({ ok: false, username: record.username, reason: result.reason });
        }
        return interaction.editReply(client.ui.message("auto.quest.cmd.restarted", { results, ok, total: accounts.length }));
    },
};
