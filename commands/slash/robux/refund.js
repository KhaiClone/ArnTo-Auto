const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const {
    checkRefundCode,
    markRefundUsed,
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

        if (!result.ok) {
            return interaction.editReply({
                embeds: [
                    client.embed(result.reason, {
                        title: "Mã không hợp lệ",
                        color: 0xed4245,
                    }),
                ],
            });
        }

        const { record } = result;

        // Mark as used
        await markRefundUsed(client, code);

        // DM buyer to confirm refund processed
        const user = await client.users.fetch(record.userId).catch(() => null);
        if (user) {
            await user
                .send({
                    embeds: [
                        client.embed(
                            [
                                `Mã hoàn tiền: \`${code}\``,
                                `Mã đơn gốc: \`${record.paymentId}\``,
                                `💰 Số tiền hoàn: **${record.price.toLocaleString("vi-VN")}đ**`,
                                "✅ Admin đã xác nhận hoàn tiền. Vui lòng kiểm tra tài khoản của bạn.",
                            ].join("\n"),
                            { title: "Đã xác nhận hoàn tiền", color: 0x57f287 },
                        ),
                    ],
                })
                .catch(() => null);
        }

        return interaction.editReply({
            embeds: [
                client.embed("", {
                    title: "✅ Mã hoàn tiền hợp lệ — Đã xác nhận",
                    color: 0x57f287,
                    fields: [
                        {
                            name: "Mã hoàn tiền",
                            value: `\`${code}\``,
                            inline: true,
                        },
                        {
                            name: "Mã đơn gốc",
                            value: `\`${record.paymentId}\``,
                            inline: true,
                        },
                        {
                            name: "Khách hàng",
                            value: `<@${record.userId}>`,
                            inline: true,
                        },
                        {
                            name: "Số Robux",
                            value: `**${record.robux.toLocaleString()} Robux**`,
                            inline: true,
                        },
                        {
                            name: "Số tiền hoàn",
                            value: `**${record.price.toLocaleString("vi-VN")}đ**`,
                            inline: true,
                        },
                        {
                            name: "Tài khoản",
                            value: record.accountName,
                            inline: true,
                        },
                    ],
                    description:
                        "Mã đã được đánh dấu là đã dùng. DM xác nhận đã gửi cho khách.",
                    timestamp: true,
                }),
            ],
        });
    },
};
