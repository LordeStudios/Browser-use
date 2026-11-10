# Generate Browser-use icon assets from the supplied icon-source.png.
Add-Type -AssemblyName System.Drawing
$assets = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = [System.Drawing.Image]::FromFile((Join-Path $assets 'icon-source.png'))
function New-IconPng([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $scale = [Math]::Min(($size * 0.92) / $source.Width, ($size * 0.92) / $source.Height)
  $w = [int]($source.Width * $scale); $h = [int]($source.Height * $scale)
  $g.DrawImage($source, [int](($size - $w) / 2), [int](($size - $h) / 2), $w, $h)
  $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
$pngs = @(
  @{ width = 256; path = Join-Path $assets 'browser-use-icon.png' },
  @{ width = 32; path = Join-Path $assets 'browser-use-icon-32.png' },
  @{ width = 16; path = Join-Path $assets 'browser-use-icon-16.png' }
)
foreach ($item in $pngs) { New-IconPng $item.width $item.path }
$images = @($pngs | ForEach-Object { @{ width = ($_.width -band 0xFF); height = ($_.width -band 0xFF); bytes = [IO.File]::ReadAllBytes($_.path) } })
$ms = New-Object IO.MemoryStream; $bw = New-Object IO.BinaryWriter($ms)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$images.Count); $offset = 6 + 16 * $images.Count
foreach ($image in $images) { $bw.Write([byte]$image.width); $bw.Write([byte]$image.height); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$image.bytes.Length); $bw.Write([uint32]$offset); $offset += $image.bytes.Length }
foreach ($image in $images) { $bw.Write($image.bytes) }
$bw.Flush(); [IO.File]::WriteAllBytes((Join-Path $assets 'browser-use-icon.ico'), $ms.ToArray()); $bw.Dispose(); $ms.Dispose(); $source.Dispose()
