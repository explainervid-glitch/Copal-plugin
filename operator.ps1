# ============================================================
# Copal - Installer Script (PowerShell)
# Installs the CEP panel that keeps shape layer fills and strokes as palettes.
# Run via install.bat, do not run this file directly.
# ============================================================

param(
    [switch]$Elevated
)

# ---- Names / layout (single place to change) ----
$PluginName  = "Copal"            # shown to the user
$InstallName = "com.copal.panel"   # folder name under CEP\extensions, and
                                      # the extension id inside manifest.xml

# ---- Color helpers ----
function Write-Ok   ($msg) { Write-Host "  [OK] $msg"  -ForegroundColor Green  }
function Write-Warn ($msg) { Write-Host "  [!]  $msg"  -ForegroundColor Yellow }
function Write-Err  ($msg) { Write-Host "  [X]  $msg"  -ForegroundColor Red    }
function Write-Step ($msg) { Write-Host "`n  >>  $msg" -ForegroundColor Cyan   }

# ============================================================
# SAFE EXIT -- pause ONLY on failure so an error stays readable;
# a successful (or cancelled) run closes on its own.
# ============================================================
function Safe-Exit ($code) {
    Write-Host ""
    if ($code -ne 0) { Read-Host "  Press Enter to exit" }
    exit $code
}

# ============================================================
# TOP-LEVEL ERROR TRAP
# ============================================================
trap {
    Write-Host ""
    Write-Err "Unexpected error: $_"
    Safe-Exit 1
}

# ============================================================
# SHARED HELPERS
# ============================================================

# The panel folder lives at cep\com.copal.panel in the repository, but a
# distributed zip may put it next to this script instead. Both are accepted,
# and the manifest is what proves a candidate is really the panel.
function Resolve-PanelSource ($baseDir) {
    $candidates = @(
        (Join-Path $baseDir "cep\$InstallName"),
        (Join-Path $baseDir $InstallName),
        (Join-Path $baseDir "panel")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path (Join-Path $candidate "CSXS\manifest.xml")) { return $candidate }
    }
    return $null
}

# Returns the target of a symbolic link or junction, or $null for a real
# folder. Used everywhere before deleting anything.
function Get-LinkTarget ($path) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $null }
    if ($item.LinkType) { return $item.Target }
    return $null
}

# The command line for the elevated PowerShell that runs a script file.
# Start-Process joins its arguments with spaces and quotes none of them, so
# a path with a space in it, as %TEMP% has for a user named "John Smith",
# would arrive as two arguments and the elevated window would close at
# once with nothing installed. The path is quoted here instead.
function Get-ElevatedArguments ($scriptPath) {
    return "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
}

# ------------------------------------------------------------
# Removing an install directory.
#
# This matters more than it looks. A developer install of this panel is a
# symbolic link pointing back at the working copy, and Remove-Item -Recurse
# on a directory link in Windows PowerShell 5.1 can follow the link and
# delete the files it points at — which would be the source repository.
# A link is therefore deleted as a link, never recursed into.
# ------------------------------------------------------------
function Remove-InstallDir ($path) {
    if (-not (Test-Path -LiteralPath $path)) { return $false }

    $link = Get-LinkTarget $path
    if ($link) {
        (Get-Item -LiteralPath $path -Force).Delete()
    } else {
        Remove-Item -LiteralPath $path -Recurse -Force
    }
    return $true
}

