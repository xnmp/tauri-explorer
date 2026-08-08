import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const installerPath = new URL('../windows_install.ps1', import.meta.url);
const installerFilePath = fileURLToPath(installerPath);
const readmePath = new URL('../README.md', import.meta.url);
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const downloadCommand =
	'irm https://raw.githubusercontent.com/xnmp/tauri-explorer/main/windows_install.ps1 | Invoke-Expression';

describe('Windows installer documentation', () => {
	it('documents the one-command entry point at the README seam', async () => {
		expect(await readFile(readmePath, 'utf8')).toContain(downloadCommand);
	});
});

describe.skipIf(process.platform !== 'win32')('Windows installer invocation', () => {
	it('reports missing prerequisites before it starts a build', async () => {
		const sandbox = await mkdtemp(join(tmpdir(), 'tauri-explorer installer missing '));
		const harnessPath = join(sandbox, 'missing-prerequisites.ps1');
		try {
			await writeFile(harnessPath, missingPrerequisitesHarness, 'utf8');
			const result = await powershellResult(['-File', harnessPath, installerFilePath]);

			expect(result.code).toBe(1);
			expect(result.output).toContain('Git — winget install --id Git.Git -e');
			expect(result.output).toContain('Rust — winget install --id Rustlang.Rustup -e');
			expect(result.output).toContain('Bun — winget install --id Oven-sh.Bun -e');
			expect(result.output).toContain('Visual Studio C++ Build Tools');
			expect(result.output).not.toContain('Building tauri-explorer');
		} finally {
			await rm(sandbox, { force: true, recursive: true });
		}
	}, 15_000);

	it('builds existing and cloned checkouts, preserves MSI paths with spaces, and cleans clones', async () => {
		const sandbox = await mkdtemp(join(tmpdir(), 'tauri-explorer installer test '));
		const harnessPath = join(sandbox, 'invoke-installer.ps1');
		try {
			await writeFile(harnessPath, powershellHarness, 'utf8');
			const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessPath, installerFilePath]);
			const result = JSON.parse(stdout.trim().split(/\r?\n/).findLast((line) => line.startsWith('RESULT:'))!.slice(7));

			expect(result.existingBuilds).toEqual(['bun install', 'bunx tauri build']);
			expect(result.temporaryBuilds).toEqual(['bun install', 'bunx tauri build']);
			expect(result.gitCommands).toEqual([['clone', '--depth', '1', 'https://github.com/xnmp/tauri-explorer.git', result.temporaryCheckout]]);
			expect(result.temporaryCheckoutRemoved).toBe(true);
			expect(result.msiArguments).toEqual([
				`"${join(tmpdir(), 'tauri explorer existing checkout', 'src-tauri', 'target', 'release', 'bundle', 'msi', 'tauri explorer.msi')}"`,
				`"${join(result.temporaryCheckout, 'src-tauri', 'target', 'release', 'bundle', 'msi', 'tauri explorer.msi')}"`,
			]);
			expect(result.msiVerbs).toEqual(['RunAs', 'RunAs']);
			expect(result.rebootMessage).toContain('restart is required');
		} finally {
			await rm(sandbox, { force: true, recursive: true });
		}
	}, 15_000);
});

async function powershellResult(args: string[]) {
	try {
		const { stdout, stderr } = await execFileAsync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
			env: process.env,
		});
		return { code: 0, output: `${stdout}${stderr}` };
	} catch (error: any) {
		return { code: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
	}
}

