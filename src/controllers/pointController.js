const prisma = require('../lib/prisma');

const HISTORY_LIMIT = 50;

// Riwayat poin diturunkan dari data Runchise yang sudah tersimpan, bukan dari
// tabel PointHistory: tidak ada satu pun alur aplikasi yang mengisi tabel itu,
// sehingga riwayat customer selalu tampil kosong padahal transaksinya ada.
//
// Sumbernya dua, keduanya berpangkal pada CustomerSalesTransactionReport agar
// satu transaksi tidak terhitung dua kali:
//   - penambahan poin  -> kolom penambahan_poin
//   - penggunaan poin  -> kolom penggunaan_poin, nama reward diambil dari
//                         detail RunchisePosRewardRedemption bila tersedia
// SUM(points_spent) detail POS sudah diverifikasi sama persis dengan
// penggunaan_poin pada seluruh transaksi yang punya detail.
const HISTORY_SOURCE_SQL = `
  SELECT
    COALESCE(r."tanggal_transaksi", r."created_at") AS occurred_at,
    'earn'::text AS type,
    r."penambahan_poin"::int AS points_change,
    CASE
      WHEN COALESCE(r."nama_outlet", '') <> ''
        THEN 'Penambahan poin - ' || r."nama_outlet"
      ELSE 'Penambahan poin'
    END AS description
  FROM "CustomerSalesTransactionReport" r
  WHERE r."customer_id" = $1
    AND r."penambahan_poin" > 0

  UNION ALL

  SELECT
    COALESCE(r."tanggal_transaksi", r."created_at") AS occurred_at,
    'redeem'::text AS type,
    (-COALESCE(pos."points_spent", r."penggunaan_poin"::int))::int AS points_change,
    COALESCE(NULLIF(pos."product_name", ''), 'Penukaran reward') AS description
  FROM "CustomerSalesTransactionReport" r
  LEFT JOIN "RunchisePosRewardRedemption" pos
    ON pos."sale_transaction_id" = r."runchise_sales_transaction_id"
   AND pos."status" = 'valid'
  WHERE r."customer_id" = $1
    AND r."penggunaan_poin" > 0
`;

async function getMyPointHistory(req, res) {
  try {
    const customer = await prisma.customer.findUnique({
      where: { user_id: req.user.id },
      select: { id: true },
    });

    if (!customer) {
      return res.status(404).json({ message: 'Customer tidak ditemukan' });
    }

    const [totalRows, histories] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS total FROM (${HISTORY_SOURCE_SQL}) riwayat`,
        customer.id,
      ),
      prisma.$queryRawUnsafe(
        `
          SELECT * FROM (${HISTORY_SOURCE_SQL}) riwayat
          ORDER BY riwayat.occurred_at DESC
          LIMIT ${HISTORY_LIMIT}
        `,
        customer.id,
      ),
    ]);

    return res.json({
      total: totalRows[0]?.total ?? 0,
      // id hanya dipakai sebagai key baris di frontend. Riwayat ini gabungan
      // dua tabel, jadi tidak ada satu primary key yang mewakili keduanya.
      items: histories.map((history, index) => ({
        id: index + 1,
        points_change: history.points_change,
        type: history.type,
        description: history.description,
        created_at: history.occurred_at,
        redemption: null,
      })),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

module.exports = { getMyPointHistory };
