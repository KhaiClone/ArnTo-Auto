module.exports = {
    name: "guildCreate",
    async execute(client, guild) {
        // Stay only in our servers (settings.guildIds) and in the bot-panel's
        // command server (PANEL_BUS_GUILD_ID); leave anything else. This used to
        // be inverted — it left the ALLOWED servers the moment it joined them.
        const keep =
            client.configs.settings.guildIds.includes(guild.id) ||
            process.env.PANEL_BUS_GUILD_ID === guild.id;
        if (!keep) guild.leave();
    },
};
