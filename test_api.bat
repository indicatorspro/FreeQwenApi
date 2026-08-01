@echo off
REM Simple batch script to test the API

echo.
echo ╔════════════════════════════════════════╗
echo ║  FreeQwenApi - API Test                ║
echo ╚════════════════════════════════════════╝
echo.

echo Starting Node.js tests...
echo.

cd /d D:\Users\Dima\Desktop\FreeQwenApi

echo Test 1: Regular request (non-streaming)
node scripts/run_tests.js
echo.

echo Test 2: Streaming test
node scripts/test_streaming.js
echo.

echo Test 3: Interactive chat (type exit to quit)
node scripts/interactive_chat.js
echo.

echo ╔════════════════════════════════════════╗
echo ║  All tests complete!                   ║
echo ╚════════════════════════════════════════╝
pause
