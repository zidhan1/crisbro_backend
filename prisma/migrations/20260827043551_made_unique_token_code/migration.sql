/*
  Warnings:

  - A unique constraint covering the columns `[token_code]` on the table `Token` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Token_token_code_key" ON "Token"("token_code");
