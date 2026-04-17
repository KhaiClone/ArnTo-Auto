const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { getRunningMap, resolveDiscordAccount, startAccount, setAllowedQuests } = require("../../../extensions/accounts");
const { getTokenRefreshRecord } = require("../../../extensions/storage");
const { normalizeDiscordTokenInput } = require("../../../bot/utils");

module.exports = {
    name: "messageCreate",
    async execute(client, message) {
        const { guild, author } = message;
        if (author.bot) return;

        // ── DM: refresh token flow ─────────────────────────────────────────────
        if (!guild) {
            try {
                const refreshRecord = await getTokenRefreshRecord(client, author.id);
                if (!refreshRecord) return;

                const token = normalizeDiscordTokenInput(message.content);
                if (!token) {
                    return message.reply({
                        embeds: [client.embed("Tin nhắn trống hoặc token không hợp lệ. Hãy gửi lại token đầy đủ.", { title: "Token không hợp lệ", color: 0xfee75c })],
                    });
                }

                const resolved = await resolveDiscordAccount(token);
                if (!resolved.ok) {
                    return message.reply({
                        embeds: [client.embed(resolved.reason, { title: "Kích hoạt thất bại" })],
                    });
                }

                if (resolved.accountId !== refreshRecord.accountId) {
                    return message.reply({
                        embeds: [client.embed(`Bạn chỉ được nhập lại token của account \`${refreshRecord.accountId}\`.`, { title: "Sai account" })],
                    });
                }

                const result = await startAccount(client, author.id, token, {
                    resolvedAccount: resolved,
                    allowRestartIfRunning: false,
                    addedAt: refreshRecord.addedAt,
                    month: refreshRecord.month,
                    notifyStarted: true,
                    forceNotifyQuestBatch: true,
                    source: "refresh",
                    requireQuestSelection: true,
                });

                if (!result.ok) {
                    return message.reply({
                        embeds: [client.embed(result.reason, { title: "Kích hoạt thất bại" })],
                    });
                }

                // Update stored token after refresh
                const runningEntry = getRunningMap(author.id).get(result.accountId);
                if (runningEntry?.allowedQuestIds instanceof Set) {
                    await setAllowedQuests(client, author.id, result.accountId, [...runningEntry.allowedQuestIds]);
                }

                return message.reply({
                    embeds: [
                        client.embed("", {
                            title: "Kích hoạt thành công",
                            color: 0x57f287,
                            fields: [
                                { name: "Tài khoản", value: result.username, inline: true },
                                { name: "ID", value: `\`${result.accountId}\``, inline: true },
                            ],
                            timestamp: true,
                        }),
                        client.embed("Token mới đã được cập nhật. Bot sẽ tiếp tục các quest còn lại.", {
                            title: "Đã tiếp tục quest đã chọn",
                            color: 0x57f287,
                        }),
                    ],
                });
            } catch (err) {
                console.warn(`[messages] DM refresh error: ${err.message}`);
            }
            return;
        }

        // ── Guild: text commands (disabled by default) ─────────────────────────
        if (!client.configs.settings.textCommands) return;
        const prefix = client.configs.settings.prefix;
        if (!prefix) return;
        if (!message.content.startsWith(prefix)) return;

        const args = message.content.slice(prefix.length).trim().split(/ +/);
        const name = args.shift().toLowerCase();
        const command =
            client.textCommands.find((e) => e.name === name) ||
            client.textCommands.find((e) => e.aliases?.includes(name));
        if (!command) return;
        if (command.category === "Development" && !client.configs.settings.devUserIds.includes(author.id)) return;
        command.execute(client, message, args);
    },
};
