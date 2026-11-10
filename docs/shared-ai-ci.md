# Shared AI native CI

The `Shared AI native acceptance` workflow is a manually dispatched Linux
installed-plugin gate; it has no push or pull-request trigger. Its
`plugin_revision` input must be a complete lowercase
40-hex commit from `xnmp/TraceExplorer`; branches and tags are refused. The host
revision is the workflow checkout. Both revisions, three binary digests and the
verified archive digests are retained with native outcome logs and screenshots.

This job installs frozen Bun dependencies in each checkout, builds the host with
`e2e-hooks`, builds separate Trace/provider frontend and backend roots, packages
each explicit binary and validates both archives. It runs Trace once without its
optional provider, then once with Image Generation. The fixture uses separate
private XDG/Xvfb/D-Bus profiles, never the user profile. Only its loopback fake
HTTP server receives generation requests; inherited provider auth variables are
removed from the private launch.

Current outcomes cover actual cold installed startup, shipped CSS/CSP/runtime
ABI, optional-provider refusal, managed Configure draft/focus return, native CAS
profile/default changes, exact PNG publication and acquired receipt, busy disable
refusal, read controls and provider restart without paid replay. Renderer reload,
Unresolved Stop/Discard, legacy migration and Windows handoff remain separate
acceptance work. The helper intentionally labels its binary evidence as a
working-snapshot debug fixture, so this gate is not a clean release qualification.

The job has a 60-minute total bound, with each installed-app scenario bounded to
10 minutes. Frontend/package contract checks in the Trace checkout use five
45-minute native platform jobs and a 20-minute browser job. These bounds are not
measured runtimes. Neither workflow publishes a release or installs outside a
disposable profile.

Windows native qualification is mandatory before merge. The integrated Store,
`durable_dir` and installed-plugin tests run natively in the "Rust platforms"
Windows job; the Trace and provider handoff tests run natively in TraceExplorer's
Windows "Build plugin" job. A cross-target check cannot satisfy that gate.
