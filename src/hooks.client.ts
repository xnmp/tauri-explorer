// Client entry (SPA mode): install crash capture before the app boots, so
// uncaught errors thrown during component init/mount are recorded — onMount
// would miss anything that fires before the root component finishes mounting.
import { installGlobalErrorHandlers } from "$lib/api/crash";

installGlobalErrorHandlers();

// The marketing site's embedded demo (`bun run build:demo`). The constant
// folds in every other build, so the boot module and everything it imports
// are dropped from the release bundle (`check:bundle` verifies this).
const SITE_DEMO = import.meta.env.VITE_SITE_DEMO === "1";

/** SvelteKit awaits `init` before loading any route, so the demo's fixture
 *  handshake completes before the app's first command. */
export const init = SITE_DEMO
  ? () => import("$lib/state/site-demo-boot").then(({ bootSiteDemo }) => bootSiteDemo())
  : undefined;