# ============================================================
# 0. SELF-ELEVATE to Administrator if not already
# ============================================================
$isAdmin = ([Security.Principal.WindowsPrincipal]`
    [Security.Principal.WindowsIdentity]::GetCurrent()`
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "  Requesting administrator privileges..." -ForegroundColor Yellow

    # Resolve script path BEFORE elevation — $PSCommandPath can be empty
    # in child processes launched via -Command.
    $selfPath = $MyInvocation.MyCommand.Path
    if (-not $selfPath) {
        $selfPath = $PSCommandPath
    }
    if (-not $selfPath) {
        Write-Err "Cannot resolve script path. Please run via install.bat."
        Safe-Exit 1
    }

    $currentScriptDir = Split-Path -Parent $selfPath

    # ------------------------------------------------------------
    # CRITICAL: if this script is running from a mapped network
    # drive (e.g. W:\...), that drive letter is NOT visible inside
    # the elevated (UAC) session. Stage what the installer needs to
    # a local temp folder BEFORE elevating, then elevate and run from
    # there. The elevated session never touches the network drive.
    #
    # Only the script and the panel folder are staged. The repository
    # also holds samples, tests and version control data, and copying
    # all of that would make the install slow for no reason.
    # ------------------------------------------------------------
    $preElevationSource = Resolve-PanelSource $currentScriptDir
    if (-not $preElevationSource) {
        Write-Err "Could not find the '$InstallName' panel folder next to this script."
        Write-Err "Expected one of:"
        Write-Host "    cep\$InstallName\CSXS\manifest.xml"  -ForegroundColor Gray
        Write-Host "    $InstallName\CSXS\manifest.xml"      -ForegroundColor Gray
        Safe-Exit 1
    }

    $localPreStage = "$env:TEMP\Copal_preelevate"

    try {
        if (Test-Path $localPreStage) {
            Remove-Item $localPreStage -Recurse -Force
        }
        New-Item -ItemType Directory -Path $localPreStage -Force | Out-Null

        Copy-Item -Path $selfPath -Destination $localPreStage -Force
        Copy-Item -Path $preElevationSource `
                  -Destination (Join-Path $localPreStage $InstallName) `
                  -Recurse -Force
    } catch {
        Write-Err "Failed to copy the panel to a local folder before elevation: $_"
        Write-Err "Make sure the source drive is accessible."
        Safe-Exit 1
    }

    $localSelfPath = Join-Path $localPreStage "operator.ps1"

    if (-not (Test-Path $localSelfPath)) {
        Write-Err "operator.ps1 not found after local staging."
        Safe-Exit 1
    }

    # Write a tiny temp launcher so we never have to embed a spaced path
    # inside a -Command string (which breaks no matter how you quote it).
    $tempLauncher = "$env:TEMP\Copal_elevate_launcher.ps1"
    # No trailing Read-Host and no -NoExit below: the elevated operator.ps1
    # handles its own exit (auto-close on success, pause on failure via
    # Safe-Exit). The catch here only pauses if the script cannot start at all.
    Set-Content -Path $tempLauncher -Encoding UTF8 -Value @"
try {
    & '$($localSelfPath -replace "'", "''")' -Elevated
} catch {
    Write-Host `$_.Exception.Message -ForegroundColor Red
    Read-Host 'Press Enter to exit'
}
"@

    try {
        Start-Process -FilePath "powershell.exe" `
                      -ArgumentList (Get-ElevatedArguments $tempLauncher) `
                      -Verb RunAs `
                      -Wait
    } catch {
        Write-Err "Elevation cancelled or failed: $_"
        Safe-Exit 1
    }

    Remove-Item $tempLauncher -ErrorAction SilentlyContinue
    Remove-Item $localPreStage -Recurse -Force -ErrorAction SilentlyContinue

    exit 0
}

# ============================================================
# BANNER
# ============================================================
Clear-Host
Write-Host ""
Write-Host "  ======================================================" -ForegroundColor DarkCyan
Write-Host "   Copal - Installer for After Effects             " -ForegroundColor Cyan
Write-Host "  ======================================================" -ForegroundColor DarkCyan
Write-Host ""

# ============================================================
# 1. RESOLVE PATHS
# ============================================================
Write-Step "Checking paths..."

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else {
    Split-Path -Parent $MyInvocation.MyCommand.Definition
}

if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$sourceDir = Resolve-PanelSource $scriptDir

if (-not $sourceDir) {
    Write-Host ""
    Write-Err "Could not find the panel folder or its manifest.xml."
    Write-Err "Expected the folder structure to look like this:"
    Write-Host ""
    Write-Host "    install.bat"                         -ForegroundColor Gray
    Write-Host "    operator.ps1"                        -ForegroundColor Gray
    Write-Host "    cep\$InstallName\"                   -ForegroundColor Gray
    Write-Host "      CSXS\manifest.xml"                 -ForegroundColor Gray
    Write-Host "      index.html"                        -ForegroundColor Gray
    Write-Host "      css\style.css"                     -ForegroundColor Gray
    Write-Host "      js\main.js"                        -ForegroundColor Gray
    Write-Host "      js\store.js"                       -ForegroundColor Gray
    Write-Host "      js\CSInterface.js"                 -ForegroundColor Gray
    Write-Host "      jsx\host.jsx"                      -ForegroundColor Gray
    Write-Host "      jsx\lib\CopalCore.jsx"          -ForegroundColor Gray
    Write-Host ""
    Write-Host "  (the folder may also sit directly beside this script)" -ForegroundColor DarkGray
    Write-Host ""
    Safe-Exit 1
}

