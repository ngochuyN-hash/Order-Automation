# png-to-ico.ps1 — Convert a PNG to a multi-resolution ICO (PNG-embedded entries)
param(
    [string]$Source = "C:\Users\Huy\.qoder\vibe_images\app-icon_1784963685.png",
    [string]$Output = "c:\Antigravity\Order Automation\resources\icon.ico"
)

Add-Type -AssemblyName System.Drawing

$sizes = @(256, 128, 64, 48, 32, 16)
$src = [System.Drawing.Image]::FromFile($Source)

# Resize each size and encode as PNG bytes
$pngBlobs = @()
foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBlobs += ,($ms.ToArray())
    $ms.Dispose()
    $bmp.Dispose()
}
$src.Dispose()

# Build ICO binary: ICONDIR + ICONDIRENTRY[] + PNG blobs
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)

# ICONDIR
$bw.Write([UInt16]0)          # reserved
$bw.Write([UInt16]1)          # type: 1 = icon
$bw.Write([UInt16]$sizes.Count)

# Calculate offsets: header(6) + entries(16 * N)
$dataOffset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $blob = $pngBlobs[$i]
    $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))  # width (0 = 256)
    $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))  # height (0 = 256)
    $bw.Write([byte]0)         # colorCount (0 for >= 8bpp)
    $bw.Write([byte]0)         # reserved
    $bw.Write([UInt16]1)       # planes
    $bw.Write([UInt16]32)      # bitCount
    $bw.Write([UInt32]$blob.Length)
    $bw.Write([UInt32]$dataOffset)
    $dataOffset += $blob.Length
}

# Append PNG blobs
foreach ($blob in $pngBlobs) {
    $bw.Write($blob)
}

$bw.Flush()
[System.IO.File]::WriteAllBytes($Output, $out.ToArray())
$bw.Dispose()
$out.Dispose()

Write-Host "ICO created: $Output ($($sizes -join ', ') px, $([math]::Round((Get-Item $Output).Length / 1024)) KB)"
