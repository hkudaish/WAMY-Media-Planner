-- Migration 008: Hierarchical Project Structure and Coding System

-- 1. Projects: add hierarchical_code
alter table projects add column if not exists hierarchical_code text;

update projects
set hierarchical_code = case
  when code = 'STR-COMM-01' then 'PRJ-001'
  when code = 'WEB-REBUILD-01' then 'PRJ-002'
  else coalesce(hierarchical_code, code)
end
where hierarchical_code is null;

-- 2. Products: add project_id, plan_track, hierarchical_code, legacy_code
alter table products add column if not exists project_id uuid references projects(id) on delete cascade;
alter table products add column if not exists plan_track text;
alter table products add column if not exists hierarchical_code text;
alter table products add column if not exists legacy_code text;

-- Backfill existing products to primary project (STR-COMM-01 / PRJ-001)
do $$
declare
  default_proj_id uuid;
begin
  select id into default_proj_id from projects where code in ('STR-COMM-01', 'PRJ-001') or status in ('active', 'planning') order by (case when code in ('STR-COMM-01', 'PRJ-001') then 0 else 1 end), created_at limit 1;
  if default_proj_id is not null then
    update products set project_id = default_proj_id where project_id is null;
  end if;
end $$;

-- Preserve legacy code and generate hierarchical code for products
update products
set legacy_code = coalesce(legacy_code, code),
    hierarchical_code = coalesce(
      hierarchical_code,
      case
        when code = 'PRD-01' then 'PRJ-001-PLN-01-PRD-001'
        when code = 'PRD-02' then 'PRJ-001-PLN-02-PRD-001'
        when code = 'PRD-03' then 'PRJ-001-PLN-03-PRD-001'
        when code = 'PRD-04' then 'PRJ-001-PLN-02-PRD-002'
        when code = 'PRD-05' then 'PRJ-001-PLN-02-PRD-003'
        when code = 'PRD-06' then 'PRJ-001-PLN-04-PRD-001'
        else 'PRJ-001-PLN-01-' || code
      end
    )
where hierarchical_code is null;

-- 3. Master Plan Items: add hierarchical_code, legacy_code
alter table master_plan_items add column if not exists hierarchical_code text;
alter table master_plan_items add column if not exists legacy_code text;

update master_plan_items
set legacy_code = coalesce(legacy_code, external_id)
where legacy_code is null;

-- Generate hierarchical code for master plan items
with numbered_items as (
  select
    i.id,
    p.code as proj_code,
    coalesce(p.hierarchical_code, p.code, 'PRJ-001') as proj_hcode,
    dense_rank() over (partition by i.project_id order by coalesce(i.track, 'عام')) as track_num,
    row_number() over (partition by i.project_id, coalesce(i.track, 'عام') order by i.planned_start nulls last, i.external_id) as item_num,
    i.item_type,
    i.phase
  from master_plan_items i
  join projects p on p.id = i.project_id
)
update master_plan_items m
set hierarchical_code = coalesce(
  m.hierarchical_code,
  n.proj_hcode || '-PLN-' || lpad(n.track_num::text, 2, '0') ||
  case
    when n.item_type in ('معلم رئيسي', 'معلم اعتماد') or lower(coalesce(n.item_type, '')) like '%معلم%'
      then '-PRD-' || lpad(n.item_num::text, 3, '0') || '-MIL-' || lpad(n.item_num::text, 2, '0')
    when n.item_type in ('مرحلة تنفيذ', 'مرحلة/خطة', 'مرحلة/مشروع') or lower(coalesce(n.item_type, '')) like '%مرحلة%'
      then '-PRD-' || lpad(n.item_num::text, 3, '0') || '-PHS-' || lpad(n.item_num::text, 2, '0')
    else '-PRD-' || lpad(n.item_num::text, 3, '0')
  end
)
from numbered_items n
where m.id = n.id and m.hierarchical_code is null;

-- 4. Reconcile tasks relationships
update tasks t
set product_id = p.id
from products p
where t.product_id is null
  and t.project_id = p.project_id
  and (
    lower(trim(p.name)) = lower(trim(t.title))
    or (t.phase_name is not null and lower(trim(p.name)) like '%' || lower(trim(t.phase_name)) || '%')
  );

-- 5. Strict DB-level trigger to guard Project -> Plan -> Product -> Task integrity
create or replace function guard_task_project_integrity() returns trigger language plpgsql as $$
declare
  plan_item_project uuid;
  product_project uuid;
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

  if new.product_id is not null then
    select project_id into product_project from products where id=new.product_id and deleted_at is null;
    if product_project is not null and product_project <> new.project_id then
      raise exception 'المنتج المحدد لا ينتمي إلى المشروع المختار' using errcode='23514';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists task_project_integrity on tasks;
create trigger task_project_integrity before insert or update on tasks
for each row execute function guard_task_project_integrity();

-- 6. Trigger to guard Product -> Project integrity
create or replace function guard_product_project_integrity() returns trigger language plpgsql as $$
begin
  if new.project_id is not null and not exists (select 1 from projects where id=new.project_id and deleted_at is null) then
    raise exception 'المشروع المحدد للمنتج غير موجود أو محذوف' using errcode='23503';
  end if;
  return new;
end $$;

drop trigger if exists product_project_integrity on products;
create trigger product_project_integrity before insert or update on products
for each row execute function guard_product_project_integrity();

create index if not exists products_project_id_idx on products(project_id) where deleted_at is null;
create index if not exists master_plan_items_hcode_idx on master_plan_items(hierarchical_code) where deleted_at is null;
create index if not exists products_hcode_idx on products(hierarchical_code) where deleted_at is null;
