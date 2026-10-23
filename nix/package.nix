{
  lib,
  stdenvNoCC,
  bun,
  bun2nix,
  makeWrapper,
  git,
  jujutsu,
  lsof,
  python3,
}:
assert lib.assertMsg (lib.versionAtLeast jujutsu.version "0.46") "herdr-jj requires JJ >= 0.46 for colocated workspaces";
assert lib.assertMsg (lib.versionAtLeast bun.version "1.3.14") "herdr-jj requires Bun >= 1.3.14";
  stdenvNoCC.mkDerivation {
    pname = "herdr-jj";
    inherit (builtins.fromJSON (builtins.readFile ../package.json)) version;
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [../src ../package.json ../bun.lock ../bun.nix ../herdr-plugin.toml];
    };

    nativeBuildInputs = [bun bun2nix.hook makeWrapper];
    bunDeps = bun2nix.fetchBunDeps {bunNix = ../bun.nix;};
    bunInstallFlags =
      ["--frozen-lockfile" "--production" "--linker=hoisted"]
      ++ lib.optionals stdenvNoCC.hostPlatform.isDarwin ["--backend=copyfile"];
    dontRunLifecycleScripts = true;
    dontUseBunPatch = true;
    dontUseBunBuild = true;
    dontUseBunCheck = true;
    dontUseBunInstall = true;
    # Bun embeds its executable payload and signature. Generic binary fixups
    # invalidate these; the wrapper already uses absolute store references.
    dontFixup = true;

    buildPhase = ''
      runHook preBuild
      bun build src/cli.ts --compile --outfile dist/herdr-jj
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      plugin="$out/share/herdr-jj"
      mkdir -p "$plugin/dist" "$out/libexec" "$out/bin"
      install -m755 dist/herdr-jj "$out/libexec/herdr-jj"
      cp herdr-plugin.toml "$plugin/herdr-plugin.toml"
      makeWrapper "$out/libexec/herdr-jj" "$out/bin/herdr-jj" \
        --prefix PATH : ${lib.makeBinPath [jujutsu git lsof]}
      ln -s "$out/bin/herdr-jj" "$plugin/dist/herdr-jj"
      runHook postInstall
    '';

    doInstallCheck = true;
    nativeInstallCheckInputs = [python3 jujutsu git];
    installCheckPhase = ''
      runHook preInstallCheck
      ${python3}/bin/python3 ${../tests/nix-package-smoke.py} "$out"
      runHook postInstallCheck
    '';

    meta = {
      description = "JJ and Git workspace management for Herdr";
      homepage = "https://github.com/maximilianpw/herdr-jj";
      mainProgram = "herdr-jj";
      platforms = ["aarch64-darwin" "aarch64-linux" "x86_64-linux"];
    };
  }
