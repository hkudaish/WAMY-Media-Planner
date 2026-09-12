-- Migration 012: Task Execution Procedures and Sub-Procedures System
-- Hierarchy: Project -> Project Plan -> Task -> Execution Procedure -> Sub-Procedure

begin;

-- 1. Create execution_procedures table
create table if not exists execution_procedures (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  plan_item_id uuid references master_plan_items(id) on delete set null,
  assigned_user_id uuid references profiles(id) on delete set null,
  team_head_id uuid references profiles(id) on delete set null,
  order_index int not null default 0,
  title text not null,
  description text,
  status text not null default 'not_started' check (status in ('not_started', 'ready', 'in_progress', 'on_hold', 'waiting_review', 'needs_revision', 'completed', 'delayed', 'cancelled')),
  progress int not null default 0 check (progress between 0 and 100),
  progress_mode text not null default 'auto' check (progress_mode in ('auto', 'manual')),
  planned_start timestamptz,
  expected_duration numeric(10, 2),
  duration_unit text not null default 'hours' check (duration_unit in ('minutes', 'hours', 'days', 'weeks')),
  due_at timestamptz,
  actual_start timestamptz,
  actual_completion timestamptz,
  actual_duration numeric(10, 2),
  priority priority_level not null default 'normal',
  notes text,
  attachments jsonb not null default '[]'::jsonb,
  related_links jsonb not null default '[]'::jsonb,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_ep_task_order on execution_procedures(task_id, order_index) where deleted_at is null;
create index if not exists idx_ep_project on execution_procedures(project_id) where deleted_at is null;
create index if not exists idx_ep_plan_item on execution_procedures(plan_item_id) where deleted_at is null;
create index if not exists idx_ep_assignee on execution_procedures(assigned_user_id) where deleted_at is null;
create index if not exists idx_ep_status on execution_procedures(status) where deleted_at is null;

-- 2. Create execution_sub_procedures table
create table if not exists execution_sub_procedures (
  id uuid primary key default gen_random_uuid(),
  procedure_id uuid not null references execution_procedures(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  plan_item_id uuid references master_plan_items(id) on delete set null,
  assigned_user_id uuid references profiles(id) on delete set null,
  order_index int not null default 0,
  title text not null,
  description text,
  status text not null default 'not_started' check (status in ('not_started', 'ready', 'in_progress', 'on_hold', 'waiting_review', 'needs_revision', 'completed', 'delayed', 'cancelled')),
  progress int not null default 0 check (progress between 0 and 100),
  planned_start timestamptz,
  expected_duration numeric(10, 2),
  duration_unit text not null default 'hours' check (duration_unit in ('minutes', 'hours', 'days', 'weeks')),
  due_at timestamptz,
  actual_start timestamptz,
  actual_completion timestamptz,
  actual_duration numeric(10, 2),
  priority priority_level not null default 'normal',
  notes text,
  attachments jsonb not null default '[]'::jsonb,
  related_links jsonb not null default '[]'::jsonb,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_esp_proc_order on execution_sub_procedures(procedure_id, order_index) where deleted_at is null;
create index if not exists idx_esp_task on execution_sub_procedures(task_id) where deleted_at is null;
create index if not exists idx_esp_assignee on execution_sub_procedures(assigned_user_id) where deleted_at is null;
create index if not exists idx_esp_status on execution_sub_procedures(status) where deleted_at is null;

-- 3. Create procedure_dependencies table (Finish-to-Start)
create table if not exists procedure_dependencies (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  scope text not null check (scope in ('PROCEDURE', 'SUB_PROCEDURE')),
  predecessor_id uuid not null,
  successor_id uuid not null,
  dependency_type text not null default 'FINISH_TO_START' check (dependency_type = 'FINISH_TO_START'),
  created_at timestamptz not null default now(),
  check (predecessor_id <> successor_id)
);

create unique index if not exists idx_proc_dep_unique on procedure_dependencies(scope, predecessor_id, successor_id);
create index if not exists idx_proc_dep_task on procedure_dependencies(task_id);
create index if not exists idx_proc_dep_succ on procedure_dependencies(successor_id);

-- 4. Automatic touch updated_at triggers
drop trigger if exists execution_procedures_touch on execution_procedures;
create trigger execution_procedures_touch before update on execution_procedures for each row execute function touch_updated_at();

drop trigger if exists execution_sub_procedures_touch on execution_sub_procedures;
create trigger execution_sub_procedures_touch before update on execution_sub_procedures for each row execute function touch_updated_at();

commit;
