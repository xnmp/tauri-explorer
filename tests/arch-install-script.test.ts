import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
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
    expect(events[2]).toMatch(/^sudo -n pacman -U tauri-explorer-1\.0\.0-1-.*\.pkg\.tar\.zst --noconfirm$/);
  }));

  it('stops before building when authentication fails', async () => withInstaller(async ({ invoke, calls }) => {
    await expect(invoke([], { AUTH_FAIL: '1' })).rejects.toThrow();
    expect(await calls()).toEqual(['sudo -v']);
  }));

  it('reports unknown options before authentication', async () => withInstaller(async ({ invoke, calls }) => {
    await expect(invoke(['--unknown'])).rejects.toThrow('Unknown option: --unknown');
    expect(await calls()).toEqual([]);
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

async function withInstaller(test: (fixture: {
  invoke: (args?: string[], environment?: NodeJS.ProcessEnv) => Promise<unknown>;
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
`, { mode: 0o755 });
    await writeFile(join(root, 'bin/makepkg'), `#!/usr/bin/env bash
set -eu
printf 'makepkg reuse=%s rebuild=%s\\n' "$_arch_reuse_frontend" "$_arch_rebuild_frontend" >> "$INSTALL_CALLS"
echo "$SOURCE_DATE_EPOCH" >> "$INSTALL_EPOCHS"
touch "tauri-explorer-1.0.0-1-$(uname -m).pkg.tar.zst"
`, { mode: 0o755 });
    const invoke = (args: string[] = [], environment: NodeJS.ProcessEnv = {}) => execFileAsync('bash', [join(root, 'arch_install.sh'), ...args], {
      cwd: tmpdir(),
      env: { ...process.env, SOURCE_DATE_EPOCH: undefined, PATH: `${join(root, 'bin')}:${process.env.PATH}`, AUTH_FAIL: '0', INSTALL_CALLS: join(root, 'calls'), INSTALL_EPOCHS: join(root, 'epochs'), ...environment },
    });
    const calls = () => readFile(join(root, 'calls'), 'utf8').then(
      (contents) => contents.trim().split('\n'),
      (error) => { if (error.code === 'ENOENT') return []; throw error; },
    );
    const epochs = () => readFile(join(root, 'epochs'), 'utf8').then((contents) => contents.trim().split('\n'));
    await test({ invoke, calls, epochs, root, sandbox });
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}
