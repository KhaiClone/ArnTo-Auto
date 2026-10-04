/**
 * autoDecoGift.js (interactionCreate event)
 * Thin interaction handler — all logic lives in extensions/AutoDecoGift.js.
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
                return interaction.reply({ content: "Deco Gift đang tạm đóng, bạn quay lại sau nhé.", flags: EPHEMERAL });
            }
            if (interaction.isButton()) return await _handleButton(client, interaction);
            if (interaction.isStringSelectMenu()) return await _handleSelect(client, interaction);
            if (interaction.isModalSubmit()) return await _handleModal(client, interaction);
        } catch (err) {
            console.error("[autoDecoGift interaction] error:", err);
            const message = `❌ ${err.message || "Có lỗi xảy ra"}`;
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
const deny = (i) => i.reply({ content: "Chỉ admin mới xử lý được đơn Deco Gift.", flags: EPHEMERAL });

/**
 * Acknowledge at once (the catalog may need a panel round trip) and return the
 * renderer: an ephemeral view is updated in place, a click on the public panel
 * opens a new ephemeral one.
 */
async function _begin(i) {
    if (i.message?.flags?.has(MessageFlags.Ephemeral)) await i.deferUpdate();
    else await i.reply({ ...dg.loadingView(), flags: EPHEMERAL | MessageFlags.IsComponentsV2 });
    i._dgView = true;
    return (view) => i.editReply(view);
}

function _outcome(o) {
    if (!o) return "Đơn đang được xử lý (hoặc không tồn tại) — thử lại sau ít giây.";
    switch (o.status) {
        case "completed":
            return `✅ Đã gửi link cho khách và hoàn thành đơn \`${o.shopOrderId}\`.`;
        case "delivered":
            return "✅ Đã gửi link cho khách. Đơn Shop chưa hoàn thành được — bot tự thử lại.";
        case "dm_failed":
            return "⚠️ Chưa gửi được cho khách (xem tin đơn). Link được giữ lại — bấm **Gửi lại DM** khi khách đã mở DM.";
        case "delivering":
            return `⏳ Chưa có phản hồi — bot tự thử lại.${o.lastError ? `\nLỗi: ${o.lastError}` : ""}`;
        case "paid":
            return o.shopOrderId ? `Đơn Shop: \`${o.shopOrderId}\` — có thể duyệt.` : `⚠️ Vẫn chưa tạo được đơn Shop: ${o.shopError || "không rõ lỗi"}`;
        case "cancelled":
            return o.shopCancelPending ? `⏳ Đã hủy, đơn Shop chưa hủy được — bot tự thử lại.${o.lastError ? `\nLỗi: ${o.lastError}` : ""}` : "❌ Đơn đã hủy.";
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
            return (await _begin(i))(await dg.categoriesView(client, userId, 0));
        case "cats":
            return (await _begin(i))(await dg.categoriesView(client, userId, Number(a)));
        case "catv":
            return (await _begin(i))(await dg.categoryView(client, userId, a, Number(b)));
        case "search":
            return i.showModal(dg.searchModal());
        case "cart":
            return (await _begin(i))(await dg.cartView(client, userId));
        case "clear": {
            dg.clearCart(userId);
            return (await _begin(i))(await dg.cartView(client, userId, "🗑️ Đã xóa giỏ."));
        }
        case "pay":
            return _pay(client, i);
        case "cancelpay":
            return _cancelPayment(client, i, a);
        case "approve": {
            if (!isAdmin(i)) return deny(i);
            const order = await dg.getOrder(client, a);
            if (!order) return i.reply({ content: "Không tìm thấy đơn.", flags: EPHEMERAL });
            if (!["paid", "dm_failed"].includes(order.status)) return i.reply({ content: "Đơn này đã được xử lý.", flags: EPHEMERAL });
            if (!order.shopOrderId) return i.reply({ content: "Đơn Shop chưa được tạo — bấm Thử lại trên tin đơn trước.", flags: EPHEMERAL });
            return i.showModal(dg.linksModal(order));
        }
        case "reject": {
            if (!isAdmin(i)) return deny(i);
            const order = await dg.getOrder(client, a);
            if (!order) return i.reply({ content: "Không tìm thấy đơn.", flags: EPHEMERAL });
            if (!["paid", "dm_failed"].includes(order.status)) return i.reply({ content: "Chỉ hủy được đơn chưa giao link.", flags: EPHEMERAL });
            return i.showModal(dg.rejectModal(order));
        }
        case "retry": {
            if (!isAdmin(i)) return deny(i);
            await i.deferReply({ flags: EPHEMERAL });
            return i.editReply({ content: _outcome(await dg.retry(client, a)) });
        }
    }
}

