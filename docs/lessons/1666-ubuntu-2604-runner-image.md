# Ubuntu 26.04 runner image: renamed WebKit driver, multicall coreutils

When GitHub's `ubuntu-latest` switched to Ubuntu 26.04 ("resolute"), two
things broke without any change in the repository:

1. **Required `smoke (ubuntu-latest)` and the Native recovery workflow** failed
   in `apt.sh key` with `E: Package 'webkit2gtk-driver' has no installation
   candidate`. 26.04 ships `/usr/bin/WebKitWebDriver` in `webkitgtk-webdriver`
   and has dropped the transitional `webkit2gtk-driver`. 24.04 has only the old
   name, and the image rollout can give a job either image. `apt.sh` now
   accepts `a|b` alternatives and installs the first with a candidate. Package
   lists name `webkitgtk-webdriver|webkit2gtk-driver`. The first version of
   the candidate probe piped `apt-cache policy` into `grep -q`. Under the
   script's `pipefail`, that pipeline returns 141 (SIGPIPE) when grep exits
   early, so every alternative looked unavailable. Capture the output first.
   The test stub keeps writing after its Candidate line, as apt does, so the
   piped form fails the contract tests.
2. **Scheduled `frontend` unit tests** failed in
   `tests/qualification/native-process-manifest.test.ts` ("expected one exact
   test application, found 0"). The fixture copied `/usr/bin/sleep` under
   another name. On 26.04 that is uutils' multicall coreutils, and the
   renamed copy did not keep running, even with `argv0: "sleep"`. The fixture
   now hard-links (or copies) the Node binary running the tests and runs a
   timer with `-e`, which does not depend on its name.

To check whether a failure is caused by the image, look for `resolute` (or the
new release codename) in the apt index output, and compare it with the last
green run's image.

Follow-up: `perf.yml`'s Tiles Scroll Perf job ran `npx playwright install
--with-deps chromium` on the host, and Playwright refuses 26.04 hosts ("does not
support chromium on ubuntu26.04-x64"). It now runs in the same digest-pinned
Playwright container as ci.yml's browser jobs, with the container bun pin.
`tests/ci-playwright-container.test.ts` holds it to that image.
