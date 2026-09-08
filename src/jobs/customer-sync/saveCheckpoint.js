async function saveCheckpointHandler(lastProcessedId) {
  if (checkpoint) {
    await prisma.syncCheckpoints.update({
      where: { sync_id: checkpoint.sync_id },
      data: { last_sync_id: lastProcessedId },
    });
  } else {
    await prisma.syncCheckpoints.create({
      data: {
        job_category: "sale_transactions",
        last_sync_id: lastProcessedId,
      },
    });
  }
}
