# Browser-use MCP watchdog — V293 permanent connection fix.
#
# The MCP endpoint MCP hosts configure (http://127.0.0.1:8790/mcp) is served by
# the DESKTOP APP itself (the desktop Electron browser surface), never by the
# old headless Chrome CLI daemon. This watchdog guarantees that endpoint:
#   - Desktop app already listening on 8790 -> exit 0 (healthy, nothing to do).
#   - Port free -> start the desktop app (packaged build preferred, dev fallback).
#   - App dies later -> the next watchdog pass relaunches it.
# Registered as a Scheduled Task at logon: BrowserUseMcpDaemon. Safe to run any
# number of times concurrently: existing healthy instance -> exit 0.

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here                       # tools/browser-use
$packagedExe = Join-Path $root 'desktop-release\win-unpacked\Browser-use.exe'
$port = 8790
$log = Join-Path $here 'daemon.log'

function Test-Port($p) {
  $c = Test-NetConnection -ComputerName 127.0.0.1 -Port $p -WarningAction SilentlyContinue
  return $c.TcpTestSucceeded
}

function Write-Log($message) {
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $log -Value "[$stamp] $message" -Encoding utf8
}

if (Test-Port $port) { Write-Output "desktop MCP already up on $port"; exit 0 }

Write-Output "desktop MCP endpoint free on 127.0.0.1:$port — starting the desktop app"
Write-Log "starting desktop app (packaged=$(Test-Path $packagedExe))"

if (Test-Path $packagedExe) {
  Start-Process -FilePath $packagedExe -WorkingDirectory (Split-Path -Parent $packagedExe) -WindowStyle Hidden | Out-Null
} else {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run desktop:dev' -WorkingDirectory $root -WindowStyle Minimized | Out-Null
}

# Wait for the endpoint to come up, then keep supervising: if the app exits or
# the port dies, relaunch — this is what makes the MCP connection permanent.
while ($true) {
  Start-Sleep -Seconds 10
  if (Test-Port $port) {
    Start-Sleep -Seconds 60
    continue
  }
  Write-Log "port $port died — relaunching desktop app"
  if (Test-Path $packagedExe) {
    Start-Process -FilePath $packagedExe -WorkingDirectory (Split-Path -Parent $packagedExe) -WindowStyle Hidden | Out-Null
  } else {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run desktop:dev' -WorkingDirectory $root -WindowStyle Minimized | Out-Null
  }
  Start-Sleep -Seconds 15
}
