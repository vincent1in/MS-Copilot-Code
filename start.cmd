@echo off
rem Start the gateway and open its page (Windows): double-click this file.
rem The same as "node dist\cli.mjs start"; add --no-open to print the page's link instead.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or later is needed, and none was found. Install it from nodejs.org, then run this again.
  pause
  exit /b 1
)
for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo Node.js 22 or later is needed.
  node --version
  pause
  exit /b 1
)
if not exist dist\cli.mjs (
  echo dist\ is missing. In a source checkout, build it first: npm ci --ignore-scripts, then npm run build
  pause
  exit /b 1
)

node dist\cli.mjs start %*
if errorlevel 1 pause
