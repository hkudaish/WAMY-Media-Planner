-- Migration 016: Permission Packages and Unified Scope ('المشروع أو الإدارة')

-- 0. Ensure profiles.role column is text to allow all 5 standardized roles cleanly
do $$ begin
  alter table profiles alter column role type text;
exception when others then null; end $$;

-- 1. Create permission_packages table
create table if not exists permission_packages (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  description text,
  scope_type text not null default 'assigned' check (scope_type in ('global', 'project', 'department', 'section', 'assigned', 'مشروع', 'إدارة')),
  permissions jsonb not null default '{}'::jsonb,
  is_default_for_role text check (is_default_for_role in ('admin', 'project_manager', 'department_manager', 'team_head', 'team_member', 'user', null)),
  is_active boolean not null default true,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_permission_packages_code on permission_packages(code) where deleted_at is null;
create index if not exists idx_permission_packages_role_default on permission_packages(is_default_for_role) where deleted_at is null and is_default_for_role is not null;

-- 2. Alter profiles table to support scope_type, assigned_project_ids, assigned_department, package_id, direct overrides
alter table profiles add column if not exists package_id uuid references permission_packages(id) on delete set null;
alter table profiles add column if not exists scope_type text not null default 'assigned';
alter table profiles add column if not exists assigned_project_ids jsonb not null default '[]'::jsonb;
alter table profiles add column if not exists assigned_department text;
alter table profiles add column if not exists direct_permissions_allow jsonb not null default '{}'::jsonb;
alter table profiles add column if not exists direct_permissions_deny jsonb not null default '{}'::jsonb;

do $$ begin
  alter table profiles drop constraint if exists profiles_scope_type_check;
  alter table profiles add constraint profiles_scope_type_check
    check (scope_type in ('global', 'project', 'department', 'section', 'assigned', 'مشروع', 'إدارة'));
exception when duplicate_object then null; end $$;

create index if not exists idx_profiles_package_id on profiles(package_id) where deleted_at is null;
create index if not exists idx_profiles_scope_type on profiles(scope_type) where deleted_at is null;
create index if not exists idx_profiles_assigned_department on profiles(org, assigned_department) where deleted_at is null and assigned_department is not null;

-- 3. Seed the 5 Standard Permission Packages
-- 3.1 باقة مدير النظام
insert into permission_packages (id, code, name, description, scope_type, permissions, is_default_for_role, is_active, is_system)
values (
  '00000000-0000-0000-0000-000000000001',
  'admin_package',
  'باقة مدير النظام',
  'صلاحيات إدارية وتشغيلية شاملة لكافة أقسام النظام والمشاريع والإعدادات',
  'global',
  '{
    "Dashboard.View": true, "MainPlan.View": true, "Products.View": true, "Tasks.View": true, "Timeline.View": true,
    "Calendar.View": true, "Files.View": true, "Reports.View": true, "Settings.View": true, "Audit.View": true, "AuditLog.View": true,
    "Projects.View": true, "Projects.Create": true, "Projects.Edit": true, "Projects.Delete": true, "Projects.Archive": true, "Projects.Activate": true, "Projects.Deactivate": true,
    "Plans.View": true, "Plans.Create": true, "Plans.Import": true, "Plans.Edit": true, "Plans.Archive": true, "Plans.Export": true,
    "Products.Create": true, "Products.Edit": true, "Products.Delete": true,
    "Milestones.View": true, "Milestones.Create": true, "Milestones.Edit": true, "Milestones.Delete": true,
    "Tasks.Create": true, "Tasks.Edit": true, "Tasks.Assign": true, "Tasks.Reassign": true, "Tasks.Delete": true, "Tasks.Start": true, "Tasks.Complete": true, "Tasks.Approve": true, "Tasks.Close": true, "Tasks.CompletionApprove": true, "Tasks.ExtensionApprove": true,
    "Procedure.Manage": true, "SubProcedure.Manage": true, "Procedures.View": true, "Procedures.Create": true, "Procedures.Edit": true, "Procedures.Delete": true,
    "Team.View": true, "Team.Manage": true,
    "Reports.Export": true, "Reports.ExportPdf": true, "Reports.ExecutiveView": true, "Reports.FinancialView": true, "Reports.TeamPerformanceView": true,
    "Files.Upload": true, "Files.Download": true, "Files.Edit": true, "Files.Delete": true, "Files.Approve": true, "Files.MoveToApproved": true,
    "Calendar.Create": true, "Calendar.Edit": true, "Calendar.Delete": true, "Calendar.ManageSchedule": true,
    "Settings.General": true, "Settings.Users": true, "Settings.Roles": true, "Settings.Permissions": true, "Settings.Departments": true, "Settings.Organizations": true, "Settings.Backup": true, "Settings.Security": true, "Settings.Integrations": true,
    "Organizations.View": true, "Organizations.Create": true, "Organizations.Edit": true, "Organizations.Activate": true, "Organizations.Deactivate": true, "Organizations.Delete": true,
    "Backup.View": true, "Backup.Create": true, "Backup.Restore": true, "Backup.Download": true, "Backup.Delete": true, "System.Reset": true,
    "Chat.View": true, "Chat.Start": true, "Chat.SendMessage": true, "Notification.View": true,
    "SECURITY_PUBLIC_REGISTRATION_VIEW": true, "SECURITY_PUBLIC_REGISTRATION_MANAGE": true, "USER_REGISTRATION_REVIEW": true, "USER_REGISTRATION_APPROVE": true, "USER_REGISTRATION_REJECT": true, "USER_PERMISSION_ASSIGN": true
  }'::jsonb,
  'admin',
  true,
  true
)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  scope_type = excluded.scope_type,
  permissions = excluded.permissions,
  is_default_for_role = excluded.is_default_for_role,
  is_system = true,
  updated_at = now();

