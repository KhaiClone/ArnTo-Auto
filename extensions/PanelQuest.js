/**
 * PanelQuest.js
 * Client for delegating quest EXECUTION to the bot-panel. Payment stays in
 * arnto-auto; when a run should start, we call the panel's external quest API and
 * the panel webhooks quest events back to /api/quest-event (see ready.js).
 *
 * Enabled only when PANEL_QUEST=true and PANEL_API_URL/PANEL_API_KEY are set.
 */

const axios = require("axios");

const BASE = () => process.env.PANEL_API_URL;
const KEY = () => process.env.PANEL_API_KEY;
const WEBHOOK = () => process.env.PANEL_QUEST_WEBHOOK_URL || null;

function isEnabled() {
    return process.env.PANEL_QUEST === "true" && !!BASE() && !!KEY();
}

function _headers() {
    return { "Content-Type": "application/json", "x-api-key": KEY() };
}

async function preview(token) {
    const res = await axios.post(
        `${BASE()}/api/external/quests/preview`,
        { token },
        { headers: _headers(), timeout: 20000, validateStatus: () => true },
    );
    if (res.status >= 400) {
        const e = new Error(res.data?.error || `preview failed (${res.status})`);
        e.tokenDead = res.status === 401;
        throw e;
    }
    return res.data; // { accountId, username, quests }
}

/**
 * Start running quests on the panel for this token.
 * @param {{token,mode?,selectedQuestIds?,ref?}} opts  ref = arnto userId (echoed in webhooks)
 */
async function start({ token, mode = "select", selectedQuestIds = [], ref }) {
    const res = await axios.post(
        `${BASE()}/api/external/quests/start`,
        { token, mode, selectedQuestIds, webhookUrl: WEBHOOK(), ref: ref ?? null },
        { headers: _headers(), timeout: 20000, validateStatus: () => true },
    );
    if (res.status >= 400) {
        const e = new Error(res.data?.error || `start failed (${res.status})`);
        e.tokenDead = res.status === 401;
        throw e;
    }
    return res.data; // { accountId, status, ... }
}

async function stop(accountId) {
    return axios
        .post(`${BASE()}/api/external/quests/${accountId}/stop`, {}, { headers: _headers(), timeout: 10000 })
        .then((r) => r.data)
        .catch(() => null);
}

async function status(accountId) {
    return axios
        .get(`${BASE()}/api/external/quests/${accountId}`, { headers: _headers(), timeout: 10000 })
        .then((r) => r.data)
        .catch(() => null);
}

module.exports = { isEnabled, preview, start, stop, status };
