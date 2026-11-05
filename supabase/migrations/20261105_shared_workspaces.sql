-- PMO Tools — shared workspaces (replaces per-browser localStorage)
-- One row per workspace; the whole board (sections, tasks, comments, …) is in `doc`.
-- Edits use optimistic locking on `version`, so two people editing at once
-- never overwrite each other (the app retries on conflict).

-- ---------- Who is calling (from the signed-in user's token) ----------
create or replace function public.pmo_role() returns text
language sql stable set search_path = '' as $$
  select case coalesce(auth.jwt() -> 'app_metadata' ->> 'role', 'member')
    when 'super_admin' then 'super_admin' when 'admin' then 'admin'
    when 'guest' then 'guest' else 'member' end
$$;

create or replace function public.pmo_email() returns text
language sql stable set search_path = '' as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

-- ---------- Table ----------
create table public.workspaces (
  id            text primary key,
  name          text not null,
  doc           jsonb not null,
  member_emails text[] not null default '{}',
  version       integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    text
);
create unique index workspaces_name_key on public.workspaces (lower(name));
create index workspaces_member_emails_idx on public.workspaces using gin (member_emails);

-- Keep derived columns in sync and protect rules the app can't be trusted with.
create or replace function public.pmo_workspaces_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.doc ->> 'id') is distinct from new.id then
    raise exception 'Workspace id mismatch.';
  end if;
  new.name := left(btrim(coalesce(new.doc ->> 'name', '')), 60);
  if new.name = '' then raise exception 'Enter a workspace name.'; end if;
  new.member_emails := coalesce((
    select array_agg(distinct lower(m ->> 'email'))
    from jsonb_array_elements(coalesce(new.doc -> 'members', '[]'::jsonb)) m
    where coalesce(m ->> 'email', '') <> ''), '{}');
  new.updated_at := now();
  new.updated_by := public.pmo_email();

  if tg_op = 'UPDATE' then
    if new.version <> old.version + 1 then
      raise exception 'This board changed on another device. Please try again.' using errcode = '40001';
    end if;
    if (new.doc -> 'members') is distinct from (old.doc -> 'members')
       and public.pmo_role() not in ('super_admin', 'admin') then
      raise exception 'Only Super Admins and Admins can add or remove members.' using errcode = '42501';
    end if;
    new.created_at := old.created_at;
  else
    new.version := 1;
  end if;
  return new;
end $$;

create trigger workspaces_guard before insert or update on public.workspaces
  for each row execute function public.pmo_workspaces_guard();

-- ---------- Row Level Security ----------
alter table public.workspaces enable row level security;

create policy "view: super admin or member" on public.workspaces for select to authenticated
  using (public.pmo_role() = 'super_admin' or public.pmo_email() = any (member_emails));

create policy "create: super admin or admin" on public.workspaces for insert to authenticated
  with check (public.pmo_role() in ('super_admin', 'admin'));

create policy "edit: not guest, super admin or member" on public.workspaces for update to authenticated
  using (public.pmo_role() <> 'guest'
         and (public.pmo_role() = 'super_admin' or public.pmo_email() = any (member_emails)))
  with check (public.pmo_role() <> 'guest'
         and (public.pmo_role() in ('super_admin', 'admin') or public.pmo_email() = any (member_emails)));

create policy "delete: super admin" on public.workspaces for delete to authenticated
  using (public.pmo_role() = 'super_admin');

-- ---------- Helpers for file permissions ----------
create or replace function public.pmo_can_view_ws(ws_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspaces w where w.id = ws_id
    and (public.pmo_role() = 'super_admin' or public.pmo_email() = any (w.member_emails)))
$$;

create or replace function public.pmo_can_edit_ws(ws_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.pmo_role() <> 'guest' and public.pmo_can_view_ws(ws_id)
$$;

revoke execute on function public.pmo_can_view_ws(text) from public, anon;
revoke execute on function public.pmo_can_edit_ws(text) from public, anon;
grant execute on function public.pmo_can_view_ws(text) to authenticated;
grant execute on function public.pmo_can_edit_ws(text) to authenticated;

-- ---------- File storage: attachments/<workspace id>/<file id> ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 10485760)
on conflict (id) do nothing;

create policy "attachments: read if can view workspace" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and public.pmo_can_view_ws((storage.foldername(name))[1]));

create policy "attachments: upload if can edit workspace" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and public.pmo_can_edit_ws((storage.foldername(name))[1]));

create policy "attachments: delete if can edit workspace" on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and public.pmo_can_edit_ws((storage.foldername(name))[1]));

-- ---------- Live updates ----------
alter publication supabase_realtime add table public.workspaces;

-- ---------- Follow-up: keep file-permission helpers out of the public API ----------
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
alter function public.pmo_can_view_ws(text) set schema private;
alter function public.pmo_can_edit_ws(text) set schema private;
create or replace function private.pmo_can_edit_ws(ws_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.pmo_role() <> 'guest' and private.pmo_can_view_ws(ws_id)
$$;
