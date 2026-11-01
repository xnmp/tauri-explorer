import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe.skipIf(process.platform !== 'linux')('Arch source build', () => {
  it('reuses an unchanged frontend while still asking Cargo to check native changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arch installer '));
    const { stdout: bunPath } = await execFileAsync('bash', ['-c', 'command -v bun']);
    try {
      await mkdir(join(root, 'bin'));
      await mkdir(join(root, 'src'));
      await mkdir(join(root, 'scripts'));
      await writeFile(join(root, 'package.json'), '{"version":"1.0.0"}');
      await writeFile(join(root, 'bun.lock'), 'locked dependencies');
      await writeFile(join(root, 'src/app.ts'), 'current app');
      await copyFile(new URL('../PKGBUILD', import.meta.url), join(root, 'PKGBUILD'));
      await copyFile(new URL('../scripts/build-arch-frontend.mjs', import.meta.url), join(root, 'scripts/build-arch-frontend.mjs'));
      await writeFile(join(root, 'bin/bun'), `#!/usr/bin/env bash
set -eu
if [[ "$*" == "--version" ]]; then echo fixture-bun; exit 0; fi
if [[ "$*" == "run build" ]]; then
  echo frontend >> "$BUILD_CALLS"
  mkdir -p build
  echo "$RANDOM" > build/index.html
elif [[ "$*" == "install --frozen-lockfile" ]]; then
  echo prepare >> "$BUILD_CALLS"
else
  exec "$REAL_BUN" "$@"
fi
`, { mode: 0o755 });
      await writeFile(join(root, 'bin/cargo'), '#!/usr/bin/env bash\necho native >> "$BUILD_CALLS"\n', { mode: 0o755 });

      await execFileAsync('bash', ['-c', 'set -e; source PKGBUILD; prepare; build; build'], {
        cwd: root,
        env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, REAL_BUN: bunPath.trim(), _srcdir: root, _arch_reuse_frontend: '1', BUILD_CALLS: join(root, 'calls') },
      }).catch((error) => { throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}`); });

      expect((await readFile(join(root, 'calls'), 'utf8')).trim().split('\n')).toEqual([
        'prepare', 'frontend', 'native', 'native',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== 'linux')('Arch installer wrapper', () => {
  it('keeps a surviving frontend builder exclusive after its helper is killed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arch interrupted build '));
    const { stdout: bunPath } = await execFileAsync('bash', ['-c', 'command -v bun']);
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(join(root, 'bin/bun'), `#!/usr/bin/env bash
set -eu
if [[ "$*" == '--version' ]]; then echo fixture-bun; exit 0; fi
if [[ "$*" == 'run build' ]]; then
  echo ready > "$BUILD_READY"
  while [[ ! -f "$BUILD_RELEASE" ]]; do sleep 0.02; done
  exit 1
fi
exit 2
`, { mode: 0o755 });
    const environment = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, BUILD_READY: join(root, 'ready'), BUILD_RELEASE: join(root, 'release') };
    const helper = fileURLToPath(new URL('../scripts/build-arch-frontend.mjs', import.meta.url));
    const child = spawn(bunPath.trim(), [helper], { cwd: root, env: environment, detached: true, stdio: 'ignore' });
    const exited = once(child, 'exit');
    try {
      const deadline = performance.now() + 5000;
      while (!await readFile(join(root, 'ready')).then(() => true, () => false)) {
        if (performance.now() > deadline) throw new Error('Frontend builder never became ready');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      child.kill('SIGKILL');
      await exited;
      await expect(execFileAsync(bunPath.trim(), [helper], { cwd: root, env: environment })).rejects.toThrow('Another frontend build is running');
    } finally {
      // This group contains only this fixture's helper and its build children.
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([{ args: [] }, { args: ['--rebuild'] }])('authenticates before building and installs the produced package: %j', async ({ args }) => withInstaller(async ({ invoke, calls }) => {
    await invoke(args);
    const events = await calls();
    expect(events[0]).toBe('sudo -v');
    expect(events[1]).toBe(`makepkg reuse=1 rebuild=${args.length ? '1' : '0'}`);
    expect(events[2]).toMatch(/^sudo -n pacman -U tauri-explorer-1\.0\.0-1-.*\.pkg\.tar\.zst --noconfirm --ask=4$/);
  }));

  it('builds ahead without credentials, then installs that package without rebuilding', async () => withInstaller(async ({ invoke, calls }) => {
    const built = await invoke(['--build-only']) as { stdout: string };
    expect(await calls()).toEqual(['makepkg reuse=1 rebuild=0']);
    expect(built.stdout).toContain('--install-only');

    const installed = await invoke(['--install-only']) as { stdout: string; stderr: string };
    const events = await calls();
    expect(events.slice(1, 2)).toEqual(['sudo -v']);
    expect(events[2]).toMatch(/^sudo -n pacman -U tauri-explorer-1\.0\.0-1-.*\.pkg\.tar\.zst --noconfirm --ask=4$/);
    expect(events).toHaveLength(3);
    expect(installed.stdout).toContain('Done.');
  }));

  it('refuses to install before any package was built, without asking for credentials', async () => withInstaller(async ({ invoke, calls }) => {
    await expect(invoke(['--install-only'])).rejects.toThrow('No built package recorded');
    expect(await calls()).toEqual([]);
  }));

  it('refuses when the recorded package has since been removed', async () => withInstaller(async ({ root, invoke, calls }) => {
    await invoke(['--build-only']);
    await rm(join(root, `tauri-explorer-1.0.0-1-${await machine()}.pkg.tar.zst`));
    await expect(invoke(['--install-only'])).rejects.toThrow('is missing');
    expect(await calls()).toEqual(['makepkg reuse=1 rebuild=0']);
  }));

  it('rejects combining build-only and install-only before authentication', async () => withInstaller(async ({ invoke, calls }) => {
    await expect(invoke(['--build-only', '--install-only'])).rejects.toThrow('mutually exclusive');
    expect(await calls()).toEqual([]);
  }));

  it('warns when the checkout moved after the build, but not for the same uncommitted edits', async () => withInstaller(async ({ root, invoke }) => {
    const git = (...args: string[]) => execFileAsync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    await git('init', '--quiet', '--template=');
    await writeFile(join(root, '.gitignore'), 'calls\nepochs\n.arch-build/\n*.pkg.tar.zst\n');
    await git('add', '-A');
    await git('commit', '--quiet', '-m', 'built');
    await writeFile(join(root, 'package.json'), '{"version":"1.0.0","edited":true}');

    await invoke(['--build-only']);
    const same = await invoke(['--install-only']) as { stderr: string };
    expect(same.stderr).not.toMatch(/was built from|cannot confirm/);

    await git('commit', '--quiet', '-am', 'moved on');
    const moved = await invoke(['--install-only']) as { stderr: string };
    expect(moved.stderr).toMatch(/Warning: .* was built from [0-9a-f]{40}\+[0-9a-f]{12}, but this checkout is now at [0-9a-f]{40};/);
  }));

  it('stops before building when authentication fails', async () => withInstaller(async ({ invoke, calls }) => {
    await expect(invoke([], { AUTH_FAIL: '1' })).rejects.toThrow();
    expect(await calls()).toEqual(['sudo -v']);
  }));

  it('reports unknown options before authentication', async () => withInstaller(async ({ invoke, calls }) => {
    await expect(invoke(['--unknown'])).rejects.toThrow('Unknown option: --unknown');
    expect(await calls()).toEqual([]);
  }));

  it.each([{ args: ['--plugin-path'] }, { args: ['--plugin-path', '--rebuild'] }])('rejects a missing plugin path before authentication: %j', async ({ args }) => withInstaller(async ({ invoke, calls }) => {
    await expect(invoke(args)).rejects.toThrow('--plugin-path requires a file or directory');
    expect(await calls()).toEqual([]);
  }));

  it('queues the newest matching package from the default repo location, as the invoking user', async () => withInstaller(async ({ sandbox, invoke }) => {
    const directory = join(sandbox, 'home/Repos/TraceExplorer/package');
    const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const other = architecture === 'x86_64' ? 'aarch64' : 'x86_64';
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `TraceExplorer-0.9.0-${architecture}-unknown-linux-gnu.teplugin`), 'old');
    await writeFile(join(directory, `TraceExplorer-0.10.0-${architecture}-unknown-linux-gnu.teplugin`), 'latest');
    await writeFile(join(directory, `TraceExplorer-9.0.0-${other}-unknown-linux-gnu.teplugin`), 'wrong architecture');
    await invoke();
    const digest = createHash('sha256').update('latest').digest('hex');
    expect(await readFile(join(sandbox, `config/tauri-explorer/pending-plugins/${digest}.teplugin`), 'utf8')).toBe('latest');
    // Repeating the script publishes the same content request rather than another copy.
    await invoke();
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(join(sandbox, 'config/tauri-explorer/pending-plugins'))).toEqual([`${digest}.teplugin`]);
  }));

  it('supports environment and command-line locations, including spaces and a relative file', async () => withInstaller(async ({ root, sandbox, invoke }) => {
    const configured = join(root, 'configured plugin.teplugin');
    const selected = join(root, 'selected plugin.TEPLUGIN');
    await writeFile(configured, 'configured'); await writeFile(selected, 'selected');
    await invoke([], { TRACE_EXPLORER_PLUGIN_PATH: configured });
    await invoke(['--plugin-path', selected.slice(tmpdir().length + 1)], { TRACE_EXPLORER_PLUGIN_PATH: configured });
    for (const content of ['configured', 'selected']) {
      const digest = createHash('sha256').update(content).digest('hex');
      expect(await readFile(join(sandbox, `config/tauri-explorer/pending-plugins/${digest}.teplugin`), 'utf8')).toBe(content);
    }
  }));

  it('skips an absent optional plugin and never queues after a failed host install', async () => withInstaller(async ({ root, sandbox, invoke }) => {
    const missing = join(root, 'missing.teplugin');
    const result = await invoke(['--plugin-path', missing]) as { stdout: string };
    expect(result.stdout).toContain('skipping plugin installation');
    const plugin = join(root, 'plugin.teplugin'); await writeFile(plugin, 'fixture');
    await expect(invoke(['--plugin-path', plugin], { INSTALL_FAIL: '1' })).rejects.toThrow();
    const { access } = await import('node:fs/promises');
    await expect(access(join(sandbox, 'config/tauri-explorer/pending-plugins'))).rejects.toThrow();
  }));

  it('moves per-user copies that shadow the package aside after installing it', async () => withInstaller(async ({ sandbox, invoke }) => {
    const { access, readdir, symlink } = await import('node:fs/promises');
    const launcher = join(sandbox, 'home/.local/bin/tauri-explorer');
    const desktop = join(sandbox, 'data/applications/tauri-explorer.desktop');
    const portal = join(sandbox, 'data/dbus-1/services/org.freedesktop.impl.portal.desktop.tauri_explorer.service');
    const unrelated = join(sandbox, 'data/applications/other.desktop');
    for (const file of [desktop, portal, unrelated]) await mkdir(join(file, '..'), { recursive: true });
    await mkdir(join(launcher, '..'), { recursive: true });
    await symlink('/nonexistent/old-build/tauri-explorer', launcher);
    await writeFile(desktop, 'Exec=/old/tauri-explorer');
    await writeFile(portal, 'Exec=/old/tauri-explorer --file-chooser-portal');
    await writeFile(unrelated, 'kept');

    const { stdout } = await invoke() as { stdout: string };

    for (const file of [launcher, desktop, portal]) {
      await expect(access(file)).rejects.toThrow();
      expect(stdout).toContain(`Moved per-user override ${file}`);
    }
    expect(await readFile(unrelated, 'utf8')).toBe('kept');
    const [batch] = await readdir(join(sandbox, 'state/tauri-explorer/retired-overrides'));
    const retired = join(sandbox, 'state/tauri-explorer/retired-overrides', batch);
    expect((await readdir(retired)).sort()).toEqual(['org.freedesktop.impl.portal.desktop.tauri_explorer.service', 'tauri-explorer', 'tauri-explorer.desktop']);
    expect(await readFile(join(retired, 'tauri-explorer.desktop'), 'utf8')).toBe('Exec=/old/tauri-explorer');
  }));

  it('keeps per-user copies when the package fails to install', async () => withInstaller(async ({ sandbox, invoke }) => {
    const desktop = join(sandbox, 'data/applications/tauri-explorer.desktop');
    await mkdir(join(desktop, '..'), { recursive: true });
    await writeFile(desktop, 'Exec=/old/tauri-explorer');
    await expect(invoke([], { INSTALL_FAIL: '1' })).rejects.toThrow();
    expect(await readFile(desktop, 'utf8')).toBe('Exec=/old/tauri-explorer');
  }));

  it('says when a running instance still holds the previous build', async () => withInstaller(async ({ invoke }) => {
    const running = await invoke([], { RUNNING_PIDS: '101 202' }) as { stdout: string };
    expect(running.stdout).toContain('still running the previous build (PID 101 202)');
    const idle = await invoke() as { stdout: string };
    expect(idle.stdout).not.toContain('still running');
  }));

  it('uses a stable source epoch and preserves an explicit caller epoch', async () => withInstaller(async ({ invoke, epochs }) => {
    await invoke();
    await invoke();
    const generated = await epochs();
    expect(generated).toHaveLength(2);
    expect(generated[0]).toMatch(/^\d+$/);
    expect(generated[1]).toBe(generated[0]);
    await invoke([], { SOURCE_DATE_EPOCH: '1700000000' });
    expect((await epochs()).at(-1)).toBe('1700000000');
  }));

  it('uses the archive timestamp when extracted beneath an unrelated Git repository', async () => withInstaller(async ({ root, sandbox, invoke, epochs }) => {
    const gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '1700000004 +0000', GIT_COMMITTER_DATE: '1700000004 +0000' };
    await execFileAsync('git', ['init', '--quiet', '--template=', sandbox], { env: gitEnvironment });
    await execFileAsync('git', ['-C', sandbox, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'unrelated parent'], { env: gitEnvironment });
    await utimes(join(root, 'package.json'), 1700000001, 1700000001);
    await invoke();
    expect(await epochs()).toEqual(['1700000001']);
  }));
});

describe.skipIf(process.platform !== 'linux')('Arch installer release route', () => {
  const releasedBytes = createHash('sha256').update('release bytes').digest('hex');
  const releaseJson = (digest = `sha256:${releasedBytes}`, version = '1.17.0') => JSON.stringify({
    tag_name: `v${version}`,
    assets: [
      { name: `tauri-explorer_${version}_amd64.AppImage`, digest: 'sha256:other' },
      { name: `tauri-explorer_${version}_amd64.deb`, digest },
    ],
  });
  const expectedPackage = /^sudo -n pacman -U .*\/\.arch-build\/release\/tauri-explorer-bin-1\.17\.0-1-x86_64\.pkg\.tar\.zst --noconfirm --ask=4$/;

  it('installs the latest release through pacman without compiling or asking', async () => withInstaller(async ({ invokeDefault, calls }) => {
    const { stdout } = await invokeDefault([], { RELEASE_JSON: releaseJson(), INSTALLED: 'tauri-explorer 1.15.1-1' });
    const events = await calls();
    expect(events[0]).toBe('makepkg release pkgver=1.17.0 sums=1 recipe=1');
    expect(events[1]).toBe('sudo -v');
    expect(events[2]).toMatch(expectedPackage);
    expect(events).toHaveLength(3);
    expect(stdout).toContain('Done.');
  }));

  it.each(['1.17.0-1', '1.18.0-1'])('leaves an installed %s alone, needing no credentials', async (version) => withInstaller(async ({ invokeDefault, calls }) => {
    const { stdout } = await invokeDefault([], { RELEASE_JSON: releaseJson(), INSTALLED: `tauri-explorer-bin ${version}` });
    expect(await calls()).toEqual([]);
    expect(stdout).toContain('already up to date');
  }));

  it('refuses a release whose bytes differ from the published digest, and never offers a build', async () => withInstaller(async ({ invokeDefault, calls }) => {
    await expect(invokeDefault(['--yes'], { RELEASE_JSON: releaseJson(`sha256:${'0'.repeat(64)}`) })).rejects.toThrow('nothing was installed');
    expect(await calls()).toEqual([]);
  }));

  it.each([
    ['no network', {}, 'could not reach'],
    ['no matching asset', { RELEASE_JSON: JSON.stringify({ tag_name: 'v1.17.0', assets: [] }) }, 'no verifiable'],
    ['no asset digest', { RELEASE_JSON: JSON.stringify({ tag_name: 'v1.17.0', assets: [{ name: 'tauri-explorer_1.17.0_amd64.deb' }] }) }, 'no verifiable'],
    ['a malformed response', { RELEASE_JSON: 'not json' }, 'unreadable'],
    ['an unusable tag', { RELEASE_JSON: JSON.stringify({ tag_name: 'v1.17.0;rm', assets: [] }) }, 'unusable version'],
    ['a failed download', { RELEASE_JSON: releaseJson(), DOWNLOAD_FAIL: '1' }, 'could not download'],
    ['a package with no application', { RELEASE_JSON: releaseJson(), EMPTY_PACKAGE: '1' }, 'produced no application'],
    ['an unsupported architecture', { RELEASE_JSON: releaseJson(), FAKE_ARCH: 'aarch64' }, 'no prebuilt aarch64'],
  ])('with %s, notifies and refuses to build when it cannot ask', async (_case, environment, reason) => withInstaller(async ({ invokeDefault, calls }) => {
    await expect(invokeDefault([], environment)).rejects.toThrow(reason);
    const events = await calls();
    const notifications = events.filter((event) => event.startsWith('notify'));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain(reason);
    expect(events.some((event) => event.startsWith('sudo') || event.startsWith('makepkg reuse'))).toBe(false);
  }));

  it('builds only after --yes accepts the notified fallback', async () => withInstaller(async ({ invokeDefault, calls }) => {
    await invokeDefault(['--yes']);
    const events = await calls();
    expect(events[0]).toContain('notify');
    expect(events[1]).toBe('sudo -v');
    expect(events[2]).toBe('makepkg reuse=1 rebuild=0');
    expect(events[3]).toMatch(/^sudo -n pacman -U tauri-explorer-1\.0\.0-1-/);
  }));

  it('builds on a yes at the prompt and stops on anything else', async () => withInstaller(async ({ invokeAnswering, calls }) => {
    await invokeAnswering('n').catch(() => undefined);
    expect((await calls()).filter((event) => !event.startsWith('notify'))).toEqual([]);
    await invokeAnswering('y');
    expect(await calls()).toContain('makepkg reuse=1 rebuild=0');
  }));

  it.each([['--source'], ['--rebuild'], ['--build-only']])('%s compiles this checkout without consulting the release', async (flag) => withInstaller(async ({ invokeDefault, calls }) => {
    await invokeDefault([flag], { RELEASE_JSON: releaseJson() });
    const events = await calls();
    expect(events.some((event) => event.startsWith('makepkg reuse=1'))).toBe(true);
    expect(events.some((event) => event.includes('release'))).toBe(false);
    expect(events.some((event) => event.startsWith('notify'))).toBe(false);
  }));

  it('still retires per-user copies and queues plugins after a release install', async () => withInstaller(async ({ sandbox, invokeDefault }) => {
    await mkdir(join(sandbox, 'home/.local/bin'), { recursive: true });
    await writeFile(join(sandbox, 'home/.local/bin/tauri-explorer'), 'old launcher');
    const { stdout } = await invokeDefault([], { RELEASE_JSON: releaseJson() });
    expect(stdout).toContain('Moved per-user override');
    expect(stdout).toContain('skipping plugin installation');
  }));
});

async function withInstaller(test: (fixture: {
  invoke: (args?: string[], environment?: NodeJS.ProcessEnv) => Promise<unknown>;
  invokeDefault: (args?: string[], environment?: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;
  invokeAnswering: (answer: string, environment?: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;
  calls: () => Promise<string[]>;
  epochs: () => Promise<string[]>;
  root: string;
  sandbox: string;
}) => Promise<void>) {
  const sandbox = await mkdtemp(join(tmpdir(), 'arch wrapper '));
  const root = join(sandbox, 'checkout');
  try {
    await mkdir(root);
    await mkdir(join(root, 'bin'));
    await copyFile(new URL('../arch_install.sh', import.meta.url), join(root, 'arch_install.sh'));
    await writeFile(join(root, 'PKGBUILD'), 'pkgver=1.0.0\npkgrel=1\n');
    await writeFile(join(root, 'package.json'), '{"version":"1.0.0"}');
    await writeFile(join(root, 'bin/sudo'), `#!/usr/bin/env bash
set -eu
echo "sudo $*" >> "$INSTALL_CALLS"
if [[ "$*" == '-v' && "$AUTH_FAIL" == 1 ]]; then exit 1; fi
if [[ "$*" == '-n pacman -U '* ]]; then [[ -f "$4" ]]; fi
if [[ "$*" == '-n pacman -U '* && "\${INSTALL_FAIL:-0}" == 1 ]]; then exit 1; fi
`, { mode: 0o755 });
    await mkdir(join(root, 'packaging/aur'), { recursive: true });
    for (const name of ['PKGBUILD', 'tauri-explorer-bin.install']) {
      await copyFile(new URL(`../packaging/aur/${name}`, import.meta.url), join(root, 'packaging/aur', name));
    }
    await writeFile(join(root, 'bin/curl'), `#!/usr/bin/env bash
[[ -n "\${RELEASE_JSON:-}" ]] || exit 22
printf '%s' "$RELEASE_JSON"
`, { mode: 0o755 });
    await writeFile(join(root, 'bin/pacman'), `#!/usr/bin/env bash
[[ -n "\${INSTALLED:-}" ]] || exit 1
echo "$INSTALLED"
`, { mode: 0o755 });
    // CI's Ubuntu has no vercmp; these fixtures only compare dotted versions.
    await writeFile(join(root, 'bin/vercmp'), `#!/usr/bin/env bash
[[ "$1" == "$2" ]] && { echo 0; exit; }
[[ "$(printf '%s\\n' "$1" "$2" | sort -V | tail -1)" == "$1" ]] && echo 1 || echo -1
`, { mode: 0o755 });
    await writeFile(join(root, 'bin/bsdtar'), `#!/usr/bin/env bash
[[ "\${EMPTY_PACKAGE:-0}" == 0 ]]
`, { mode: 0o755 });
    await writeFile(join(root, 'bin/uname'), `#!/usr/bin/env bash
echo "\${FAKE_ARCH:-$(/usr/bin/env -i PATH=/usr/bin:/bin uname -m)}"
`, { mode: 0o755 });
    await writeFile(join(root, 'bin/notify-send'), `#!/usr/bin/env bash
echo "notify $*" >> "$INSTALL_CALLS"
`, { mode: 0o755 });
    await writeFile(join(root, 'bin/makepkg'), `#!/usr/bin/env bash
set -eu
if [[ "$*" == '-g' ]]; then
  [[ "\${DOWNLOAD_FAIL:-0}" == 0 ]] || exit 1
  printf 'release bytes' > "$(sed -n 's/^pkgver=//p' PKGBUILD | sed 's/.*/tauri-explorer_&_amd64.deb/')"
  echo "sha256sums=('stub')"
  exit
fi
if [[ "$*" == '-f --nodeps --noconfirm' ]]; then
  version=$(sed -n 's/^pkgver=//p' PKGBUILD)
  echo "makepkg release pkgver=$version sums=$(grep -c "^sha256sums=('stub')$" PKGBUILD) recipe=$(grep -c '^package()' PKGBUILD)" >> "$INSTALL_CALLS"
  touch "$PKGDEST/tauri-explorer-bin-$version-1-x86_64.pkg.tar.zst"
  exit
fi
printf 'makepkg reuse=%s rebuild=%s\\n' "$_arch_reuse_frontend" "$_arch_rebuild_frontend" >> "$INSTALL_CALLS"
echo "$SOURCE_DATE_EPOCH" >> "$INSTALL_EPOCHS"
touch "tauri-explorer-1.0.0-1-$(uname -m).pkg.tar.zst"
`, { mode: 0o755 });
    await writeFile(join(root, 'bin/pgrep'), `#!/usr/bin/env bash
[[ -n "\${RUNNING_PIDS:-}" ]] || exit 1
printf '%s\\n' $RUNNING_PIDS
`, { mode: 0o755 });
    const environmentFor = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...process.env, HOME: join(sandbox, 'home'), XDG_CONFIG_HOME: join(sandbox, 'config'), XDG_DATA_HOME: join(sandbox, 'data'), XDG_STATE_HOME: join(sandbox, 'state'), RUNNING_PIDS: undefined, TRACE_EXPLORER_PLUGIN_PATH: undefined, SOURCE_DATE_EPOCH: undefined, PATH: `${join(root, 'bin')}:${process.env.PATH}`, AUTH_FAIL: '0', INSTALL_CALLS: join(root, 'calls'), INSTALL_EPOCHS: join(root, 'epochs'), ...environment });
    const run = (args: string[], environment: NodeJS.ProcessEnv) => execFileAsync('bash', [join(root, 'arch_install.sh'), ...args], { cwd: tmpdir(), env: environmentFor(environment) });
    // Most contracts here concern the source route; release tests use invokeDefault.
    const invoke = (args: string[] = [], environment: NodeJS.ProcessEnv = {}) => run(['--source', ...args], environment);
    const invokeDefault = (args: string[] = [], environment: NodeJS.ProcessEnv = {}) => run(args, { FAKE_ARCH: 'x86_64', ...environment });
    // Runs the installer on a real pseudo-terminal, answering its prompt.
    const invokeAnswering = (answer: string, environment: NodeJS.ProcessEnv = {}) => {
      const command = `printf '${answer}\\n' | script -qec ${JSON.stringify(`bash '${join(root, 'arch_install.sh')}'`)} /dev/null`;
      return execFileAsync('bash', ['-c', command], { cwd: tmpdir(), env: environmentFor({ FAKE_ARCH: 'x86_64', ...environment }) });
    };
    const calls = () => readFile(join(root, 'calls'), 'utf8').then(
      (contents) => contents.trim().split('\n'),
      (error) => { if (error.code === 'ENOENT') return []; throw error; },
    );
    const epochs = () => readFile(join(root, 'epochs'), 'utf8').then((contents) => contents.trim().split('\n'));
    await test({ invoke, invokeDefault, invokeAnswering, calls, epochs, root, sandbox });
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}

async function machine() {
  const { stdout } = await execFileAsync('uname', ['-m']);
  return stdout.trim();
}
