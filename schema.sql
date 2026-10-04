-- MLearning schema
-- Tables and columns used by index.js. Apply in the Supabase SQL editor.
-- The app connects with SUPABASE_SERVICE_ROLE_KEY, which bypasses row level security.
-- This script does not enable RLS and does not store secrets.

create table if not exists public.learn_events (
  id bigint generated always as identity primary key,
  source text not null,
  app text,
  level text,
  tool text not null,
  message text not null,
  context jsonb,
  signature_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists learn_events_created_at_idx
  on public.learn_events (created_at desc);

create table if not exists public.error_events (
  id bigint generated always as identity primary key,
  source text not null,
  app text,
  tool text not null,
  message text not null,
  context jsonb,
  signature_hash text not null
);

create table if not exists public.verified_solutions (
  id bigint generated always as identity primary key,
  signature_hash text not null unique,
  summary text,
  solution text,
  confidence_score double precision,
  auto_applicable boolean
);

create table if not exists public.fix_attempts (
  id bigint generated always as identity primary key,
  source text,
  target_file text,
  fix_type text,
  mode text,
  changed boolean,
  summary text,
  diff_count integer
);

create table if not exists public.applied_patches (
  id bigint generated always as identity primary key,
  source text,
  project text,
  target_file text,
  patch_type text,
  patch_key text not null unique,
  summary text,
  backup_name text,
  created_at timestamptz not null default now()
);

create index if not exists applied_patches_created_at_idx
  on public.applied_patches (created_at desc);

create table if not exists public.code_proposals (
  id bigint generated always as identity primary key,
  source text,
  project text,
  target_file text,
  insertion_zone text,
  intent text,
  proposed_code text,
  proposal_hash text,
  mode text,
  status text,
  created_at timestamptz not null default now()
);

create index if not exists code_proposals_created_at_idx
  on public.code_proposals (created_at desc);

create table if not exists public.file_snapshots (
  id bigint generated always as identity primary key,
  project text,
  file_path text,
  content_hash text,
  bytes integer
);

grant select, insert, update, delete on public.learn_events to service_role;
grant select, insert, update, delete on public.error_events to service_role;
grant select, insert, update, delete on public.verified_solutions to service_role;
grant select, insert, update, delete on public.fix_attempts to service_role;
grant select, insert, update, delete on public.applied_patches to service_role;
grant select, insert, update, delete on public.code_proposals to service_role;
grant select, insert, update, delete on public.file_snapshots to service_role;

grant usage, select on sequence public.learn_events_id_seq to service_role;
grant usage, select on sequence public.error_events_id_seq to service_role;
grant usage, select on sequence public.verified_solutions_id_seq to service_role;
grant usage, select on sequence public.fix_attempts_id_seq to service_role;
grant usage, select on sequence public.applied_patches_id_seq to service_role;
grant usage, select on sequence public.code_proposals_id_seq to service_role;
grant usage, select on sequence public.file_snapshots_id_seq to service_role;
