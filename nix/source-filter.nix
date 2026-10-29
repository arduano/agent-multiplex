# Only inputs consumed by the framework build enter its source derivation.
# Mutable agent/system state and local development output have no implicit home.
root: path: type:
let
  rootPath = toString root;
  value = toString path;
  relative = if value == rootPath then "" else
    builtins.substring (builtins.stringLength rootPath + 1) (builtins.stringLength value) value;
  prefix = start: builtins.substring 0 (builtins.stringLength start) relative == start;
in
  type != "symlink" && (
    relative == "" || relative == "src" || prefix "src/" || relative == "scripts" ||
    builtins.elem relative [ "package.json" "package-lock.json" "tsconfig.json"
      "LICENSE" "README.md" "scripts/build.ts" ]
  )
