const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();

const base_url = process.env.FAZPASS_BASE_URL;
const merchant_key = process.env.FAZPASS_MERCHANT_KEY;

const fazpassClient = axios.create({
  baseURL: process.env.FAZPASS_BASE_URL,
  headers: {
    Accept: "application/json",
    Authorization: `Bearer ${merchant_key}`,
    "Content-Type": "application/json",
  },
  timeout: 6000,
});

async function generateOtpCode({ phone, gateway_key }) {
  try {
    const response = await fazpassClient.post(`/v1/otp/generate`, {
      phone,
      gateway_key,
    });

    const result = response.data;

    return {
      otp: result.data.otp,
      otp_id: result.data.id,
    };
  } catch (error) {
    throw new Error(error.message);
  }
}

async function sendOtpCode({ phone, otp, gateway_key }) {
  try {
    const response = await fazpassClient.post(`/v1/otp/send`, {
      phone,
      otp,
      gateway_key,
    });

    const data = response.data;

    return data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message = error.response.data.message.toString();
      throw new Error(message);
    }
    throw error;
  }
}

async function verifyOtpCode({ otp_id, otp }) {
  try {
    const response = await fazpassClient.post(`/v1/otp/verify`, {
      otp_id,
      otp,
    });

    const data = response.data;

    return data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message = error.response.data.message.toString();
      throw new Error(message);
    }
    throw error;
  }
}

module.exports = { generateOtpCode, sendOtpCode, verifyOtpCode };
