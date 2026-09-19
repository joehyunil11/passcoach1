@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "URL=http://127.0.0.1:5501/index.html"
set "HEALTH=http://127.0.0.1:5501/api/health"

rem 이미 서버가 켜져 있으면 그대로 사용합니다.
curl -s -o nul -m 2 "%HEALTH%" && goto open

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 설치한 뒤 다시 실행해 주세요.
  pause
  exit /b 1
)

if not exist "node_modules\@supabase\supabase-js" (
  echo 필요한 패키지를 설치합니다...
  call npm install
  if errorlevel 1 (
    echo 패키지 설치에 실패했습니다. 인터넷 연결을 확인한 뒤 다시 실행해 주세요.
    pause
    exit /b 1
  )
)

echo 서버를 시작합니다...
start "passcoach9ai-server" /min cmd /k "node server.js"

for /l %%i in (1,1,30) do (
  curl -s -o nul -m 2 "%HEALTH%" && goto open
  timeout /t 1 /nobreak >nul
)

echo 서버가 응답하지 않습니다. 최소화된 passcoach9ai-server 창의 오류 메시지를 확인해 주세요.
pause
exit /b 1

:open
start "" "%URL%"
exit /b 0
