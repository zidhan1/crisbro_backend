const crypto = require("crypto");
const axios = require("axios");
const dotenv = require("dotenv").config();
const prisma = require("../../lib/prisma");

const base_url = process.env.QONTAK_BASE_URL;
const client_id = process.env.QONTAK_CLIENT_ID;
const client_secret = process.env.QONTAK_CLIENT_SECRET;

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7

// Hasilkan Date yang kalau disimpan ke DB, nilainya = jam WIB
function toStoredWIB(date) {
  return new Date(date.getTime() + WIB_OFFSET_MS);
}

async function getTokenFromDB() {
  try {
    let token = await prisma.token.findFirst({
      where: { token_code: "qontak" },
    });

    if (!token) throw new Error("Qontak Access Token doesn't exist");

    // now dibandingkan dalam "basis WIB" juga, biar konsisten sama expires_at yang disimpan
    const nowWIB = toStoredWIB(new Date());

    if (token.expires_at < nowWIB) {
      await generateToken({ refresh_token: token.refresh_token });

      token = await prisma.token.findFirst({
        where: { token_code: "qontak" },
      });
    }

    const { access_token, refresh_token } = token;

    return { access_token, refresh_token };
  } catch (error) {
    throw new Error(error.message || error);
  }
}

async function generateToken({ refresh_token }) {
  try {
    const response = await axios.post(`${base_url}/oauth/token`, {
      refresh_token,
      grant_type: "refresh_token",
      client_id,
      client_secret,
    });

    const data = response.data;

    const realExpiresAt = new Date(Date.now() + data.expires_in * 1000);
    const expiresAtWIB = toStoredWIB(realExpiresAt);

    return prisma.token.update({
      where: { token_code: "qontak" },
      data: {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: expiresAtWIB,
      },
    });
  } catch (error) {
    console.log(error.response.data);
    throw new Error(error.response?.data || error.message);
  }
}

function generateHmacHeader(method, path, secret, username) {
  const dateString = new Date().toUTCString();
  const requestLine = `${method} ${path} HTTP/1.1`;
  const stringToSign = `date: ${dateString}\n${requestLine}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(stringToSign)
    .digest("base64");

  const authHeader = `hmac username="${username}", algorithm="hmac-sha256", headers="date request-line", signature="${signature}"`;
  return { Authorization: authHeader, Date: dateString };
}

async function sendVerificationWhatsapp({ toNumber, toName, token }) {
  const path = "/api/open/v1/broadcasts/whatsapp/direct";
  const headers = generateHmacHeader(
    "POST",
    path,
    process.env.QONTAK_DEV_CLIENT_SECRET,
    process.env.QONTAK_DEV_CLIENT_ID,
  );

  const payload = {
    to_number: toNumber,
    to_name: toName,
    message_template_id: process.env.QONTAK_TEMPLATE_ID,
    channel_integration_id: process.env.QONTAK_CHANNEL_ID,
    language: { code: "id" },
    parameters: {
      // body: [
      //   {
      //     key: "1",
      //     value_text: `http://localhost:3000/verify?verify_phone_token=${token}`,
      //     value: "verif",
      //   },
      // ],
      buttons: [
        {
          index: "0",
          type: "url",
          value: `${token}`,
        },
      ],
    },
  };

  const { access_token, refresh_token } = await getTokenFromDB();

  try {
    const response = await axios.post(`${base_url}${path}`, payload, {
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
      },
    });

    return response.data;
  } catch (error) {
    console.log(error.response.data);
    throw new Error(error?.response?.data || error.message);
  }
}

// module.exports = { getTokenFromDB };

sendVerificationWhatsapp({
  toNumber: "+6281259783014",
  toName: "zidanalfa",
  token: "09t789bjsbjf75678",
});
