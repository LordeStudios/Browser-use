$procs = Get-CimInstance Win32_Process -Filter "name='node.exe'"
foreach ($p in $procs) {
  $cmd = if ($p.CommandLine) { $p.CommandLine } else { '' }
  $cpu = [Math]::Round(($p.KernelModeTime + $p.UserModeTime) / 10000000, 1)
  Write-Output ($p.ProcessId.ToString() + ' cpuSec=' + $cpu + ' :: ' + $cmd.Substring(0, [Math]::Min(120, $cmd.Length)))
}
