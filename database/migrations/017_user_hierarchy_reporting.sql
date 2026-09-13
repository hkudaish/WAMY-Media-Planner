-- Migration 017: User Hierarchy Reporting & Job Position Standardization
-- Adds reports_to_id column to profiles for organizational hierarchy linking
-- Normalizes existing position titles to the unified 5 standard positions

alter table profiles
  add column if not exists reports_to_id uuid references profiles(id) on delete set null;

create index if not exists idx_profiles_reports_to_id on profiles(reports_to_id);

-- Clean up and normalize legacy position strings to official standardized Arabic titles:
-- 1. مدير النظام (admin)
-- 2. مدير مشروع (project_manager)
-- 3. مدير إدارة (department_manager)
-- 4. رئيس قسم (team_head)
-- 5. موظف قسم (team_member / user)

update profiles
   set position = 'مدير النظام'
 where role = 'admin'
   and (position is null or position = '' or position ilike '%مدير نظام%' or position ilike '%admin%');

update profiles
   set position = 'مدير مشروع'
 where (role = 'project_manager' or position ilike '%مدير مشروع%' or position ilike '%project_manager%')
   and role != 'admin';

update profiles
   set position = 'مدير إدارة'
 where (role = 'department_manager' or position ilike '%مدير إدارة%' or position ilike '%Manager%')
   and role not in ('admin', 'project_manager');

update profiles
   set position = 'رئيس قسم'
 where (role in ('team_head', 'team_lead') or position ilike '%رئيس قسم%' or position ilike '%TeamHead%')
   and role not in ('admin', 'project_manager', 'department_manager');

update profiles
   set position = 'موظف قسم'
 where (role in ('team_member', 'user') or position ilike '%موظف%' or position ilike '%Team Member%' or position is null or position = '')
   and role not in ('admin', 'project_manager', 'department_manager', 'team_head', 'team_lead');
