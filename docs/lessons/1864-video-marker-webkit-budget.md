# Video-marker matrix exhausted WebKit's test budget

The first failing dev CI run reached the last replacement-image click in
`e2e/video-indicators.spec.ts`, then exceeded the 30-second **test** timeout on
all three light/classic attempts. Material and dark/classic also timed out in
that tail and passed on a retry. This was cumulative scenario time, not a
failed video-marker expectation: the replacement row was already visible,
enabled and stable. The previous dev run was green; the intervening Compact
layout PR did not change the tested marker or preview code.

Keep the two color themes and five icon themes, but give each independent
behavior its own fresh fixture and test budget: all three view modes, preview
media/fullscreen transitions, and large Tiles plus refreshed image replacement.
All original outcome assertions remain, including the separate late-response
race case. No retries or timeout limits need increasing. A fast local run of
the original scenario is not proof against this cumulative CI failure.

Controlled local reproduction: with Playwright `launchOptions.slowMo: 1000`
(one second per browser action), the original light/classic scenario exhausted
its 30-second budget; the three split light/classic cases all passed with the
same delay and deadline. The temporary control spec/config were removed after
comparison. Without the delay, the full split WebKit matrix passed 31 tests.
