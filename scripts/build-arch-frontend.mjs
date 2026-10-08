import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const schema = 1;
const execFileAsync = promisify(execFile);
const rootInput = /\.(?:[cm]?js|ts|json|ya?ml|lock|toml)$|^\.env(?:\.|$)|^\.(?:npmrc|nvmrc|node-version|tool-versions|browserslistrc)$/;
const transientEnvironment = new Set(['_', 'SHLVL', 'PWD', 'OLDPWD', '_arch_rebuild_frontend']);

/** @typedef {{root?: string, environment?: NodeJS.ProcessEnv, build?: () => Promise<void>}} BuildOptions */
/** @param {unknown} error */
const isMissing = (error) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

// Hash bytes and paths, not mtimes: deletions, restored timestamps, symlinked
// sources and locally edited dependencies must all invalidate reuse.
/** @param {string} root @param {string[]} paths @param {(path: string) => boolean} [exclude] */
async function fingerprint(root, paths, exclude = () => false) {
  const hash = createHash('sha256');
  const visited = new Set();
  /** @param {unknown} value */
  const record = (value) => hash.update(JSON.stringify(value) + '\n');
  /** @param {string} relative @returns {Promise<void>} */
  async function visit(relative) {
    if (exclude(relative)) return;
    const path = join(root, relative);
    const info = await lstat(path).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) { record([relative, 'missing']); return; }
    if (info.isSymbolicLink()) record([relative, 'link', await readlink(path)]);
    const canonical = await realpath(path);
    const target = info.isSymbolicLink() ? await lstat(canonical) : info;
    if (target.isDirectory()) {
      // prepare:pdf creates this container in a clean checkout. Its presence
      // alone is not an input; retain other assets authored under generated/.
      if (relative === 'static/generated' && !info.isSymbolicLink()
        && (await readdir(path)).every((name) => name === 'pdfjs')) return;
      record([relative, 'directory', canonical]);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      for (const name of (await readdir(path)).sort()) await visit(join(relative, name));
    } else if (target.isFile()) {
      const content = createHash('sha256');
      for await (const chunk of createReadStream(path)) content.update(chunk);
      record([relative, 'file', content.digest('hex')]);
    } else {
      throw new Error(`Unsupported frontend input: ${relative}`);
    }
  }
  for (const path of [...paths].sort()) await visit(path);
  return hash.digest('hex');
}

/** @param {string} root @param {NodeJS.ProcessEnv} environment */
async function inputFingerprint(root, environment) {
  const paths = [
    'src', 'static', 'scripts', 'node_modules', 'src-tauri/tauri.conf.json',
    ...(await readdir(root)).filter((name) => rootInput.test(name)),
  ];
  const files = await fingerprint(root, paths, (path) =>
    ['static/generated/pdfjs', 'node_modules/.vite', 'node_modules/.vite-temp'].includes(path));
  const env = Object.entries(environment)
    .filter(([key]) => !transientEnvironment.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  const versions = await Promise.all(['bun', 'node'].map(async (tool) => {
    const { stdout } = await execFileAsync(tool, ['--version'], { cwd: root, env: environment });
    return stdout.trim();
  }));
  return createHash('sha256').update(JSON.stringify([schema, files, env, versions])).digest('hex');
}

/** @param {string} root */
async function outputFingerprint(root) {
  // The static adapter's output consumed by tauri.conf.json.
  const index = await lstat(join(root, 'build/index.html')).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return index?.isFile() ? fingerprint(root, ['build']) : null;
}

/** Reuse only an intact frontend produced successfully from these exact inputs.
 * @param {BuildOptions} [options]
 */
export async function ensureArchFrontend({ root = process.cwd(), environment = process.env, build } = {}) {
  const cacheDir = join(root, '.arch-build');
  await mkdir(cacheDir, { recursive: true });
  const lock = await open(join(cacheDir, 'frontend-build.lock'), 'a');
  try {
    // flock locks this open file description, retained by our handle after the
    // child exits. The kernel releases it even if this process is killed.
    await new Promise((accept, reject) => {
      const child = spawn('flock', ['--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', lock.fd],
      });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? accept(undefined) : reject(new Error('Another frontend build is running; retry after it finishes.')));
    });
    return await buildOrReuse({ root, environment, build, cacheDir, lockFd: lock.fd });
  } finally { await lock.close(); }
}

/** @param {{root: string, environment: NodeJS.ProcessEnv, build?: () => Promise<void>, cacheDir: string, lockFd: number}} options */
async function buildOrReuse({ root, environment, build, cacheDir, lockFd }) {
  const cacheFile = join(cacheDir, 'frontend-build.json');
  const inputs = await inputFingerprint(root, environment);
  let previous;
  try { previous = JSON.parse(await readFile(cacheFile, 'utf8')); }
  catch (error) {
    if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
  }
  if (environment._arch_rebuild_frontend !== '1' && previous?.inputs === inputs) {
    const output = await outputFingerprint(root);
    if (output && previous.output === output && inputs === await inputFingerprint(root, environment)) {
      return { rebuilt: false };
    }
  }

  // A failed or interrupted rebuild must not leave a reusable receipt.
  await rm(cacheFile, { force: true });
  if (build) await build();
  else {
    // A killed helper can leave its build child running. Inherit ownership so
    // that a replacement cannot write assets until that child has exited too.
    const result = spawnSync('bun', ['run', 'build'], {
      cwd: root, env: environment, stdio: ['inherit', 'inherit', 'inherit', lockFd],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Frontend build failed (${result.signal ?? result.status})`);
  }
  const output = await outputFingerprint(root);
  if (!output) throw new Error('Frontend build did not produce build/index.html');
  if (inputs !== await inputFingerprint(root, environment)) {
    throw new Error('Frontend inputs changed during the build; rerun the installer.');
  }
  await mkdir(cacheDir, { recursive: true });
  const temporary = `${cacheFile}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ inputs, output }) + '\n');
    await rename(temporary, cacheFile);
  } finally { await rm(temporary, { force: true }); }
  return { rebuilt: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { rebuilt } = await ensureArchFrontend();
    if (!rebuilt) console.log('Frontend unchanged; reusing verified build (Cargo still checks native sources).');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
