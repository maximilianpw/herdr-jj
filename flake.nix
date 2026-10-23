{
  description = "JJ-first Herdr workspace plugin with native-style JJ/Git dialogs";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    self,
    nixpkgs,
    bun2nix,
  }: let
    systems = ["aarch64-darwin" "aarch64-linux" "x86_64-linux"];
    forAllSystems = nixpkgs.lib.genAttrs systems;
    pkgsFor = system: import nixpkgs {inherit system;};
  in {
    packages = forAllSystems (system: let
      pkgs = pkgsFor system;
      package = pkgs.callPackage ./nix/package.nix {
        bun2nix = bun2nix.packages.${system}.default;
      };
    in {
      default = package;
      herdr-jj = package;
    });

    apps = forAllSystems (system: {
      default = {
        type = "app";
        program = "${self.packages.${system}.default}/bin/herdr-jj";
        meta.description = "Manage JJ and Git workspaces in Herdr";
      };
    });

    checks = forAllSystems (system: {
      package = self.packages.${system}.default;
    });

    devShells = forAllSystems (system: let
      pkgs = pkgsFor system;
    in {
      default = pkgs.mkShell {
        packages = [pkgs.bun pkgs.jujutsu pkgs.git pkgs.lsof pkgs.alejandra bun2nix.packages.${system}.default];
      };
    });

    formatter = forAllSystems (system: (pkgsFor system).alejandra);
  };
}
