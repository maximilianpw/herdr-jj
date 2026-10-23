#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyte==0.8.2", "wcwidth==0.2.13"]
# ///
"""Real Herdr smoke test, isolated config/registry/session and disposable jj repo."""
import argparse
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

import pyte

class VerificationScreen(pyte.Screen):
    def report_device_status(self, mode, private=False):
        # Herdr emits private DSR queries; this passive renderer has no terminal
        # capabilities to report. pyte 0.8.2's default handler lacks this kwarg.
        pass


project = Path(__file__).resolve().parent.parent
herdr = shutil.which("herdr")
jj = shutil.which("jj")
assert herdr and jj, "Install Herdr 0.9.5+ and jj 0.46+ first"
parser = argparse.ArgumentParser()
parser.add_argument("--plugin-root", type=Path, default=project,
                    help="Plugin directory to verify (source tree or Nix store package/share/herdr-jj)")
args = parser.parse_args()
plugin_root = args.plugin_root.resolve()
plugin = plugin_root / "dist/herdr-jj"
assert plugin.is_file(), "Build the plugin first"
evidence = project / ".verification"
evidence.mkdir(exist_ok=True)

with tempfile.TemporaryDirectory(prefix="hjj-", dir="/tmp") as temporary:
    home = Path(temporary).resolve()
    config = home / ".config/herdr/config.toml"
    config.parent.mkdir(parents=True)
    config.write_text('''onboarding = false
[terminal]
default_shell = "/bin/sh"
shell_mode = "non_login"
[update]
version_check = false
manifest_check = false
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["$vcs_status", "$vcs_bookmark"]]
[[keys.command]]
key = "prefix+j"
type = "plugin_action"
command = "personal.herdr-jj.create"
description = "new jj workspace"
[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "personal.herdr-jj.open"
description = "open jj workspace"
[[keys.command]]
key = "prefix+x"
type = "plugin_action"
command = "personal.herdr-jj.cleanup"
description = "archive jj workspace"
''')
    jj_config = home / "jj.toml"
    jj_config.write_text('''[user]
name = "Herdr JJ Verification"
email = "test@example.invalid"
[revset-aliases]
"trunk()" = "main"
[signing]
behavior = "drop"
''')
    env = {
        "PATH": os.environ["PATH"], "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "HERDR_CONFIG_PATH": str(config), "HERDR_SESSION": "jj-test",
        "HERDR_BIN_PATH": herdr, "JJ_CONFIG": str(jj_config),
        "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
        "TERM": "xterm-256color", "SHELL": "/bin/sh", "LANG": "en_US.UTF-8", "PS1": "hjj-test$ ",
    }
    repo = home / "repo"

    def run(argv, cwd=None, check=True):
        result = subprocess.run([str(arg) for arg in argv], env=env, cwd=cwd or home,
                                text=True, capture_output=True, timeout=30)
        if check and result.returncode:
            raise AssertionError(f"Command failed: {argv}\n{result.stdout}\n{result.stderr}")
        return result

    def h(*args):
        return json.loads(run([herdr, "--session", "jj-test", *args]).stdout)["result"]

    def cli(*args):
        return json.loads(run([plugin, *args, "--repo", repo]).stdout)["result"]

    run([jj, "git", "init", "--colocate", repo])
    (repo / "hello.txt").write_text("verified\n")
    run([jj, "describe", "-m", "seed"], repo)
    run([jj, "bookmark", "set", "main", "-r", "@"], repo)
    run([jj, "new"], repo)
    # A real submodule reproduces Git metadata outside the primary checkout.
    superproject = home / "superproject"
    run(["git", "init", superproject])
    submodule = superproject / "module"
    run(["git", "-c", "protocol.file.allow=always", "submodule", "add", repo, submodule], superproject)
    run([jj, "git", "init", "--colocate"], submodule)
    run([jj, "config", "set", "--repo", 'revset-aliases."trunk()"', "main"], submodule)
    run([jj, "new", "main"], submodule)
    git_only = home / "git-only"
    run(["git", "init", "--initial-branch=git-visible", git_only])
    # Native Git branch rows must not leak into the JJ-first sidebar.
    run(["git", "switch", "-c", "git-hidden"], repo)
    config_dir = Path(run([herdr, "plugin", "config-dir", "personal.herdr-jj"]).stdout.strip())
    assert config_dir.is_relative_to(home), "Refusing to link outside the isolated home"
    # Home Manager runs this again on every activation and on rollback.
    run([herdr, "plugin", "link", plugin_root])
    run([herdr, "plugin", "link", plugin_root])
    server_log = open(evidence / "herdr-server.log", "w")
    server = subprocess.Popen([herdr, "--session", "jj-test", "server"], env=env, cwd=repo,
                              stdout=server_log, stderr=server_log)
    client = None
    master = None
    transcript = bytearray()
    screen = VerificationScreen(120, 36)
    terminal_stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    try:
        deadline = time.monotonic() + 15
        while True:
            result = run([herdr, "--session", "jj-test", "workspace", "list"], check=False)
            if result.returncode == 0:
                break
            assert server.poll() is None, "Isolated server exited; inspect .verification/herdr-server.log"
            assert time.monotonic() < deadline, "Isolated server did not become ready"
            time.sleep(0.1)
        primary = h("workspace", "create", "--cwd", str(repo), "--label", "JJ test", "--focus")
        primary_id = primary["workspace"]["workspace_id"]
        actions = h("plugin", "action", "list", "--plugin", "personal.herdr-jj")
        assert '"create"' in json.dumps(actions), actions
        created = cli("create", "cli-task", "--focus")
        target = Path(created["workspace"]["path"])
        assert target.is_dir() and (target / ".git").is_file()
        listed = h("workspace", "list")["workspaces"]
        linked = next(workspace for workspace in listed
                      if workspace.get("worktree", {}).get("checkout_path") == str(target))
        assert linked["worktree"]["is_linked_worktree"]
        assert linked["worktree"]["repo_root"] == str(repo)
        cli("refresh")
        tokens = h("workspace", "get", linked["workspace_id"])["workspace"]["tokens"]
        assert tokens["jj_change"] and tokens["jj_files"] == "0"
        assert tokens["vcs_status"] == tokens["jj_status"]
        cli("open", "cli-task")
        assert len(h("workspace", "list")["workspaces"]) == len(listed), "Open duplicated the Herdr space"
        h("workspace", "close", linked["workspace_id"])
        assert target.is_dir(), "Closing Herdr deleted the checkout"
        archived = cli("cleanup", "cli-task", "--confirm", str(target))
        assert Path(archived["archive"]).joinpath("hello.txt").read_text() == "verified\n"
        assert not target.exists()
        h("workspace", "create", "--cwd", str(submodule), "--label", "Submodule", "--no-focus")
        sub_created = json.loads(run([plugin, "create", "sub-task", "--repo", submodule]).stdout)["result"]
        sub_path = Path(sub_created["workspace"]["path"])
        assert sub_path == superproject / "module.jj-sub-task"
        sub_space = next(space for space in h("workspace", "list")["workspaces"]
                         if space.get("worktree", {}).get("checkout_path") == str(sub_path))
        assert sub_space["worktree"]["repo_root"] == str(submodule)
        git_space = h("workspace", "create", "--cwd", str(git_only), "--label", "Git only", "--no-focus")
        cli("refresh")
        sub_tokens = h("workspace", "get", sub_space["workspace_id"])["workspace"]["tokens"]
        assert sub_tokens["vcs_status"].startswith("jj ")
        git_tokens = h("workspace", "get", git_space["workspace"]["workspace_id"])["workspace"]["tokens"]
        assert git_tokens["vcs_status"] == "git git-visible" and "jj_status" not in git_tokens
        h("workspace", "focus", primary_id)

        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 120, 0, 0))
        client = subprocess.Popen([herdr, "--session", "jj-test"], env=env, cwd=repo,
                                  stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)

        def wait_text(needle, start=0, timeout=15):
            deadline = time.monotonic() + timeout
            def rendered_contains():
                text = "".join("".join(screen.display).split())
                return len(transcript) > start and "".join(needle.decode().split()) in text
            while not rendered_contains():
                assert time.monotonic() < deadline, f"Terminal did not display {needle!r}"
                readable, _, _ = select.select([master], [], [], 0.2)
                if readable:
                    data = os.read(master, 65536)
                    assert data, "Client terminal closed"
                    transcript.extend(data)
                    terminal_stream.feed(decoder.decode(data))
            return len(transcript)

        def send(data):
            os.write(master, data)

        def wait_popup_exit():
            deadline = time.monotonic() + 15
            while True:
                # Keep the attached terminal draining while we wait for the
                # process. Full-frame terminal UIs otherwise fill the PTY and
                # block the client before it can deliver cancellation input.
                readable, _, _ = select.select([master], [], [], 0.05)
                if readable:
                    data = os.read(master, 65536)
                    transcript.extend(data)
                    terminal_stream.feed(decoder.decode(data))
                rows = [line.strip().split(None, 2) for line in run(["ps", "-axo", "pid,ppid,command"]).stdout.splitlines()[1:]]
                parents = {int(row[0]): int(row[1]) for row in rows if len(row) == 3}
                def owned(pid):
                    seen = set()
                    while pid in parents and pid not in seen:
                        if pid == server.pid:
                            return True
                        seen.add(pid)
                        pid = parents[pid]
                    return False
                running = any(len(row) == 3 and "herdr-jj pane " in row[2] and owned(int(row[0])) for row in rows)
                if not running:
                    # Allow Herdr's next render tick to retire the exited modal.
                    time.sleep(0.1)
                    return
                assert time.monotonic() < deadline, "Popup process did not exit"
                time.sleep(0.05)

        wait_text(b"JJ test")
        wait_text(b"git git-visible")
        primary_tokens = h("workspace", "get", primary_id)["workspace"]["tokens"]
        wait_text(primary_tokens["vcs_status"].encode())
        assert "git-hidden" not in "\n".join(screen.display), "Native Git row leaked into JJ sidebar"
        (evidence / "vcs-sidebar.txt").write_text("\n".join(screen.display))
        # Exercise the installed manifest action via its real keybinding.
        mark = len(transcript)
        send(b"\x02j")
        mark = wait_text(b"workspace-name", mark)
        send(b"popup-task")
        mark = wait_text(b"repo.jj-popup-task", mark)
        (evidence / "native-style-create.txt").write_text("\n".join(screen.display))
        assert any(cell.bg == "313244" for line in screen.buffer.values() for cell in line.values()), "Focused field is not styled"
        send(b"\r")  # One form, JJ and trunk are already selected.
        deadline = time.monotonic() + 15
        while not (home / "repo.jj-popup-task/.git").exists():
            assert time.monotonic() < deadline, "Popup did not create a colocated workspace"
            time.sleep(0.1)
        # Wait for open to finish; then open a second popup and cancel it.
        mark = wait_text(b"jj: popup-task", mark)
        wait_popup_exit()
        send(b"\x02j")
        wait_text(b"workspace-name", mark)
        send(b"\x1b")
        wait_popup_exit()
        names = run([jj, "--ignore-working-copy", "workspace", "list", "-T", 'name ++ "\\n"'], repo).stdout
        assert names.strip().splitlines() == ["default", "popup-task"]
        cli("create", "popup-task", "--no-open")  # Same journal as the popup.
        mark = len(transcript)
        send(b"\x02o")
        mark = wait_text(b"2 workspaces", mark)
        send(b"\r")  # First entry is the primary/default jj workspace.
        wait_popup_exit()
        assert h("workspace", "get", primary_id)["workspace"]["focused"]
        cli("create", "pop-clean", "--no-open")
        mark = len(transcript)
        send(b"\x02x")
        mark = wait_text(b"pop-clean", mark)
        send(b"\r")  # pop-clean sorts before popup-task.
        mark = wait_text(b"Type the full path", mark)
        send(str(home / "repo.jj-pop-clean").encode() + b"\r")
        wait_text(b"Archived without deleting files", mark)
        send(b"\r")
        wait_popup_exit()
        assert cli("cleanup", "pop-clean")["phase"] == "archived"

        send(b"\x02j")
        mark = wait_text(b"workspace-name", mark)
        send(b"popup-git")
        send(b"\x1b[Z\x1b[C")  # Shift-tab to type, right to Git.
        mark = wait_text(b"repo.git-popup-git", mark)
        send(b"\r")
        mark = wait_text(b"git: popup-git", mark)
        wait_popup_exit()
        git_target = home / "repo.git-popup-git"
        assert git_target.joinpath(".git").is_file() and not git_target.joinpath(".jj").exists()
        inventory = cli("list")["workspaces"]
        assert len(inventory) == 3, inventory
        assert [item["kind"] for item in inventory] == ["jj", "jj", "git"]
        git_linked = next(space for space in h("workspace", "list")["workspaces"]
                          if space.get("worktree", {}).get("checkout_path") == str(git_target))
        assert git_linked["worktree"]["repo_root"] == str(repo)
        h("workspace", "focus", primary_id)
        send(b"\x02o")
        mark = wait_text(b"3 workspaces", mark)
        wait_text(b"GIT", mark - 1)
        (evidence / "mixed-workspace-picker.txt").write_text("\n".join(screen.display))
        send(b"/popup-git")
        mark = wait_text(b"1/3 workspaces", mark)
        (evidence / "native-style-filter.txt").write_text("\n".join(screen.display))
        assert any(cell.bg == "89b4fa" for line in screen.buffer.values() for cell in line.values()), "Selected row is not highlighted"
        send(b"\x15not-a-workspace")  # Ctrl-U clears the filter.
        mark = wait_text(b"No matching workspaces", mark)
        focused_before = [space["workspace_id"] for space in h("workspace", "list")["workspaces"] if space["focused"]]
        send(b"\r")  # Empty results must not activate an unrelated entry.
        focused_after = [space["workspace_id"] for space in h("workspace", "list")["workspaces"] if space["focused"]]
        assert focused_after == focused_before
        send(b"\x1b")  # Clearing the filter also proves the picker stayed open.
        mark = wait_text(b"3 workspaces", mark)
        send(b"/popup-git\r")
        wait_popup_exit()
        assert h("workspace", "get", git_linked["workspace_id"])["workspace"]["focused"]
        # A Git-only sibling still discovers the repository's JJ support.
        git_created = json.loads(run([plugin, "create", "from-git-checkout", "--repo", git_target]).stdout)["result"]
        assert git_created["workspace"]["kind"] == "jj", "Repository-wide JJ availability should remain the default"
        pure_created = run([plugin, "create", "pure-task", "--repo", git_only], check=False)
        assert pure_created.returncode != 0, "An unborn Git HEAD must not be guessed"
        run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "seed"], git_only)
        pure_created = json.loads(run([plugin, "create", "pure-task", "--repo", git_only]).stdout)["result"]
        assert pure_created["workspace"]["kind"] == "git"
        assert not git_only.joinpath(".jj").exists()
        print(json.dumps({"passed": ["isolated manifest registration", "compiled CLI create/open",
              "colocated grouping", "submodule create/open/status", "JJ-only rendered sidebar", "Git-only rendered fallback", "sidebar tokens", "idempotent open", "close preserves checkout",
              "cleanup archive", "real keybinding popup create", "Escape cancellation", "CLI/popup shared journal",
              "open popup", "confirmed cleanup popup", "single-form creation and live path preview", "Git creation popup", "mixed counted workspace picker", "search and empty-result safety", "native-style colors", "Git-only default creation"],
              "live_session_modified": False}, indent=2))
    finally:
        (evidence / "herdr-plugin-log.json").write_text(run([herdr, "--session", "jj-test", "plugin", "log", "list", "--plugin", "personal.herdr-jj"], check=False).stdout)
        (evidence / "herdr-terminal.ansi").write_bytes(transcript)
        (evidence / "herdr-terminal.txt").write_text("\n".join(screen.display))
        if client is not None:
            client.terminate()
            try:
                client.wait(timeout=5)
            except subprocess.TimeoutExpired:
                client.kill()
                client.wait(timeout=5)
        if master is not None:
            os.close(master)
        # Explicit isolated env/session: never targets the caller's Herdr server.
        run([herdr, "--session", "jj-test", "server", "stop"], check=False)
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.terminate()
            server.wait(timeout=5)
        server_log.close()
