"""Contract for ``jupyter_aiterminal/dsh_profile.yml``, the agent runtime's authority overlay.

The profile is a patch layer over the shipped ``sdk-minimal`` bundle and is the
only place where the Jupyter AI Terminal narrows what the agent may do. These
checks compose the real profile tree through the bundled ``dsh`` CLI
(``--dump-config``), boot the pinned runtime with the overlay, call
``initialize``, and drive a local stub model through real ``bash`` tool calls.

Execution checks use a loopback stub model in a throwaway workspace with a
controlled empty ``DSH_HOME``; no real model, no external network, and no real
key is involved. Composition and execution errors fail loudly; they are never
converted into skips.

The SDK/runtime pair is pinned to ``0.2.1rc2``. ``serverInfo.version`` is the wire
protocol version, which is not required to equal the release version.

Run with the pinned probe venv visible to the repository's pytest::

    PYTHONPATH=<probe-venv>/lib/python3.13/site-packages \
        python -m pytest tests/test_dsh_profile.py -q
"""

from __future__ import annotations

import contextlib
import importlib.metadata
import importlib.util
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest
import yaml

PROFILE_PATH = Path(__file__).resolve().parents[1] / "jupyter_aiterminal" / "dsh_profile.yml"
SDK_DISTRIBUTION = "deepseek-harness-sdk"
RUNTIME_DISTRIBUTION = "deepseek-harness-runtime-bin"
EXPECTED_RELEASE_VERSION = "0.2.1rc2"
EXPECTED_WIRE_NAME = "deepseek-harness-sdk-runtime"
FAKE_KEY = "dsh-profile-fake-not-a-secret"
DUMP_TIMEOUT_SECONDS = 20.0
INITIALIZE_TIMEOUT_SECONDS = 20.0
SHUTDOWN_TIMEOUT_SECONDS = 2.0
PROFILE_NAME = "sdk-minimal"
# Model-facing shell tools and the PTY backends they spawn. Each platform enables
# exactly one pair; the base tree owns the platform gate.
SHELL_TOOL_IDS = ("persistent-bash", "persistent-pwsh")
PTY_BACKEND_IDS = ("terminal-bash", "terminal-pwsh")
EXPECTED_SHELL_PLUGIN = {
    "persistent-bash": "@deepseek-ai/dsh-tool-bash-persistent",
    "persistent-pwsh": "@deepseek-ai/dsh-tool-pwsh-persistent",
    "terminal-bash": "@deepseek-ai/dsh-terminal-bash",
    "terminal-pwsh": "@deepseek-ai/dsh-terminal-bash",
}
# The overlay is a trusted static file, but only these expressions may appear:
# the runtime-cwd fallback and the base-tree platform gates. Arbitrary ``!!js``
# expressions would execute at config load time and must not sneak in.
ALLOWED_JS_EXPRESSIONS = frozenset(
    {
        "process.cwd()",
        "process.platform === 'win32'",
        'process.platform === "win32"',
        "process.platform !== 'win32'",
        'process.platform !== "win32"',
    }
)
_PROXY_ENV_VARS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)

pytest.importorskip(
    "deepseek_harness",
    reason="deepseek-harness-sdk not importable; set DSH_SDK_SITE/PYTHONPATH to its site-packages",
)
from deepseek_harness import DeepSeekHarness, DeepSeekHarnessConfig, HarnessClient, HarnessConfig  # noqa: E402
from deepseek_harness_runtime import resolve_bundled_launch_args  # noqa: E402

def _load_policy_helpers():
    """Load the read-only stub-model/drive helpers from ``tests/test_dsh_policy.py``."""
    path = Path(__file__).with_name("test_dsh_policy.py")
    spec = importlib.util.spec_from_file_location("_dsh_policy_helpers", path)
    assert spec is not None and spec.loader is not None, f"cannot load helpers from {path}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_POLICY = _load_policy_helpers()


class _CordisLoader(yaml.SafeLoader):
    """SafeLoader that keeps Cordis ``!!js`` scalars as opaque expression strings."""


def _js_scalar(loader: yaml.SafeLoader, tag_suffix: str, node: yaml.Node) -> dict[str, str]:
    if not isinstance(node, yaml.ScalarNode):
        raise yaml.constructor.ConstructorError(
            None, None, f"unsupported !!js{tag_suffix} node", node.start_mark
        )
    return {"__jsExpr": loader.construct_scalar(node)}


_CordisLoader.add_multi_constructor("tag:yaml.org,2002:js", _js_scalar)


