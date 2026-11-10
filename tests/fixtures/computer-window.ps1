param([string]$WindowTitle)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = $WindowTitle
$form.Size = New-Object System.Drawing.Size(560, 580)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$field = New-Object System.Windows.Forms.TextBox
$field.Location = New-Object System.Drawing.Point(30, 50)
$field.Size = New-Object System.Drawing.Size(470, 30)
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Record value'
$button.Location = New-Object System.Drawing.Point(30, 100)
$button.Size = New-Object System.Drawing.Size(180, 40)
$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(30, 170)
$label.Size = New-Object System.Drawing.Size(470, 70)
$label.Text = 'Native computer-use fixture'
$panel = New-Object System.Windows.Forms.Panel
$panel.Location = New-Object System.Drawing.Point(30, 260)
$panel.Size = New-Object System.Drawing.Size(470, 220)
$panel.BackColor = [System.Drawing.Color]::White
$script:strokePoints = $null
$panel.Add_MouseDown({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $p = $sender.PointToScreen($e.Location)
    $script:strokePoints = [System.Collections.Generic.List[object]]::new()
    $script:strokePoints.Add(@{x=$p.X;y=$p.Y})
  }
})
$panel.Add_MouseMove({
  param($sender, $e)
  if ($null -ne $script:strokePoints) {
    $p = $sender.PointToScreen($e.Location)
    $script:strokePoints.Add(@{x=$p.X;y=$p.Y})
  }
})
$panel.Add_MouseUp({
  param($sender, $e)
  if ($null -ne $script:strokePoints) {
    $p = $sender.PointToScreen($e.Location)
    $script:strokePoints.Add(@{x=$p.X;y=$p.Y})
    [Console]::WriteLine((@{event='stroke';points=$script:strokePoints.ToArray()} | ConvertTo-Json -Depth 5 -Compress))
    [Console]::Out.Flush()
    $script:strokePoints = $null
  }
})
$form.Controls.AddRange(@($field, $button, $label, $panel))
$button.Add_Click({
  $label.Text = $field.Text
  [Console]::WriteLine((@{event='clicked'; text=$field.Text} | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$script:ticks = 0
$timer.Add_Tick({
  $script:ticks++
  $form.BackColor = [System.Drawing.Color]::FromArgb(230, (210 + $script:ticks % 40), 240)
})
$form.Add_Shown({
  $field.Focus()
  $a = $field.PointToScreen((New-Object System.Drawing.Point(15, 12)))
  $b = $button.PointToScreen((New-Object System.Drawing.Point(60, 20)))
  $c = $panel.PointToScreen((New-Object System.Drawing.Point(0, 0)))
  [Console]::WriteLine((@{event='ready'; handle=$form.Handle.ToInt64().ToString(); field=@{x=$a.X;y=$a.Y}; button=@{x=$b.X;y=$b.Y}; region=@{x=$c.X;y=$c.Y;width=$panel.Width;height=$panel.Height}} | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  $timer.Start()
})
try { [void]$form.ShowDialog() } finally { $timer.Stop(); $timer.Dispose(); $form.Dispose() }