-- 3.2 باقة مدير مشروع
insert into permission_packages (id, code, name, description, scope_type, permissions, is_default_for_role, is_active, is_system)
values (
  '00000000-0000-0000-0000-000000000002',
  'project_manager_package',
  'باقة مدير مشروع',
  'صلاحيات تشغيلية وإدارية كاملة ضمن نطاق المشروع أو المشاريع المسندة إليه فقط',
  'project',
  '{
    "Dashboard.View": true, "MainPlan.View": true, "Products.View": true, "Tasks.View": true, "Timeline.View": true,
    "Calendar.View": true, "Files.View": true, "Reports.View": true,
    "Projects.View": true, "Projects.Edit": true,
    "Plans.View": true, "Plans.Create": true, "Plans.Import": true, "Plans.Edit": true, "Plans.Export": true,
    "Products.Create": true, "Products.Edit": true,
    "Milestones.View": true, "Milestones.Create": true, "Milestones.Edit": true,
    "Team.View": true, "Team.Manage": true,
    "Tasks.Create": true, "Tasks.Edit": true, "Tasks.Assign": true, "Tasks.Reassign": true, "Tasks.Start": true, "Tasks.Complete": true, "Tasks.Approve": true, "Tasks.CompletionApprove": true, "Tasks.ExtensionApprove": true,
    "Procedure.Manage": true, "SubProcedure.Manage": true, "Procedures.View": true, "Procedures.Create": true, "Procedures.Edit": true,
    "Reports.Export": true, "Reports.ExportPdf": true, "Reports.TeamPerformanceView": true,
    "Files.Upload": true, "Files.Download": true, "Files.Edit": true, "Files.Approve": true, "Files.MoveToApproved": true,
    "Calendar.ManageSchedule": true,
    "Chat.View": true, "Chat.Start": true, "Chat.SendMessage": true, "Notification.View": true
  }'::jsonb,
  'project_manager',
  true,
  true
)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  scope_type = excluded.scope_type,
  permissions = excluded.permissions,
  is_default_for_role = excluded.is_default_for_role,
  is_system = true,
  updated_at = now();

-- 3.3 باقة مدير إدارة
insert into permission_packages (id, code, name, description, scope_type, permissions, is_default_for_role, is_active, is_system)
values (
  '00000000-0000-0000-0000-000000000003',
  'department_manager_package',
  'باقة مدير إدارة',
  'صلاحيات واسعة لإنشاء وإدارة المشاريع والخطط والمنتجات والفرق والمهام التابعة للإدارة المحددة',
  'department',
  '{
    "Dashboard.View": true, "MainPlan.View": true, "Products.View": true, "Tasks.View": true, "Timeline.View": true,
    "Calendar.View": true, "Files.View": true, "Reports.View": true,
    "Projects.View": true, "Projects.Create": true, "Projects.Edit": true,
    "Plans.View": true, "Plans.Create": true, "Plans.Import": true, "Plans.Edit": true, "Plans.Export": true,
    "Products.Create": true, "Products.Edit": true,
    "Milestones.View": true, "Milestones.Create": true, "Milestones.Edit": true,
    "Team.View": true, "Team.Manage": true,
    "Tasks.Create": true, "Tasks.Edit": true, "Tasks.Assign": true, "Tasks.Reassign": true, "Tasks.Start": true, "Tasks.Complete": true, "Tasks.Approve": true, "Tasks.CompletionApprove": true, "Tasks.ExtensionApprove": true,
    "Procedure.Manage": true, "SubProcedure.Manage": true, "Procedures.View": true, "Procedures.Create": true, "Procedures.Edit": true,
    "Reports.Export": true, "Reports.ExportPdf": true, "Reports.ExecutiveView": true, "Reports.TeamPerformanceView": true,
    "Files.Upload": true, "Files.Download": true, "Files.Edit": true, "Files.Approve": true, "Files.MoveToApproved": true,
    "Calendar.Create": true, "Calendar.Edit": true, "Calendar.ManageSchedule": true,
    "Chat.View": true, "Chat.Start": true, "Chat.SendMessage": true, "Notification.View": true
  }'::jsonb,
  'department_manager',
  true,
  true
)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  scope_type = excluded.scope_type,
  permissions = excluded.permissions,
  is_default_for_role = excluded.is_default_for_role,
  is_system = true,
  updated_at = now();

