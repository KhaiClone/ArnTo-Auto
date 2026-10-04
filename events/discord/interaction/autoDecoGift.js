/**
 * autoDecoGift.js (interactionCreate event)
 * Thin interaction handler — all logic lives in extensions/AutoDecoGift.js, every
 * word comes from its templates (templates/decoGift.js).
 * All custom IDs are namespaced with "dg:" prefix.
 *
 * Buyer side (every view ephemeral, opened from the public panel):
 *   dg:browse · dg:cats:<page> · dg:cat (select) · dg:catv:<cat>:<page> · dg:add:c:<cat>:<page> (select)
 *   dg:search (modal) · dg:searchm · dg:add:s (select) · dg:cart · dg:rm (select) · dg:clear
 *   dg:pay · dg:cancelpay:<paymentId>
 * Staff channel (Administrator only):
 *   dg:approve:<id> (modal) · dg:links:<id> · dg:reject:<id> (modal) · dg:rejectm:<id> · dg:retry:<id>
 */

const { MessageFlags, PermissionFlagsBits } = require("discord.js");
const dg = require("../../../extensions/AutoDecoGift");

const EPHEMERAL = MessageFlags.Ephemeral;
const BUYER_ACTIONS = new Set(["browse", "cats", "cat", "catv", "add", "search", "searchm", "cart", "rm", "clear", "pay"]);

module.exports = {
    name: "interactionCreate",
    async execute(client, interaction) {
        const id = interaction.customId ?? "";
        if (!id.startsWith("dg:")) return;
        if (!interaction.guild) return;

        try {
            const action = id.split(":")[1];
            if (BUYER_ACTIONS.has(action) && !dg.isEnabled(client)) {
                return interaction.reply({ content: dg.note(client, "closed"), flags: EPHEMERAL });
            }
            if (interaction.isButton()) return await _handleButton(client, interaction);
            if (interaction.isStringSelectMenu()) return await _handleSelect(client, interaction);
            if (interaction.isModalSubmit()) return await _handleModal(client, interaction);
        } catch (err) {
            console.error("[autoDecoGift interaction] error:", err);
            const message = dg.note(client, "error", { error: err.message || "Có lỗi xảy ra" });
            // A buyer view already on screen (or our "Đang tải…") shows the error in place.
            if (interaction._dgView) {
                const shown = await interaction.editReply(dg.messageView(client, message)).catch(() => null);
                if (shown) return;
            }
            const payload = { content: message, flags: EPHEMERAL };
            if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => null);
            else await interaction.reply(payload).catch(() => null);
        }
    },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const isAdmin = (i) => !!i.memberPermissions?.has(PermissionFlagsBits.Administrator);
const say = (i, content) => i.reply({ content, flags: EPHEMERAL });

/**
 * Acknowledge at once (the catalog may need a panel round trip) and return the
 * renderer: an ephemeral view is updated in place, a click on the public panel
 * opens a new ephemeral one.
 */
