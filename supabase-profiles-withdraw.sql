-- 회원 탈퇴 후에도 profiles 행을 남깁니다.
-- status 컬럼에 '회원탈퇴'가 들어가고, 가입 당시 email은 그대로 둡니다.
-- Supabase SQL Editor에서 이 파일 전체를 실행하세요.

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists status text default '가입';

update public.profiles
set status = '가입'
where status is null or btrim(status) = '';

comment on column public.profiles.status is '가입 | 회원탈퇴';
comment on column public.profiles.email is '가입 시 이메일';

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
