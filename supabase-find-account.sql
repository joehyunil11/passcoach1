-- 아이디 찾기 · 비밀번호 찾기에 쓰는 조회 함수입니다.
-- Supabase SQL Editor에서 이 파일 전체를 실행하세요.

create or replace function public.mask_email(p_email text)
returns text
language sql
immutable
as $$
  select case
    when p_email is null or position('@' in p_email) < 2 then null
    else left(split_part(p_email, '@', 1), 2)
      || repeat('*', greatest(char_length(split_part(p_email, '@', 1)) - 2, 1))
      || '@'
      || split_part(p_email, '@', 2)
  end;
$$;

create or replace function public.find_account_emails(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_name text;
  v_rows jsonb;
begin
  v_name := trim(both from coalesce(p_name, ''));
  if v_name = '' then
    raise exception '이름을 입력해 주세요.';
  end if;

  select coalesce(jsonb_agg(public.mask_email(x.email)), '[]'::jsonb)
  into v_rows
  from (
    select distinct p.email
    from public.profiles p
    where p.email is not null
      and lower(trim(both from coalesce(p.nickname, ''))) = lower(v_name)
    union
    select distinct u.email
    from auth.users u
    where u.email is not null
      and (
        lower(trim(both from coalesce(u.raw_user_meta_data->>'name', ''))) = lower(v_name)
        or lower(trim(both from coalesce(u.raw_user_meta_data->>'nickname', ''))) = lower(v_name)
      )
  ) x;

  return v_rows;
end;
$$;

create or replace function public.confirm_account_email(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text;
  v_found boolean := false;
begin
  v_email := lower(trim(both from coalesce(p_email, '')));
  if position('@' in v_email) = 0 then
    raise exception '이메일 주소를 입력해 주세요.';
  end if;

  select exists(select 1 from auth.users u where lower(u.email) = v_email)
  into v_found;

  if not v_found then
    select exists(select 1 from public.profiles p where lower(p.email) = v_email)
    into v_found;
  end if;

  if v_found then
    return jsonb_build_object(
      'found', true,
      'email', public.mask_email(v_email),
      'message', '아이디는 가입한 이메일입니다.'
    );
  end if;

  return jsonb_build_object('found', false, 'email', null);
end;
$$;

revoke all on function public.mask_email(text) from public;
revoke all on function public.find_account_emails(text) from public;
revoke all on function public.confirm_account_email(text) from public;

grant execute on function public.mask_email(text) to anon, authenticated;
grant execute on function public.find_account_emails(text) to anon, authenticated;
grant execute on function public.confirm_account_email(text) to anon, authenticated;

notify pgrst, 'reload schema';
