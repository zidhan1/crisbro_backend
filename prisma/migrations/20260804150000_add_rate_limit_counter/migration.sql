-- Hitungan rate limit untuk endpoint autentikasi dan batas umum API.
-- Disimpan di database agar batasnya berlaku menyeluruh lintas instance
-- serverless; penyimpan berbasis memori akan ter-reset tiap cold start dan
-- dapat dilipatgandakan dengan menyebar request ke banyak instance.
CREATE TABLE "RateLimitCounter" (
    "key" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("key")
);

-- Dipakai pembersih baris yang jendelanya sudah lewat.
CREATE INDEX "RateLimitCounter_expires_at_idx" ON "RateLimitCounter"("expires_at");

-- Tabel ini tidak boleh terbaca lewat kunci API publik, sama seperti tabel lain.
ALTER TABLE "RateLimitCounter" ENABLE ROW LEVEL SECURITY;
