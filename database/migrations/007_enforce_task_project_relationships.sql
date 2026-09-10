-- Migration 007: Enforce Task-Project Relational Integrity and Migrate Orphan Tasks

-- 1. Safely migrate any historical tasks with NULL project_id
do $$
declare default_proj_id uuid;
begin
  select id into default_proj_id from projects where code='STR-COMM-01' or status in ('active','planning') order by code limit 1;
  if default_proj_id is null then
    insert into projects (code, name, description, org, status)
    values ('STR-COMM-01', 'عقد التواصل الاستراتيجي 2026-2027', 'المشروع الرئيسي لمتابعة الخطة الإعلامية', 'wamy', 'active')
    returning id into default_proj_id;
  end if;
  update tasks set project_id = default_proj_id where project_id is null;
end $$;

-- 2. Match plan_item_id for historical tasks where possible
update tasks t
set plan_item_id = i.id
from master_plan_items i
where t.plan_item_id is null
  and i.project_id = t.project_id
  and i.deleted_at is null
  and (
    lower(trim(i.title)) = lower(trim(t.title))
    or (t.phase_name is not null and i.phase is not null and lower(trim(i.phase)) = lower(trim(t.phase_name)))
  );

-- 3. Set NOT NULL on tasks.project_id
alter table tasks alter column project_id set not null;

-- 4. Enforce foreign key constraints
do $$ begin
  alter table tasks drop constraint if exists tasks_project_id_fkey;
  alter table tasks add constraint tasks_project_id_fkey foreign key (project_id) references projects(id) on delete cascade;
exception when others then null;
end $$;

-- 5. Trigger to strictly prevent orphan tasks and cross-project plan items at DB level
create or replace function guard_task_project_integrity() returns trigger language plpgsql as $$
declare plan_item_project uuid;
begin
  if new.project_id is null then
    raise exception 'المهمة يجب أن تكون مرتبطة بمشروع صالح' using errcode='23502';
  end if;
  if not exists (select 1 from projects where id=new.project_id and deleted_at is null) then
    raise exception 'المشروع المحدد غير موجود أو محذوف' using errcode='23503';
  end if;
  if new.plan_item_id is not null then
    select project_id into plan_item_project from master_plan_items where id=new.plan_item_id and deleted_at is null;
    if plan_item_project is null or plan_item_project <> new.project_id then
      raise exception 'بند الخطة المحدد لا ينتمي إلى المشروع المختار' using errcode='23514';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists task_project_integrity on tasks;
create trigger task_project_integrity before insert or update on tasks
for each row execute function guard_task_project_integrity();

create index if not exists tasks_project_plan_idx on tasks(project_id, plan_item_id) where deleted_at is null;
