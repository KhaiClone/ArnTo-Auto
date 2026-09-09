/**
 * badgeEmojis.js
 * Emoji cho từng mốc badge, dùng ở panel /badge-setup và các menu chọn.
 *
 * Emoji nằm ở server phụ 1183033659838697542 (bot đã ở trong đó). Bot dùng được
 * emoji của mọi server nó tham gia, nên không cần thêm gì.
 *
 * Thứ tự tier PHẢI khớp với BADGE_CATALOG bên panel — key ở đây chính là
 * `tierKey` panel trả về. Mốc nào không có emoji thì tự bỏ qua, không vỡ layout.
 */

// tên:id — giữ nguyên tên để dễ đối chiếu khi Discord đổi id.
const E = (name, id) => ({ name, id, tag: `<:${name}:${id}>` });

const GAME_TIME = {
    casual: E("game_depth_tier_1", "1547322146303516732"),
    recreational: E("game_depth_tier_2", "1547322236057292820"),
    dedicated: E("game_depth_tier_3", "1547322266532978820"),
    committed: E("game_depth_tier_4", "1547322294135820318"),
    serious: E("game_depth_tier_5", "1547322607358054541"),
    devoted: E("game_depth_tier_6", "1547322378302791680"),
    seasoned: E("game_depth_tier_7", "1547322400599838890"),
    ironclad: E("game_depth_tier_8", "1547322424390058005"),
    unshakeable: E("game_depth_tier_9", "1547322449442635918"),
    eternal: E("game_depth_tier_10", "1547322182378721350"),
};

const GAME_VARIETY = {
    sampler: E("game_diversity_tier_1", "1547322650542608567"),
    dabbler: E("game_diversity_tier_2", "1547322671551877150"),
    enthusiast: E("game_diversity_tier_3", "1547322708700696616"),
    ranger: E("game_diversity_tier_4", "1547322761922355230"),
    explorer: E("game_diversity_tier_5", "1547322798899335310"),
    adventurer: E("game_diversity_tier_6", "1547322819749093437"),
    voyager: E("game_diversity_tier_7", "1547322844005007360"),
    maverick: E("game_diversity_tier_8", "1547322860287037480"),
    polymath: E("game_diversity_tier_9", "1547322893434749089"),
    universalist: E("game_diversity_tier_10", "1547322918453907466"),
};

const HYPESQUAD = {
    bravery: E("1_", "1495429339959787582"),
    brilliance: E("2_", "1495429363871514776"),
    balance: E("3_", "1495429264013660291"),
};

const BY_BADGE = {
    game_time: GAME_TIME,
    game_variety: GAME_VARIETY,
    hypesquad: HYPESQUAD,
};

// Emoji đại diện cho cả một loại badge (dùng ở tiêu đề và menu chọn loại).
const BADGE_ICON = {
    game_time: GAME_TIME.eternal,
    game_variety: GAME_VARIETY.universalist,
    hypesquad: HYPESQUAD.bravery,
};

/** `<:name:id>` của một mốc, hoặc "" nếu chưa có emoji. */
function tierTag(badgeKey, tierKey) {
    return BY_BADGE[badgeKey]?.[tierKey]?.tag ?? "";
}

/** `<:name:id>` đại diện cho một loại badge. */
function badgeTag(badgeKey) {
    return BADGE_ICON[badgeKey]?.tag ?? "";
}

/**
 * Dạng { id, name } cho `emoji` của StringSelectMenu — API select menu nhận
 * object chứ không nhận chuỗi `<:name:id>`.
 */
function tierEmoji(badgeKey, tierKey) {
    const e = BY_BADGE[badgeKey]?.[tierKey];
    return e ? { id: e.id, name: e.name } : undefined;
}

function badgeEmoji(badgeKey) {
    const e = BADGE_ICON[badgeKey];
    return e ? { id: e.id, name: e.name } : undefined;
}

module.exports = { BY_BADGE, BADGE_ICON, tierTag, badgeTag, tierEmoji, badgeEmoji };
