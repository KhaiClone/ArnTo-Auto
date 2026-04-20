const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { failOrder } = require("../../../extensions/AutoRobux");

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
        ),

    async execute(client, interaction) {
        const paymentId = interaction.options
            .getString("order_id", true)
            .trim();
        const result = await failOrder(client, paymentId);

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
                    title: "❌ Đơn thất bại — Đã gửi mã hoàn tiền",
                    color: 0xed4245,
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
                            name: "Số tiền hoàn",
                            value: `**${result.entry.price.toLocaleString("vi-VN")}đ**`,
                            inline: true,
                        },
                        {
                            name: "Mã hoàn tiền",
                            value: `\`\`\`${result.refundCode}\`\`\``,
                            inline: false,
                        },
                    ],
                    description: "Mã hoàn tiền đã được gửi cho khách qua DM.",
                    timestamp: true,
                }),
            ],
        });
    },
};
