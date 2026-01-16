
// this file is generated — do not edit it


/// <reference types="@sveltejs/kit" />

/**
 * Environment variables [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env`. Like [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), this module cannot be imported into client-side code. This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured).
 * 
 * _Unlike_ [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), the values exported from this module are statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * ```ts
 * import { API_KEY } from '$env/static/private';
 * ```
 * 
 * Note that all environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * 
 * ```
 * MY_FEATURE_FLAG=""
 * ```
 * 
 * You can override `.env` values from the command line like so:
 * 
 * ```sh
 * MY_FEATURE_FLAG="enabled" npm run dev
 * ```
 */
declare module '$env/static/private' {
	export const ZELLIJ_SESSION_NAME: string;
	export const ATUIN_SESSION: string;
	export const SNAP_COMMON: string;
	export const SNAP_INSTANCE_KEY: string;
	export const USER: string;
	export const CLAUDE_CODE_ENTRYPOINT: string;
	export const npm_config_user_agent: string;
	export const GIT_EDITOR: string;
	export const BUN_INSTALL: string;
	export const npm_node_execpath: string;
	export const SHLVL: string;
	export const SNAP_UID: string;
	export const WT_PROFILE_ID: string;
	export const npm_config_noproxy: string;
	export const HOME: string;
	export const LESS: string;
	export const OLDPWD: string;
	export const SNAP_LIBRARY_PATH: string;
	export const VIPSHOME: string;
	export const NVM_BIN: string;
	export const SNAP_USER_DATA: string;
	export const npm_package_json: string;
	export const LSCOLORS: string;
	export const NVM_INC: string;
	export const ZSH: string;
	export const PAGER: string;
	export const npm_config_userconfig: string;
	export const npm_config_local_prefix: string;
	export const DBUS_SESSION_BUS_ADDRESS: string;
	export const P9K_TTY: string;
	export const VISUAL: string;
	export const SNAP_REVISION: string;
	export const WSL_DISTRO_NAME: string;
	export const COLOR: string;
	export const NVM_DIR: string;
	export const WAYLAND_DISPLAY: string;
	export const LOGNAME: string;
	export const NAME: string;
	export const PULSE_SERVER: string;
	export const SNAP_CONTEXT: string;
	export const WSL_INTEROP: string;
	export const _: string;
	export const _P9K_SSH_TTY: string;
	export const npm_config_prefix: string;
	export const npm_config_npm_version: string;
	export const ATUIN_HISTORY_ID: string;
	export const SNAP_VERSION: string;
	export const TERM: string;
	export const OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: string;
	export const npm_config_cache: string;
	export const SNAP_INSTANCE_NAME: string;
	export const npm_config_node_gyp: string;
	export const PATH: string;
	export const NODE: string;
	export const npm_package_name: string;
	export const SNAP_DATA: string;
	export const WT_SESSION: string;
	export const XDG_RUNTIME_DIR: string;
	export const COREPACK_ENABLE_AUTO_PIN: string;
	export const DISPLAY: string;
	export const LANG: string;
	export const NoDefaultCurrentDirectoryInExePath: string;
	export const LS_COLORS: string;
	export const ZELLIJ_PANE_ID: string;
	export const npm_lifecycle_script: string;
	export const SNAP_ARCH: string;
	export const SNAP_COOKIE: string;
	export const SNAP_USER_COMMON: string;
	export const ZELLIJ: string;
	export const SHELL: string;
	export const npm_package_version: string;
	export const npm_lifecycle_event: string;
	export const SNAP_REEXEC: string;
	export const SNAP_NAME: string;
	export const CLAUDECODE: string;
	export const P9K_SSH: string;
	export const npm_config_globalconfig: string;
	export const npm_config_init_module: string;
	export const FZF_DEFAULT_COMMAND: string;
	export const PWD: string;
	export const npm_execpath: string;
	export const NVM_CD_FLAGS: string;
	export const SNAP_REAL_HOME: string;
	export const _P9K_TTY: string;
	export const npm_config_global_prefix: string;
	export const SNAP: string;
	export const SNAP_EUID: string;
	export const npm_command: string;
	export const HOSTTYPE: string;
	export const WSL2_GUI_APPS_ENABLED: string;
	export const EDITOR: string;
	export const WSLENV: string;
	export const INIT_CWD: string;
	export const TEST: string;
	export const VITEST: string;
	export const NODE_ENV: string;
	export const PROD: string;
	export const DEV: string;
	export const BASE_URL: string;
	export const MODE: string;
}

