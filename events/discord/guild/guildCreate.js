module.exports = {
    name: "guildCreate",
    async execute(client, guild) {
        if (client.configs.settings.guildIds.includes(guild.id)) guild.leave();
    },
};
