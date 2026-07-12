// Client entry (SPA mode): install crash capture before the app boots, so
// uncaught errors thrown during component init/mount are recorded — onMount
// would miss anything that fires before the root component finishes mounting.
import { installGlobalErrorHandlers } from "$lib/api/crash";

installGlobalErrorHandlers();