def _profile_patches() -> list[dict]:
    """The overlay rows as authored, before composition."""
    parsed = yaml.load(PROFILE_PATH.read_text(), Loader=_CordisLoader)
    assert isinstance(parsed, list) and parsed, f"{PROFILE_PATH} is not a non-empty patch list"
    return parsed


def _js_expressions(node: object) -> list[str]:
    """Collect every opaque ``!!js`` expression in an authored patch list."""
    if isinstance(node, dict):
        if set(node) == {"__jsExpr"}:
            return [str(node["__jsExpr"])]
        found: list[str] = []
        for value in node.values():
            found.extend(_js_expressions(value))
        return found
    if isinstance(node, list):
        found = []
        for value in node:
            found.extend(_js_expressions(value))
        return found
    return []


def _isolated_env(tmp_path: Path) -> dict[str, str]:
    """System env with a throwaway HOME and every egress proxy blanked."""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    env = dict(os.environ)
    env.update(
        {
            "HOME": str(home),
            "DEEPSEEK_API_KEY": FAKE_KEY,
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
        }
    )
    for name in _PROXY_ENV_VARS:
        env[name] = ""
    return env


def _dump_tree(tmp_path: Path, *, overlay: bool) -> list[dict]:
    """Compose the profile tree through the bundled CLI; fail on any runtime error."""
    dsh_home = tmp_path / ("dsh-home-overlay" if overlay else "dsh-home-base")
    dsh_home.mkdir(exist_ok=True)
    env = {**_isolated_env(tmp_path), "DSH_HOME": str(dsh_home)}
    argv = [*resolve_bundled_launch_args(), "--profile", PROFILE_NAME]
    if overlay:
        argv += ["--patch", str(PROFILE_PATH)]
    result = subprocess.run(
        [*argv, "--dump-config"],
        capture_output=True,
        text=True,
        env=env,
        timeout=DUMP_TIMEOUT_SECONDS,
    )
    assert result.returncode == 0, (
        f"--dump-config failed for {'overlay' if overlay else 'base'} tree: "
        f"{result.stderr.strip() or result.stdout.strip()}"
    )
    tree = yaml.load(result.stdout, Loader=_CordisLoader)
    assert isinstance(tree, list) and tree, f"dump-config produced no entries: {result.stdout!r}"
    return tree


def _entry(tree: list[dict], entry_id: str) -> dict:
    matches = [entry for entry in tree if isinstance(entry, dict) and entry.get("id") == entry_id]
    assert len(matches) == 1, f"expected exactly one {entry_id!r} entry, found {len(matches)}"
    return matches[0]


def _shell_is_disabled(entry: dict, is_windows: bool) -> bool:
    """Resolve the tree's platform gate: bool, or ``process.platform`` comparison."""
    disabled = entry.get("disabled")
    if disabled is None:
        return False
    if isinstance(disabled, bool):
        return disabled
    if isinstance(disabled, dict):
        expression = str(disabled.get("__jsExpr") or "")
        assert "process.platform" in expression, f"unexpected disabled expression: {expression!r}"
        if "===" in expression:
            return is_windows
        if "!==" in expression:
            return not is_windows
    raise AssertionError(f"cannot resolve disabled gate for {entry.get('id')!r}: {disabled!r}")


def _enabled_shell_entries(tree: list[dict], is_windows: bool, entry_ids: tuple[str, ...]) -> list[dict]:
    return [
        _entry(tree, entry_id)
        for entry_id in entry_ids
        if not _shell_is_disabled(_entry(tree, entry_id), is_windows)
    ]


def test_distribution_is_the_pinned_release():
    """The overlay contract is written against exactly this SDK/runtime pair."""
    sdk_version = importlib.metadata.version(SDK_DISTRIBUTION)
    runtime_version = importlib.metadata.version(RUNTIME_DISTRIBUTION)
    assert sdk_version == EXPECTED_RELEASE_VERSION, sdk_version
    assert runtime_version == EXPECTED_RELEASE_VERSION, runtime_version