async function _pay(client, i) {
    const render = await _begin(i);
    const res = await dg.startPayment(client, i.user.id);
    if (res.removed) {
        return render(
            await dg.cartView(client, i.user.id, `⚠️ ${res.removed} deco vừa ngừng bán dạng Gift nên đã bị bỏ khỏi giỏ — xem lại rồi thanh toán.`),
        );
    }
    if (res.empty) return render(await dg.cartView(client, i.user.id));
    if (res.existed) {
        await render(await dg.cartView(client, i.user.id, "⚠️ Bạn đang có một đơn chờ thanh toán (tin bên dưới) — thanh toán hoặc hủy nó trước khi tạo đơn mới."));
        return i.followUp({
            embeds: [dg.paymentEmbed(client, res.existed, "Đơn đang chờ thanh toán.")],
            components: [dg.paymentCancelRow(res.existed.id)],
            flags: EPHEMERAL,
        });
    }
    const p = res.payment;
    await render(dg.messageView(client, "✅ Đã tạo QR thanh toán ở tin bên dưới. Giỏ đã được làm trống."));
    return i.followUp({
        embeds: [dg.paymentEmbed(client, p, `Quét QR để thanh toán **${p.items.length} deco**. Thanh toán xong, đơn được lên tự động và admin sẽ gửi link quà qua tin nhắn riêng.`)],
        components: [dg.paymentCancelRow(p.id)],
        flags: EPHEMERAL,
    });
}

async function _cancelPayment(client, i, paymentId) {
    const payment = await dg.getPayment(client, paymentId);
    if (!payment) {
        const paid = await dg.getOrder(client, paymentId);
        return i.reply({
            content: paid ? "Đơn này đã được thanh toán, không hủy được nữa." : "Không tìm thấy đơn (có thể QR đã hết hạn).",
            flags: EPHEMERAL,
        });
    }
    if (payment.userId !== i.user.id) return i.reply({ content: "Bạn không thể hủy đơn của người khác.", flags: EPHEMERAL });
    if (payment.status !== "pending") return i.reply({ content: "Đơn này đã được hủy.", flags: EPHEMERAL });
    await dg.cancelPayment(client, paymentId);
    return i.update({
        embeds: [
            dg.paymentEmbed(
                client,
                { ...payment, status: "cancelled" },
                "🚫 Đã hủy đơn — đừng chuyển khoản nữa. Nếu bạn đã lỡ chuyển trong 10 phút của QR, đơn vẫn được ghi nhận.",
            ),
        ],
        components: [],
    });
}

// ── Select menu handler ────────────────────────────────────────────────────────

async function _handleSelect(client, i) {
    const [, action, kind, a, b] = i.customId.split(":");
    const userId = i.user.id;

    if (action === "cat") return (await _begin(i))(await dg.categoryView(client, userId, i.values[0], 0));
    if (action === "rm") {
        dg.removeFromCart(userId, i.values);
        return (await _begin(i))(await dg.cartView(client, userId, `🗑️ Đã bỏ ${i.values.length} deco khỏi giỏ.`));
    }
    if (action === "add") {
        const render = await _begin(i);
        const note = await dg.addSkus(userId, i.values);
        if (kind === "c") return render(await dg.categoryView(client, userId, a, Number(b), note));
        return render(await dg.searchView(client, userId, note));
    }
}

// ── Modal handler ──────────────────────────────────────────────────────────────

async function _handleModal(client, i) {
    const [, action, a] = i.customId.split(":");

    if (action === "searchm") {
        const render = await _begin(i);
        const { view, note } = await dg.runSearch(client, i.user.id, i.fields.getTextInputValue("q"));
        return render(view === "cart" ? await dg.cartView(client, i.user.id, note) : await dg.searchView(client, i.user.id, note));
    }

    if (action === "links") {
        if (!isAdmin(i)) return deny(i);
        const order = await dg.getOrder(client, a);
        if (!order) return i.reply({ content: "Không tìm thấy đơn.", flags: EPHEMERAL });
        const read = dg.readLinks(order, i.fields);
        if (read.error) {
            return i.reply({
                content: `❌ ${read.error}\nBấm **Duyệt** lại — những gì bạn đã nhập được giữ sẵn trong form.`,
                flags: EPHEMERAL,
            });
        }
        await i.deferReply({ flags: EPHEMERAL });
        return i.editReply({ content: _outcome(await dg.approve(client, a, i.user.id, read.links)) });
    }

    if (action === "rejectm") {
        if (!isAdmin(i)) return deny(i);
        await i.deferReply({ flags: EPHEMERAL });
        const done = await dg.cancelOrder(client, a, i.user.id, i.fields.getTextInputValue("reason").trim());
        return i.editReply({ content: `${_outcome(done)}\nĐã nhắn lý do và hướng dẫn hoàn tiền cho khách.` });
    }
}
