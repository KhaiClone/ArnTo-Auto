module.exports = {
    name: "messageReactionAdd",
    async execute(client, reaction, user) {
        if (reaction.message.guild) return;
        if (user.bot) return;
        if (reaction.emoji.name !== "❌") return;
        reaction.message.delete().catch(() => {});
    },
};
