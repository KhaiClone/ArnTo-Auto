const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require("discord.js");
const { ROBUX_PACKAGES } = require("../../../extensions/AutoRobux");

module.exports = {
    deferReply: {},
    data: new SlashCommandBuilder()
        .setName("rb-setup")
        .setDescription("Gửi panel mua Robux vào kênh hiện tại")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(client, interaction) {
        const packageList = ROBUX_PACKAGES.map(
            (p) =>
                `> - **${p.robux.toLocaleString()} <:robux:1456493708382830735>** <a:Love:1379091872747880670> **${p.price.toLocaleString("vi-VN")}đ**`,
        ).join("\n");
        const menu = new StringSelectMenuBuilder()
            .setCustomId("rb:select_package")
            .setPlaceholder("💲 Chọn gói Robux muốn mua")
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
                ROBUX_PACKAGES.map((p) => ({
                    label: `${p.robux.toLocaleString()} Robux`,
                    value: String(p.robux),
                    description: `${p.price.toLocaleString("vi-VN")}đ`,
                    emoji: `<:robux:1456493708382830735>`,
                })),
            );

        const embed = new EmbedBuilder()
            .setColor(client.funcs.hexToInt(client.configs.embed.color))
            .setTitle(
                "<:roblox:1487511739246444606> Robux 120h <:roblox:1487511739246444606>",
            )
            .setDescription(
                [
                    packageList,
                    "",
                    "",
                    "<:warning:1487512261793808586> **Lưu Ý**",
                    "",
                    "- Đây là robux gamepass đã tính thuế.",
                    "- Nick phải trên 7 ngày và có skin bất kì.",
                    "- Mua bằng link gamepass, mỗi link cài cố định 358 <:robux:1456493708382830735> (hướng dẫn: <#1456496321413386461>)",
                    "",
                    "",
                    "**Có thắc mắc vui lòng liên hệ trực tiếp với shop qua** <#1246028759597846650>",
                ].join("\n"),
            )
            .addFields(
                {
                    name: "⏱ Thời gian chờ QR",
                    value: "10 phút (quá thời gian sẽ hết hạn).",
                    inline: true,
                },
                {
                    name: "⚙️ Xử lý",
                    value: "Trong vòng 24h sau khi thanh toán, lâu hơn nếu hệ thống gặp lỗi.",
                    inline: true,
                },
            )
            .setThumbnail(
                "https://cdn.discordapp.com/attachments/1245991899450572912/1456492591506788383/1767325292739.png?ex=69e6f1ee&is=69e5a06e&hm=766ce191eeee144238a57ebdbcaa687bbb705db9b350f9bcee5249c75e007570&",
            )
            .setImage(
                "https://logos-world.net/wp-content/uploads/2020/10/Roblox-Logo-2018-present.jpg",
            );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        await interaction.editReply({
            content: "✅ Đã gửi panel Robux vào kênh này.",
            ephemeral: true,
        });
    },
};
