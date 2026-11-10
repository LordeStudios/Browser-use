$procs = Get-CimInstance Win32_Process -Filter "name='node.exe'"
foreach ($p in $procs) {
  $cmd = if ($p.CommandLine) { $p.CommandLine } else { '' }
  if ($cmd -like '*audit-check*') {
    Write-Output ("KILL " + $p.ProcessId + " :: " + $cmd.Substring(0, [Math]::Min(140, $cmd.Length)))
    Stop-Process -Id $p.ProcessId -Force
  } else {
    Write-Output ("KEEP " + $p.ProcessId + " :: " + $cmd.Substring(0, [Math]::Min(140, $cmd.Length)))
  }
}
