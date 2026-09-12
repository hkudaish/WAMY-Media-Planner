-- Migration 011: Project Team Structure, Team Heads (Project/Plan level), and Team Members Hierarchy

begin;

-- 1. Create project team assignments table (Team Heads at Project or Plan level)
create table if not exists project_team_assignments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  plan_item_id uuid references master_plan_items(id) on delete cascade,
  team_head_id uuid not null references profiles(id) on delete cascade,
  scope text not null check (scope in ('PROJECT', 'PLAN')),
  title text,
  is_active boolean not null default true,
  effective_from date,
  effective_to date,
  notes text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((scope = 'PROJECT' and plan_item_id is null) or (scope = 'PLAN' and plan_item_id is not null))
);

create index if not exists idx_pta_project_head on project_team_assignments(project_id, team_head_id) where deleted_at is null;
create index if not exists idx_pta_plan_head on project_team_assignments(plan_item_id, team_head_id) where deleted_at is null;
create index if not exists idx_pta_active on project_team_assignments(team_head_id, is_active) where deleted_at is null;

-- 2. Create project team members table (Team Members under a Team Head assignment)
create table if not exists project_team_members (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references project_team_assignments(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  role_title text,
  is_active boolean not null default true,
  joined_at date not null default current_date,
  left_at date,
  notes text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_ptm_assignment_user on project_team_members(assignment_id, user_id) where deleted_at is null;
create index if not exists idx_ptm_user_active on project_team_members(user_id, is_active) where deleted_at is null;

-- 3. Automatic touch updated_at triggers
drop trigger if exists project_team_assignments_touch on project_team_assignments;
create trigger project_team_assignments_touch before update on project_team_assignments for each row execute function touch_updated_at();

drop trigger if exists project_team_members_touch on project_team_members;
create trigger project_team_members_touch before update on project_team_members for each row execute function touch_updated_at();

commit;
