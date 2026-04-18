module.exports = {
    name: "messageCreate",
    async execute(client, message) {
        const { guild, author } = message;
        if (author.bot) return;

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
        if (
            command.category === "Development" &&
            !client.configs.settings.devUserIds.includes(author.id)
        )
            return;
        command.execute(client, message, args);
    },
};
