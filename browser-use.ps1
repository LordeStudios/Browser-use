$nodeDir = Split-Path -Parent (Get-Command node).Source
$selfDir = $PSScriptRoot
& "$nodeDir\node.exe" "$selfDir\src\index.js" @args
