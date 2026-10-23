#!/usr/bin/env python3
"""Exercise the installed package without a server, network, or user configuration."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib

package = Path(sys.argv[1])
cli = package / "bin/herdr-jj"
plugin = package / "share/herdr-jj"
manifest = tomllib.loads((plugin / "herdr-plugin.toml").read_text())
assert manifest["id"] == "personal.herdr-jj"
for section in ["startup", "actions", "events", "panes"]:
    for entry in manifest[section]:
        assert (plugin / entry["command"][0]).is_file(), entry

with tempfile.TemporaryDirectory(prefix="herdr-jj-nix-") as temporary:
    home = Path(temporary).resolve()
    env = {"HOME": str(home), "PATH": os.environ["PATH"], "JJ_CONFIG": str(home / "jj.toml"),
           "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
    (home / "jj.toml").write_text('''[user]
name = "Nix package test"
email = "test@example.invalid"
[revset-aliases]
"trunk()" = "main"
[signing]
behavior = "drop"
''')

    def run(args, cwd=home):
        result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env,
                                text=True, capture_output=True, timeout=30)
        assert result.returncode == 0, f"{args}\n{result.stdout}\n{result.stderr}"
        return result.stdout

    repo = home / "repo"
    run(["jj", "git", "init", "--colocate", repo])
    (repo / "hello.txt").write_text("packaged\n")
    run(["jj", "describe", "-m", "seed"], repo)
    run(["jj", "bookmark", "set", "main", "-r", "@"], repo)
    run(["jj", "new"], repo)
    # Runtime tools must come from the package wrapper, not the caller's PATH.
    env["PATH"] = str(home / "no-tools")
    assert "create" in run([cli, "--help"])
    assert "create" in run([plugin / "dist/herdr-jj", "--help"])

    def command(*args):
        return json.loads(run([cli, *args, "--repo", repo, "--state-dir", home / "state"]))["result"]

    jj_workspace = command("create", "jj-test", "--no-open")["workspace"]
    git_workspace = command("create", "git-test", "--vcs", "git", "--no-open")["workspace"]
    assert Path(jj_workspace["path"]).joinpath(".jj").is_dir()
    assert not Path(git_workspace["path"]).joinpath(".jj").exists()
    assert Path(git_workspace["path"]).joinpath("hello.txt").read_text() == "packaged\n"
    inventory = command("list")["workspaces"]
    assert [entry["kind"] for entry in inventory] == ["jj", "jj", "git"]
    assert len({entry["path"] for entry in inventory}) == 3
    assert command("status")["files"] == 0
print("Nix package smoke test passed: installed manifest, wrapped tools, JJ/Git creation and inventory")
