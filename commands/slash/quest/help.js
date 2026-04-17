const { SlashCommandBuilder } = require("discord.js");

module.exports = {
    deferReply: { ephemeral: true },
    data: new SlashCommandBuilder().setName("help").setDescription("Hướng dẫn sử dụng bot"),
    async execute(client, interaction) {
        return interaction.editReply({
            embeds: [client.embed("", {
                title: "Hướng dẫn sử dụng",
                color: 0x5865f2,
                fields: [
                    { name: "/setup", value: "Gửi panel nhập token vào kênh (admin only)", inline: false },
                    { name: "/status", value: "Xem trạng thái account đang chạy", inline: false },
                    { name: "/stop <account_id>", value: "Dừng một account", inline: false },
                    { name: "/stopall", value: "Dừng tất cả account", inline: false },
                    { name: "/removeaccount <account_id>", value: "Xóa account khỏi storage", inline: false },
                    { name: "/restart", value: "Restart tất cả account đã lưu", inline: false },
                ],
            })],
        });
    },
};
