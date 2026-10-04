const { SlashCommandBuilder, PermissionFlagsBits, StringSelectMenuBuilder, ActionRowBuilder } = require("discord.js");
const { ROBUX_PACKAGES, packageVars } = require("../../../extensions/AutoRobux");

/** The Robux panel (template auto.robux.panel) — also what "update posted panels" re-renders. */
const panel = (client) => {
    const packages = ROBUX_PACKAGES.map(packageVars);
    const sel = client.ui.select("auto.robux.panel", { packages });
    const menu = new StringSelectMenuBuilder()
        .setCustomId("rb:select_package")
        .setPlaceholder(sel.placeholder("package") || "Robux")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(packages.map((p) => ({ ...sel.option("package", p), value: String(p.robux) })));
    return client.ui.message("auto.robux.panel", { packages }, { components: [new ActionRowBuilder().addComponents(menu)] });
};

module.exports = {
    panel,
    deferReply: {},
    data: new SlashCommandBuilder()
        .setName("rb-setup")
        .setDescription("Gửi panel mua Robux vào kênh hiện tại")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(client, interaction) {
        const message = await interaction.channel.send(panel(client));
        await client.ui.track("auto.robux.panel", message);
        await interaction.editReply({ ...client.ui.message("auto.robux.cmd.setupDone"), ephemeral: true });
    },
};
