Add-Type -AssemblyName System.Drawing

$assetRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function New-RoundedPath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Draw-ErpGlyph($graphics, [float]$x, [float]$y, [float]$size) {
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $soft = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 255, 255, 255))
  $unit = $size / 8
  $graphics.FillRectangle($white, $x, $y + $unit * 4.2, $unit * 1.3, $unit * 3.1)
  $graphics.FillRectangle($white, $x + $unit * 2, $y + $unit * 2.4, $unit * 1.3, $unit * 4.9)
  $graphics.FillRectangle($white, $x + $unit * 4, $y + $unit * .7, $unit * 3.5, $unit * 6.6)
  foreach ($row in 0..2) {
    foreach ($col in 0..1) {
      $graphics.FillRectangle($soft, $x + $unit * (4.6 + $col * 1.35), $y + $unit * (1.45 + $row * 1.45), $unit * .72, $unit * .72)
    }
  }
  $white.Dispose(); $soft.Dispose()
}

# NSIS Modern UI welcome/finish bitmap: 164 x 314.
$sidebar = New-Object System.Drawing.Bitmap 164, 314
$g = [System.Drawing.Graphics]::FromImage($sidebar)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Rectangle 0, 0, 164, 314),
  [System.Drawing.Color]::FromArgb(0, 122, 255),
  [System.Drawing.Color]::FromArgb(78, 86, 224),
  90
)
$g.FillRectangle($gradient, 0, 0, 164, 314)

$glow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(22, 255, 255, 255))
$g.FillEllipse($glow, 26, 20, 122, 122)
$tilePath = New-RoundedPath 49 47 66 66 15
$tileBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(32, 255, 255, 255))
$tilePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(34, 255, 255, 255)), 1
$g.FillPath($tileBrush, $tilePath); $g.DrawPath($tilePen, $tilePath)
Draw-ErpGlyph $g 62 62 39

$titleFont = New-Object System.Drawing.Font 'Segoe UI', 12, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$subFont = New-Object System.Drawing.Font 'Segoe UI', 9, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$whiteBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$softWhite = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(220, 255, 255, 255))
$g.DrawString('ERPNext Desktop', $titleFont, $whiteBrush, 12, 139)
$g.DrawString('One setup. Your complete ERP.', $subFont, $softWhite, 12, 160)

$linePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(44, 255, 255, 255)), 1
$g.DrawLine($linePen, 12, 190, 150, 190)
$smallBold = New-Object System.Drawing.Font 'Segoe UI', 8, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$small = New-Object System.Drawing.Font 'Segoe UI', 8, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('LOCAL', $smallBold, $whiteBrush, 12, 207)
$g.DrawString('PRIVATE', $smallBold, $whiteBrush, 61, 207)
$g.DrawString('OPEN', $smallBold, $whiteBrush, 115, 207)
$g.DrawString('ERPNext, official apps and', $small, $softWhite, 12, 236)
$g.DrawString('required Windows components.', $small, $softWhite, 12, 250)
$g.DrawString('Version 0.1', $small, $softWhite, 12, 289)

$sidebar.Save((Join-Path $assetRoot 'installer-sidebar.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $sidebar.Dispose(); $gradient.Dispose(); $glow.Dispose(); $tilePath.Dispose(); $tileBrush.Dispose(); $tilePen.Dispose(); $titleFont.Dispose(); $subFont.Dispose(); $smallBold.Dispose(); $small.Dispose(); $whiteBrush.Dispose(); $softWhite.Dispose(); $linePen.Dispose()

# NSIS Modern UI header bitmap: 150 x 57, logo aligned to the right.
$header = New-Object System.Drawing.Bitmap 150, 57
$h = [System.Drawing.Graphics]::FromImage($header)
$h.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$h.Clear([System.Drawing.Color]::White)
$headerTile = New-RoundedPath 96 8 42 42 10
$headerGradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Rectangle 96, 8, 42, 42),
  [System.Drawing.Color]::FromArgb(0, 122, 255),
  [System.Drawing.Color]::FromArgb(72, 88, 224),
  75
)
$h.FillPath($headerGradient, $headerTile)
Draw-ErpGlyph $h 105 17 24
$header.Save((Join-Path $assetRoot 'installer-header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$h.Dispose(); $header.Dispose(); $headerTile.Dispose(); $headerGradient.Dispose()