/**
 * Similar to [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private), except that it only includes environment variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`), and can therefore safely be exposed to client-side code.
 * 
 * Values are replaced statically at build time.
 * 
 * ```ts
 * import { PUBLIC_BASE_URL } from '$env/static/public';
 * ```
 */
declare module '$env/static/public' {
	
}

/**
 * This module provides access to runtime environment variables, as defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`. This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured).
 * 
 * This module cannot be imported into client-side code.
 * 
 * ```ts
 * import { env } from '$env/dynamic/private';
 * console.log(env.DEPLOYMENT_SPECIFIC_VARIABLE);
 * ```
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` always includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 */
declare module '$env/dynamic/private' {
	export const env: {
		ZELLIJ_SESSION_NAME: string;
		ATUIN_SESSION: string;
		SNAP_COMMON: string;
		SNAP_INSTANCE_KEY: string;
		USER: string;
		CLAUDE_CODE_ENTRYPOINT: string;
		npm_config_user_agent: string;
		GIT_EDITOR: string;
		BUN_INSTALL: string;
		npm_node_execpath: string;
		SHLVL: string;
		SNAP_UID: string;
		WT_PROFILE_ID: string;
		npm_config_noproxy: string;
		HOME: string;
		LESS: string;
		OLDPWD: string;
		SNAP_LIBRARY_PATH: string;
		VIPSHOME: string;
		NVM_BIN: string;
		SNAP_USER_DATA: string;
		npm_package_json: string;
		LSCOLORS: string;
		NVM_INC: string;
		ZSH: string;
		PAGER: string;
		npm_config_userconfig: string;
		npm_config_local_prefix: string;
		DBUS_SESSION_BUS_ADDRESS: string;
		P9K_TTY: string;
		VISUAL: string;
		SNAP_REVISION: string;
		WSL_DISTRO_NAME: string;
		COLOR: string;
		NVM_DIR: string;
		WAYLAND_DISPLAY: string;
		LOGNAME: string;
		NAME: string;
		PULSE_SERVER: string;
		SNAP_CONTEXT: string;
		WSL_INTEROP: string;
		_: string;
		_P9K_SSH_TTY: string;
		npm_config_prefix: string;
		npm_config_npm_version: string;
		ATUIN_HISTORY_ID: string;
		SNAP_VERSION: string;
		TERM: string;
		OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: string;
		npm_config_cache: string;
		SNAP_INSTANCE_NAME: string;
		npm_config_node_gyp: string;
		PATH: string;
		NODE: string;
		npm_package_name: string;
		SNAP_DATA: string;
		WT_SESSION: string;
		XDG_RUNTIME_DIR: string;
		COREPACK_ENABLE_AUTO_PIN: string;
		DISPLAY: string;
		LANG: string;
		NoDefaultCurrentDirectoryInExePath: string;
		LS_COLORS: string;
		ZELLIJ_PANE_ID: string;
		npm_lifecycle_script: string;
		SNAP_ARCH: string;
		SNAP_COOKIE: string;
		SNAP_USER_COMMON: string;
		ZELLIJ: string;
		SHELL: string;
		npm_package_version: string;
		npm_lifecycle_event: string;
		SNAP_REEXEC: string;
		SNAP_NAME: string;
		CLAUDECODE: string;
		P9K_SSH: string;
		npm_config_globalconfig: string;
		npm_config_init_module: string;
		FZF_DEFAULT_COMMAND: string;
		PWD: string;
		npm_execpath: string;
		NVM_CD_FLAGS: string;
		SNAP_REAL_HOME: string;
		_P9K_TTY: string;
		npm_config_global_prefix: string;
		SNAP: string;
		SNAP_EUID: string;
		npm_command: string;
		HOSTTYPE: string;
		WSL2_GUI_APPS_ENABLED: string;
		EDITOR: string;
		WSLENV: string;
		INIT_CWD: string;
		TEST: string;
		VITEST: string;
		NODE_ENV: string;
		PROD: string;
		DEV: string;
		BASE_URL: string;
		MODE: string;
		[key: `PUBLIC_${string}`]: undefined;
		[key: `${string}`]: string | undefined;
	}
}

/**
 * Similar to [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), but only includes variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`), and can therefore safely be exposed to client-side code.
 * 
 * Note that public dynamic environment variables must all be sent from the server to the client, causing larger network requests — when possible, use `$env/static/public` instead.
 * 
 * ```ts
 * import { env } from '$env/dynamic/public';
 * console.log(env.PUBLIC_DEPLOYMENT_SPECIFIC_VARIABLE);
 * ```
 */
declare module '$env/dynamic/public' {
	export const env: {
		[key: `PUBLIC_${string}`]: string | undefined;
	}
}