async function _begin(client, i) {
    if (i.message?.flags?.has(MessageFlags.Ephemeral)) await i.deferUpdate();
    else await i.reply({ ...dg.loadingView(client), flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    i._dgView = true;
    return (view) => i.editReply(view);
}

/** What the admin is told after an action (template auto.dg.admin). */
function _outcome(client, o) {
    const t = (slot) => dg.adminText(client, slot, o ? { order: dg.orderVars(o) } : {});
    if (!o) return t("busy");
    switch (o.status) {
        case "completed":
            return t("completed");
        case "delivered":
            return t("delivered");
        case "dm_failed":
            return t("dmFailed");
        case "delivering":
            return t("delivering");
        case "paid":
            return t(o.shopOrderId ? "paidReady" : "paidNoShop");
        case "cancelled":
            return t(o.shopCancelPending ? "cancelledPending" : "cancelled");
        default:
            return o.status;
    }
}

// ── Button handler ─────────────────────────────────────────────────────────────

async function _handleButton(client, i) {
    const [, action, a, b] = i.customId.split(":");
    const userId = i.user.id;

    switch (action) {
        case "browse":
            return (await _begin(client, i))(await dg.categoriesView(client, userId, 0));
        case "cats":
            return (await _begin(client, i))(await dg.categoriesView(client, userId, Number(a)));
        case "catv":
            return (await _begin(client, i))(await dg.categoryView(client, userId, a, Number(b)));
        case "search":
            return i.showModal(dg.searchModal(client));
        case "cart":
            return (await _begin(client, i))(await dg.cartView(client, userId));
        case "clear": {
            dg.clearCart(userId);
            return (await _begin(client, i))(await dg.cartView(client, userId, dg.note(client, "cleared")));
        }
        case "pay":
            return _pay(client, i);
        case "cancelpay":
            return _cancelPayment(client, i, a);
        case "approve": {
            if (!isAdmin(i)) return say(i, dg.adminText(client, "notAdmin"));
            const order = await dg.getOrder(client, a);
            if (!order) return say(i, dg.adminText(client, "notFound"));
            if (!["paid", "dm_failed"].includes(order.status)) return say(i, dg.adminText(client, "handled"));
            if (!order.shopOrderId) return say(i, dg.adminText(client, "noShopYet"));
            return i.showModal(dg.linksModal(client, order));
        }
        case "reject": {
            if (!isAdmin(i)) return say(i, dg.adminText(client, "notAdmin"));
            const order = await dg.getOrder(client, a);
            if (!order) return say(i, dg.adminText(client, "notFound"));
            if (!["paid", "dm_failed"].includes(order.status)) return say(i, dg.adminText(client, "cannotCancel"));
            return i.showModal(dg.rejectModal(client, order));
        }
        case "retry": {
            if (!isAdmin(i)) return say(i, dg.adminText(client, "notAdmin"));
            await i.deferReply({ flags: EPHEMERAL });
            return i.editReply({ content: _outcome(client, await dg.retry(client, a)) });
        }
    }
}

async function _pay(client, i) {
    const render = await _begin(client, i);
    const res = await dg.startPayment(client, i.user.id);
    if (res.removed) return render(await dg.cartView(client, i.user.id, dg.note(client, "stoppedBeforePay", { count: res.removed })));
    if (res.empty) return render(await dg.cartView(client, i.user.id));
    if (res.existed) {
        await render(await dg.cartView(client, i.user.id, dg.note(client, "paymentExists")));
        return i.followUp(dg.paymentMessage(client, res.existed, "pending", { ephemeral: true }));
    }
    await render(dg.messageView(client, dg.note(client, "qrCreated")));
    return i.followUp(dg.paymentMessage(client, res.payment, "created", { ephemeral: true }));
}

async function _cancelPayment(client, i, paymentId) {
    const payment = await dg.getPayment(client, paymentId);
    if (!payment) {
        const paid = await dg.getOrder(client, paymentId);
        return say(i, dg.paymentNote(client, paid ? "alreadyPaid" : "notFound"));
    }
    if (payment.userId !== i.user.id) return say(i, dg.paymentNote(client, "notYours", payment));
    if (payment.status !== "pending") return say(i, dg.paymentNote(client, "alreadyCancelled", payment));
    await dg.cancelPayment(client, paymentId);
    return i.update(dg.paymentMessage(client, { ...payment, status: "cancelled" }, "cancelled", { edit: true }));
}

// ── Select menu handler ────────────────────────────────────────────────────────

async function _handleSelect(client, i) {
    const [, action, kind, a, b] = i.customId.split(":");
    const userId = i.user.id;

    if (action === "cat") return (await _begin(client, i))(await dg.categoryView(client, userId, i.values[0], 0));
    if (action === "rm") {
        dg.removeFromCart(userId, i.values);
        return (await _begin(client, i))(await dg.cartView(client, userId, dg.note(client, "removed", { count: i.values.length })));
    }
    if (action === "add") {
        const render = await _begin(client, i);
        const note = await dg.addSkus(client, userId, i.values);
        if (kind === "c") return render(await dg.categoryView(client, userId, a, Number(b), note));
        return render(await dg.searchView(client, userId, note));
    }
}

// ── Modal handler ──────────────────────────────────────────────────────────────

async function _handleModal(client, i) {
    const [, action, a] = i.customId.split(":");

    if (action === "searchm") {
        const render = await _begin(client, i);
        const { view, note } = await dg.runSearch(client, i.user.id, i.fields.getTextInputValue("q"));
        return render(view === "cart" ? await dg.cartView(client, i.user.id, note) : await dg.searchView(client, i.user.id, note));
    }

    if (action === "links") {
        if (!isAdmin(i)) return say(i, dg.adminText(client, "notAdmin"));
        const order = await dg.getOrder(client, a);
        if (!order) return say(i, dg.adminText(client, "notFound"));
        const read = dg.readLinks(client, order, i.fields);
        if (read.error) return say(i, dg.adminText(client, "linkRetry", { error: read.error }));
        await i.deferReply({ flags: EPHEMERAL });
        return i.editReply({ content: _outcome(client, await dg.approve(client, a, i.user.id, read.links)) });
    }

    if (action === "rejectm") {
        if (!isAdmin(i)) return say(i, dg.adminText(client, "notAdmin"));
        await i.deferReply({ flags: EPHEMERAL });
        const done = await dg.cancelOrder(client, a, i.user.id, i.fields.getTextInputValue("reason").trim());
        return i.editReply({ content: `${_outcome(client, done)}\n${dg.adminText(client, "cancelledNotified", { order: dg.orderVars(done) })}` });
    }
}
