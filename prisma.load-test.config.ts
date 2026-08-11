import { defineConfig } from "prisma/config";

const value = process.env["LOAD_TEST_DATABASE_URL"];
if (!value) throw new Error("LOAD_TEST_DATABASE_URL wajib diisi");

const url = new URL(value);
const database = decodeURIComponent(url.pathname.slice(1));
const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
if (!localHosts.has(url.hostname) || !/(load|test)/i.test(database)) {
  throw new Error(
    'Load test ditolak: database harus loopback dan namanya memuat "load" atau "test"',
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: value },
});
