import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Windows installer', () => {
	const installerPath = new URL('../windows_install.ps1', import.meta.url);

	it('gives Windows users one self-contained build-and-install entry point', async () => {
		const script = await readFile(installerPath, 'utf8');

		expect(script).toContain('windows_install.ps1 | Invoke-Expression');
		expect(script).toMatch(/Get-Command git/);
		expect(script).toMatch(/Get-Command cargo/);
		expect(script).toMatch(/Get-Command bun/);
		expect(script).toContain("Join-Path $PSScriptRoot 'package.json'");
		expect(script).toContain("@('clone', '--depth', '1')");
		expect(script).toContain('& git @cloneArgs');
		expect(script).toContain('bun install');
		expect(script).toContain('bunx tauri build');
		expect(script).toContain('Start-Process msiexec.exe');
	});
});
