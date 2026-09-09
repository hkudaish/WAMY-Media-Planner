alter type user_role add value if not exists 'project_manager';
alter type user_role add value if not exists 'department_manager';
alter type user_role add value if not exists 'team_lead';
alter type user_role add value if not exists 'reviewer';
alter type user_role add value if not exists 'approver';
alter type user_role add value if not exists 'read_only';

alter table profiles add column if not exists department text;
alter table profiles add column if not exists team text;
alter table profiles add column if not exists data_scope text not null default 'my_data';

do $$ begin
  alter table profiles add constraint profiles_data_scope_check
    check (data_scope in ('my_data','my_team','my_department','my_project','all_data'));
exception when duplicate_object then null; end $$;

create index if not exists profiles_department_idx on profiles(org,department) where deleted_at is null;
create index if not exists profiles_team_idx on profiles(org,team) where deleted_at is null;

update profiles set permissions = permissions || jsonb_build_object(
  'Dashboard.View', true,
  'MainPlan.View', coalesce((permissions->>'canCreateTasks')::boolean,false),
  'Products.View', true,
  'Tasks.View', true,
  'Timeline.View', true,
  'Calendar.View', true,
  'Files.View', true,
  'Reports.View', coalesce((permissions->>'canExportReports')::boolean,false),
  'Settings.View', coalesce((permissions->>'canManageSettings')::boolean,false) or coalesce((permissions->>'canEditUsers')::boolean,false),
  'Projects.View', coalesce((permissions->>'canCreateTasks')::boolean,false),
  'Projects.Create', false, 'Projects.Edit', false, 'Projects.Delete', false, 'Projects.Archive', false,
  'Plans.View', coalesce((permissions->>'canCreateTasks')::boolean,false),
  'Plans.Create', coalesce((permissions->>'canCreateTasks')::boolean,false),
  'Plans.Import', coalesce((permissions->>'canCreateTasks')::boolean,false),
  'Plans.Edit', coalesce((permissions->>'canCreateTasks')::boolean,false),
  'Plans.Archive', false, 'Plans.Export', coalesce((permissions->>'canExportReports')::boolean,false)
) || jsonb_build_object(
  'Products.Create', false, 'Products.Edit', false, 'Products.Delete', false,
  'Milestones.View', true, 'Milestones.Create', false, 'Milestones.Edit', false, 'Milestones.Delete', false,
  'Tasks.Create', coalesce((permissions->>'canCreateTasks')::boolean,false),
  'Tasks.Edit', coalesce((permissions->>'canCreateTasks')::boolean,false),
  'Tasks.Assign', coalesce((permissions->>'canCreateTasks')::boolean,false),
  'Tasks.Delete', false, 'Tasks.Start', true, 'Tasks.Complete', true, 'Tasks.Approve', false, 'Tasks.Close', false,
  'Reports.Export', coalesce((permissions->>'canExportReports')::boolean,false),
  'Reports.ExecutiveView', coalesce((permissions->>'canExportReports')::boolean,false),
  'Reports.FinancialView', false, 'Reports.TeamPerformanceView', false,
  'Files.Upload', coalesce((permissions->>'canCreateTasks')::boolean,false),
  'Files.Download', true, 'Files.Edit', false, 'Files.Delete', false,
  'Files.Approve', coalesce((permissions->>'canApproveFiles')::boolean,false),
  'Files.MoveToApproved', coalesce((permissions->>'canApproveFiles')::boolean,false)
) || jsonb_build_object(
  'Calendar.Create', false, 'Calendar.Edit', false, 'Calendar.Delete', false,
  'Calendar.ManageSchedule', coalesce((permissions->>'canCreateTasks')::boolean,false),
  'Settings.General', coalesce((permissions->>'canManageSettings')::boolean,false),
  'Settings.Users', coalesce((permissions->>'canEditUsers')::boolean,false),
  'Settings.Roles', coalesce((permissions->>'canEditUsers')::boolean,false),
  'Settings.Permissions', coalesce((permissions->>'canEditUsers')::boolean,false),
  'Settings.Departments', coalesce((permissions->>'canEditUsers')::boolean,false),
  'Settings.Backup', false, 'Settings.Security', false,
  'Settings.Integrations', coalesce((permissions->>'canManageSettings')::boolean,false),
  'Audit.View', false
), data_scope=case when role='admin' then 'all_data' else data_scope end;
