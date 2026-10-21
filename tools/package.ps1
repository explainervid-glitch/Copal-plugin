<#
    Builds a distributable bundle for installing on another machine.

        powershell -ExecutionPolicy Bypass -File tools\package.ps1
        powershell -ExecutionPolicy Bypass -File tools\package.ps1 -NoZip

    The output holds the installer and the panel and nothing else. Tests, the
    preview server, git data and the development debug port file all stay
    behind, because none of them are needed to run the panel and the debug
    file would open a port on an installed copy.

    Copy the zip to the other machine, unpack it anywhere, and run install.bat.
#>

[CmdletBinding()]
param(
    [switch]$NoZip,
    [string]$OutputDir
)

$ErrorActionPreference = 'Stop'

$BundleId = 'com.copal.panel'
$Root = Split-Path -Parent $PSScriptRoot
$PanelSource = Join-Path $Root "cep\$BundleId"

function Write-Ok   ($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green  }
function Write-Step ($msg) { Write-Host "`n  >>  $msg" -ForegroundColor Cyan  }

if (-not (Test-Path (Join-Path $PanelSource 'CSXS\manifest.xml'))) {
    throw "Panel not found at $PanelSource"
}

# ---- Version comes from the manifest, so the bundle name cannot drift ----
$manifest = [xml](Get-Content (Join-Path $PanelSource 'CSXS\manifest.xml') -Raw)
$version = $manifest.ExtensionManifest.ExtensionBundleVersion
if (-not $version) { throw 'manifest.xml has no ExtensionBundleVersion' }

$distRoot = if ($OutputDir) { $OutputDir } else { Join-Path $Root 'dist' }
$name = "copal-$version"
$stage = Join-Path $distRoot $name

Write-Host ""
Write-Host "  Packaging Copal $version" -ForegroundColor Cyan

# ---- Stage ----
Write-Step 'Staging files...'

if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $stage 'cep') -Force | Out-Null

Copy-Item (Join-Path $Root 'install.bat')  $stage -Force
Copy-Item (Join-Path $Root 'operator.ps1') $stage -Force
Write-Ok 'install.bat, operator.ps1'

Copy-Item $PanelSource (Join-Path $stage "cep\$BundleId") -Recurse -Force
Write-Ok "cep\$BundleId"

# The debug port file belongs to development, not to a shipped copy.
$debugFile = Join-Path $stage "cep\$BundleId\.debug"
if (Test-Path -LiteralPath $debugFile) {
    Remove-Item -LiteralPath $debugFile -Force
    Write-Ok 'removed .debug'
}

# ---- A short note for whoever runs it ----
$readme = @"
Copal $version - After Effects panel
========================================

To install:

  1. Run install.bat. It asks for administrator rights, copies the panel into
     Adobe's extensions folder, and allows After Effects to load it.

  2. Restart After Effects, then open Window > Extensions > Copal.

To use it:

  Save     Select a shape layer, or a group, fill or stroke inside it, and
           press +. Its fill and stroke become a palette in the panel.

  Apply    Select one or more shape layers, or parts of their Contents, and
           double click a palette.

  Picture  Drag an image onto the panel, click any colour you do not want,
           and press the tick. Each colour kept becomes a fill palette.

  Right click a palette to rename it, replace it or delete it.

Where palettes are kept:

  This project   copal.json beside the .aep, shared by every project
                 saved in that folder.
  All projects   copal.json in your own settings folder.

  Both are plain JSON. To hand a set of palettes to someone else, send them
  the file.

Requires After Effects 2019 or later, on Windows.
"@
Set-Content -Path (Join-Path $stage 'READ ME FIRST.txt') -Value $readme -Encoding UTF8
Write-Ok 'READ ME FIRST.txt'

# ---- Zip ----
if (-not $NoZip) {
    Write-Step 'Compressing...'
    $zip = Join-Path $distRoot "$name.zip"
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }

    <#
        The entries are written by hand rather than with Compress-Archive or
        ZipFile.CreateFromDirectory. On .NET Framework both of those use the
        platform separator inside the archive, so a zip built on Windows holds
        backslashes, which the zip format does not allow. Windows unpacks them
        anyway; other tools produce a flat pile of files with backslashes in
        their names instead of folders, and the installer on the other machine
        then cannot find the panel.
    #>
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $zipStream = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
    $archive = New-Object System.IO.Compression.ZipArchive(
        $zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $stage -Recurse -File) {
            $relative = $file.FullName.Substring($stage.Length + 1).Replace('\', '/')
            $entry = $archive.CreateEntry($relative,
                [System.IO.Compression.CompressionLevel]::Optimal)
            $source = [System.IO.File]::OpenRead($file.FullName)
            $target = $entry.Open()
            try { $source.CopyTo($target) } finally { $target.Dispose(); $source.Dispose() }
        }
    } finally {
        $archive.Dispose()
        $zipStream.Dispose()
    }

    $sizeKB = [math]::Round((Get-Item $zip).Length / 1KB)
    Write-Ok "$zip  ($sizeKB KB)"
}

# ---- Report ----
$files = Get-ChildItem -LiteralPath $stage -Recurse -File
Write-Step "Bundle contains $($files.Count) files:"
foreach ($f in $files) {
    $relative = $f.FullName.Substring($stage.Length + 1)
    Write-Host ("      {0,-42} {1,6} KB" -f $relative, [math]::Round($f.Length / 1KB, 1)) -ForegroundColor Gray
}

Write-Host ""
Write-Host "  Folder : $stage" -ForegroundColor White
if (-not $NoZip) {
    Write-Host "  Zip    : $(Join-Path $distRoot "$name.zip")" -ForegroundColor White
}
Write-Host ""
Write-Host "  Copy it to the other machine and run install.bat there." -ForegroundColor DarkGray
Write-Host ""
