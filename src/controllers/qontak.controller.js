const {
  sendMessageViaBot,
} = require("../integration/qontak/qontak.integration");
const { verifyUserPhone } = require("../services/auth.service");
const {
  badRequest,
  successRequest,
} = require("../utils/responseReuest");

function flattenAxiosError(error) {
  const data = error.response?.data;

  if (!data) return error.message;
  if (typeof data === "string") return data;

  // kalau object/array -> flatten jadi satu string
  return JSON.stringify(data);
}

const failed_message = `Waduh, konfirmasi akun kamu belum berhasil nih. 😅\nBiasanya ini terjadi karena tautan sudah kedaluwarsa (lewat dari 3 menit) atau merubah no.Ref.\nTenang, kamu bisa minta tautan baru lewat halaman login aplikasi/website ya!`;

const success_message = `Yey, akun Crisbro kamu sudah aktif! 🎉\nSekarang kamu sudah resmi jadi bagian dari Crisbro. Yuk, langsung jelajahi dan nikmati semua fiturnya sekarang!`;

async function sendBotMessageSafely({ room_id, text }) {
  try {
    await sendMessageViaBot({ room_id, text });
  } catch (error) {
    // Delivery of the reply must not turn an already received webhook into a
    // failed request, otherwise Qontak will retry the same interaction.
    console.error("Failed to send Qontak bot reply:", flattenAxiosError(error));
  }
}

async function receiveQontakMessageInteraction(req, res) {
  const payload = req.body;

  if (!payload)
    return badRequest({
      code: 400,
      res,
      error: "Failed receive message payload",
    });

  const room_id = payload.room_id ?? undefined;
  const sender_id = payload.sender_id ?? undefined;
  const text = payload.text ?? undefined;
  const phone = payload.room?.account_uniq_id ?? undefined;

  if (!room_id && !sender_id && !text && !phone) {
    return badRequest({
      code: 400,
      res,
      error: "room_id, sender_id, text, account_uniq_id must be required",
    });
  }

  console.log("room_id: ", room_id);
  console.log("sender_id: ", sender_id);
  console.log("text: ", text);
  console.log("phone: ", phone);

  try {
    // Validate is crisbro validation message.
    const identifier = text.split("\n") ?? undefined;

    // Loloskan kalau tidak bisa di split
    // Karena pasti bukan aktivasi crisbro
    if (!identifier) return successRequest({ res, data: null, code: 200 });

    // Loloskan apabila bukan aktivasi crisbro
    if (identifier[0] !== "AKTIVASI CRISBRO")
      return successRequest({ res, data: null, code: 200 });

    const [_, noRef] = identifier[2].split(":") ?? undefined;

    // Verify phone
    const verify = await verifyUserPhone({ raw_phone: phone, noRef: noRef });

    if (!verify) {
      await sendBotMessageSafely({ room_id, text: failed_message });

      console.log(verify);
      return successRequest({
        res,
        code: 200,
        data: null,
        message: "Webhook received; phone verification failed",
      });
    }

    // Success and send message to customer
    await sendBotMessageSafely({ room_id, text: success_message });

    console.log(verify);
    return successRequest({ res, code: 200, data: null });
  } catch (error) {
    console.error("Qontak phone verification failed:", flattenAxiosError(error));
    await sendBotMessageSafely({ room_id, text: failed_message });

    // A verification error is a processed webhook, not a transport failure.
    // Returning 200 prevents Qontak from retrying the same message.
    return successRequest({
      res,
      code: 200,
      data: null,
      message: "Webhook received; phone verification failed",
    });
  }
}

module.exports = { receiveQontakMessageInteraction };
