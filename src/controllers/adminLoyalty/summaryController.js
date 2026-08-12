function createGetSummary({
  prisma,
  Prisma,
  parsePositiveInt,
  parseDateBoundary,
  toRedemptionTrend,
  toPublicRedemptionHistory,
  handleError,
  ValidationError,
}) {
  return async function getSummary(req, res) {
  try {
    const redemptionHistoryPage =
      parsePositiveInt(
        req.query.redemption_history_page,
        'redemption_history_page',
        {
          required: false,
        },
      ) ?? 1;
    const requestedHistoryLimit =
      parsePositiveInt(
        req.query.redemption_history_limit,
        'redemption_history_limit',
        { required: false },
      ) ?? 25;
    const redemptionHistoryLimit = Math.min(requestedHistoryLimit, 100);
    const redemptionFrom = parseDateBoundary(
      req.query.redemption_from,
      'redemption_from',
    );
    const redemptionTo = parseDateBoundary(
      req.query.redemption_to,
      'redemption_to',
      true,
    );
    const outletId = parsePositiveInt(req.query.outlet_id, 'outlet_id', {
      required: false,
    });
    const selectedOutlet = outletId
      ? await prisma.location.findUnique({
          where: { id: outletId },
          select: { runchise_id: true },
        })
      : null;
    // L-3: `outlet_id` yang tidak dikenal adalah kesalahan input pengguna,
    // bukan kegagalan server. `Error` biasa tidak dikenali `handleError` dan
    // jatuh ke respondWithServerError -- pemakai menerima 500 "kesalahan
    // server" beserta error_id, sementara log error terisi noise yang menutupi
    // kegagalan sungguhan. ValidationError memetakannya ke 400 dengan pesan
    // yang bisa ditindaklanjuti.
    if (outletId && !selectedOutlet?.runchise_id) {
      throw new ValidationError(
        'outlet_id tidak ditemukan atau bukan outlet Runchise',
      );
    }
    const posRedemptionWhere = {
      status: 'valid',
      is_managed_reward: true,
      redeemed_at: {
        ...(redemptionFrom ? { gte: redemptionFrom } : {}),
        ...(redemptionTo ? { lte: redemptionTo } : {}),
      },
      ...(selectedOutlet?.runchise_id
        ? { location_id: selectedOutlet.runchise_id }
        : {}),
    };
    const [
      totalMembers,
      activeMembers,
      points,
      pointsEarned,
      pointsRedeemed,
      redemptionCount,
      pendingRedemptions,
      claimedRedemptions,
      topRewards,
      activatedCustomersByOutlet,
      redemptionsByOutlet,
      redemptionTrend,
      redemptionHistory,
      runchiseCustomersByOutlet,
      runchiseCustomersUnique,
      salesPointUsageByOutlet,
    ] = await Promise.all([
      prisma.customer.count(),
      // Member aktif dihitung berdasarkan status aktivasi akun aplikasi, bukan status customer di POS, agar metrik sesuai dengan kemampuan login pengguna.
      prisma.customer.count({
        where: {
          user: {
            activation_status: { not: 'pending_activation' },
            password_hash: { not: '' },
          },
        },
      }),
      prisma.customerPoint.aggregate({
        _sum: { total_point: true, available_point: true },
      }),
      prisma.pointHistory.aggregate({
        where: { points_change: { gt: 0 } },
        _sum: { points_change: true },
      }),
      prisma.pointHistory.aggregate({
        where: { points_change: { lt: 0 } },
        _sum: { points_change: true },
      }),
      prisma.runchisePosRewardRedemption.count({ where: posRedemptionWhere }),
      prisma.rewardRedemption.count({ where: { status: 'pending' } }),
      prisma.rewardRedemption.count({ where: { status: 'claimed' } }),
      prisma.runchisePosRewardRedemption.groupBy({
        by: ['runchise_product_id', 'product_name', 'redeem_menu_item_id'],
        where: posRedemptionWhere,
        _sum: { quantity: true, points_spent: true },
        _count: { id: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 5,
      }),
      prisma.customer.groupBy({
        by: ['owner_location_id'],
        where: {
          owner_location_id: { not: null },
          user: { password_hash: { not: '' } },
        },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),
      prisma.runchisePosRewardRedemption.groupBy({
        by: ['location_id', 'location_name'],
        where: posRedemptionWhere,
        _count: { id: true },
        _sum: { quantity: true, points_spent: true },
      }),
      // M-4 (lanjutan): bucket harian dihitung pada kalender WIB, bukan UTC.
      // `redeemed_at` bertipe `timestamp without time zone` berisi instant UTC,
      // sehingga DATE_TRUNC polos mengelompokkan per hari UTC -- redemption jam
      // 03:00 WIB tanggal 12 masuk bucket tanggal 11 pada grafik.
      //
      // Labelnya dikembalikan sebagai TEXT yang sudah jadi, bukan timestamp.
      // Driver pg mem-parse `timestamp without time zone` memakai zona proses
      // Node, jadi mengembalikan timestamp akan memindahkan ketergantungan zona
      // dari SQL ke JavaScript alih-alih menghilangkannya.
      //
      // Hanya ekspresi GROUP BY/ORDER BY yang dibungkus; predikat WHERE tetap
      // menyentuh kolom mentah supaya index (is_managed_reward, status,
      // redeemed_at) masih terpakai.
      prisma.$queryRaw`
        SELECT
          TO_CHAR(
            DATE_TRUNC('day', redemption."redeemed_at" + INTERVAL '7 hours'),
            'YYYY-MM-DD'
          ) AS date,
          COALESCE(SUM(redemption."quantity"), 0)::double precision AS redemption_count,
          COALESCE(SUM(redemption."points_spent"), 0)::double precision AS points_spent
        FROM "RunchisePosRewardRedemption" redemption
        WHERE redemption."status" = 'valid'
          AND redemption."is_managed_reward" = TRUE
          ${redemptionFrom ? Prisma.sql`AND redemption."redeemed_at" >= ${redemptionFrom}` : Prisma.empty}
          ${redemptionTo ? Prisma.sql`AND redemption."redeemed_at" <= ${redemptionTo}` : Prisma.empty}
          ${selectedOutlet?.runchise_id ? Prisma.sql`AND redemption."location_id" = ${selectedOutlet.runchise_id}` : Prisma.empty}
        GROUP BY DATE_TRUNC('day', redemption."redeemed_at" + INTERVAL '7 hours')
        ORDER BY DATE_TRUNC('day', redemption."redeemed_at" + INTERVAL '7 hours') ASC
      `,
      prisma.runchisePosRewardRedemption.findMany({
        where: posRedemptionWhere,
        select: {
          id: true,
          redeem_menu_item_id: true,
          runchise_product_id: true,
          product_name: true,
          quantity: true,
          point_per_item: true,
          points_spent: true,
          selling_price: true,
          location_id: true,
          location_name: true,
          redeemed_at: true,
        },
        orderBy: { redeemed_at: 'desc' },
        skip: (redemptionHistoryPage - 1) * redemptionHistoryLimit,
        take: redemptionHistoryLimit,
      }),
      prisma.$queryRaw`
        SELECT
          l."id" AS outlet_id,
          l."runchise_id" AS source_location_id,
          l."name" AS outlet_name,
          l."city" AS city,
          COALESCE(customer_metric.stored_customers, 0)::int AS stored_customers,
          COALESCE(customer_metric.customers_with_points, 0)::int AS customers_with_points,
          customer_metric.last_snapshot_at,
          latest_import.api_reported_total,
          latest_import.rows_received,
          latest_import.status AS import_status
        FROM "Location" l
        LEFT JOIN (
          SELECT
            customer_location."location_id",
            COUNT(DISTINCT customer_location."customer_id")::int AS stored_customers,
            COUNT(DISTINCT customer_location."customer_id") FILTER (
              WHERE COALESCE(customer_point."available_point", 0) > 0
            )::int AS customers_with_points,
            MAX(COALESCE(customer."runchise_updated_at", customer."updated_at")) AS last_snapshot_at
          FROM "CustomerLocation" customer_location
          JOIN "Customer" customer
            ON customer."id" = customer_location."customer_id"
          LEFT JOIN "CustomerPoint" customer_point
            ON customer_point."customer_id" = customer."id"
          GROUP BY customer_location."location_id"
        ) customer_metric
          ON customer_metric."location_id" = l."id"
        LEFT JOIN LATERAL (
          SELECT
            import_run."api_reported_total",
            import_run."rows_received",
            import_run."status"
          FROM "RunchiseCustomerImportRun" import_run
          WHERE import_run."source_location_id" = l."runchise_id"
          ORDER BY import_run."started_at" DESC
          LIMIT 1
        ) latest_import ON TRUE
        WHERE l."is_outlet" = TRUE
          AND l."runchise_id" IS NOT NULL
        ORDER BY l."name" ASC
      `,
      // Customer unik secara global. Perhitungan per outlet di atas juga
      // memakai CustomerLocation, sehingga satu customer tetap boleh muncul
      // pada beberapa outlet tetapi tidak terhitung ganda di outlet yang sama.
      prisma.$queryRaw`
        SELECT COUNT(DISTINCT customer_location."customer_id")::int AS unique_customers
        FROM "CustomerLocation" customer_location
        JOIN "Customer" customer
          ON customer."id" = customer_location."customer_id"
        JOIN "Location" l
          ON l."id" = customer_location."location_id"
        WHERE l."is_outlet" = TRUE
          AND l."runchise_id" IS NOT NULL
      `,
      // Sumber kolom "Jumlah Poin yang Diredeem" pada tabel customer per
      // outlet: total kolom "Penggunaan Poin" di Crisbro Transaction Report.
      // Sengaja tanpa filter tanggal/outlet supaya angkanya sama dengan
      // penjumlahan tabel transaksi tanpa filter.
      prisma.customerSalesTransactionReport.groupBy({
        by: ['source_location_id'],
        _sum: { penggunaan_poin: true },
      }),
    ]);

    const outletIds = activatedCustomersByOutlet
      .map((item) => item.owner_location_id)
      .filter(Boolean);
    const redemptionLocationIds = redemptionsByOutlet.map(
      (item) => item.location_id,
    );
    const [outlets, redemptionLocations] = await Promise.all([
      prisma.location.findMany({
        where: { id: { in: outletIds } },
        select: { id: true, name: true, city: true },
      }),
      prisma.location.findMany({
        where: { runchise_id: { in: redemptionLocationIds } },
        select: { id: true, runchise_id: true, name: true, city: true },
      }),
    ]);
    const outletById = new Map(outlets.map((outlet) => [outlet.id, outlet]));
    const redemptionLocationByRunchiseId = new Map(
      redemptionLocations.map((location) => [location.runchise_id, location]),
    );
    const outletRedemptionById = new Map();
    for (const redemption of redemptionsByOutlet) {
      const outlet = redemptionLocationByRunchiseId.get(redemption.location_id);

      const current = outletRedemptionById.get(redemption.location_id) ?? {
        outlet_id: outlet?.id ?? null,
        runchise_location_id: redemption.location_id,
        outlet_name:
          redemption.location_name ?? outlet?.name ?? 'Outlet tidak diketahui',
        city: outlet?.city ?? null,
        redemption_count: 0,
        redeemed_quantity: 0,
        points_spent: 0,
      };

      current.redemption_count += redemption._count.id;
      current.redeemed_quantity += Number(redemption._sum.quantity ?? 0);
      current.points_spent += redemption._sum.points_spent ?? 0;
      outletRedemptionById.set(redemption.location_id, current);
    }

    // source_location_id pada laporan transaksi adalah runchise_id outlet,
    // sama dengan kolom source_location_id tabel customer per outlet.
    const salesPointUsageByLocationId = new Map(
      salesPointUsageByOutlet.map((row) => [
        row.source_location_id,
        Number(row._sum.penggunaan_poin ?? 0),
      ]),
    );
    const customerMetricsByOutlet = runchiseCustomersByOutlet.map((outlet) => {
      const apiReportedTotal = outlet.api_reported_total ?? null;
      const rowsReceived = outlet.rows_received ?? 0;
      const isCapped = rowsReceived >= 10000;
      const hasMismatch =
        apiReportedTotal !== null && apiReportedTotal !== rowsReceived;

      return {
        outlet_id: outlet.outlet_id,
        source_location_id: outlet.source_location_id,
        outlet_name: outlet.outlet_name,
        city: outlet.city,
        stored_customers: outlet.stored_customers,
        customers_with_points: outlet.customers_with_points,
        points_redeemed:
          salesPointUsageByLocationId.get(outlet.source_location_id) ?? 0,
        api_reported_total: apiReportedTotal,
        last_snapshot_at: outlet.last_snapshot_at,
        status: hasMismatch
          ? 'mismatch'
          : isCapped
            ? 'capped'
            : (outlet.import_status ??
              (outlet.stored_customers > 0 ? 'available' : 'empty')),
      };
    });

    const totalPointsGiven = points._sum.total_point ?? 0;
    const totalPointsAvailable = points._sum.available_point ?? 0;

    res.json({
      total_members: totalMembers,
      active_members: activeMembers,
      total_points_given: totalPointsGiven,
      total_points_available: totalPointsAvailable,
      points_earned: pointsEarned._sum.points_change ?? 0,
      // Poin terpakai menurut Runchise: selisih poin seumur hidup dengan saldo
      // yang masih tersedia. PointHistory tidak dapat dipakai karena penukaran
      // terjadi di kasir/POS dan tabel itu tidak pernah terisi, sehingga metrik
      // lama selalu melaporkan 0 meskipun Runchise mencatat poin terpakai.
      // Nilai versi PointHistory tetap diekspos terpisah untuk transparansi.
      points_redeemed: Math.max(0, totalPointsGiven - totalPointsAvailable),
      points_redeemed_from_history: Math.abs(
        pointsRedeemed._sum.points_change ?? 0,
      ),
      redemption_count: redemptionCount,
      pending_redemptions: pendingRedemptions,
      claimed_redemptions: claimedRedemptions,
      // Jumlah baris per outlet, sama dengan total kolom di tabel per outlet.
      runchise_customers_stored: customerMetricsByOutlet.reduce(
        (total, outlet) => total + outlet.stored_customers,
        0,
      ),
      // Sama dengan penjumlahan kolom "Customer Berpoin" pada tabel
      // jumlah customer Runchise per outlet.
      runchise_customers_with_points: customerMetricsByOutlet.reduce(
        (total, outlet) => total + outlet.customers_with_points,
        0,
      ),
      runchise_customers_unique:
        runchiseCustomersUnique?.[0]?.unique_customers ?? 0,
      runchise_customers_by_outlet: customerMetricsByOutlet,
      top_rewards: topRewards.map((item) => ({
        reward_id: item.redeem_menu_item_id,
        runchise_product_id: item.runchise_product_id,
        reward_name: item.product_name,
        redemption_count: Number(item._sum.quantity ?? 0),
        transaction_line_count: item._count.id,
        points_spent: item._sum.points_spent ?? 0,
      })),
      activation_by_outlet: activatedCustomersByOutlet.map((item) => {
        const outlet = outletById.get(item.owner_location_id);

        return {
          outlet_id: item.owner_location_id,
          outlet_name: outlet?.name ?? 'Outlet tidak diketahui',
          city: outlet?.city ?? null,
          activated_count: item._count.id,
        };
      }),
      top_redeem_outlets: Array.from(outletRedemptionById.values())
        .sort((a, b) => b.redemption_count - a.redemption_count)
        .slice(0, 5),
      redemption_trend: toRedemptionTrend(redemptionTrend),
      redemption_history: toPublicRedemptionHistory(
        redemptionHistory,
        redemptionLocationByRunchiseId,
      ),
      redemption_history_pagination: {
        page: redemptionHistoryPage,
        limit: redemptionHistoryLimit,
        total: redemptionCount,
        total_pages: Math.ceil(redemptionCount / redemptionHistoryLimit),
      },
    });
  } catch (error) {
    handleError(res, error);
  }
}
}

module.exports = { createGetSummary };
