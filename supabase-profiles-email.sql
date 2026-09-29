-- 회원가입 시 profiles.email 에 가입 이메일이 들어가게 합니다.
-- Supabase SQL Editor에서 이 파일 전체를 실행하세요.

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists created_at timestamptz default now();
alter table public.profiles add column if not exists joined_on date;

comment on column public.profiles.email is '가입 시 이메일';

update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id
  and (p.email is null or btrim(p.email) = '')
  and u.email is not null;

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
    'free',
    '가입',
    coalesce(new.created_at, now()),
    joined
  )
  on conflict (id) do update
    set email = coalesce(nullif(btrim(public.profiles.email), ''), excluded.email),
        nickname = coalesce(public.profiles.nickname, excluded.nickname),
        created_at = coalesce(public.profiles.created_at, excluded.created_at),
        joined_on = coalesce(public.profiles.joined_on, excluded.joined_on);
  return new;
exception when others then
  begin
    insert into public.profiles (id, email, created_at, joined_on)
    values (new.id, new.email, coalesce(new.created_at, now()), joined)
    on conflict (id) do update
      set email = coalesce(nullif(btrim(public.profiles.email), ''), excluded.email),
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

notify pgrst, 'reload schema';
