-- 로그인한 회원을 모두 premium 으로 둡니다.
-- Supabase SQL Editor에서 한 번 실행하세요.

alter table public.profiles
  alter column plan set default 'premium';

update public.profiles
set plan = 'premium'
where coalesce(plan, '') is distinct from 'premium';
