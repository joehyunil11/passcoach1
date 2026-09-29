-- 무료 이용기간 설정.
--  1) 비회원도 공지사항을 읽고, 오류 신고를 쓰고·목록을 보고·비밀번호로 열람할 수 있게 합니다.
--  2) AI 선생님 이용자별 누적 사용횟수(ai_quota)를 Edge Function(ask-ai)이 기록합니다.
-- supabase-notices.sql, supabase-reports.sql 을 먼저 실행한 뒤, Supabase SQL Editor에서 이 파일 전체를 실행하세요.

create extension if not exists pgcrypto with schema extensions;

-- 1) 공지사항: 비회원 읽기 허용
grant select on table public.notices to anon;

drop policy if exists notices_select_anon on public.notices;
create policy notices_select_anon on public.notices
  for select to anon
  using (true);

-- 2) 오류 신고: 비회원 목록·작성·열람 허용 (답변·삭제는 계속 관리자만)
create or replace function public.list_reports()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  payload jsonb;
begin
  select coalesce(jsonb_agg(public.report_summary(r) order by r.created_at desc), '[]'::jsonb)
    into payload
  from public.reports r;
  return payload;
end;
$$;

create or replace function public.create_report(p_title text, p_content text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  title_text text := btrim(coalesce(p_title, ''));
  body_text text := btrim(coalesce(p_content, ''));
  pass_text text := coalesce(p_password, '');
  author text;
  rec public.reports;
begin
  if title_text = '' or body_text = '' then
    raise exception '제목과 내용을 입력해 주세요.';
  end if;
  if char_length(title_text) > 80 or char_length(body_text) > 20000 then
    raise exception '제목 또는 내용이 너무 깁니다.';
  end if;
  if char_length(pass_text) < 4 then
    raise exception '비밀번호는 4자 이상이어야 합니다.';
  end if;
  if auth.uid() is not null then
    select coalesce(nullif(btrim(p.nickname), ''), '회원')
      into author
    from public.profiles p
    where p.id = auth.uid();
    author := coalesce(author, '회원');
  else
    author := '비회원';
  end if;
  insert into public.reports (title, content, password_hash, author_id, author_name)
  values (title_text, body_text, crypt(pass_text, gen_salt('bf')), auth.uid(), author)
  returning * into rec;
  return public.report_detail(rec);
end;
$$;

create or replace function public.open_report(p_id bigint, p_password text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  rec public.reports;
  pass_text text := coalesce(p_password, '');
begin
  select * into rec from public.reports where id = p_id;
  if not found then
    raise exception '글을 찾을 수 없습니다.';
  end if;
  if auth.uid() is not null and public.is_notice_admin() then
    return public.report_detail(rec);
  end if;
  if pass_text = '' then
    raise exception '비밀번호를 입력해 주세요.';
  end if;
  if rec.password_hash is distinct from crypt(pass_text, rec.password_hash) then
    raise exception '비밀번호가 올바르지 않습니다.';
  end if;
  return public.report_detail(rec);
end;
$$;

grant execute on function public.list_reports() to anon, authenticated;
grant execute on function public.create_report(text, text, text) to anon, authenticated;
grant execute on function public.open_report(bigint, text) to anon, authenticated;

-- 3) AI 선생님 누적 사용횟수 (owner_key = 'user:<uuid>' / 'guest:<기기ID>' / 'ip:<주소>')
create table if not exists public.ai_quota (
  owner_key text primary key,
  used integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.ai_quota enable row level security;
revoke all on table public.ai_quota from anon, authenticated, public;

create or replace function public.get_ai_quota(p_key text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select used from public.ai_quota where owner_key = p_key), 0);
$$;

-- 한도 안이면 1 올리고 새 횟수를, 한도를 넘었으면 -1 을 돌려줍니다.
create or replace function public.consume_ai_quota(p_key text, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
begin
  insert into public.ai_quota (owner_key, used) values (p_key, 0)
  on conflict (owner_key) do nothing;
  update public.ai_quota
     set used = used + 1, updated_at = now()
   where owner_key = p_key and used < p_limit
  returning used into v_used;
  return coalesce(v_used, -1);
end;
$$;

create or replace function public.refund_ai_quota(p_key text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
begin
  update public.ai_quota
     set used = greatest(used - 1, 0), updated_at = now()
   where owner_key = p_key
  returning used into v_used;
  return coalesce(v_used, 0);
end;
$$;

revoke all on function public.get_ai_quota(text) from public, anon, authenticated;
revoke all on function public.consume_ai_quota(text, integer) from public, anon, authenticated;
revoke all on function public.refund_ai_quota(text) from public, anon, authenticated;
grant execute on function public.get_ai_quota(text) to service_role;
grant execute on function public.consume_ai_quota(text, integer) to service_role;
grant execute on function public.refund_ai_quota(text) to service_role;

notify pgrst, 'reload schema';
