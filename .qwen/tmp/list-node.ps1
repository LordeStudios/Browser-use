$procs = Get-CimInstance Win32_Process -Filter "name='node.exe'"
foreach ($p in $procs) {
  $cmd = if ($p.CommandLine) { $p.CommandLine } else { '' }
  Write-Output ($p.ProcessId.ToString() + ' :: ' + $cmd.Substring(0, [Math]::Min(180, $cmd.Length)))
}
