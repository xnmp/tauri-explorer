# Draft PR #812 hosted-check triage — 2026-09-28

The hosted draft head is `74596540`; the verified local head `83c27a1f`
merges exact `dev` `e8050938`. The old head's [bounded Windows soak](https://github.com/xnmp/tauri-explorer/actions/runs/36295698690)
passed, but two other hosted jobs failed:

- [Linux recovery](https://github.com/xnmp/tauri-explorer/actions/runs/36295698662)
  failed in `file-recovery.spec.ts`'s `before` hook: the status-bar path did not
  confirm navigation to the fixture replacement directory. The directory scan
  ran, then a WebDriver `executeScript` request for the navigation receipt had
  no logged response for about 15 seconds before the test timed out. The log
  does not establish whether the renderer, driver or application caused the
  delay. The later four-file history/move suite and renderer-recovery probe
  passed in that same job; they do not erase the file-recovery failure.
- [Windows native smoke](https://github.com/xnmp/tauri-explorer/actions/runs/36295698660)
  reported `moved: false` in the split-tab tear-off case of
  `window-transfer-lifetime.spec.ts`; the job ended with 38 passing and one
  failing spec file.

On the later `dev` tip `e8050938`, the [recovery job](https://github.com/xnmp/tauri-explorer/actions/runs/36306053114)
executed all seven `file-recovery.spec.ts` cases successfully, and the
[Windows native job](https://github.com/xnmp/tauri-explorer/actions/runs/36306053111)
passed 42/42 spec files, including that exact split-tab tear-off case. The
local #812 final tree differs from `e8050938` in seven soak/report/workflow
paths, none of which is either failing spec or its product code. This supports
rerunning the updated PR head; it does not prove either old failure's root
cause or count as final-head hosted acceptance.

The updated #812 head still needs publication and all required hosted checks.
W2.4's Windows smoke streak remains 2/5 qualifying `dev` runs.
