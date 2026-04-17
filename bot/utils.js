function sleep(seconds) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function formatUptime(startedAt) {
    const diff = Math.floor((Date.now() - startedAt) / 1000);
    const hours = Math.floor(diff / 3600);
    const minutes = Math.floor((diff % 3600) / 60);
    const seconds = diff % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
}

function normalizeDiscordTokenInput(value) {
    // Bỏ mọi khoảng trắng (space, tab, xuống dòng) — khách hay dán token thừa hoặc giữa các phần
    let token = String(value ?? "").replace(/\s+/g, "");
    const wrapperPairs = [
        ['"', '"'],
        ["'", "'"],
        ["`", "`"],
        ["“", "”"],
        ["‘", "’"],
    ];

    while (token.length >= 2) {
        const matchedPair = wrapperPairs.find(
            ([opening, closing]) =>
                token.startsWith(opening) && token.endsWith(closing),
        );
        if (!matchedPair) {
            break;
        }

        token = token
            .slice(matchedPair[0].length, token.length - matchedPair[1].length)
            .trim();
    }

    return token;
}


module.exports = { sleep, formatUptime, normalizeDiscordTokenInput };
