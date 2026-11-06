Add-Type -AssemblyName System.Drawing

$sourceSize = 1024
$targetSize = 512
$scale = 2.0
$outputPath = Join-Path $PSScriptRoot 'icon.png'

function New-RoundedRectanglePath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

$bitmap = [System.Drawing.Bitmap]::new($sourceSize, $sourceSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

$shadowPath = New-RoundedRectanglePath (28 * $scale) (38 * $scale) (456 * $scale) (456 * $scale) (108 * $scale)
$shadowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(24, 51, 68, 61))
$graphics.FillPath($shadowBrush, $shadowPath)

$backgroundPath = New-RoundedRectanglePath (24 * $scale) (24 * $scale) (464 * $scale) (464 * $scale) (112 * $scale)
$backgroundBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#f9fbfa'))
$graphics.FillPath($backgroundBrush, $backgroundPath)
$borderPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#e2e8e4'), 1.5 * $scale)
$graphics.DrawPath($borderPen, $backgroundPath)

$wavePath = [System.Drawing.Drawing2D.GraphicsPath]::new()
$wavePath.StartFigure()
$wavePath.AddBezier(110 * $scale, 260 * $scale, 142 * $scale, 260 * $scale, 145 * $scale, 188 * $scale, 180 * $scale, 188 * $scale)
$wavePath.AddBezier(180 * $scale, 188 * $scale, 217 * $scale, 188 * $scale, 216 * $scale, 332 * $scale, 252 * $scale, 332 * $scale)
$wavePath.AddBezier(252 * $scale, 332 * $scale, 288 * $scale, 332 * $scale, 290 * $scale, 164 * $scale, 327 * $scale, 164 * $scale)
$wavePath.AddBezier(327 * $scale, 164 * $scale, 364 * $scale, 164 * $scale, 365 * $scale, 260 * $scale, 402 * $scale, 260 * $scale)
$waveBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.PointF]::new(110 * $scale, 256 * $scale),
  [System.Drawing.PointF]::new(402 * $scale, 256 * $scale),
  [System.Drawing.ColorTranslator]::FromHtml('#46d8b0'),
  [System.Drawing.ColorTranslator]::FromHtml('#5b8def')
)
$wavePen = [System.Drawing.Pen]::new($waveBrush, 42 * $scale)
$wavePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$wavePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$wavePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$graphics.DrawPath($wavePen, $wavePath)

$beatBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#ff7b78'))
$graphics.FillEllipse($beatBrush, (381 * $scale), (239 * $scale), (42 * $scale), (42 * $scale))

$target = [System.Drawing.Bitmap]::new($targetSize, $targetSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$targetGraphics = [System.Drawing.Graphics]::FromImage($target)
$targetGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$targetGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$targetGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$targetGraphics.DrawImage($bitmap, 0, 0, $targetSize, $targetSize)
$target.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$targetGraphics.Dispose()
$target.Dispose()
$beatBrush.Dispose()
$wavePen.Dispose()
$waveBrush.Dispose()
$wavePath.Dispose()
$borderPen.Dispose()
$backgroundBrush.Dispose()
$backgroundPath.Dispose()
$shadowBrush.Dispose()
$shadowPath.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output $outputPath