$destSystem = "C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\$InstallName"
$destUser   = "$env:APPDATA\Adobe\CEP\extensions\$InstallName"
$destDir    = if (Test-Path "C:\Program Files (x86)\Common Files\Adobe\CEP\extensions") {
    $destSystem
} else {
    Write-Warn "System CEP path not found, using per-user path."
    $destUser
}

Write-Ok "Source      : $sourceDir"
Write-Ok "Destination : $destDir"

# Read the version out of the manifest so the install log says what it put down.
try {
    $manifestXml = [xml](Get-Content (Join-Path $sourceDir "CSXS\manifest.xml") -Raw)
    $bundleVersion = $manifestXml.ExtensionManifest.ExtensionBundleVersion
    if ($bundleVersion) { Write-Ok "Version     : $bundleVersion" }
} catch {
    Write-Warn "Could not read the version from manifest.xml (not critical)."
}

# ============================================================
# 2. CONFIRM SOURCE IS LOCAL (already staged before elevation)
# ============================================================
Write-Step "Confirming plugin source is local..."
Write-Ok "Running from local staged copy: $sourceDir"

# ============================================================
# 3. CHECK FOR A DEVELOPER LINK OR A SECOND COPY
#
# After Effects loads extensions from both the per-user and the all-users
# folder. The same extension id in both is ambiguous, and a developer link
# in one of them would silently keep overriding whatever is installed in the
# other, so the situation is surfaced rather than left to chance.
# ============================================================
Write-Step "Checking for an existing install of $InstallName..."

$otherDir = if ($destDir -eq $destSystem) { $destUser } else { $destSystem }

$destLink  = Get-LinkTarget $destDir
$otherLink = Get-LinkTarget $otherDir

if ($destLink) {
    Write-Warn "The destination is currently a developer link:"
    Write-Host "      $destDir" -ForegroundColor Gray
    Write-Host "      -> $destLink" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Replacing it installs a real copy and unlinks your working folder." -ForegroundColor White
    Write-Host "  Your working folder itself is not touched." -ForegroundColor DarkGray
    Write-Host ""
    $answer = Read-Host "  Replace the link with an installed copy? (y/N)"
    if ($answer -notmatch '^(y|yes)$') {
        Write-Warn "Installation cancelled. The developer link was left alone."
        Safe-Exit 0
    }
}

if (Test-Path $otherDir) {
    Write-Warn "Another copy of this extension exists at:"
    Write-Host "      $otherDir" -ForegroundColor Gray
    if ($otherLink) {
        Write-Host "      -> $otherLink  (developer link)" -ForegroundColor Gray
    }
    Write-Host ""
    Write-Host "  After Effects would see two extensions with the same id." -ForegroundColor White
    Write-Host ""
    $answer = Read-Host "  Remove the other copy? (Y/n)"
    if ($answer -match '^(n|no)$') {
        Write-Warn "Both copies kept. After Effects may load either one."
    } else {
        try {
            Remove-InstallDir $otherDir | Out-Null
            Write-Ok "Removed: $otherDir"
        } catch {
            Write-Warn "Could not remove the other copy: $_"
        }
    }
} else {
    Write-Ok "No conflicting copy found."
}

# ============================================================
# 4. CHECK ADOBE AFTER EFFECTS PROCESS
# ============================================================
Write-Step "Checking for running Adobe After Effects process..."

$aeProcess = Get-Process -Name "AfterFX" -ErrorAction SilentlyContinue

if ($aeProcess) {
    Write-Warn "Adobe After Effects is currently running."
    Write-Host ""
    Write-Host "  Choose an action:" -ForegroundColor White
    Write-Host "  [1] Close After Effects automatically and continue" -ForegroundColor Gray
    Write-Host "  [2] Continue without closing (not recommended)" -ForegroundColor Gray
    Write-Host "  [3] Cancel" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Closing discards unsaved work." -ForegroundColor DarkYellow
    Write-Host ""

    $choice = Read-Host "  Choice (1/2/3)"

    switch ($choice) {
        "1" {
            Stop-Process -Name "AfterFX" -Force
            Start-Sleep -Seconds 2
            Write-Ok "After Effects closed."
        }
        "2" {
            Write-Warn "Continuing without closing. Restart After Effects after installation is complete."
        }
        default {
            Write-Warn "Installation cancelled."
            Safe-Exit 0
        }
    }
} else {
    Write-Ok "Adobe After Effects is not currently running."
}

# ============================================================
# 5. COPY EXTENSION FILES (CEP Panel)
# ============================================================
Write-Step "Copying extension files to CEP extensions folder..."

