async function syncSalesAcrossLocations({ locationIds, syncLocation, logger = console }) {
  const summary = {
    status: 'completed',
    locations_total: locationIds.length,
    locations_completed: 0,
    locations_failed: 0,
    synced: 0,
    total: 0,
    skipped: 0,
    skipped_zero_points: 0,
    deleted_zero_points: 0,
    results: [],
    failures: [],
  };

  // Sengaja sekuensial: setiap outlet dapat memuat banyak halaman transaksi
  // dan customer. Paralelisasi seluruh outlet sekaligus berisiko menekan API,
  // koneksi database, dan memori proses cron secara berlebihan.
  for (const locationId of locationIds) {
    try {
      const result = await syncLocation(locationId);
      summary.locations_completed++;
      summary.synced += result.synced;
      summary.total += result.total;
      summary.skipped += result.skipped;
      summary.skipped_zero_points += result.skipped_zero_points;
      summary.deleted_zero_points += result.deleted_zero_points;
      summary.results.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.locations_failed++;
      summary.failures.push({ location_id: locationId, error: message });
      logger.error(`[runchise-sync:sales] outlet ${locationId} failed:`, message);
    }
  }

  if (summary.locations_failed > 0) {
    summary.status =
      summary.locations_completed > 0 ? 'completed_with_errors' : 'failed';
  }

  if (summary.locations_completed === 0) {
    const error = new Error(
      `Sinkronisasi sales gagal untuk seluruh ${summary.locations_total} outlet`,
    );
    error.syncSummary = summary;
    throw error;
  }

  return summary;
}

module.exports = { syncSalesAcrossLocations };
