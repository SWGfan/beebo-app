# Generates the installable-web-app icons in desktop/apps/desktop/electron/pwa/.
#
# Source: the Android launcher artwork (apps/core/.../drawable-xxxhdpi/ic_launcher_foreground.png), the
# largest square brand image in the repo: 432x432, opaque, full-bleed. It is only ever scaled DOWN (or
# copied as-is), never enlarged, so no size here is an upscale. A true 512 or 1024 master would let us
# ship a 512 icon; until then the biggest icon is the native 432.
#
#   icon-192.png            192x192  (manifest "any" and "maskable" 192, browser tab icon)
#   icon-432.png            432x432  (manifest "any" and "maskable"; the source, copied byte for byte)
#   apple-touch-icon.png    180x180  (iPhone; iOS rounds the corners itself and needs no transparency)
#   apple-touch-icon-167.png 167x167 (iPad Pro), apple-touch-icon-152.png 152x152 (iPad)
#
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File tools\make-pwa-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'apps\core\app\src\main\res\drawable-xxxhdpi\ic_launcher_foreground.png'
$out = Join-Path $root 'desktop\apps\desktop\electron\pwa'
New-Item -ItemType Directory -Force $out | Out-Null

$src = [System.Drawing.Bitmap]::FromFile($source)
if ($src.Width -ne 432 -or $src.Height -ne 432) { throw "Unexpected source size $($src.Width)x$($src.Height)" }

function Save-Scaled([int]$size, [string]$name) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $size, $size)
  $g.Dispose()
  $bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

Save-Scaled 192 'icon-192.png'
Save-Scaled 180 'apple-touch-icon.png'
Save-Scaled 167 'apple-touch-icon-167.png'
Save-Scaled 152 'apple-touch-icon-152.png'
Copy-Item $source (Join-Path $out 'icon-432.png') -Force
$src.Dispose()
Get-ChildItem $out | Select-Object Name, Length
