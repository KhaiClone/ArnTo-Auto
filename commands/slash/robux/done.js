const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { completeOrder, orderVars } = require("../../../extensions/AutoRobux");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("rb-done")
        .setDescription("Đánh dấu đơn Robux đã hoàn thành")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption((o) =>
            o
                .setName("order_id")
                .setDescription("Mã đơn Robux (VD: RBxxxxxxxx)")
                .setRequired(true),
        ),

    async execute(client, interaction) {
        const paymentId = interaction.options
            .getString("order_id", true)
            .trim();
        const result = await completeOrder(client, paymentId);
        if (!result.ok) return interaction.editReply(client.ui.message("auto.robux.cmd.error", { reason: result.reason }));
        return interaction.editReply(client.ui.message("auto.robux.cmd.done", { order: orderVars({ ...result.entry, paymentId }) }));
    },
};