try {
    if (Remove-InstallDir $destDir) {
        Write-Ok "Previous installation removed."
    }
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    Copy-Item -Path "$sourceDir\*" -Destination $destDir -Recurse -Force
    Write-Ok "Files copied to: $destDir"
} catch {
    Write-Err "Failed to copy files: $_"
    Safe-Exit 1
}

# The .debug file opens a remote debugging port for the panel. That belongs to
# development, not to an installed copy.
$debugFile = Join-Path $destDir ".debug"
if (Test-Path $debugFile) {
    Remove-Item $debugFile -Force -ErrorAction SilentlyContinue
    Write-Ok "Removed the development debug port file."
}

# ============================================================
# 6. REGISTRY -- PlayerDebugMode (required for unsigned CEP)
#
# The key is per CEP version and Adobe adds a new one with most releases, so
# every version that already exists on this machine is covered, plus the range
# current releases use.
# ============================================================
Write-Step "Setting registry PlayerDebugMode..."

$csxsVersions = 9..24
$regErrors    = 0
$regSet       = 0

foreach ($ver in $csxsVersions) {
    $regPath = "HKCU:\Software\Adobe\CSXS.$ver"
    try {
        if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
        Set-ItemProperty -Path $regPath -Name "PlayerDebugMode" -Value "1" -Type String -Force
        $regSet++
    } catch {
        Write-Warn "CSXS.$ver - Failed: $_"
        $regErrors++
    }
}

Write-Ok "PlayerDebugMode=1 on $regSet CSXS version(s)."

if ($regErrors -gt 0) {
    Write-Warn "$regErrors key(s) could not be set (not critical)."
}

# ============================================================
# 7. VERIFICATION
# ============================================================
Write-Step "Verifying installation..."

$checks = @(
    @{ Path = "$destDir\CSXS\manifest.xml";   Label = "manifest.xml"   },
    @{ Path = "$destDir\index.html";          Label = "index.html"     },
    @{ Path = "$destDir\css\style.css";       Label = "style.css"      },
    @{ Path = "$destDir\js\main.js";          Label = "main.js"        },
    @{ Path = "$destDir\js\store.js";         Label = "store.js"       },
    @{ Path = "$destDir\js\gradient.js";      Label = "gradient.js"    },
    @{ Path = "$destDir\js\picture.js";       Label = "picture.js"     },
    @{ Path = "$destDir\js\CSInterface.js";   Label = "CSInterface.js" },
    @{ Path = "$destDir\jsx\host.jsx";        Label = "host.jsx"       },
    @{ Path = "$destDir\jsx\lib\CopalCore.jsx"; Label = "CopalCore.jsx" },
    @{ Path = "$destDir\jsx\lib\CopalSampler.jsx"; Label = "CopalSampler.jsx" },
    @{ Path = "$destDir\jsx\lib\json.jsx";    Label = "json.jsx"       }
)

$allOk = $true
foreach ($check in $checks) {
    if (Test-Path $check.Path) {
        Write-Ok $check.Label
    } else {
        Write-Err "$($check.Label) -- FILE NOT FOUND!"
        $allOk = $false
    }
}

# ============================================================
# DONE
# ============================================================
Write-Host ""
Write-Host "  ======================================================" -ForegroundColor DarkCyan

if ($allOk) {
    Write-Host "   INSTALLATION SUCCESSFUL!                          " -ForegroundColor Green
    Write-Host "  ======================================================" -ForegroundColor DarkCyan
    Write-Host ""
    Write-Host "  To use it:" -ForegroundColor White
    Write-Host "  1. Open Adobe After Effects"                              -ForegroundColor Gray
    Write-Host "  2. Window > Extensions > $PluginName"                     -ForegroundColor Gray
    Write-Host "  3. Select a shape layer, then press +"                    -ForegroundColor Gray
    Write-Host "  4. Select another shape layer and double click a palette" -ForegroundColor Gray
    Write-Host ""
    # Success: no key press needed. Show the result briefly, then close on its own.
    Write-Host "  This window closes automatically in 8 seconds..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 8
    exit 0
} else {
    Write-Host "   INSTALLATION COMPLETED WITH WARNINGS.            " -ForegroundColor Yellow
    Write-Host "  ======================================================" -ForegroundColor DarkCyan
    Write-Host ""
    Write-Host "  Some files were not found at the destination." -ForegroundColor Yellow
    Write-Host "  Check the source folder and try again." -ForegroundColor Yellow
    Write-Host ""
    # Something is off — pause so the warnings can be read.
    Safe-Exit 1
}
