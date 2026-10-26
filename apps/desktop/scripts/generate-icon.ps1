Add-Type -AssemblyName System.Drawing

$outputDirectory = Join-Path $PSScriptRoot '..\build'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$outputPath = Join-Path $outputDirectory 'icon.png'

$bitmap = New-Object System.Drawing.Bitmap 512, 512
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(24, 27, 29))

$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 94, 87))
$light = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(244, 244, 241))

$graphics.FillEllipse($accent, 88, 88, 336, 336)
$graphics.FillEllipse($light, 224, 224, 64, 64)

$barWidths = 28, 28, 28, 28
$barHeights = 92, 190, 138, 70
$barX = 154, 202, 250, 298
for ($index = 0; $index -lt $barX.Count; $index += 1) {
  $height = $barHeights[$index]
  $rectangle = New-Object System.Drawing.RectangleF $barX[$index], ((512 - $height) / 2), $barWidths[$index], $height
  $graphics.FillRectangle($light, $rectangle)
}

$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
$accent.Dispose()
$light.Dispose()

Write-Output $outputPath
