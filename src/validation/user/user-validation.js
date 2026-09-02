const { z } = require("zod");

const createUserSchema = z.object({
  email: z.string().email("Email format is not valid"),
  username: z.string().min(6),
  password: z
    .string()
    .min(8)
    .regex(/[A-Z]/, "Password harus mengandung huruf besar")
    .regex(/[0-9]/, "Password harus mengandung angka"),
  phone: z
    .string()
    .min(11)
    .max(15)
    .regex(/^[1-9]\d*$/, {
      message: "Nomor telepon tidak boleh diawali angka 0",
    })
    .optional(),
  role: z.enum(["customer", "marketing", "admin"]),
  referral_code: z.string().optional(),
  no_referensi: z.string().optional(),
  status: z.enum(["active", "inactive"]),
});

const updateUserSchema = z.object({
  email: z.string().email("Email format is not valid").optional(),
  username: z.string().min(6).optional(),
  password: z
    .string()
    .min(8)
    .regex(/[A-Z]/, "Password harus mengandung huruf besar")
    .regex(/[0-9]/, "Password harus mengandung angka")
    .optional(),
  phone: z
    .string()
    .min(11)
    .max(15)
    .regex(/^[1-9]\d*$/, {
      message: "Nomor telepon tidak boleh diawali angka 0",
    })
    .optional(),
  role: z.enum(["customer", "marketing", "admin"]).optional(),
  referral_code: z.string().optional(),
  no_referensi: z.string().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

module.exports = { createUserSchema, updateUserSchema };
