-- Migration 015: Public Registration Settings and Request Workflow
begin;

-- 1. Extend user_status enum
do $$ begin
  alter type user_status add value if not exists 'rejected';
exception when duplicate_object then null; end $$;

do $$ begin
  alter type user_status add value if not exists 'suspended';
exception when duplicate_object then null; end $$;

do $$ begin
  alter type user_status add value if not exists 'needs_info';
exception when duplicate_object then null; end $$;

-- 2. Add columns to profiles for registration request metadata
alter table profiles add column if not exists mobile text;
alter table profiles add column if not exists request_notes text;
alter table profiles add column if not exists rejection_reason text;
alter table profiles add column if not exists request_info_note text;
alter table profiles add column if not exists approved_by uuid references profiles(id) on delete set null;
alter table profiles add column if not exists approved_at timestamptz;
alter table profiles add column if not exists reviewed_by uuid references profiles(id) on delete set null;
alter table profiles add column if not exists reviewed_at timestamptz;

-- 3. Add public registration configuration to app_settings
alter table app_settings add column if not exists allow_public_signup boolean not null default true;
alter table app_settings add column if not exists public_registration_enabled boolean not null default true;

-- Indexes for registration status and lookup
create index if not exists profiles_status_idx on profiles(status) where deleted_at is null;
create index if not exists profiles_mobile_idx on profiles(mobile) where mobile is not null and deleted_at is null;

commit;
