// extensions/hypesquad.js

/**
 * Gửi request tham gia HypeSquad
 * @param {string} userToken - Token của người dùng (không có chữ "Bot " ở trước)
 * @param {number} houseId - ID của nhà (1: Bravery (Tím), 2: Brilliance (Cam), 3: Balance (Xanh))
 * @returns {Promise<object>} - Kết quả của request
 */
async function setHypeSquadBadge(userToken, houseId = 1) {
    try {
        const response = await fetch(
            "https://discord.com/api/v9/hypesquad/online",
            {
                method: "POST",
                headers: {
                    Authorization: userToken, // Header này xác thực người dùng
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ house_id: houseId }),
            },
        );

        if (response.ok) {
            return {
                success: true,
                message: `Đã lấy thành công badge HypeSquad (House ID: ${houseId})!`,
            };
        } else {
            const data = await response.json().catch(() => ({}));
            return {
                success: false,
                message:
                    data.message ||
                    `Lỗi API: ${response.status} ${response.statusText}`,
            };
        }
    } catch (error) {
        console.error("Lỗi khi gọi API HypeSquad:", error);
        return {
            success: false,
            message: "Không thể kết nối đến máy chủ Discord.",
        };
    }
}

module.exports = setHypeSquadBadge;
