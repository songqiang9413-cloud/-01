<#
  「清月水印处理工具」小程序头像生成器
  ------------------------------------------------------------
  用法（在项目根目录执行）：
      powershell -ExecutionPolicy Bypass -File tools\make-avatar.ps1

  产物：assets\logo\ 下的 PNG，每个方案三份
      *-1024.png   存档 / 以后做分享图用
      *-512.png    上传微信后台用的（小程序头像建议 ≥144，512 最稳）
      *-144.png    按微信要求的最小尺寸导出一份，用来看小图效果

  设计要点（微信小程序头像规范）：
      1) 正方形、不透明满铺背景 —— 微信有的地方会裁成圆形，所以月亮和水波都收在中心圆内；
      2) 不用任何第三方平台的 logo / 图标，也不用二维码；
      3) 只用几何图形：弯月代表「清月」，水波代表「去水印」，渐变夜空做底。

  为什么用代码画不用 AI 生图：图标要边缘干净、左右对称，代码画的是数学曲线，
  缩到 144 也不糊，而且零依赖、改个颜色重跑就行。
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'assets\logo'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$RENDER = 1024   # 先按 1024 画，再缩到目标尺寸，边缘更干净

function C([int]$r, [int]$g, [int]$b, [int]$a = 255) {
  return [System.Drawing.Color]::FromArgb($a, $r, $g, $b)
}

# ---------------------------------------------------------------- 配色方案
$palettes = @{
  night = @{ top = (C 8 20 42); bottom = (C 14 66 88); moon = (C 255 244 214); moonDim = (C 246 226 178); ripple = (C 120 226 235); glow = (C 140 210 255) }
  indigo = @{ top = (C 18 14 46); bottom = (C 46 26 88); moon = (C 255 233 176); moonDim = (C 246 214 150); ripple = (C 172 156 255); glow = (C 186 170 255) }
  teal  = @{ top = (C 6 30 42); bottom = (C 10 62 68); moon = (C 236 255 246); moonDim = (C 206 240 230); ripple = (C 126 240 206); glow = (C 150 255 224) }
}

function New-Canvas([hashtable]$pal) {
  $bmp = New-Object System.Drawing.Bitmap($RENDER, $RENDER)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

  # 夜空渐变（上深下浅）
  $rect = New-Object System.Drawing.Rectangle(0, 0, $RENDER, $RENDER)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $pal.top, $pal.bottom, 90.0)
  $g.FillRectangle($brush, $rect)
  $brush.Dispose()
  return @{ bmp = $bmp; g = $g }
}

# 月亮周围的光晕：用径向渐变一次画完
# （早先用「一圈圈椭圆叠加」，alpha 会累加，中间变成一块实心亮圆盘，很难看）
function Add-Glow($g, [double]$cx, [double]$cy, [double]$r, [System.Drawing.Color]$color, [int]$alpha = 90) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse([float]($cx - $r), [float]($cy - $r), [float]($r * 2), [float]($r * 2))
  $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush($path)
  $brush.CenterPoint = New-Object System.Drawing.PointF([float]$cx, [float]$cy)
  $brush.CenterColor = [System.Drawing.Color]::FromArgb($alpha, $color.R, $color.G, $color.B)
  $brush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $color.R, $color.G, $color.B))
  $g.FillPath($brush, $path)
  $brush.Dispose()
  $path.Dispose()
}

# 弯月：外圆挖掉一个错位的圆，剩下的就是月牙
function Add-Crescent($g, [double]$cx, [double]$cy, [double]$r, [double]$cutDx, [double]$cutDy, [double]$cutR, $pal) {
  $outer = New-Object System.Drawing.Drawing2D.GraphicsPath
  $outer.AddEllipse([float]($cx - $r), [float]($cy - $r), [float]($r * 2), [float]($r * 2))
  $inner = New-Object System.Drawing.Drawing2D.GraphicsPath
  $inner.AddEllipse([float]($cx + $cutDx - $cutR), [float]($cy + $cutDy - $cutR), [float]($cutR * 2), [float]($cutR * 2))

  $region = New-Object System.Drawing.Region($outer)
  $region.Exclude($inner)

  $rect = New-Object System.Drawing.Rectangle([int]($cx - $r), [int]($cy - $r), [int]($r * 2), [int]($r * 2))
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $pal.moon, $pal.moonDim, 115.0)
  $g.FillRegion($brush, $region)
  $brush.Dispose()
  $region.Dispose()
  $outer.Dispose()
  $inner.Dispose()
}

