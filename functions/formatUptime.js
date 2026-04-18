function formatUptime(startedAt) {
    const diff = Math.floor((Date.now() - startedAt) / 1000);
    const hours = Math.floor(diff / 3600);
    const minutes = Math.floor((diff % 3600) / 60);
    const seconds = diff % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
}

module.exports = formatUptime;
