# Regenerates the favicon and app-icon PNGs in public/ from public/brand/animated-mindmap-logo.png.
#
# Run this after replacing the logo:
#   powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
#
# Why crop rather than just scale: the source is 1254x1254 but the artwork only occupies about
# 1166x981, leaving roughly 135px of transparent letterboxing top and bottom. Scaling the whole
# canvas into a 32px tab icon would spend a third of it on nothing, making the mark look small
# and indistinct. So the alpha bounding box is measured, cropped, and recentred in a square.
#
# The bounds are measured on every run rather than hardcoded, so a differently-padded replacement
# logo still comes out correct.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 (the default `powershell.exe`) reads a
# BOM-less UTF-8 script as Windows-1252, which mangles multi-byte characters. An em dash becomes
# three characters, one of which is a double quote - and that terminates a string early and makes
# the script fail to parse.

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "public\brand\animated-mindmap-logo.png"
$outDir = Join-Path $root "public"

if (-not (Test-Path $src)) {
    Write-Error "Logo not found at $src"
    exit 1
}

$img = [System.Drawing.Bitmap]::FromFile($src)
$w = $img.Width
$h = $img.Height

# --- Measure the alpha bounding box ---
$rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$data = $img.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$img.UnlockBits($data)

$minX = $w
$maxX = -1
$minY = $h
$maxY = -1
for ($y = 0; $y -lt $h; $y++) {
    $row = $y * $data.Stride
    for ($x = 0; $x -lt $w; $x++) {
        if ($bytes[$row + $x * 4 + 3] -gt 12) {
            if ($x -lt $minX) { $minX = $x }
            if ($x -gt $maxX) { $maxX = $x }
            if ($y -lt $minY) { $minY = $y }
            if ($y -gt $maxY) { $maxY = $y }
        }
    }
}

if ($maxX -lt 0) {
    # A fully transparent source would otherwise produce blank icons silently.
    Write-Error "Logo appears to be fully transparent - nothing to crop."
    exit 1
}

$inkX = $minX
$inkY = $minY
$inkW = $maxX - $minX + 1
$inkH = $maxY - $minY + 1
"source {0}x{1}  ->  ink {2}x{3} at ({4},{5})" -f $w, $h, $inkW, $inkH, $inkX, $inkY
""

# 'pad' is a fraction of the output size. Small sizes get none: at 32px every pixel counts and a
# browser tab already insets the icon visually.
$targets = @(
    @{ size = 32;  pad = 0.00; name = "favicon-32.png" },
    @{ size = 48;  pad = 0.00; name = "favicon-48.png" },
    @{ size = 180; pad = 0.04; name = "apple-touch-icon.png" },
    # For the in-app header and empty state - see src/components/AppLogo.tsx. Kept separate from
    # apple-touch-icon.png so UI markup is not semantically borrowing a platform icon.
    @{ size = 192; pad = 0.02; name = "logo-192.png" },
    @{ size = 512; pad = 0.05; name = "icon-512.png" }
)

foreach ($t in $targets) {
    $size = [int]$t.size
    $inset = [int][Math]::Round($size * $t.pad)
    $box = $size - $inset * 2

    # Fit inside the box preserving aspect; this mark is wider than tall, so width binds.
    $scale = [Math]::Min($box / $inkW, $box / $inkH)
    $drawW = [int][Math]::Round($inkW * $scale)
    $drawH = [int][Math]::Round($inkH * $scale)
    $offX = [int][Math]::Round(($size - $drawW) / 2)
    $offY = [int][Math]::Round(($size - $drawH) / 2)

    $out = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($out)
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $destRect = New-Object System.Drawing.Rectangle $offX, $offY, $drawW, $drawH
    $srcRect = New-Object System.Drawing.Rectangle $inkX, $inkY, $inkW, $inkH
    $g.DrawImage($img, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()

    $dest = Join-Path $outDir $t.name
    $out.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()

    "{0,-22} {1,4}x{2,-4} mark {3}x{4}   {5:N1} KB" -f $t.name, $size, $size, $drawW, $drawH, ((Get-Item $dest).Length / 1KB)
}

$img.Dispose()
