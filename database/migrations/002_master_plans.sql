create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  objective text,
  vision text,
  mission text,
  org org_code not null default 'wamy',
  manager_id uuid references profiles(id) on delete set null,
  planned_start date,
  planned_end date,
  status text not null default 'planning' check (status in ('planning','active','on_hold','completed','cancelled')),
  budget numeric(16,2),
  currency text,
  source_notes text,
  created_by uuid references profiles(id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (planned_start is null or planned_end is null or planned_end >= planned_start)
);

create table if not exists master_plan_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  external_id text not null,
  parent_external_id text,
  item_type text,
  track text,
  phase text,
  title text not null,
  content text,
  description text,
  quantity numeric(16,2),
  unit text,
  responsible_org text,
  planned_start date,
  planned_end date,
  duration numeric(12,2),
  duration_unit text,
  original_timing text,
  recurrence text,
  kpi text,
  target text,
  priority priority_level not null default 'normal',
  baseline_status task_status not null default 'not_started',
  import_notes text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id,external_id),
  check (planned_start is null or planned_end is null or planned_end >= planned_start)
);

alter table tasks add column if not exists project_id uuid references projects(id) on delete set null;
alter table tasks add column if not exists plan_item_id uuid references master_plan_items(id) on delete set null;

create index if not exists projects_active_org_idx on projects(org,status) where deleted_at is null;
create index if not exists master_plan_items_project_idx on master_plan_items(project_id) where deleted_at is null;
create index if not exists master_plan_items_dates_idx on master_plan_items(planned_start,planned_end) where deleted_at is null;
create index if not exists tasks_project_idx on tasks(project_id) where deleted_at is null;
create index if not exists tasks_plan_item_idx on tasks(plan_item_id) where deleted_at is null;

drop trigger if exists projects_touch on projects;
create trigger projects_touch before update on projects for each row execute function touch_updated_at();
drop trigger if exists master_plan_items_touch on master_plan_items;
create trigger master_plan_items_touch before update on master_plan_items for each row execute function touch_updated_at();
