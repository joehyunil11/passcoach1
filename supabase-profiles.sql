-- 회원 프로필. id 는 Supabase Auth(auth.users)를 참조합니다.
-- Supabase SQL Editor에서 supabase-auth-users.sql 을 먼저 실행하세요.
-- 이 파일만 다시 실행해도 됩니다.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text,
  email text,
  target_exam text,
  target_date date,
  plan text default 'premium',
  subjects text[] default '{}',
  daily_target integer default 30,
  notify jsonb default '{"study":true,"review":true,"event":false}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  status text default '가입',
  joined_on date
);

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists subjects text[] default '{}';
alter table public.profiles add column if not exists daily_target integer default 30;
alter table public.profiles add column if not exists notify jsonb default '{"study":true,"review":true,"event":false}'::jsonb;
alter table public.profiles add column if not exists updated_at timestamptz default now();
alter table public.profiles add column if not exists status text default '가입';
alter table public.profiles add column if not exists created_at timestamptz default now();
alter table public.profiles add column if not exists joined_on date;
alter table public.profiles add column if not exists is_admin boolean default false;

alter table public.profiles enable row level security;

revoke all on table public.profiles from anon, public;
grant select, insert, update, delete on table public.profiles to authenticated;

drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists profiles_delete_own on public.profiles;

create policy profiles_select_own on public.profiles
  for select to authenticated using (auth.uid() = id);
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (auth.uid() = id);
create policy profiles_update_own on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
create policy profiles_delete_own on public.profiles
  for delete to authenticated using (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  joined date := (timezone('Asia/Seoul', coalesce(new.created_at, now())))::date;
begin
  insert into public.profiles (id, nickname, email, plan, status, created_at, joined_on)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'nickname',
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    new.email,
    'premium',
    '가입',
    coalesce(new.created_at, now()),
    joined
  )
  on conflict (id) do update
    set email = coalesce(nullif(btrim(public.profiles.email), ''), excluded.email),
        nickname = coalesce(public.profiles.nickname, excluded.nickname),
        plan = 'premium',
        created_at = coalesce(public.profiles.created_at, excluded.created_at),
        joined_on = coalesce(public.profiles.joined_on, excluded.joined_on);
  return new;
exception when others then
  begin
    insert into public.profiles (id, email, plan, created_at, joined_on)
    values (new.id, new.email, 'premium', coalesce(new.created_at, now()), joined)
    on conflict (id) do update
      set email = coalesce(nullif(btrim(public.profiles.email), ''), excluded.email),
          plan = 'premium',
          created_at = coalesce(public.profiles.created_at, excluded.created_at),
          joined_on = coalesce(public.profiles.joined_on, excluded.joined_on);
  exception when others then
    raise warning 'handle_new_user: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.withdraw_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  mail text;
begin
  if uid is null then
    raise exception '로그인이 필요합니다.';
  end if;

  select u.email into mail
  from auth.users u
  where u.id = uid;

  insert into public.profiles (id, email, status, updated_at)
  values (uid, mail, '회원탈퇴', now())
  on conflict (id) do update
    set status = '회원탈퇴',
        email = coalesce(public.profiles.email, excluded.email, mail),
        updated_at = now();
end;
$$;

revoke all on function public.withdraw_account() from public, anon;
grant execute on function public.withdraw_account() to authenticated;

notify pgrst, 'reload schema';
