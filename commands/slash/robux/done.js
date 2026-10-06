const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { completeOrder } = require("../../../extensions/AutoRobux");

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

        if (!result.ok) {
            return interaction.editReply({
                embeds: [
                    client.embed(result.reason, {
                        title: "Lỗi",
                        color: 0xed4245,
                    }),
                ],
            });
        }

        return interaction.editReply({
            embeds: [
                client.embed("", {
                    title: "✅ Đơn đã hoàn thành",
                    color: 0x57f287,
                    fields: [
                        {
                            name: "Mã đơn",
                            value: `\`${paymentId}\``,
                            inline: true,
                        },
                        {
                            name: "Khách hàng",
                            value: `<@${result.entry.userId}>`,
                            inline: true,
                        },
                        {
                            name: "Số Robux",
                            value: `**${result.entry.robux.toLocaleString()} Robux**`,
                            inline: true,
                        },
                        {
                            name: "Tài khoản",
                            value: result.entry.accountName,
                            inline: true,
                        },
                    ],
                    timestamp: true,
                }),
            ],
        });
    },
};
