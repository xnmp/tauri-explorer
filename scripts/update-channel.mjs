#!/usr/bin/env node
// update-channel.mjs — where each release's updater manifest goes (#1783).
//
// Versions reset from 1.28 to the 0.28 alpha line. Installs from 1.28.1 and
// earlier compare plain versions against `releases/latest` (the self-update
// `latest.json`, and the GitHub API for the notify-only notice), so they can
// never see an alpha release. Two rules keep every install moving:
//
//   GitHub "Latest"  only a release that is newer in plain version order
//                    than every 1.x release: v1.28.2, the bridge, until a
//                    1.29+ release. Such a release also publishes
//                    `latest.json`, which old self-updating installs read.
//   update-channel   a prerelease that is never "Latest", whose
//                    `latest-alpha.json` asset always describes the newest
//                    release. The bridge and every later build read only it
//                    (tauri.conf.json `plugins.updater.endpoints`, and
//                    update_check.rs for the notice), ordering releases with
//                    src-tauri/src/update_check/release_order.rs, mirrored
//                    here by `isReleasedAfter`.
//
// Usage (release.yml):
//   node scripts/update-channel.mjs github-latest <version>   prints true|false
//   node scripts/update-channel.mjs check --version <version> [--channel <latest-alpha.json>]
//     fails unless <version> is the channel's current release or one released
//     after it, and is not a pre-release.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CHANNEL_TAG = "update-channel";

/** The first minor of the alpha line, and the last minor of the 1.x line. */
const RESET_MINOR = 28;

/** @param {string} version */
function parse(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`Not a SemVer version: ${version}`);
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] };
}

/** @param {number[]} numbers */
function era([major, minor]) {
  if (major === 0 && minor < RESET_MINOR) return 0;
  if (major === 1 && minor <= RESET_MINOR) return 1;
  return 2;
}

/**
 * Whether `candidate` was released after `current` (release_order.rs): era
 * first (0.0–0.27, 1.0–1.28, then 0.28 onwards), then version order, with a
 * pre-release before its release.
 * @param {string} candidate
 * @param {string} current
 */
export function isReleasedAfter(candidate, current) {
  const c = parse(candidate);
  const i = parse(current);
  if (era(c.numbers) !== era(i.numbers)) return era(c.numbers) > era(i.numbers);
  for (let at = 0; at < 3; at++) {
    if (c.numbers[at] !== i.numbers[at]) return c.numbers[at] > i.numbers[at];
  }
  return c.pre === undefined && i.pre !== undefined;
}

/**
 * Whether the release may become GitHub's "Latest" (and publish
 * `latest.json`): only when every 1.x install's plain version comparison
 * sees it as newer, so the alpha line never displaces the bridge.
 * @param {string} version
 */
export function marksGitHubLatest(version) {
  const { numbers, pre } = parse(version);
  return pre === undefined && numbers[0] >= 1;
}

/**
 * Why `version` must not replace the channel manifest, or null. Release
 * order must not go back; the same release again is allowed.
 * @param {string} version
 * @param {{ version?: unknown } | undefined} channel the current `latest-alpha.json`, if any
 */
export function channelProblem(version, channel) {
  // Every install follows the one channel, so a pre-release would reach all of them.
  if (parse(version).pre !== undefined) return `${version} is a pre-release; the update channel has no pre-releases`;
  if (channel === undefined) return null;
  if (typeof channel?.version !== "string") return "the channel manifest has no version";
  // The same release again is a re-run after a failed upload.
  if (channel.version === version.replace(/^v/, "")) return null;
  return isReleasedAfter(version, channel.version)
    ? null
    : `${version} was not released after the channel's ${channel.version}`;
}

/** @param {string} name */
function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function main() {
  const [command, operand] = process.argv.slice(2);
  if (command === "github-latest") {
    if (!operand) throw new Error("Missing version");
    console.log(String(marksGitHubLatest(operand)));
    return;
  }
  if (command === "check") {
    const version = arg("version");
    const channel = process.argv.includes("--channel")
      ? JSON.parse(readFileSync(arg("channel"), "utf8"))
      : undefined;
    const problem = channelProblem(version, channel);
    if (problem) throw new Error(`Refusing to update ${CHANNEL_TAG}: ${problem}`);
    console.log(`${CHANNEL_TAG}: ${channel?.version ?? "(empty)"} -> ${version.replace(/^v/, "")}`);
    return;
  }
  throw new Error(`Unknown command: ${command ?? "(none)"}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
