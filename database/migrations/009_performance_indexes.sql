-- Migration 009: Composite Performance Indexes for High-Frequency Operational Queries
-- Ensures fast index scans on cascading filters, project lookups, and audit log inquiries.

-- 1. Tasks by Project & Product (active records)
create index if not exists tasks_project_deleted_idx on tasks(project_id) where deleted_at is null;
create index if not exists tasks_product_deleted_idx on tasks(product_id) where deleted_at is null;
create index if not exists tasks_plan_item_deleted_idx on tasks(plan_item_id) where deleted_at is null;
create index if not exists tasks_org_status_idx on tasks(org, status) where deleted_at is null;

-- 2. Master Plan Items by Project & Schedule
create index if not exists master_plan_project_start_idx on master_plan_items(project_id, planned_start nulls last) where deleted_at is null;
create index if not exists master_plan_ext_id_idx on master_plan_items(project_id, external_id) where deleted_at is null;

-- 3. Products by Project & Status
create index if not exists products_project_active_idx on products(project_id, is_active, status) where deleted_at is null;
create index if not exists products_org_idx on products(org) where deleted_at is null;

-- 4. Files by Product & Folder
create index if not exists files_product_folder_idx on files(product_id, folder) where deleted_at is null;
create index if not exists files_org_status_idx on files(org, status) where deleted_at is null;

-- 5. Activity Log Multi-Parameter Filtering
create index if not exists activity_log_filter_idx on activity_log(entity_table, type, created_at desc);
create index if not exists activity_log_actor_idx on activity_log(actor_id, created_at desc);