def test_overlay_patches_existing_rows_and_keeps_platform_shell_pair(tmp_path: Path):
    """The overlay only narrows base rows and leaves each platform's shell pair enabled."""
    patches = _profile_patches()
    base_tree = _dump_tree(tmp_path, overlay=False)
    base_ids = {entry.get("id") for entry in base_tree if isinstance(entry, dict)}

    for patch in patches:
        assert isinstance(patch, dict), patch
        assert "insert" not in patch, f"the overlay must not invent plugins: {patch!r}"
        assert set(patch) <= {"id", "config", "disabled"}, f"unsupported patch fields: {patch!r}"
        assert patch.get("id") in base_ids, f"overlay targets a row absent from the base tree: {patch!r}"

    expressions = _js_expressions(patches)
    unexpected = sorted(set(expressions) - ALLOWED_JS_EXPRESSIONS)
    assert unexpected == [], f"overlay uses non-allowlisted !!js expressions: {unexpected}"

    overlay_tree = _dump_tree(tmp_path, overlay=True)

    sandbox = _entry(overlay_tree, "sandbox-policy")
    assert sandbox.get("name") == "@deepseek-ai/dsh-sandbox-policy"
    assert sandbox.get("config", {}).get("mode") == "workspace-write", sandbox
    assert sandbox["config"].get("workspaceRoot") == {"__jsExpr": "process.cwd()"}, sandbox["config"]
    widened = [entry.get("id") for entry in overlay_tree if entry.get("config", {}).get("mode") == "danger-full-access"]
    assert widened == [], f"the composed tree still grants full access: {widened}"

    tool_fs = _entry(overlay_tree, "tool-fs")
    assert tool_fs.get("config") == {
        "read": True,
        "readImage": True,
        "write": True,
        "edit": True,
    }, tool_fs.get("config")

    is_windows = sys.platform == "win32"
    expected_tool = "persistent-pwsh" if is_windows else "persistent-bash"
    expected_backend = "terminal-pwsh" if is_windows else "terminal-bash"

    enabled_tools = _enabled_shell_entries(overlay_tree, is_windows, SHELL_TOOL_IDS)
    assert [entry["id"] for entry in enabled_tools] == [expected_tool], (
        f"expected exactly one enabled model-facing shell ({expected_tool}), got "
        f"{[entry.get('id') for entry in enabled_tools]}"
    )
    assert enabled_tools[0].get("name") == EXPECTED_SHELL_PLUGIN[expected_tool]

    enabled_backends = _enabled_shell_entries(overlay_tree, is_windows, PTY_BACKEND_IDS)
    assert [entry["id"] for entry in enabled_backends] == [expected_backend], (
        f"expected exactly one enabled PTY backend ({expected_backend}), got "
        f"{[entry.get('id') for entry in enabled_backends]}"
    )
    assert enabled_backends[0].get("name") == EXPECTED_SHELL_PLUGIN[expected_backend]

    duplicate_tool_rows = [
        entry.get("id")
        for entry in overlay_tree
        if entry.get("id") == "tool-terminal"
        or entry.get("name") == "@deepseek-ai/dsh-tool-terminal"
    ]
    assert duplicate_tool_rows == [], (
        f"the base tree must not add a second model-facing terminal tool: {duplicate_tool_rows}"
    )


def test_profile_file_carries_no_credentials_or_gateway():
    """Deployment injects the provider; the checked-in overlay must stay secret-free."""
    text = PROFILE_PATH.read_text()
    for forbidden in ("apiKey", "baseURL", "providers:", "sk-", "Bearer "):
        assert forbidden not in text, f"{PROFILE_PATH} embeds {forbidden!r}"
    assert FAKE_KEY not in text


def test_initialize_accepts_overlay_on_the_released_runtime(tmp_path: Path):
    """The runtime composes the overlay and answers ``initialize``; no prompt is sent.

    ``serverInfo.version`` is the wire protocol version, not the release version, so it is
    only required to be non-empty. ``cwd`` is passed once as the runtime process cwd and
    once in ``initialize``; keeping them equal is what makes the profile's
    ``workspaceRoot: process.cwd()`` fallback match the agent session cwd.
    """
    workspace = tmp_path / "cwd"
    workspace.mkdir()
    dsh_home = tmp_path / "host-home"
    dsh_home.mkdir()
    client = HarnessClient(
        HarnessConfig(
            profile=PROFILE_NAME,
            patches=(str(PROFILE_PATH),),
            dsh_home=str(dsh_home),
            cwd=str(workspace),
            env=_isolated_env(tmp_path),
            initialize_timeout_seconds=INITIALIZE_TIMEOUT_SECONDS,
            request_timeout_seconds=INITIALIZE_TIMEOUT_SECONDS,
            shutdown_timeout_seconds=SHUTDOWN_TIMEOUT_SECONDS,
        )
    )
    try:
        client.start()
        response = client.initialize(
            cwd=str(workspace),
            provider="deepseek-official",
            model="deepseek-v4-flash",
        )
        assert client.config.cwd == str(workspace.resolve()), (
            "the runtime process cwd must match the initialize cwd so the workspaceRoot "
            f"fallback stays narrow: {client.config.cwd} != {workspace.resolve()}"
        )
    finally:
        client.close()

    server_info = response.serverInfo
    assert server_info is not None, f"initialize returned no serverInfo: {response!r}"
    assert server_info.name == EXPECTED_WIRE_NAME
    assert isinstance(server_info.version, str) and server_info.version.strip()


