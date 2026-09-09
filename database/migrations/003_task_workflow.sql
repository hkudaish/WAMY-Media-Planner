alter table tasks add column if not exists goal text;
alter table tasks add column if not exists required_outputs text;
alter table tasks add column if not exists scheduled_start_at timestamptz;
alter table tasks add column if not exists scheduled_due_at timestamptz;

update tasks set
  scheduled_start_at=coalesce(scheduled_start_at,planned_start::timestamp at time zone 'Asia/Riyadh'),
  scheduled_due_at=coalesce(scheduled_due_at,due_date::timestamp at time zone 'Asia/Riyadh')
where scheduled_start_at is null or scheduled_due_at is null;

create table if not exists task_assignees (
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  assigned_by uuid references profiles(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key(task_id,user_id)
);

insert into task_assignees(task_id,user_id,assigned_by)
select id,assignee_id,created_by from tasks where assignee_id is not null
on conflict do nothing;

create table if not exists task_schedule_history (
  id bigint generated always as identity primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  baseline_start_at timestamptz,
  baseline_due_at timestamptz,
  previous_start_at timestamptz,
  previous_due_at timestamptz,
  new_start_at timestamptz,
  new_due_at timestamptz,
  change_reason text,
  changed_by uuid references profiles(id) on delete set null,
  changed_by_name text,
  changed_at timestamptz not null default now()
);

create index if not exists task_assignees_user_idx on task_assignees(user_id,task_id);
create index if not exists task_schedule_history_task_idx on task_schedule_history(task_id,changed_at desc);

create or replace function prevent_schedule_history_mutation() returns trigger language plpgsql as $$
begin
  if current_setting('app.allow_audit_mutation', true) = 'on' then return old; end if;
  raise exception 'task schedule history is append-only' using errcode='42501';
end $$;
drop trigger if exists task_schedule_history_immutable on task_schedule_history;
create trigger task_schedule_history_immutable before update or delete on task_schedule_history
for each row execute function prevent_schedule_history_mutation();
