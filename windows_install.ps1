# windows_install.ps1 — build and install tauri-explorer on Windows from source.
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/xnmp/tauri-explorer/main/windows_install.ps1 | Invoke-Expression
#
# Run this script from an existing checkout to build that checkout, or download
# it as above to clone a temporary checkout. An optional -Ref selects the tag or
# branch when cloning. The script needs Git, Rust, Bun, and the Visual Studio C++
# build tools; it reports an install command for each missing prerequisite.

[CmdletBinding()]
param(
    [string]$Ref
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Error "error: $Message"
    exit 1
}

if ($env:OS -ne 'Windows_NT') {
    Fail "this installer is for Windows (detected $env:OS)"
}

$missing = @()
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    $missing += 'Git — winget install --id Git.Git -e'
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    $missing += 'Rust — winget install --id Rustlang.Rustup -e'
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    $missing += 'Bun — winget install --id Oven-sh.Bun -e'
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vswhereCommand = if (Test-Path $vswhere) {
    $vswhere
} else {
    Get-Command vswhere -ErrorAction SilentlyContinue
}
$buildTools = if ($vswhereCommand) {
    & $vswhereCommand -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
} else {
    $null
}
if (-not $buildTools) {
    $missing += 'Visual Studio C++ Build Tools — winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
}

if ($missing.Count -gt 0) {
    # Write directly to stderr so $ErrorActionPreference does not stop after the
    # first line and hide the remaining prerequisite setup commands.
    [Console]::Error.WriteLine('error: missing prerequisites:')
    $missing | ForEach-Object { [Console]::Error.WriteLine("  - $_") }
    [Console]::Error.WriteLine('Install the listed prerequisites, open a new PowerShell window, then run this installer again.')
    exit 1
}

$repo = 'xnmp/tauri-explorer'
$temporaryCheckout = $null
try {
    $repoDir = $null
    if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'package.json')) -and (Test-Path (Join-Path $PSScriptRoot 'src-tauri'))) {
        $repoDir = $PSScriptRoot
        Write-Host "Using existing checkout at $repoDir"
        if ($Ref) {
            Write-Warning "Ignoring '$Ref' because this is an existing checkout; check out the ref first."
        }
    } else {
        $temporaryCheckout = Join-Path ([System.IO.Path]::GetTempPath()) "tauri-explorer-build-$([guid]::NewGuid())"
        $repoDir = Join-Path $temporaryCheckout 'tauri-explorer'
        $cloneArgs = @('clone', '--depth', '1')
        if ($Ref) {
            $cloneArgs += @('--branch', $Ref)
        }
        $cloneArgs += "https://github.com/$repo.git", $repoDir
        Write-Host "Cloning $repo..."
        & git @cloneArgs
        if ($LASTEXITCODE -ne 0) {
            Fail "could not clone $repo"
        }
    }

    Push-Location $repoDir
    try {
        Write-Host 'Installing JavaScript dependencies...'
        & bun install
        if ($LASTEXITCODE -ne 0) {
            Fail 'could not install JavaScript dependencies'
        }

        Write-Host 'Building tauri-explorer (this can take several minutes)...'
        & bunx tauri build
        if ($LASTEXITCODE -ne 0) {
            Fail 'build failed'
        }
    } finally {
        Pop-Location
    }

    $bundleDir = Join-Path $repoDir 'src-tauri\target\release\bundle\msi'
    $installer = Get-ChildItem -Path $bundleDir -Filter '*.msi' -File | Select-Object -First 1
    if (-not $installer) {
        Fail "build succeeded but no MSI installer was found under $bundleDir"
    }

    Write-Host "Installing $($installer.Name)..."
    # Start-Process joins ArgumentList into a command line. Keep the MSI as one
    # msiexec argument when the checkout or temporary directory contains spaces.
    $quotedMsiPath = '"{0}"' -f $installer.FullName
    # RunAs makes the UAC consent boundary explicit before a machine installer
    # changes system state.
    $process = Start-Process msiexec.exe -ArgumentList @('/i', $quotedMsiPath, '/passive', '/norestart') -Verb RunAs -Wait -PassThru
    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
        Fail "MSI installation failed with exit code $($process.ExitCode)"
    }

    if ($process.ExitCode -eq 3010) {
        Write-Host 'Installed tauri-explorer. Restart Windows before launching it.'
    } else {
        Write-Host 'Installed tauri-explorer. Launch it from the Start menu.'
    }
} finally {
    if ($temporaryCheckout -and (Test-Path $temporaryCheckout)) {
        Remove-Item -Recurse -Force $temporaryCheckout
    }
}
