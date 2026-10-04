const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const {
    checkRefundCode,
    markRefundUsed,
    orderVars,
} = require("../../../extensions/AutoRobux");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("rb-refund")
        .setDescription("Kiểm tra và xác nhận mã hoàn tiền Robux")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption((o) =>
            o
                .setName("code")
                .setDescription("Mã hoàn tiền của khách (8 ký tự)")
                .setRequired(true),
        ),

    async execute(client, interaction) {
        const code = interaction.options
            .getString("code", true)
            .trim()
            .toUpperCase();
        const result = await checkRefundCode(client, code);
        if (!result.ok) return interaction.editReply(client.ui.message("auto.robux.cmd.refundInvalid", { reason: result.reason }));

        const { record } = result;
        const vars = { order: orderVars(record), refund: { code, amount: record.price } };

        // Mark as used
        await markRefundUsed(client, code);

        // DM buyer to confirm refund processed
        const user = await client.users.fetch(record.userId).catch(() => null);
        if (user) await user.send(client.ui.message("auto.robux.dm.refunded", { ...vars, user: client.ui.user(user) })).catch(() => null);

        return interaction.editReply(client.ui.message("auto.robux.cmd.refunded", vars));
    },
};