function Add-FullMoon($g, [double]$cx, [double]$cy, [double]$r, $pal) {
  $rect = New-Object System.Drawing.Rectangle([int]($cx - $r), [int]($cy - $r), [int]($r * 2), [int]($r * 2))
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $pal.moon, $pal.moonDim, 120.0)
  $g.FillEllipse($brush, [float]($cx - $r), [float]($cy - $r), [float]($r * 2), [float]($r * 2))
  $brush.Dispose()
  # 两个浅一点的环形山，让圆月不那么像一块纯色圆饼
  $crater = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(38, 190, 170, 130))
  $g.FillEllipse($crater, [float]($cx - $r * 0.45), [float]($cy - $r * 0.5), [float]($r * 0.42), [float]($r * 0.42))
  $g.FillEllipse($crater, [float]($cx + $r * 0.1), [float]($cy + $r * 0.15), [float]($r * 0.3), [float]($r * 0.3))
  $crater.Dispose()
}

# 水波：一条正弦曲线，两头细、中间粗，整条一次性填充
# （早先是分段描边，段与段的圆头互相叠加，看起来像一串珠子，所以改成填充带）
function Add-Ripple($g, [double]$y, [double]$thickness, [double]$amplitude, [double]$phase, [int]$alpha, [System.Drawing.Color]$color) {
  $left = 0.08; $right = 0.92; $steps = 120
  $topList = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
  $botList = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
  for ($i = 0; $i -le $steps; $i++) {
    $t = $i / $steps
    $x = $left + ($right - $left) * $t
    $yy = $y + $amplitude * [Math]::Sin(($t * 2 * [Math]::PI * 1.15) + $phase)
    # 两头收细：sin(PI*t)^0.6 在两端趋近 0，中间是 1
    $half = ($thickness / 2) * [Math]::Pow([Math]::Sin([Math]::PI * $t), 0.6)
    $topList.Add((New-Object System.Drawing.PointF([float]($x * $RENDER), [float](($yy - $half) * $RENDER))))
    $botList.Insert(0, (New-Object System.Drawing.PointF([float]($x * $RENDER), [float](($yy + $half) * $RENDER))))
  }
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddCurve($topList.ToArray())
  $path.AddCurve($botList.ToArray())
  $path.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($alpha, $color.R, $color.G, $color.B))
  $g.FillPath($brush, $path)
  $brush.Dispose()
  $path.Dispose()
}

function Add-Stars($g, $pal) {
  $stars = @(
    @(0.20, 0.17, 0.010, 150),
    @(0.79, 0.22, 0.013, 180),
    @(0.31, 0.09, 0.007, 120),
    @(0.70, 0.10, 0.008, 130),
    @(0.16, 0.34, 0.007, 110),
    @(0.86, 0.40, 0.009, 120)
  )
  foreach ($s in $stars) {
    $r = [double]$s[2] * $RENDER
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb([int]$s[3], 255, 255, 255))
    $g.FillEllipse($brush, [float]([double]$s[0] * $RENDER - $r), [float]([double]$s[1] * $RENDER - $r), [float]($r * 2), [float]($r * 2))
    $brush.Dispose()
  }
}

function Add-Text($g, [string]$text, [double]$cx, [double]$cy, [double]$sizeRatio, [System.Drawing.Color]$color, [int]$shadowAlpha = 90) {
  $font = New-Object System.Drawing.Font('微软雅黑', [float]($sizeRatio * $RENDER), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF(0, 0, $RENDER, $RENDER)

  $shadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($shadowAlpha, 6, 16, 34))
  $g.DrawString($text, $font, $shadow, (New-Object System.Drawing.PointF([float]($cx * $RENDER + 3), [float]($cy * $RENDER + 4))), $fmt)
  $shadow.Dispose()

  $brush = New-Object System.Drawing.SolidBrush($color)
  $g.DrawString($text, $font, $brush, (New-Object System.Drawing.PointF([float]($cx * $RENDER), [float]($cy * $RENDER))), $fmt)
  $brush.Dispose()
  $font.Dispose()
  $fmt.Dispose()
}