const powershellHarness = String.raw`
param([string]$Installer)
$ErrorActionPreference = 'Stop'
$env:OS = 'Windows_NT'
$global:installerBuildCalls = @()
$global:installerGitCommands = @()
$global:installerMsiArguments = @()
$global:installerMsiVerbs = @()
$global:installerMessages = @()
$global:installerMsiExitCodes = @(0, 3010)
$global:installerMsiLaunches = 0
$global:installerTemporaryCheckout = $null

function global:git {
    $global:installerGitCommands += ,@($args)
    if ($args[0] -eq 'clone') {
        $global:installerTemporaryCheckout = $args[-1]
        New-Item -ItemType Directory -Force -Path $global:installerTemporaryCheckout, (Join-Path $global:installerTemporaryCheckout 'src-tauri') | Out-Null
        New-Item -ItemType File -Force -Path (Join-Path $global:installerTemporaryCheckout 'package.json') | Out-Null
    }
    $global:LASTEXITCODE = 0
}
function global:cargo { $global:LASTEXITCODE = 0 }
function global:vswhere {
    'C:\fake-build-tools'
    $global:LASTEXITCODE = 0
}
function global:bun {
    $global:installerBuildCalls += "bun $args"
    $global:LASTEXITCODE = 0
}
function global:bunx {
    $global:installerBuildCalls += "bunx $args"
    $bundle = Join-Path (Get-Location) 'src-tauri\target\release\bundle\msi'
    New-Item -ItemType Directory -Force -Path $bundle | Out-Null
    New-Item -ItemType File -Force -Path (Join-Path $bundle 'tauri explorer.msi') | Out-Null
    $global:LASTEXITCODE = 0
}
function global:Start-Process {
    param([string]$FilePath, [object[]]$ArgumentList, [string]$Verb, [switch]$Wait, [switch]$PassThru)
    $global:installerMsiArguments += $ArgumentList[1]
    $global:installerMsiVerbs += $Verb
    $exitCode = $global:installerMsiExitCodes[$global:installerMsiLaunches]
    $global:installerMsiLaunches += 1
    [pscustomobject]@{ ExitCode = $exitCode }
}
function global:Write-Host {
    $global:installerMessages += ($args -join ' ')
}

$existing = Join-Path ([System.IO.Path]::GetTempPath()) 'tauri explorer existing checkout'
New-Item -ItemType Directory -Force -Path $existing, (Join-Path $existing 'src-tauri') | Out-Null
New-Item -ItemType File -Force -Path (Join-Path $existing 'package.json') | Out-Null
Copy-Item $Installer (Join-Path $existing 'windows_install.ps1')
& (Join-Path $existing 'windows_install.ps1')
$existingBuilds = @($global:installerBuildCalls)

$global:installerBuildCalls = @()
$downloaded = Join-Path ([System.IO.Path]::GetTempPath()) 'tauri explorer downloaded installer'
New-Item -ItemType Directory -Force -Path $downloaded | Out-Null
Copy-Item $Installer (Join-Path $downloaded 'windows_install.ps1')
& (Join-Path $downloaded 'windows_install.ps1')
$temporaryBuilds = @($global:installerBuildCalls)
$temporaryCheckoutRemoved = -not (Test-Path (Split-Path $global:installerTemporaryCheckout -Parent))

[pscustomobject]@{
    existingBuilds = $existingBuilds
    temporaryBuilds = $temporaryBuilds
    gitCommands = @($global:installerGitCommands)
    temporaryCheckout = $global:installerTemporaryCheckout
    temporaryCheckoutRemoved = $temporaryCheckoutRemoved
    msiArguments = @($global:installerMsiArguments)
    msiVerbs = @($global:installerMsiVerbs)
    rebootMessage = $global:installerMessages | Where-Object { $_ -match 'restart is required' } | Select-Object -First 1
} | ConvertTo-Json -Compress -Depth 4 | ForEach-Object { "RESULT:$_" }
Remove-Item -Recurse -Force $existing, $downloaded
`;

const missingPrerequisitesHarness = String.raw`
param([string]$Installer)
$env:OS = 'Windows_NT'
$env:VSINSTALLDIR = 'C:\Visual Studio without C++ tools'
Set-Item -Path 'Env:ProgramFiles(x86)' -Value ([System.IO.Path]::GetTempPath())
function global:Get-Command {
    [CmdletBinding()]
    param([string]$Name)
    $null
}
& $Installer
`;