-- 3.4 باقة رئيس قسم
insert into permission_packages (id, code, name, description, scope_type, permissions, is_default_for_role, is_active, is_system)
values (
  '00000000-0000-0000-0000-000000000004',
  'team_head_package',
  'باقة رئيس قسم',
  'إدارة ومتابعة الهياكل والمهام القائمة في القسم؛ مستثنى منها إنشاء المشاريع والخطط والمنتجات والخطط الزمنية الأساسية',
  'department',
  '{
    "Dashboard.View": true, "MainPlan.View": true, "Products.View": true, "Tasks.View": true, "Timeline.View": true,
    "Calendar.View": true, "Files.View": true, "Reports.View": true,
    "Projects.View": true, "Projects.Edit": true,
    "Projects.Create": false, "Plans.Create": false, "Products.Create": false,
    "Plans.View": true, "Plans.Edit": true, "Plans.Export": true,
    "Products.Edit": true,
    "Milestones.View": true, "Milestones.Edit": true,
    "Team.View": true, "Team.Manage": true,
    "Tasks.Create": true, "Tasks.Edit": true, "Tasks.Assign": true, "Tasks.Reassign": true, "Tasks.Start": true, "Tasks.Complete": true, "Tasks.Approve": true, "Tasks.CompletionApprove": true, "Tasks.ExtensionApprove": true,
    "Procedure.Manage": true, "SubProcedure.Manage": true, "Procedures.View": true, "Procedures.Create": true, "Procedures.Edit": true,
    "Reports.Export": true, "Reports.ExportPdf": true, "Reports.TeamPerformanceView": true,
    "Files.Upload": true, "Files.Download": true, "Files.Edit": true,
    "Calendar.ManageSchedule": true,
    "Chat.View": true, "Chat.Start": true, "Chat.SendMessage": true, "Notification.View": true
  }'::jsonb,
  'team_head',
  true,
  true
)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  scope_type = excluded.scope_type,
  permissions = excluded.permissions,
  is_default_for_role = excluded.is_default_for_role,
  is_system = true,
  updated_at = now();

-- 3.5 باقة موظف قسم
insert into permission_packages (id, code, name, description, scope_type, permissions, is_default_for_role, is_active, is_system)
values (
  '00000000-0000-0000-0000-000000000005',
  'team_member_package',
  'باقة موظف قسم',
  'صلاحيات تشغيلية خاصة بالمهام والإجراءات المسندة إلى الموظف فقط مع إمكانية المحادثة ورفع المرفقات',
  'assigned',
  '{
    "Dashboard.View": true, "Tasks.View": true, "Tasks.ViewAssigned": true,
    "Tasks.Start": true, "Tasks.Complete": true, "Tasks.CompleteSubmit": true, "Tasks.ExtensionRequest": true,
    "Tasks.Create": false, "Tasks.Edit": false, "Tasks.Assign": false, "Tasks.Approve": false,
    "Projects.Create": false, "Projects.Edit": false, "Plans.Create": false, "Plans.Edit": false, "Products.Create": false,
    "Procedures.View": true, "Procedures.Create": true, "Procedures.EditAssigned": true,
    "SubProcedures.View": true, "SubProcedures.Create": true, "SubProcedures.EditAssigned": true,
    "Files.View": true, "Files.Upload": true, "Files.Download": true,
    "Chat.View": true, "Chat.SendMessage": true, "Chat.MentionTask": true, "Notification.View": true
  }'::jsonb,
  'user',
  true,
  true
)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  scope_type = excluded.scope_type,
  permissions = excluded.permissions,
  is_default_for_role = excluded.is_default_for_role,
  is_system = true,
  updated_at = now();

-- 4. Safely migrate existing users to the 5 standardized roles & package links
-- Map 'team_lead' -> 'team_head'
update profiles set role = 'team_head' where role = 'team_lead';

-- Migrate role to standard packages & scopes
update profiles set
  package_id = case
    when role = 'admin' then '00000000-0000-0000-0000-000000000001'::uuid
    when role = 'project_manager' then '00000000-0000-0000-0000-000000000002'::uuid
    when role = 'department_manager' then '00000000-0000-0000-0000-000000000003'::uuid
    when role = 'team_head' then '00000000-0000-0000-0000-000000000004'::uuid
    else '00000000-0000-0000-0000-000000000005'::uuid
  end,
  scope_type = case
    when role = 'admin' then 'global'
    when role = 'project_manager' then 'project'
    when role in ('department_manager', 'team_head') then 'department'
    else 'assigned'
  end,
  assigned_department = coalesce(assigned_department, department)
where package_id is null;

-- Populate assigned_project_ids for project managers who manage projects
update profiles p
set assigned_project_ids = (
  select coalesce(jsonb_agg(pr.id), '[]'::jsonb)
  from projects pr
  where pr.manager_id = p.id and pr.deleted_at is null
)
where p.role = 'project_manager' and (p.assigned_project_ids is null or p.assigned_project_ids = '[]'::jsonb);
