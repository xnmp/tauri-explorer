import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureArchFrontend } from '../scripts/build-arch-frontend.mjs';

async function withFixture(test: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const fixture = await createFixture();
  try { await test(fixture); }
  finally { await rm(fixture.root, { recursive: true, force: true }); }
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'arch frontend '));
  const environment = { PATH: process.env.PATH ?? '', VITE_E2E_HOOKS: '0' };
  const put = async (file: string, contents: string) => {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), contents);
  };
  await put('src/app.ts', 'original app');
  await put('static/icon.png', 'original icon');
  await put('static/generated/custom.txt', 'original generated asset');
  await put('scripts/prepare-pdf-assets.mjs', 'original build script');
  await put('node_modules/dependency/index.js', 'original dependency');
  await put('package.json', '{"version":"1.0.0"}');
  await put('bun.lock', 'original lockfile');
  await put('vite.config.ts', 'original config');
  let builds = 0;
  const build = async () => {
    builds += 1;
    await put('build/index.html', `built ${builds}: ${await readFile(join(root, 'src/app.ts'), 'utf8')}`);
    await put('build/app.js', `bundle ${builds}`);
    await put('static/generated/pdfjs/generated.bin', `pdf output ${builds}`);
    await put('node_modules/.vite-temp/generated.mjs', `vite temporary output ${builds}`);
  };
  const run = (overrides = {}) => ensureArchFrontend({ root, environment, build, ...overrides });
  const output = () => readFile(join(root, 'build/index.html'), 'utf8');
  return { root, environment, put, build, run, output };
}

describe.skipIf(process.platform !== 'linux')('Arch frontend reuse', () => {
  it('builds a clean checkout whose PDF asset container does not exist yet', async () => withFixture(async ({ root, run, output }) => {
    await rm(join(root, 'static/generated'), { recursive: true });
    expect(await run()).toEqual({ rebuilt: true });
    expect(await run()).toEqual({ rebuilt: false });
    expect(await output()).toBe('built 1: original app');
  }));

  it('reuses verified output despite generated PDF and Vite temporary files', async () => withFixture(async ({ run, output, put }) => {
    expect(await run()).toEqual({ rebuilt: true });
    await put('static/generated/pdfjs/generated.bin', 'regenerated copy');
    await put('node_modules/.vite-temp/generated.mjs', 'temporary config');
    expect(await run()).toEqual({ rebuilt: false });
    expect(await output()).toBe('built 1: original app');
  }));

  it.each([
    'src/app.ts', 'static/icon.png', 'static/generated/custom.txt',
    'scripts/prepare-pdf-assets.mjs', 'node_modules/dependency/index.js',
    'package.json', 'bun.lock', 'vite.config.ts', '.env.production.local',
  ])('rebuilds when %s changes, including restored modification times', async (file) => withFixture(async ({ root, run, put, output }) => {
    await run();
    await put(file, 'changed');
    await utimes(join(root, file), new Date(0), new Date(0));
    expect(await run()).toEqual({ rebuilt: true });
    expect(await output()).toMatch(/^built 2:/);
  }));

  it('detects deleted and added inputs', async () => withFixture(async ({ root, run, put }) => {
    await run();
    await rm(join(root, 'static/icon.png'));
    expect(await run()).toEqual({ rebuilt: true });
    await put('static/new-icon.png', 'new asset');
    expect(await run()).toEqual({ rebuilt: true });
  }));

  it.each(['modify', 'delete', 'add'])('rebuilds after outputs are changed by another build: %s', async (change) => withFixture(async ({ root, run, put, output }) => {
    await run();
    if (change === 'modify') await put('build/index.html', 'different build');
    if (change === 'delete') await rm(join(root, 'build/app.js'));
    if (change === 'add') await put('build/extra.js', 'different build');
    expect(await run()).toEqual({ rebuilt: true });
    expect(await output()).toBe('built 2: original app');
  }));

  it('rebuilds missing or malformed receipts', async () => withFixture(async ({ root, run, put }) => {
    await run();
    await put('.arch-build/frontend-build.json', '{malformed');
    expect(await run()).toEqual({ rebuilt: true });
    await rm(join(root, '.arch-build/frontend-build.json'));
    expect(await run()).toEqual({ rebuilt: true });
  }));

  it('invalidates changed build environment and allows an explicit rebuild', async () => withFixture(async ({ environment, run, output }) => {
    await run();
    expect(await run({ environment: { ...environment, VITE_E2E_HOOKS: '1' } })).toEqual({ rebuilt: true });
    expect(await run({ environment: { ...environment, VITE_E2E_HOOKS: '1', _arch_rebuild_frontend: '1' } })).toEqual({ rebuilt: true });
    expect(await run({ environment: { ...environment, VITE_E2E_HOOKS: '1' } })).toEqual({ rebuilt: false });
    expect(await output()).toBe('built 3: original app');
  }));

  it('never reuses partially written output after a failed rebuild', async () => withFixture(async ({ environment, run, put, output }) => {
    await run();
    await expect(run({
      environment: { ...environment, _arch_rebuild_frontend: '1' },
      build: async () => { await put('build/index.html', 'partial'); throw new Error('build failed'); },
    })).rejects.toThrow('build failed');
    expect(await run()).toEqual({ rebuilt: true });
    expect(await output()).toBe('built 2: original app');
  }));

  it('rejects inputs changed during a build and rebuilds after the change settles', async () => withFixture(async ({ run, put, build, output }) => {
    await expect(run({ build: async () => { await build(); await put('src/app.ts', 'changed during build'); } })).rejects.toThrow('inputs changed during the build');
    expect(await run()).toEqual({ rebuilt: true });
    expect(await output()).toBe('built 2: changed during build');
  }));

  it('follows source symlinks and handles circular dependency directory links', async () => withFixture(async ({ root, run, put }) => {
    await put('external/source.ts', 'original external source');
    await symlink(join(root, 'external/source.ts'), join(root, 'src/linked.ts'));
    await symlink(join(root, 'node_modules'), join(root, 'node_modules/dependency/cycle'));
    await run();
    await put('external/source.ts', 'changed external source');
    expect(await run()).toEqual({ rebuilt: true });
  }));

  it('rejects overlapping builders before they can modify shared output', async () => withFixture(async ({ run, build, put, output }) => {
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = run({ build: async () => { started(); await held; await build(); } });
    await entered;
    try {
      await expect(run({ build: async () => { await put('build/index.html', 'partial competing output'); } })).rejects.toThrow('Another frontend build is running');
    } finally { release(); }
    expect(await first).toEqual({ rebuilt: true });
    expect(await run()).toEqual({ rebuilt: false });
    expect(await output()).toBe('built 1: original app');
  }));
});
