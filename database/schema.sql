begin;

create extension if not exists pgcrypto;

do $$ begin create type org_code as enum ('wamy','imaan'); exception when duplicate_object then null; end $$;
do $$ begin create type user_role as enum ('admin','supervisor','user'); exception when duplicate_object then null; end $$;
do $$ begin create type user_status as enum ('pending','active','disabled'); exception when duplicate_object then null; end $$;
do $$ begin create type task_status as enum ('not_started','in_progress','blocked','completed','approved'); exception when duplicate_object then null; end $$;
do $$ begin create type product_status as enum ('not_started','in_progress','completed','approved'); exception when duplicate_object then null; end $$;
alter type product_status add value if not exists 'cancelled';
alter type product_status add value if not exists 'archived';
do $$ begin create type priority_level as enum ('low','normal','high','critical'); exception when duplicate_object then null; end $$;
do $$ begin create type file_folder as enum ('proposals','approved'); exception when duplicate_object then null; end $$;
do $$ begin create type file_status as enum ('draft','under_review','ready_for_approval','approved','rejected'); exception when duplicate_object then null; end $$;
do $$ begin create type log_type as enum ('AUTH','CREATE','UPDATE','DELETE','UPLOAD','APPROVAL','SETTINGS'); exception when duplicate_object then null; end $$;

create or replace function default_permissions() returns jsonb language sql immutable as $$
  select '{"canCreateTasks":false,"canApproveFiles":false,"canEditUsers":false,"canExportReports":true,"canManageSettings":false}'::jsonb
$$;

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  password_hash text not null,
  role user_role not null default 'user',
  org org_code not null default 'wamy',
  position text,
  status user_status not null default 'pending',
  permissions jsonb not null default default_permissions(),
  avatar_url text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists profiles_email_lower_key on profiles (lower(email));

create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_user_id_idx on sessions(user_id);
create index if not exists sessions_expires_at_idx on sessions(expires_at);

