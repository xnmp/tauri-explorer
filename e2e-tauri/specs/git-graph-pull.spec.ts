/**
 * Git-graph fetch/refresh against the built binary and REAL git (#432).
 *
 * Regression for "ticking the pull-remote box pulls but the graph does not
 * update afterwards" / "F5 doesn't refresh the graph". The structural bug was
 * a refresh arriving mid-load being silently dropped (GitGraphView reload had
 * no generation counter / dirty flag). Browser-mode Playwright cannot catch
 * this: it mocks IPC, so there is no real `git fetch`, no real refs advancing,
 * and no real reload race.
 *
 * What this drives, all against the real Rust backend + real git:
 *   1. A bare "remote" repo + a local repo with an initial commit, pushed with
 *      an upstream (plain `git` CLI from Node).
 *   2. The app navigates to the local repo and opens the commit graph via the
 *      command palette; the initial commit renders.
 *   3. A second clone commits + pushes a NEW commit to the bare remote,
 *      out-of-band (the app never sees it locally yet).
 *   4. F5 in the graph runs the real `gitGraph.refresh` command
 *      (fetch-from-remotes + reload). The new commit — reachable only via the
 *      fetched `origin/main` — must appear. This is the #432 assertion.
 *   5. A rapid double-F5 during load must still converge (dirty-flag re-run).
 */
import { browser, $, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo, domTexts } from "./helpers";

const baseDir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-gitgraph-")),
);
const remoteDir = path.join(baseDir, "remote.git");
const localDir = path.join(baseDir, "local");
const otherCloneDir = path.join(baseDir, "other-clone");

const INITIAL_SUBJECT = "e2e initial commit";

/** Run git in `cwd`, with a deterministic identity so commits never depend on
 *  the host's global git config (which may be absent under CI/Xvfb). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=E2E Bot",
      "-c",
      "user.email=e2e@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
}

/** Commit a fresh file in `cwd` with `subject`, then push to origin/main. */
function commitAndPush(cwd: string, subject: string, fileName: string): void {
  fs.writeFileSync(path.join(cwd, fileName), `${subject}\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", subject);
  git(cwd, "push", "origin", "main");
}

/** Current visible commit subjects in the graph (CSS-clip-immune textContent). */
async function graphSubjects(): Promise<string[]> {
  return (await domTexts(".commit-row .summary")).map((s) => s.trim());
}

describe("git graph fetch/refresh against real git (#432)", () => {
  before(function () {
    // Bare remote.
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);

    // Local repo with an initial commit, wired to the remote with an upstream.
    fs.mkdirSync(localDir);
    git(localDir, "init", "-b", "main");
    fs.writeFileSync(path.join(localDir, "README.md"), "initial\n");
    git(localDir, "add", "-A");
    git(localDir, "commit", "-m", INITIAL_SUBJECT);
    git(localDir, "remote", "add", "origin", remoteDir);
    git(localDir, "push", "-u", "origin", "main");

    // Independent clone used to push out-of-band commits the app hasn't seen.
    git(baseDir, "clone", remoteDir, otherCloneDir);
  });

  after(async () => {
    // Close the commit graph before the session ends so it isn't left as the
    // active pane view. The per-pane `gitGraph` state persists to localStorage,
    // which is shared across every tauri-driver session (same origin), so a
    // graph left open here would relaunch later specs into graph mode and
    // `.file-list` would never render (#447). navigateTo also resets defensively.
    await browser.execute(() => {
      window.dispatchEvent(new CustomEvent("e2e-reset-view"));
    });
    await $(".file-list").waitForExist({ timeout: 15_000 });
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("F5 fetches a remote commit and it appears in the graph", async () => {
    await navigateTo(localDir);

    // Open the commit graph via the command palette (robust under Xvfb, where
    // some Alt-chord shortcuts are unreliable).
    await browser.keys(["Control", "Shift", "p"]);
    const palette = $(".command-palette-dialog .search-input");
    await palette.waitForDisplayed();
    await palette.setValue("Toggle Commit Graph");
    await $(".command-item").waitForDisplayed();
    await browser.keys(["Enter"]);

    await $('[data-testid="git-graph-view"]').waitForExist({ timeout: 15_000 });

    // Initial commit renders from the real backend log.
    await browser.waitUntil(
      async () => (await graphSubjects()).includes(INITIAL_SUBJECT),
      { timeout: 15_000, timeoutMsg: "initial commit never rendered in the graph" },
    );

    // Out-of-band: a new commit lands on the remote. The app hasn't fetched it.
    const remoteSubject = `e2e remote update ${Date.now()}`;
    commitAndPush(otherCloneDir, remoteSubject, "remote-1.txt");

    // Sanity: without a refresh the new commit is NOT visible yet.
    expect(await graphSubjects()).not.toContain(remoteSubject);

    // F5 → gitGraph.refresh command → real `git fetch` + graph reload.
    await browser.keys(["F5"]);

    // The regression assertion: the fetched origin/main commit must surface.
    await browser.waitUntil(
      async () => (await graphSubjects()).includes(remoteSubject),
      {
        timeout: 15_000,
        timeoutMsg:
          "F5 fetch did not update the graph with the new remote commit (#432 regression)",
      },
    );
  });

  it("a rapid double F5 during load still converges", async () => {
    // Another out-of-band commit.
    const remoteSubject = `e2e remote burst ${Date.now()}`;
    commitAndPush(otherCloneDir, remoteSubject, "remote-2.txt");

    // Two refreshes fired back-to-back: the second lands while the first's
    // fetch+reload is in flight. The dirty-flag re-run (#432) must still leave
    // the graph converged on the latest state rather than wedged on a stale one.
    await browser.keys(["F5"]);
    await browser.keys(["F5"]);

    await browser.waitUntil(
      async () => (await graphSubjects()).includes(remoteSubject),
      {
        timeout: 15_000,
        timeoutMsg: "graph never converged after a rapid double F5 (wedged refresh)",
      },
    );
  });
});