function Save-All($bmp, [string]$name) {
  foreach ($size in @(1024, 512, 144)) {
    $target = New-Object System.Drawing.Bitmap($size, $size)
    $tg = [System.Drawing.Graphics]::FromImage($target)
    $tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $tg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $tg.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $tg.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
    $tg.Dispose()
    $file = Join-Path $outDir ($name + '-' + $size + '.png')
    $target.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $target.Dispose()
    "{0,-34} {1,5} x {1,-5} {2,7:N1} KB" -f ($name + '-' + $size + '.png'), $size, ((Get-Item $file).Length / 1KB)
  }
}

# ================================================================ 方案 A：弯月 + 水波
function Build-A {
  $pal = $palettes.night
  $c = New-Canvas $pal
  Add-Stars $c.g $pal
  Add-Glow $c.g (0.50 * $RENDER) (0.395 * $RENDER) (0.42 * $RENDER) $pal.glow 105
  Add-Crescent $c.g (0.50 * $RENDER) (0.395 * $RENDER) (0.205 * $RENDER) (0.135 * $RENDER) (-0.075 * $RENDER) (0.190 * $RENDER) $pal
  Add-Ripple $c.g 0.655 0.026 0.019 0.0  225 $pal.ripple
  Add-Ripple $c.g 0.730 0.019 0.017 1.7  160 $pal.ripple
  Add-Ripple $c.g 0.798 0.014 0.014 3.1  105 $pal.ripple
  Save-All $c.bmp 'qingyue-avatar-a'
  $c.bmp.Dispose(); $c.g.Dispose()
}

# ================================================================ 方案 B：弯月 + 「清月」两个字
function Build-B {
  $pal = $palettes.night
  $c = New-Canvas $pal
  Add-Stars $c.g $pal
  Add-Glow $c.g (0.50 * $RENDER) (0.275 * $RENDER) (0.34 * $RENDER) $pal.glow 105
  Add-Crescent $c.g (0.50 * $RENDER) (0.275 * $RENDER) (0.155 * $RENDER) (0.100 * $RENDER) (-0.058 * $RENDER) (0.143 * $RENDER) $pal
  Add-Ripple $c.g 0.462 0.013 0.011 0.4 110 $pal.ripple
  # 两个字分开画，中间留出手工字距（比整串居中好看）
  Add-Text $c.g '清' 0.352 0.665 0.210 (C 250 250 255)
  Add-Text $c.g '月' 0.648 0.665 0.210 (C 250 250 255)
  Add-Ripple $c.g 0.862 0.015 0.013 2.2 140 $pal.ripple
  Save-All $c.bmp 'qingyue-avatar-b'
  $c.bmp.Dispose(); $c.g.Dispose()
}

# ================================================================ 方案 C：圆月 + 水波（深靛）
function Build-C {
  $pal = $palettes.indigo
  $c = New-Canvas $pal
  Add-Stars $c.g $pal
  Add-Glow $c.g (0.50 * $RENDER) (0.38 * $RENDER) (0.40 * $RENDER) $pal.glow 100
  Add-FullMoon $c.g (0.50 * $RENDER) (0.38 * $RENDER) (0.185 * $RENDER) $pal
  Add-Ripple $c.g 0.650 0.026 0.019 0.0  220 $pal.ripple
  Add-Ripple $c.g 0.727 0.019 0.017 1.7  155 $pal.ripple
  Add-Ripple $c.g 0.795 0.014 0.014 3.1  100 $pal.ripple
  Save-All $c.bmp 'qingyue-avatar-c'
  $c.bmp.Dispose(); $c.g.Dispose()
}

"渲染中（每个方案先按 $RENDER x $RENDER 画，再缩到目标尺寸）…"
Build-A
Build-B
Build-C
""
"输出目录：$outDir"