create table if not exists products (
  id uuid primary key default gen_random_uuid(), code text not null unique, name text not null,
  content text, target_qty text, org org_code not null,
  manager_id uuid references profiles(id) on delete set null,
  start_date date, due_date date, status product_status not null default 'not_started',
  manual_progress int not null default 0 check (manual_progress between 0 and 100),
  active_duration_days int, recurrence text,
  allow_multiple_tasks boolean not null default false,
  is_active boolean not null default true,
  drive_folder_id text, drive_proposals_folder_id text, drive_approved_folder_id text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(), product_id uuid references products(id) on delete cascade,
  title text not null, description text, org org_code not null,
  assignee_id uuid references profiles(id) on delete set null,
  priority priority_level not null default 'normal', status task_status not null default 'not_started',
  progress int not null default 0 check (progress between 0 and 100), planned_start date, due_date date,
  actual_completion timestamptz, active_duration int,
  phase_name text, notes text, import_key text,
  created_by uuid references profiles(id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists files (
  id uuid primary key default gen_random_uuid(), name text not null,
  product_id uuid references products(id) on delete cascade,
  folder file_folder not null default 'proposals', size_label text, file_type text,
  uploader_id uuid references profiles(id) on delete set null, org org_code not null,
  drive_url text, version text not null default 'v1.0', status file_status not null default 'under_review',
  approved_by uuid references profiles(id) on delete set null, approved_at timestamptz,
  drive_file_id text, drive_view_link text, drive_icon_link text, mime_type text,
  size_bytes bigint, drive_parent_id text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists files_drive_file_id_key on files(drive_file_id) where drive_file_id is not null;

create table if not exists activity_log (
  id bigint generated always as identity primary key,
  actor_id uuid references profiles(id) on delete set null, actor_name text, org org_code,
  action text not null, type log_type not null default 'UPDATE', entity_table text, entity_id text,
  details jsonb not null default '{}'::jsonb, request_id text, ip_address text,
  created_at timestamptz not null default now()
);

create table if not exists login_attempts (
  id bigint generated always as identity primary key,
  email text not null,
  ip_address text not null,
  succeeded boolean not null default false,
  user_id uuid references profiles(id) on delete set null,
  attempted_at timestamptz not null default now()
);

create table if not exists app_settings (
  id smallint primary key default 1 check (id = 1), drive_client_id text,
  drive_picker_api_key text, drive_root_folder_id text, drive_root_folder_name text,
  updated_by uuid references profiles(id) on delete set null, updated_at timestamptz not null default now()
);
insert into app_settings (id) values (1) on conflict (id) do nothing;

-- Idempotent upgrades for databases created by earlier application versions.
alter table products add column if not exists allow_multiple_tasks boolean not null default false;
alter table products add column if not exists is_active boolean not null default true;
alter table tasks add column if not exists phase_name text;
alter table tasks add column if not exists notes text;
alter table tasks add column if not exists import_key text;
alter table profiles add column if not exists deleted_at timestamptz;
alter table products add column if not exists deleted_at timestamptz;
alter table tasks add column if not exists deleted_at timestamptz;
alter table files add column if not exists deleted_at timestamptz;
alter table activity_log add column if not exists details jsonb not null default '{}'::jsonb;
alter table activity_log add column if not exists request_id text;
alter table activity_log add column if not exists ip_address text;

create index if not exists tasks_product_id_idx on tasks(product_id);
create index if not exists tasks_assignee_id_idx on tasks(assignee_id);
create index if not exists tasks_due_date_idx on tasks(due_date);
create unique index if not exists tasks_import_key_key on tasks(import_key) where import_key is not null;
create index if not exists files_product_id_idx on files(product_id);
create index if not exists activity_created_idx on activity_log(created_at desc);
create index if not exists login_attempts_lookup_idx on login_attempts(lower(email),ip_address,attempted_at desc);
create index if not exists tasks_active_status_due_idx on tasks(status,due_date) where deleted_at is null;
create index if not exists tasks_active_org_idx on tasks(org) where deleted_at is null;
create index if not exists files_active_org_idx on files(org) where deleted_at is null;

do $$ begin
  alter table tasks add constraint tasks_date_order_check check (planned_start is null or due_date is null or due_date >= planned_start);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table products add constraint products_date_order_check check (start_date is null or due_date is null or due_date >= start_date);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table tasks add constraint tasks_duration_check check (active_duration is null or active_duration between 1 and 10000);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table products add constraint products_duration_check check (active_duration_days is null or active_duration_days between 1 and 10000);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table profiles add constraint profiles_permissions_object_check check (jsonb_typeof(permissions) = 'object');
exception when duplicate_object then null; end $$;

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create or replace function sync_task_completion() returns trigger language plpgsql as $$
begin
  if new.status in ('completed','approved') then
    new.progress := 100;
    if new.actual_completion is null then new.actual_completion := now(); end if;
  elsif tg_op = 'UPDATE' and old.status in ('completed','approved') and new.status not in ('completed','approved') then
    new.actual_completion := null;
  end if;
  return new;
end $$;

create or replace function protect_last_admin() returns trigger language plpgsql as $$
begin
  if old.role = 'admin' and old.status = 'active'
     and (tg_op = 'DELETE' or (tg_op = 'UPDATE' and (new.role <> 'admin' or new.status <> 'active')))
     and not exists (select 1 from profiles where id <> old.id and role = 'admin' and status = 'active') then
    raise exception 'لا يمكن تعطيل أو حذف آخر مدير نظام نشط' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists profiles_touch on profiles;
create trigger profiles_touch before update on profiles for each row execute function touch_updated_at();
drop trigger if exists products_touch on products;
create trigger products_touch before update on products for each row execute function touch_updated_at();
drop trigger if exists tasks_touch on tasks;
create trigger tasks_touch before update on tasks for each row execute function touch_updated_at();
drop trigger if exists files_touch on files;
create trigger files_touch before update on files for each row execute function touch_updated_at();
drop trigger if exists settings_touch on app_settings;
create trigger settings_touch before update on app_settings for each row execute function touch_updated_at();
drop trigger if exists task_completion on tasks;
create trigger task_completion before insert or update on tasks for each row execute function sync_task_completion();
drop trigger if exists last_admin_guard on profiles;
create trigger last_admin_guard before update or delete on profiles for each row execute function protect_last_admin();

drop trigger if exists task_product_capacity on tasks;

insert into products (code,name,content,target_qty,org,start_date,due_date,status,manual_progress,active_duration_days,recurrence) values
 ('PRD-01','التعاقد والتهيئة وإعادة الهيكلة والتطوير','اعتماد عرض السعر، إعداد خطة تعزيز الصورة الذهنية، وإعادة هيكلة الموقع الإلكتروني.','خطة شاملة + موقع + 2 موظفين','wamy','2026-06-30','2026-08-31','approved',100,60,'مرحلي'),
 ('PRD-02','مخرجات التشغيل - الجزء الأول (سبتمبر - نوفمبر 2026)','إنتاج المحتوى الرقمي والأفلام والاستشارات.','188 بوست + 13 إنفو + 3 أفلام + 13 تيك توك','imaan','2026-09-01','2026-11-30','in_progress',55,90,'مستمر'),
 ('PRD-03','التقارير الاستراتيجية وشاملة الأداء والمشاريع المميزة','تقارير سنوية ونصف سنوية وشهرية.','28 تقريراً دورياً وشاملاً','wamy','2026-09-01','2027-06-30','in_progress',35,300,'شهري ونصف سنوي'),
 ('PRD-04','مخرجات التشغيل - الجزء الثاني (ديسمبر 2026 - يناير 2027)','تسليم المنشورات والأفلام وبناء القدرات.','187 بوست + 12 إنفو + 3 أفلام','imaan','2026-12-01','2027-01-30','not_started',0,60,'مستمر'),
 ('PRD-05','مخرجات التشغيل - الجزء الثالث (فبراير - مارس 2027)','تسليم المحتوى وورش العمل والدراسة الاستراتيجية.','188 بوست + 13 إنفو + 3 أفلام','imaan','2027-02-01','2027-03-30','not_started',0,60,'مستمر'),
 ('PRD-06','التقرير الختامي والأرشيف الإلكتروني الشامل (يونيو 2027)','التقرير السنوي الشامل والأرشيف الإلكتروني.','التقرير الختامي + الأرشيف الرقمي','wamy','2027-06-01','2027-06-30','not_started',0,30,'نهائي')
on conflict (code) do nothing;

insert into tasks (product_id,title,description,org,priority,status,progress,planned_start,due_date,active_duration)
select p.id,v.title,v.description,v.org::org_code,v.priority::priority_level,v.status::task_status,v.progress,v.planned_start::date,v.due_date::date,v.duration
from (values
 ('PRD-01','اعتماد عرض السعر مع الوثائق الخاصة به بالمشروع','مراجعة وتوقيع المستندات التعاقدية.','wamy','critical','approved',100,'2026-06-25','2026-06-30',30),
 ('PRD-01','إعداد خطة تعزيز الصورة الذهنية','تجهيز مسودة الخطة الأولى.','imaan','high','completed',100,'2026-07-01','2026-08-31',60),
 ('PRD-02','تقديم 40 مقترحاً للمحتوى الرقمي','تغطية الأمانة والمكاتب.','imaan','high','in_progress',85,'2026-09-01','2026-09-14',30),
 ('PRD-02','إنتاج 13 إنفوجرافيك و3 أفلام توعوية','تصميم وإخراج المواد للمنصات.','imaan','high','in_progress',60,'2026-09-01','2026-09-30',30),
 ('PRD-03','تسليم خطة ومسودات التقارير الاستراتيجية','إعداد التقارير السنوية ونصف السنوية.','wamy','high','in_progress',40,'2026-09-01','2026-11-30',90)
) v(code,title,description,org,priority,status,progress,planned_start,due_date,duration)
join products p on p.code=v.code
where not exists (select 1 from tasks t where t.title=v.title);

-- Preserve products that already have parallel work when upgrading, then
-- enforce the capacity rule for every write path (including direct SQL).
update products p set allow_multiple_tasks=true
where (select count(*) from tasks t where t.product_id=p.id and t.deleted_at is null) > 1;

create or replace function guard_product_task_capacity() returns trigger language plpgsql as $$
declare multiple_allowed boolean;
declare product_open boolean;
begin
  if new.product_id is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.product_id::text, 0));
  select allow_multiple_tasks, is_active and status not in ('completed','approved','cancelled','archived')
    into multiple_allowed, product_open from products where id=new.product_id;
  if not coalesce(product_open, false) then
    raise exception 'المنتج مغلق أو غير نشط' using errcode='23514';
  end if;
  if not multiple_allowed and exists (
    select 1 from tasks where product_id=new.product_id and deleted_at is null and id is distinct from new.id
  ) then
    raise exception 'المنتج لا يسمح بأكثر من مهمة' using errcode='23505';
  end if;
  return new;
end $$;

drop trigger if exists task_product_capacity on tasks;
create trigger task_product_capacity before insert or update of product_id on tasks
for each row execute function guard_product_task_capacity();

create or replace function protect_activity_log() returns trigger language plpgsql as $$
begin
  if current_setting('app.allow_audit_mutation', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'activity_log is append-only' using errcode='42501';
end $$;

drop trigger if exists activity_log_immutable on activity_log;
create trigger activity_log_immutable before update or delete on activity_log
for each row execute function protect_activity_log();

commit;
