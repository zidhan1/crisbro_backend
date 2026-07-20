-- Supports customer registration date filtering and chronological pagination.
CREATE INDEX "Customer_created_at_idx" ON "Customer"("created_at");
