const { SlashCommandBuilder } = require("discord.js");

/** The bot-management panel (template auto.panelbot.panel) — also what "update posted panels" re-renders. */
const panel = (client) =>
    client.ui.message(
        "auto.panelbot.panel",
        {},
        {
            buttons: {
                status: { customId: "panel:status" },
                manage: { customId: "panel:manage" },
                extend: { customId: "panel:extend" },
                upgrade: { customId: "panel:upgrade" },
            },
        },
    );

module.exports = {
    panel,
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("panel-setup")
        .setDescription("Set up the bot management panel")
        .setDefaultMemberPermissions(8), // Admin only
    async execute(client, interaction) {
        const cmd = client.ui.card("auto.panelbot.cmd");
        if (!client.autoPanel?.isConfigured) {
            return interaction.followUp({ content: cmd.text("notConfigured") });
        }

        const message = await interaction.channel.send(panel(client));
        await client.ui.track("auto.panelbot.panel", message);
        return interaction.followUp({ content: cmd.text("setupDone"), ephemeral: true });
    },
};
