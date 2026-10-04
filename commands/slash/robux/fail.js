const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { failOrder, orderVars } = require("../../../extensions/AutoRobux");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder()
        .setName("rb-fail")
        .setDescription("Đánh dấu đơn Robux thất bại và cấp mã hoàn tiền")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption((o) =>
            o
                .setName("order_id")
                .setDescription("Mã đơn Robux (VD: RBxxxxxxxx)")
                .setRequired(true),
        )
        .addIntegerOption((o) =>
            o
                .setName("refund_amount")
                .setDescription(
                    "Số tiền hoàn trả (VNĐ). Mặc định: toàn bộ tiền đơn.",
                )
                .setRequired(false)
                .setMinValue(0),
        ),

    async execute(client, interaction) {
        const paymentId = interaction.options
            .getString("order_id", true)
            .trim();
        const refundAmount = interaction.options.getInteger("refund_amount");
        const result = await failOrder(client, paymentId, refundAmount);
        if (!result.ok) return interaction.editReply(client.ui.message("auto.robux.cmd.error", { reason: result.reason }));
        return interaction.editReply(
            client.ui.message("auto.robux.cmd.failed", {
                order: orderVars({ ...result.entry, paymentId }),
                refund: { code: result.refundCode, amount: refundAmount ?? result.entry.price },
            }),
        );
    },
};
