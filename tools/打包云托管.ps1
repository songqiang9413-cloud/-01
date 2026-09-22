<#
  打包「微信云托管」部署包
  ------------------------------------------------------------
  用法（在项目根目录执行）：
        powershell -ExecutionPolicy Bypass -File tools\打包云托管.ps1

  产物：dist\云托管部署包\  —— 把这个文件夹整个上传到云托管控制台即可。
  注意：云托管容器没有持久硬盘，data 目录（埋点、余额）在重新发布后会清空。

  现在更推荐「绑定 GitHub 仓库」的方式（git push 即发布，见 docs\云托管-GitHub部署步骤.md），
  这个手动上传脚本留着当兜底。手动上传包里没有 node_modules，所以连不了 MySQL（会退回文件存储）。
#>
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'server'
$out  = Join-Path $root 'dist\云托管部署包'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$utf8Bom = New-Object System.Text.UTF8Encoding($true)

if (Test-Path $out) { Remove-Item -LiteralPath $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null

foreach ($item in @('index.js', 'src', 'admin', 'demo')) {
  Copy-Item -LiteralPath (Join-Path $src $item) -Destination $out -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $out 'data') | Out-Null
[IO.File]::WriteAllText((Join-Path $out 'data\.keep'), '', $utf8)

# 必须按 UTF-8 读，PowerShell 5.1 默认会用系统编码(GBK)读，中文注释会乱、并且吞掉换行
$envText = [IO.File]::ReadAllText((Join-Path $src '.env'), [Text.Encoding]::UTF8)

$tokenSecret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
$adminToken  = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ })

$envText = [regex]::Replace($envText, '(?m)^TOKEN_SECRET=[^\r\n]*', 'TOKEN_SECRET=' + $tokenSecret)
$envText = [regex]::Replace($envText, '(?m)^ADMIN_TOKEN=[^\r\n]*', 'ADMIN_TOKEN=' + $adminToken)
$envText = [regex]::Replace($envText, '(?m)^PROXY_DIRECT_HOSTS=[^\r\n]*', 'PROXY_DIRECT_HOSTS=*')
if ($envText -notmatch '(?m)^PROXY_DIRECT_HOSTS=') { $envText += "`r`nPROXY_DIRECT_HOSTS=*" }

$header = @(
  '# ===== 云托管部署包（由 tools\打包云托管.ps1 生成，密钥每次打包都会换新） =====',
  '# 云托管容器没有公网下载域名，所以 PROXY_DIRECT_HOSTS=* ：素材一律直连 CDN，',
  '# 这些 CDN 域名必须加进小程序后台的 downloadFile 合法域名（见 docs\微信合法域名-200个.txt）。',
  ''
) -join "`r`n"
$envText = $header + "`r`n" + $envText

[IO.File]::WriteAllText((Join-Path $out '.env'), $envText, $utf8)
[IO.File]::WriteAllText((Join-Path $out 'env.cloud'), $envText, $utf8)
Copy-Item -LiteralPath (Join-Path $src 'Dockerfile') -Destination $out

$readme = @"
微信云托管部署包（$(Get-Date -Format 'yyyy-MM-dd HH:mm') 生成）

上传步骤：
  1. 微信云托管控制台 -> 服务管理 -> 你的服务 -> 部署发布
  2. 「选择方式」选：手动上传代码包
  3. 「上传方式」选：文件夹，然后选中本文件夹（注意是选中文件夹本身）
  4. 点「发布」，等 2~3 分钟（构建 + 部署）

看板口令（浏览器打开 公网域名/admin?token=口令 ）：
  $adminToken

注意：
  - 容器没有持久硬盘，data 目录（埋点、余额、UV）重新发布会清空，别频繁重发。
  - 小程序端要填云托管的「环境 ID」和「服务名」，见 miniprogram/config/index.js 的 CLOUD。
"@
[IO.File]::WriteAllText((Join-Path $out '部署说明.txt'), $readme, $utf8Bom)

# 自检：确认关键配置真的写进去了（这几行被中文注释吞掉过一次，所以必须验）
$check = [IO.File]::ReadAllText((Join-Path $out '.env'), [Text.Encoding]::UTF8)
$must = @{
  'PARSE_PROVIDER=http'      = ($check -match '(?m)^PARSE_PROVIDER=http\s*$')
  'TOKEN_SECRET 已换新'      = ($check -match '(?m)^TOKEN_SECRET=' + [regex]::Escape($tokenSecret) + '\s*$')
  'ADMIN_TOKEN 已换新'       = ($check -match '(?m)^ADMIN_TOKEN=' + [regex]::Escape($adminToken) + '\s*$')
  'PROXY_DIRECT_HOSTS=*'     = ($check -match '(?m)^PROXY_DIRECT_HOSTS=\*\s*$')
  'PARSE_API_URL 带密钥'     = ($check -match '(?m)^PARSE_API_URL=https://api\.zhuceka\.cn/')
}
"打包完成：" + $out
"  文件数: " + (Get-ChildItem $out -Recurse -File).Count
"  看板口令: " + $adminToken
"  自检："
$bad = 0
foreach ($k in $must.Keys) {
  if ($must[$k]) { "    [OK]   " + $k } else { "    [FAIL] " + $k; $bad++ }
}
if ($bad -gt 0) { throw "配置自检没通过，别上传这个包" }
