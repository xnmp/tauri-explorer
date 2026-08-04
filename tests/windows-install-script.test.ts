import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const installerPath = new URL('../windows_install.ps1', import.meta.url);
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
		try {
			const result = await powershellResult(['-File', installerPath.pathname], {
				PATH: sandbox,
				'ProgramFiles(x86)': sandbox,
			});

			expect(result.code).toBe(1);
			expect(result.output).toContain('Git — winget install --id Git.Git -e');
			expect(result.output).toContain('Rust — winget install --id Rustlang.Rustup -e');
			expect(result.output).toContain('Bun — winget install --id Oven-sh.Bun -e');
			expect(result.output).toContain('Visual Studio C++ Build Tools');
			expect(result.output).not.toContain('Building tauri-explorer');
		} finally {
			await rm(sandbox, { force: true, recursive: true });
		}
	});

	it('builds existing and cloned checkouts, preserves MSI paths with spaces, and cleans clones', async () => {
		const sandbox = await mkdtemp(join(tmpdir(), 'tauri-explorer installer test '));
		const harnessPath = join(sandbox, 'invoke-installer.ps1');
		try {
			await writeFile(harnessPath, powershellHarness, 'utf8');
			const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessPath, installerPath.pathname]);
			const result = JSON.parse(stdout.trim().split(/\r?\n/).findLast((line) => line.startsWith('RESULT:'))!.slice(7));

			expect(result.existingBuilds).toEqual(['bun install', 'bunx tauri build']);
			expect(result.temporaryBuilds).toEqual(['bun install', 'bunx tauri build']);
			expect(result.gitCommands).toEqual([['clone', '--depth', '1', 'https://github.com/xnmp/tauri-explorer.git', result.temporaryCheckout]]);
			expect(result.temporaryCheckoutRemoved).toBe(true);
			for (const msiArgument of result.msiArguments) {
				expect(msiArgument).toMatch(/^".* installer test .*\.msi"$/);
			}
			expect(result.msiVerbs).toEqual(['RunAs', 'RunAs']);
		} finally {
			await rm(sandbox, { force: true, recursive: true });
		}
	});
});

async function powershellResult(args: string[], env: Record<string, string>) {
	try {
		const { stdout, stderr } = await execFileAsync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
			env: { ...process.env, ...env },
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
$env:VSINSTALLDIR = 'C:\fake-build-tools'
$script:buildCalls = @()
$script:gitCommands = @()
$script:msiArguments = @()
$script:msiVerbs = @()
$script:temporaryCheckout = $null

function git {
    $script:gitCommands += ,@($args)
    if ($args[0] -eq 'clone') {
        $script:temporaryCheckout = $args[-1]
        New-Item -ItemType Directory -Force -Path $script:temporaryCheckout, (Join-Path $script:temporaryCheckout 'src-tauri') | Out-Null
        New-Item -ItemType File -Force -Path (Join-Path $script:temporaryCheckout 'package.json') | Out-Null
    }
    $global:LASTEXITCODE = 0
}
function cargo { $global:LASTEXITCODE = 0 }
function bun {
    $script:buildCalls += "bun $args"
    $global:LASTEXITCODE = 0
}
function bunx {
    $script:buildCalls += "bunx $args"
    $bundle = Join-Path (Get-Location) 'src-tauri\target\release\bundle\msi'
    New-Item -ItemType Directory -Force -Path $bundle | Out-Null
    New-Item -ItemType File -Force -Path (Join-Path $bundle 'tauri explorer.msi') | Out-Null
    $global:LASTEXITCODE = 0
}
function Start-Process {
    param([string]$FilePath, [object[]]$ArgumentList, [string]$Verb, [switch]$Wait, [switch]$PassThru)
    $script:msiArguments += $ArgumentList[1]
    $script:msiVerbs += $Verb
    [pscustomobject]@{ ExitCode = 0 }
}

$existing = Join-Path ([System.IO.Path]::GetTempPath()) 'tauri explorer existing checkout'
New-Item -ItemType Directory -Force -Path $existing, (Join-Path $existing 'src-tauri') | Out-Null
New-Item -ItemType File -Force -Path (Join-Path $existing 'package.json') | Out-Null
Copy-Item $Installer (Join-Path $existing 'windows_install.ps1')
& (Join-Path $existing 'windows_install.ps1')
$existingBuilds = @($script:buildCalls)

$script:buildCalls = @()
$downloaded = Join-Path ([System.IO.Path]::GetTempPath()) 'tauri explorer downloaded installer'
New-Item -ItemType Directory -Force -Path $downloaded | Out-Null
Copy-Item $Installer (Join-Path $downloaded 'windows_install.ps1')
& (Join-Path $downloaded 'windows_install.ps1')
$temporaryBuilds = @($script:buildCalls)
$temporaryCheckoutRemoved = -not (Test-Path (Split-Path $script:temporaryCheckout -Parent))

[pscustomobject]@{
    existingBuilds = $existingBuilds
    temporaryBuilds = $temporaryBuilds
    gitCommands = @($script:gitCommands)
    temporaryCheckout = $script:temporaryCheckout
    temporaryCheckoutRemoved = $temporaryCheckoutRemoved
    msiArguments = @($script:msiArguments)
    msiVerbs = @($script:msiVerbs)
} | ConvertTo-Json -Compress -Depth 4 | ForEach-Object { "RESULT:$_" }
Remove-Item -Recurse -Force $existing, $downloaded
`;