@contextlib.contextmanager
def _overlay_harness(tmp_path: Path, stub, *, workspace: Path | None = None):
    """Start the released runtime with the overlay, a loopback stub model, and empty DSH_HOME."""
    httpd, port = _POLICY._serve(stub)
    workspace = workspace or tmp_path / "cwd"
    workspace.mkdir(parents=True, exist_ok=True)
    dsh_home = tmp_path / "dsh-home"
    dsh_home.mkdir(exist_ok=True)
    harness = DeepSeekHarness(
        DeepSeekHarnessConfig(
            profile=PROFILE_NAME,
            patches=(str(PROFILE_PATH),),
            base_url=f"http://127.0.0.1:{port}",
            api_key="stub-not-a-real-key",
            cwd=str(workspace),
            dsh_home=str(dsh_home),
            env=_isolated_env(tmp_path),
            initialize_timeout_seconds=INITIALIZE_TIMEOUT_SECONDS,
            request_timeout_seconds=INITIALIZE_TIMEOUT_SECONDS,
            shutdown_timeout_seconds=SHUTDOWN_TIMEOUT_SECONDS,
        )
    )
    try:
        harness.start()
        try:
            yield harness, workspace
        finally:
            harness.close()
    finally:
        httpd.shutdown()
        httpd.server_close()


def _outside_workspace_root(tmp_path: Path) -> Path:
    """A throwaway root whose children are outside the sandbox's writable temp allowlist.

    macOS ``workspace-write`` allows writes under the system temp directory, so a sibling
    of ``tmp_path`` would stay writable. A directory next to the per-user temp folder is
    outside that allowlist and is denied. On other platforms a home-based temp root is
    used, since only the workspace should be writable there.
    """
    if sys.platform == "darwin":
        parent = Path(tempfile.gettempdir()).parent
    else:
        parent = Path.home()
    return Path(tempfile.mkdtemp(prefix="dsh-profile-outside-", dir=parent))


def test_overlay_bash_executes_inside_workspace(tmp_path: Path):
    """A real ``bash`` call under the overlay runs: the persistent tool has its PTY backend."""
    stub = _POLICY._ToolCallStubModel(
        {"description": "write a workspace marker", "command": "echo overlay-ok > marker.txt"}
    )
    with _overlay_harness(tmp_path, stub) as (harness, workspace):
        observation = _POLICY._drive_turn(harness, "profile-shell-allow", "write the marker")

    event_types = observation.event_types()
    assert "tool/call" in event_types, f"runtime never dispatched the bash call: {event_types}"
    assert "tool/result" in event_types, f"bash call produced no result: {event_types}"
    assert (workspace / "marker.txt").exists(), (
        "the overlay's bash call did not execute in the workspace; the persistent shell has "
        f"no usable PTY backend. toolResult={observation.tool_result_text()!r}"
    )


def test_overlay_bash_denies_write_outside_workspace(tmp_path: Path):
    """A sibling directory outside the workspace is not writable under ``workspace-write``."""
    outside_root = _outside_workspace_root(tmp_path)
    try:
        workspace = outside_root / "cwd"
        outside = outside_root / "outside"
        outside.mkdir()
        escape_target = outside / "escape.txt"
        command = (
            "echo inside-ok > control.txt; "
            f"echo escaped > {shlex.quote(str(escape_target))}"
        )
        stub = _POLICY._ToolCallStubModel(
            {"description": "try an out-of-workspace write", "command": command}
        )
        with _overlay_harness(tmp_path, stub, workspace=workspace) as (harness, cwd):
            observation = _POLICY._drive_turn(harness, "profile-shell-deny", "write outside")

        event_types = observation.event_types()
        assert "tool/call" in event_types, f"runtime never dispatched the bash call: {event_types}"
        assert "tool/result" in event_types, f"bash call produced no result: {event_types}"
        assert (cwd / "control.txt").exists(), (
            "the in-workspace control write did not run, so the deny case is inconclusive. "
            f"toolResult={observation.tool_result_text()!r}"
        )
        assert not escape_target.exists(), (
            "the overlay wrote outside its workspace; ``workspace-write`` is not enforced. "
            f"toolResult={observation.tool_result_text()!r}"
        )
        result_text = observation.tool_result_text().lower()
        assert any(
            fragment in result_text
            for fragment in ("operation not permitted", "permission denied", "read-only file system")
        ), f"the outside write did not fail with a sandbox denial: {result_text!r}"
    finally:
        shutil.rmtree(outside_root, ignore_errors=True)
