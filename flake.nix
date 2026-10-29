{
  description = "Agent Multiplex public immutable framework and reference application";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/d6524aaca2ff07876657ae2b323f24be4874944b";
  outputs = { self, nixpkgs }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs { inherit system; };
    runtime = pkgs.callPackage ./nix/package.nix { source = self; };
  in {
    packages.${system} = { default = runtime; agent-multiplex = runtime; };
    apps.${system}.default = { type = "app"; program = "${runtime}/bin/multiplex"; };
    checks.${system}.payload = runtime;
  };
}
