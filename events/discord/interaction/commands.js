module.exports = {
    name: "interactionCreate",
    async execute(client, interaction) {
        if (!interaction.guild) return;
        if (interaction.isChatInputCommand()) {
            const command = client.slashCommands.find(
                (e) => e.data.name === interaction.commandName,
            );
            if (!command) {
                return interaction.reply(
                    client.ui.message(
                        "auto.system.unknownCommand",
                        { user: client.ui.user(interaction.user), command: interaction.commandName },
                        { ephemeral: true },
                    ),
                );
            }
            if (command.deferReply)
                await interaction.deferReply(command.deferReply);
            await command.execute(client, interaction);
        }
        if (interaction.isAutocomplete()) {
            const command = client.slashCommands.find(
                (e) => e.data.name === interaction.commandName,
            );
            if (!command) return;
            await command.autoComplete(client, interaction);
        }
    },
};
