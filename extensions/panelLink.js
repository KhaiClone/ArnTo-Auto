const PanelBus = require("./PanelBus");

// Commands from the bot-panel, over Discord (extensions/PanelBus.js). The panel
// never calls this bot over the network: it posts here, this bot replies there.
module.exports = (client) => {
    const bus = new PanelBus(client);

    // Quest progress the panel runs for our buyers.
    bus.handle("quest.event", (body) => require("../functions/panelQuestEvent")(client, body));

    // Auto Badge order progress.
    bus.handle("badge.event", async (body) => {
        await require("./AutoBadge").handlePanelEvent(client, body || {});
        return { handled: true };
    });

    // A Deco Gift order made on the panel for a buyer who paid in a ticket.
    bus.handle("decor.gift.create", (body) => require("./AutoDecoGift").createByHand(client, body || {}));

    // A DM to a buyer on the panel's behalf (expiry notices …).
    bus.handle("dm.send", async ({ buyerID, content, embeds, components } = {}) => {
        if (!/^\d{17,20}$/.test(String(buyerID || ""))) throw new Error("buyerID is required");
        const user = await client.users.fetch(buyerID);
        await user.send({ content, embeds, components });
        return { sent: true };
    });

    client.panelBus = bus.start();
    return bus;
};
