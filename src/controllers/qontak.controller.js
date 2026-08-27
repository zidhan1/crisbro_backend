const {
  badRequest,
  successRequest,
  respondWithServerError,
} = require("../utils/responseReuest");
const axios = require("axios");

function flattenAxiosError(error) {
  const data = error.response?.data;

  if (!data) return error.message;
  if (typeof data === "string") return data;

  // kalau object/array -> flatten jadi satu string
  return JSON.stringify(data);
}

async function receiveQontakMessageInteraction(req, res) {
  const payload = req.body;

  if (!payload)
    return badRequest({
      code: 400,
      res,
      error: "Failed receive message payload",
    });

  try {
    const room_id = payload.room_id ?? undefined;
    const sender_id = payload.sender_id ?? undefined;
    const text = payload.text ?? undefined;
    const phone = payload.room.account_uniq_id ?? undefined;

    if (!room_id && !sender_id && !text && !phone) {
      return badRequest({
        code: 400,
        res,
        error: "room_id, sender_id, text, account_uniq_id must be required",
      });
    }

    // Validate is crisbro validation message.
    const identifier = text.split("\n") ?? undefined;

    // Loloskan kalau tidak bisa di split
    // Karena pasti bukan aktivasi crisbro
    if (!identifier) return successRequest({ res, data: null, code: 200 });

    // Loloskan apabila bukan aktivasi crisbro
    if (identifier[0] !== "AKTIVASI CRISBRO")
      return successRequest({ res, data: null, code: 200 });

    console.log("Identifier: ", identifier[2]);
    console.log("room_id: ", room_id);
    console.log("sender_id: ", sender_id);
    console.log("Text: ", text);
  } catch (error) {
    respondWithServerError(res, flattenAxiosError(error));
  }
}

module.exports = { receiveQontakMessageInteraction };
