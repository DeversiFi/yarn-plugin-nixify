{
  description = "yarn-plugin-nixify";

  inputs = {
    # Note: with "latest" nixpkgs (747927516efcb5e31ba03b7ff32f61f6d47e7d87) mozjpeg does not build
    nixpkgs.url = "github:NixOS/nixpkgs/29769d2a1390d294469bcc6518f17931953545e1";
    flake-utils.url = "github:numtide/flake-utils";
    flake-compat = {
      url = "github:edolstra/flake-compat";
      flake = false;
    };
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
    ...
  }: (
    flake-utils.lib.eachDefaultSystem (
      system: (
        let
          pkgs = nixpkgs.legacyPackages.${system};
          inherit (pkgs) coreutils lib yarn;
        in {
          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs
              yarn
            ];
          };
        }
      )
    )
  );
}
