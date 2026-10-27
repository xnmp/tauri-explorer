/**
 * Evidence screenshots are opt-in (#1123).
 *
 * Many specs save acceptance PNGs into the tracked `screenshots/` and
 * `evidence/` directories with `page.screenshot({ path })`. They prove a
 * change to a reviewer; they assert nothing. Written on every run, they cost
 * capture time and rewrite tracked files in every local and CI checkout.
 *
 * Unless `CAPTURE_EVIDENCE=1` is set, a screenshot whose `path` lies in one of
 * those directories is skipped and resolves to an empty buffer. Screenshots
 * elsewhere (`testInfo.outputPath`, `test-results/`) and screenshots without
 * a path (pixel assertions) are unaffected. A skipped call that asks for
 * `animations: "disabled"` still captures, without writing: that option
 * finishes CSS animations, which a later step may rely on.
 */
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const EVIDENCE_DIRS = ["screenshots", "evidence"];

/** Whether evidence screenshots are written (`CAPTURE_EVIDENCE=1`). */
export const captureEvidence = Boolean(process.env.CAPTURE_EVIDENCE) && process.env.CAPTURE_EVIDENCE !== "0";

/**
 * True when `path` (resolved like Playwright does, against the working
 * directory) names a file under a tracked evidence directory of `root`.
 */
export function isEvidencePath(path: string, root = REPO_ROOT, cwd = process.cwd()): boolean {
  const rel = relative(root, resolve(cwd, path)).split(sep).join("/");
  return EVIDENCE_DIRS.some((dir) => rel.startsWith(`${dir}/`));
}

type ScreenshotOptions = { path?: string; animations?: "disabled" | "allow" } & Record<string, unknown>;
type Shooter = (options?: ScreenshotOptions) => Promise<Buffer>;

/**
 * Wrap a `screenshot` method so evidence writes happen only under
 * `CAPTURE_EVIDENCE=1` (see the module comment).
 */
export function gateEvidence(shoot: Shooter, capture = captureEvidence): Shooter {
  return function (this: unknown, options?: ScreenshotOptions) {
    if (capture || !options?.path || !isEvidencePath(options.path)) return shoot.call(this, options);
    if (options.animations === "disabled") {
      const { path: _skipped, ...rest } = options;
      return shoot.call(this, rest);
    }
    return Promise.resolve(Buffer.alloc(0));
  };
}

const GATED = Symbol.for("tauri-explorer.evidence-gated");

/** Gate `screenshot` on a prototype once (Page and Locator share theirs). */
export function gatePrototype(proto: { screenshot: Shooter; [GATED]?: true }): void {
  if (proto[GATED]) return;
  proto.screenshot = gateEvidence(proto.screenshot);
  proto[GATED] = true;
}
