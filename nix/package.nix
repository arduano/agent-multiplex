{ lib, buildNpmPackage, importNpmLock, nodejs_24, nodejs-slim_24,
  makeWrapper, autoPatchelfHook, stdenv, musl, ncurses, source }:
let
  package = builtins.fromJSON (builtins.readFile (source + "/package.json"));
  lock = builtins.fromJSON (builtins.readFile (source + "/package-lock.json"));
  https = value: builtins.isString value &&
    builtins.match "https://[A-Za-z0-9.-]+(:[0-9]+)?/[^[:space:]]*" value != null;
  published = item: builtins.isAttrs item && !(item.link or false) &&
    https (item.resolved or null) && builtins.isString (item.integrity or null) &&
    builtins.match "sha(256|384|512)-[A-Za-z0-9+/]+=*" item.integrity != null;
  locked = builtins.attrNames lock.packages;
  declared = (package.dependencies or { }) // (package.devDependencies or { }) //
    (package.optionalDependencies or { });
  pinned = name:
    let
      spec = declared.${name};
      entry = lock.packages.${"node_modules/" + name} or null;
    in entry != null && builtins.isString spec && (
      (https spec && entry.resolved == spec) ||
      (builtins.match "[0-9]+\\.[0-9]+\\.[0-9]+(-[A-Za-z0-9.-]+)?(\\+[A-Za-z0-9.-]+)?" spec != null &&
        entry.version == spec)
    );
  clean = lib.cleanSourceWith {
    src = source;
    filter = import ./source-filter.nix source;
  };
in
assert lib.assertMsg (lock.lockfileVersion == 3 && builtins.all (path:
  path == "" || (builtins.match "node_modules/.*" path != null && published lock.packages.${path})
) locked) "Agent Multiplex requires HTTPS/SRI npm lock artifacts; local, linked and git sources are refused";
assert lib.assertMsg (builtins.all pinned (builtins.attrNames declared))
  "Agent Multiplex requires exact declared versions or matching pinned HTTPS artifacts";
assert nodejs_24.version == "24.19.0";
assert nodejs-slim_24.version == "24.19.0";
buildNpmPackage {
  pname = "agent-multiplex";
  inherit (package) version;
  src = clean;
  nodejs = nodejs_24;
  npmDeps = importNpmLock { npmRoot = clean; };
  npmConfigHook = importNpmLock.npmConfigHook;
  # Shared by install, rebuild, explicit build, pack and prune. The named build
  # still runs; npm's implicit dependency/pre/post lifecycle scripts do not.
  npmFlags = [ "--ignore-scripts" ];
  npmInstallFlags = [ "--include=optional" ];
  npmPruneFlags = [ "--include=optional" ];
  nativeBuildInputs = [ makeWrapper autoPatchelfHook ];
  # Published Koffi includes a musl addon; Codex includes zsh/tinfo. Let the
  # normal ELF hook resolve their real dependencies without an ignore list.
  buildInputs = [ stdenv.cc.cc.lib musl ncurses ];
  dontStrip = true;
  postInstall = ''
    target="$out/lib/node_modules/@arduano/agent-multiplex"
    rm -f "$out/bin/multiplex"
    makeWrapper ${nodejs-slim_24}/bin/node "$out/bin/multiplex" \
      --add-flags "$target/dist/reference/cli.js"
  '';
  meta = { description = "Typed native-agent Hosts, routing and retained React clients";
    license = lib.licenses.mit; platforms = [ "x86_64-linux" ]; mainProgram = "multiplex"; };
}
