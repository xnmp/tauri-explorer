# Ubuntu 26.04 runner image: renamed WebKit driver, multicall coreutils

When GitHub's `ubuntu-latest` switched to Ubuntu 26.04 ("resolute"), two
things broke without any change in the repository:

1. **Required `smoke (ubuntu-latest)` and the Native recovery workflow** failed
   in `apt.sh key` with `E: Package 'webkit2gtk-driver' has no installation
   candidate`. 26.04 ships `/usr/bin/WebKitWebDriver` in `webkitgtk-webdriver`
   and has dropped the transitional `webkit2gtk-driver`. 24.04 has only the old
   name, and the image rollout can give a job either image. `apt.sh` now
   accepts `a|b` alternatives and installs the first with a candidate. Package
   lists name `webkitgtk-webdriver|webkit2gtk-driver`.
2. **Scheduled `frontend` unit tests** failed in
   `tests/qualification/native-process-manifest.test.ts` ("expected one exact
   test application, found 0"). 26.04's `/usr/bin/sleep` is uutils' multicall
   binary, which dispatches on `argv[0]`, so a copy named `qualified-app`
   exited immediately. The fixture now spawns it with `argv0: "sleep"`.
   `/proc/<pid>/exe` still names the copy, which is what the selector matches.

To check whether a failure is caused by the image, look for `resolute` (or the
new release codename) in the apt index output, and compare it with the last
green run's image.
