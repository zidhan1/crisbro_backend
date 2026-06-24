-- Customer registration lookup
CREATE INDEX "Customer_phone_number_idx" ON "Customer"("phone_number");
CREATE INDEX "Customer_runchise_id_idx" ON "Customer"("runchise_id");

-- Catalog filtering and joins
CREATE INDEX "MenuCategory_name_idx" ON "MenuCategory"("name");
CREATE INDEX "SubBrandProductCategory_sub_brand_id_idx" ON "SubBrandProductCategory"("sub_brand_id");
CREATE INDEX "SubBrandProductCategory_menu_category_id_idx" ON "SubBrandProductCategory"("menu_category_id");
CREATE INDEX "MenuItem_brand_id_idx" ON "MenuItem"("brand_id");
CREATE INDEX "MenuItem_category_id_idx" ON "MenuItem"("category_id");
CREATE INDEX "MenuItem_is_active_idx" ON "MenuItem"("is_active");

-- Visible promo listing
CREATE INDEX "Promo_is_visible_idx" ON "Promo"("is_visible");
CREATE INDEX "Promo_start_at_idx" ON "Promo"("start_at");
CREATE INDEX "Promo_is_visible_start_at_idx" ON "Promo"("is_visible", "start_at");
