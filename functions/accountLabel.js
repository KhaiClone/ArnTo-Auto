/**
 * The Discord account a token-error message is about: "**name** (`id`)".
 *
 * Every "token is dead, send a new one" message (Auto Quest and Auto Badge, DM and
 * staff order log) names the account, because one buyer often buys for several
 * accounts and has to know WHICH token to send again. Once the token is dead nobody
 * can ask Discord who it was, so the name comes from what was stored while it worked
 * (the panel's event, the payment, the stored account record).
 *
 * "Unknown" is the placeholder the stored account records use for a missing name.
 * Returns null when neither the name nor the id is known — the caller drops the line.
 */
function accountLabel(username, accountId) {
    const name = typeof username === "string" && username && username !== "Unknown" ? username : null;
    const id = accountId != null && accountId !== "" ? String(accountId) : null;
    if (name && id) return `**${name}** (\`${id}\`)`;
    if (name) return `**${name}**`;
    if (id) return `\`${id}\``;
    return null;
}

module.exports = accountLabel;
