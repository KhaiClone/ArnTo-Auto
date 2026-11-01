/**
 * orderFeed.js
 * The order feed: ONE channel where every auto order shows up — Auto Quest, Auto
 * Badge, Deco Gift — as one message per order, edited in place as the order moves
 * on (waiting → done / cancelled). Quest done notices used to be one message per
 * quest posted by this bot; Deco Gift orders sat in the shop's waiting list.
 *
 * Posted through a webhook (settings.orderFeedWebhookUrl ← ORDER_FEED_WEBHOOK_URL),
 * not as the bot: a webhook can edit what it posted, so each order keeps the
 * message id and edits it. The buyer is mentioned so each message says whose order
 * it is; SuppressNotifications keeps it silent (the mention renders, no ping).
 * No webhook configured = no feed (nothing is DMed instead).
 *
 * This file only sends and edits; what a message says, and where its id is kept,
 * is up to the caller (functions/questFeed.js, autoBadgeHelpers.js, AutoDecoGift.js).
 */

const { MessageFlags } = require("discord.js");

const WEBHOOK_URL = /discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{17,20})\/([\w-]+)/;
// Discord: the message or the webhook is gone — editing again will not help.
const GONE = new Set([10008, 10015]);

let _hook = null; // { url, promise } — the webhook, fetched once per URL

function _url(client) {
    return client.configs.settings.orderFeedWebhookUrl || "";
}

function isEnabled(client) {
    return WEBHOOK_URL.test(_url(client));
}

/** The Webhook (with guildId / channelId, for message links). A failed fetch is retried next time. */
function _webhook(client) {
    const url = _url(client);
    const m = url.match(WEBHOOK_URL);
    if (!m) return Promise.resolve(null);
    if (_hook?.url !== url) {
        const promise = client.fetchWebhook(m[1], m[2]).catch((e) => {
            if (_hook?.promise === promise) _hook = null;
            throw e;
        });
        _hook = { url, promise };
    }
    return _hook.promise;
}

const _payload = (userId, embed) => ({
    embeds: [embed],
    allowedMentions: { users: userId ? [String(userId)] : [] },
});

/**
 * Post an order's message.
 * @returns {Promise<{messageId: string, url: string} | null>} null: feed off, or Discord refused
 */
async function post(client, userId, embed) {
    if (!isEnabled(client)) return null;
    try {
        const hook = await _webhook(client);
        const msg = await hook.send({ ..._payload(userId, embed), flags: MessageFlags.SuppressNotifications });
        const channelId = msg.channelId ?? msg.channel_id ?? hook.channelId;
        return { messageId: msg.id, url: `https://discord.com/channels/${hook.guildId}/${channelId}/${msg.id}` };
    } catch (e) {
        console.warn(`[orderFeed] post: ${e.message}`);
        return null;
    }
}

/**
 * Edit an order's message.
 * @returns {Promise<boolean | "gone">} "gone": the message (or the webhook that posted it) no longer exists
 */
async function edit(client, messageId, userId, embed) {
    if (!messageId || !isEnabled(client)) return false;
    try {
        const hook = await _webhook(client);
        await hook.editMessage(messageId, _payload(userId, embed));
        return true;
    } catch (e) {
        if (GONE.has(e?.code)) {
            console.warn(`[orderFeed] message ${messageId} is gone (${e.code}) — no longer edited`);
            return "gone";
        }
        console.warn(`[orderFeed] edit ${messageId}: ${e.message}`);
        return false;
    }
}

module.exports = { isEnabled, post, edit };
