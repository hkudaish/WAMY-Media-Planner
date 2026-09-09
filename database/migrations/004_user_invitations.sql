create table if not exists user_invitations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  token_hash char(64) not null unique,
  created_by uuid references profiles(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create unique index if not exists user_invitations_active_profile_key
  on user_invitations(profile_id) where accepted_at is null and revoked_at is null;
create index if not exists user_invitations_expiry_idx
  on user_invitations(expires_at) where accepted_at is null and revoked_at is null;
