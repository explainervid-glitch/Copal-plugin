<#
    Links the CEP panel into the Adobe extensions folder so After Effects
    loads it straight from this repository. Saving a file in the repo then
    shows up on the next panel reload, with no copying or packaging.

    Usage:
        powershell -ExecutionPolicy Bypass -File tools\link-dev.ps1
        powershell -ExecutionPolicy Bypass -File tools\link-dev.ps1 -Unlink

    Creating a symbolic link needs either an elevated shell or Windows
    Developer Mode. Without both, the script falls back to a directory
    junction, which After Effects treats identically and which any user can
    create.
#>

[CmdletBinding()]
param(
    [switch]$Unlink,
    [switch]$AllUsers   # link into Common Files instead of the user profile
)

$ErrorActionPreference = 'Stop'

$BundleId = 'com.copal.panel'
$Source = Join-Path (Split-Path -Parent $PSScriptRoot) "cep\$BundleId"

$ExtensionsDir = if ($AllUsers) {
    'C:\Program Files (x86)\Common Files\Adobe\CEP\extensions'
} else {
    Join-Path $env:APPDATA 'Adobe\CEP\extensions'
}
$Link = Join-Path $ExtensionsDir $BundleId

function Get-LinkTarget($path) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $null }
    if ($item.LinkType) { return $item.Target }
    return $null
}

if ($Unlink) {
    if (-not (Test-Path -LiteralPath $Link)) {
        Write-Host "Nothing linked at $Link"
        exit 0
    }
    if (-not (Get-LinkTarget $Link)) {
        throw "$Link is a real folder, not a link. Refusing to delete it. Remove it by hand if that is what you want."
    }
    # Remove-Item on a link deletes the link, not the files it points at.
    (Get-Item -LiteralPath $Link -Force).Delete()
    Write-Host "Unlinked $Link"
    exit 0
}

if (-not (Test-Path -LiteralPath $Source)) {
    throw "Panel source not found at $Source"
}

if (-not (Test-Path -LiteralPath $ExtensionsDir)) {
    New-Item -ItemType Directory -Path $ExtensionsDir -Force | Out-Null
}

$existingTarget = Get-LinkTarget $Link
if ($existingTarget) {
    if ($existingTarget -eq $Source) {
        Write-Host "Already linked: $Link -> $Source"
        exit 0
    }
    throw "$Link already points at $existingTarget. Run with -Unlink first."
}
if (Test-Path -LiteralPath $Link) {
    throw "$Link exists as a real folder. Move it aside first."
}

cmd /c mklink /D "`"$Link`"" "`"$Source`"" | Out-Null
if (-not (Test-Path -LiteralPath $Link)) {
    Write-Host "Symbolic link refused, falling back to a junction."
    cmd /c mklink /J "`"$Link`"" "`"$Source`"" | Out-Null
}
if (-not (Test-Path -LiteralPath $Link)) {
    throw "Could not create a link at $Link"
}

Write-Host "Linked: $Link -> $Source"

# Unsigned extensions only load with PlayerDebugMode set, and the key is per
# CEP version, so every version After Effects might use is covered.
$missing = @()
foreach ($v in 9..24) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { continue }
    $mode = (Get-ItemProperty $key -Name PlayerDebugMode -ErrorAction SilentlyContinue).PlayerDebugMode
    if ($mode -ne 1) { $missing += "CSXS.$v" }
}
if ($missing.Count -gt 0) {
    Write-Warning "PlayerDebugMode is not set for: $($missing -join ', ')"
    Write-Host 'Run this to set it, then restart After Effects:'
    Write-Host '  foreach ($v in 9..24) { $k = "HKCU:\Software\Adobe\CSXS.$v"; if (Test-Path $k) { Set-ItemProperty $k -Name PlayerDebugMode -Value 1 -Type String } }'
} else {
    Write-Host 'PlayerDebugMode is set.'
}

Write-Host ''
Write-Host 'Restart After Effects, then open Window > Extensions > Copal.'
Write-Host 'Debug the panel at http://localhost:8096 while it is open.'
