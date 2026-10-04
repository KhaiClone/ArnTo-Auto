const PanelBus = require("./PanelBus");
const MessageTemplates = require("./MessageTemplates");

// Commands from the bot-panel, over Discord (extensions/PanelBus.js). The panel
// never calls this bot over the network: it posts here, this bot replies there.
//
// Messages in templates/*.js are editable on the panel's Embeds page
// (extensions/MessageTemplates.js); posted panels can be re-rendered from there.
module.exports = (client) => {
    client.ui = new MessageTemplates(client, { guildId: client.configs.settings.guildIds[1] || client.configs.settings.guildIds[0] });
    client.ui.refreshable("auto.dg.panel", () => require("./AutoDecoGift").panelMessage(client));
    client.ui.refreshable("auto.quest.panel", () => require("../functions/autoQuestHelpers").questPanelMessage(client));
    client.ui.refreshable("auto.robux.panel", () => require("../commands/slash/robux/setup").panel(client));
    client.ui.refreshable("auto.badge.panel", () => require("../commands/slash/badge/setup").panel(client));
    client.ui.refreshable("auto.panelbot.panel", () => require("../commands/slash/panel/setup").panel(client));

    const bus = new PanelBus(client);

    // Quest progress the panel runs for our buyers.
    bus.handle("quest.event", (body) => require("../functions/panelQuestEvent")(client, body));

    // Auto Badge order progress.
    bus.handle("badge.event", async (body) => {
        await require("./AutoBadge").handlePanelEvent(client, body || {});
        return { handled: true };
    });

    // A DM to a buyer on the panel's behalf (expiry notices …).
    bus.handle("dm.send", async ({ buyerID, content, embeds, components } = {}) => {
        if (!/^\d{17,20}$/.test(String(buyerID || ""))) throw new Error("buyerID is required");
        const user = await client.users.fetch(buyerID);
        await user.send({ content, embeds, components });
        return { sent: true };
    });

    client.ui.attachBus(bus);
    client.panelBus = bus.start();
    client.ui.start();
    return bus;
};
