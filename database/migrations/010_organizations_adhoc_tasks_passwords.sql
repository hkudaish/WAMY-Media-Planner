-- Migration 010: Managed Organizations Registry, Standalone/Ad-hoc Tasks, Project Classifications, and Security Enhancements

begin;

-- 1. Create Organizations table
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  name_ar text,
  name_en text,
  short_name text,
  description text,
  color text not null default '#3b82f6',
  logo_url text,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_by uuid references profiles(id) on delete set null,
  updated_by uuid references profiles(id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists organizations_code_lower_idx on organizations (lower(code)) where deleted_at is null;

-- 2. Seed initial baseline organizations
insert into organizations (code, name, name_ar, name_en, short_name, description, color, sort_order)
values
  ('wamy', 'الندوة العالمية للشباب الإسلامي', 'الندوة العالمية للشباب الإسلامي', 'World Assembly of Muslim Youth', 'الندوة', 'الجهة المالكة للمشروع والاستراتيجية', '#2563eb', 1),
  ('imaan', 'مؤسسة إمعان للإنتاج الإعلامي', 'مؤسسة إمعان للإنتاج الإعلامي', 'Imaan Media Production', 'إمعان', 'الجهة المنفذة للإنتاج الإعلامي والتواصل', '#059669', 2)
on conflict do nothing;

-- 3. Safely convert enum org_code to text on operational tables
do $$ begin
  alter table profiles alter column org type text using org::text;
  alter table profiles alter column org set default 'wamy';
exception when others then null; end $$;

do $$ begin
  alter table projects alter column org type text using org::text;
  alter table projects alter column org set default 'wamy';
exception when others then null; end $$;

do $$ begin
  alter table products alter column org type text using org::text;
exception when others then null; end $$;

do $$ begin
  alter table tasks alter column org type text using org::text;
exception when others then null; end $$;

do $$ begin
  alter table files alter column org type text using org::text;
exception when others then null; end $$;

do $$ begin
  alter table activity_log alter column org type text using org::text;
exception when others then null; end $$;

-- 4. Extend Projects with system metadata and classification
alter table projects add column if not exists is_system boolean not null default false;
alter table projects add column if not exists system_key text;
alter table projects add column if not exists classification text;
create unique index if not exists projects_system_key_idx on projects(system_key) where system_key is not null and deleted_at is null;

-- 5. Extend Tasks with task_mode
alter table tasks add column if not exists task_mode text not null default 'structured';
do $$ begin
  alter table tasks add constraint tasks_task_mode_check check (task_mode in ('structured', 'adhoc'));
exception when duplicate_object then null; end $$;
create index if not exists tasks_mode_idx on tasks(task_mode) where deleted_at is null;

-- 6. Trigger for updated_at on organizations
drop trigger if exists organizations_touch on organizations;
create trigger organizations_touch before update on organizations
for each row execute function touch_updated_at();

commit;
