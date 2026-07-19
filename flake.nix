{
  description = "tauri-explorer: a keyboard-first file manager (Tauri v2 + Svelte 5)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = pkgs.lib;

        cargoToml = lib.importTOML ./src-tauri/Cargo.toml;
        version = cargoToml.package.version;

        isLinux = pkgs.stdenv.hostPlatform.isLinux;

        # Tauri v2 on Linux embeds WebKitGTK; these are the runtime/link-time
        # deps it (and a couple of our own crates) need. Names verified
        # against nixpkgs-unstable (2026-07): `webkitgtk_4_1` and `libsoup_3`
        # are the WebKitGTK 4.1 / libsoup3 attrs Tauri v2 requires (the older
        # `webkitgtk`/`libsoup` 2.x attrs are for Tauri v1 and don't work).
        tauriLinuxDeps = with pkgs; [
          glib
          gtk3
          cairo
          pango
          gdk-pixbuf
          librsvg
          dbus
          openssl
          libsoup_3
          webkitgtk_4_1
          libayatana-appindicator # tray-icon support, harmless if unused
        ];

        # Native build tools beyond pkg-config/cc that our Rust deps need:
        # - cmake + nasm: git2's `vendored-libgit2` feature and the
        #   `turbojpeg` crate both compile bundled C sources (libgit2,
        #   libjpeg-turbo) that need cmake and, for turbojpeg's SIMD asm,
        #   nasm — mirrors the `nasm` apt package in .github/workflows/release.yml.
        # - patchelf: used by tauri-bundler when producing Linux bundles.
        nativeBuildTools = [
          pkgs.cmake
          pkgs.nasm
          pkgs.patchelf
          pkgs.pkg-config
        ];

        # `bun run build` (Tauri's `beforeBuildCommand`) needs `node_modules`
        # already populated. nixpkgs has no `buildBunPackage`/`fetchBunDeps`
        # equivalent to npm's `fetchNpmDeps` yet (tracked upstream:
        # NixOS/nixpkgs#255890), and the community `bun2nix` project requires
        # committing a generated `bun.nix` mirror of `bun.lock` plus an extra
        # flake input/CLI — more moving parts than this repo's lockfile churn
        # warrants. Instead we do what every pre-`fetchNpmDeps` era Nix
        # package for npm/yarn did: run the real installer inside a
        # fixed-output derivation. FODs are allowed network access (Nix
        # trusts the output hash instead of sandboxing the inputs), so `bun
        # install --frozen-lockfile` can hit the registry, and the result is
        # still reproducible because Nix checks the produced `node_modules`
        # against `outputHash`.
        #
        # Bump `outputHash` whenever `bun.lock` changes: `nix build
        # .#bunDeps` will fail with the correct hash to paste in.
        bunDeps = pkgs.stdenvNoCC.mkDerivation {
          pname = "tauri-explorer-bun-deps";
          inherit version;

          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./package.json
              ./bun.lock
            ];
          };

          nativeBuildInputs = [ pkgs.bun ];
          dontConfigure = true;
          # This is a raw content blob, not a runnable derivation — skip the
          # generic fixup phase entirely. It patches shebangs/RPATHs to point
          # at other store paths, which fixed-output derivations must not
          # reference (only their own content hash is trusted).
          dontFixup = true;

          buildPhase = ''
            runHook preBuild
            export HOME="$TMPDIR"
            # Playwright/webdriverio are devDependencies unused by the
            # production frontend build; skip Playwright's (network-heavy,
            # non-reproducible-size) browser download.
            export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
            bun install --frozen-lockfile --no-progress
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp -r node_modules "$out/node_modules"
            runHook postInstall
          '';

          outputHashMode = "recursive";
          outputHash = "sha256-8idWpx8ZBNkR346Ga8YHjTy6/eQQD3q4uq3YQJbXdXY=";
        };
      in
      {
        # Exposed mainly so `nix build .#bunDeps` can be used to (re)compute
        # `outputHash` above after `bun.lock` changes.
        packages.bunDeps = bunDeps;

        packages.default = pkgs.rustPlatform.buildRustPackage (finalAttrs: {
          pname = "tauri-explorer";
          inherit version;

          src = ./.;

          # Cargo.toml/Cargo.lock live in src-tauri/, not the repo root.
          cargoRoot = "src-tauri";
          buildAndTestSubdir = finalAttrs.cargoRoot;
          cargoLock.lockFile = ./src-tauri/Cargo.lock;

          nativeBuildInputs = [
            pkgs.cargo-tauri.hook
            pkgs.bun
            # Not invoked directly (the frontend build runs through `bun run
            # build`), but several JS deps in node_modules/.bin shebang
            # `#!/usr/bin/env node`; `patchShebangs` (below) needs a `node`
            # on PATH to resolve those to a working store path.
            pkgs.nodejs
          ]
          ++ nativeBuildTools
          ++ lib.optionals isLinux [ pkgs.wrapGAppsHook4 ];

          buildInputs = lib.optionals isLinux tauriLinuxDeps;

          # tauriBuildHook's `preBuild` runs before it `pushd`s into
          # cargoRoot, so this still runs from the repo root — exactly where
          # `bun run build` (Tauri's beforeBuildCommand, which `bun run`
          # resolves by walking up to the nearest package.json) needs
          # node_modules to already exist, offline.
          preBuild = ''
            cp -r ${bunDeps}/node_modules ./node_modules
            chmod -R u+w ./node_modules
            # bunDeps was assembled outside the sandbox (a FOD, so it can't
            # reference other store paths — see its `dontFixup`), so its
            # `#!/usr/bin/env ...` shebangs were never patched to nix store
            # paths. Do that now that it's copied into a normal derivation.
            patchShebangs ./node_modules
            export HOME="$TMPDIR"
          '';

          # cargo-tauri.hook's tauriBuildHook drives `cargo tauri build`
          # itself (with --profile release), which is what gates the
          # `tauri/custom-protocol` feature on — unlike a bare `cargo build
          # --release`, which silently produces a dev-mode binary that dials
          # localhost:1420 (see CLAUDE.md). Nothing to do here beyond using
          # the hook rather than bypassing it.
          doCheck = false;

          meta = {
            description = "A keyboard-first file manager: fuzzy quick-open, ripgrep content search, a command palette for every action";
            homepage = "https://github.com/xnmp/tauri-explorer";
            license = lib.licenses.mit;
            mainProgram = "tauri-explorer";
            platforms = lib.platforms.linux;
          };
        });

        apps.default = flake-utils.lib.mkApp {
          drv = self.packages.${system}.default;
          name = "tauri-explorer";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.nodejs # a couple of scripts/*.mjs shell out to `node` directly
            pkgs.rustc
            pkgs.cargo
            pkgs.rustfmt
            pkgs.clippy
          ]
          ++ nativeBuildTools
          ++ tauriLinuxDeps
          ++ lib.optionals isLinux [ pkgs.wrapGAppsHook4 ];

          # No manual PKG_CONFIG_PATH/LD_LIBRARY_PATH wiring: pkg-config's
          # nixpkgs setup hook already adds every buildInput's `.pc` dir to
          # PKG_CONFIG_PATH, and wrapGAppsHook4's setup hook exports the
          # GSettings schema / GI typelib / XDG_DATA_DIRS variables WebKitGTK
          # and GTK need — the same mechanism nixpkgs uses to wrap installed
          # Tauri binaries, just applied to the shell environment instead.
          shellHook = ''
            export RUST_SRC_PATH="${pkgs.rustPlatform.rustLibSrc}"
          '';
        };
      }
    );
}
