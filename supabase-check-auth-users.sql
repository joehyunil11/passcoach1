-- auth.users 가입 기록을 확인합니다.
-- Table Editor의 public 테이블이 아니라 SQL Editor에서 실행하세요.

select
  id,
  email,
  created_at,
  last_sign_in_at,
  email_confirmed_at is not null as email_confirmed,
  raw_user_meta_data->>'name' as name
from auth.users
order by created_at desc
limit 50;
