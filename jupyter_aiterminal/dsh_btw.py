"""One dedicated, tool-less DSH runtime hosting every BTW side-chat session.

Design boundaries:

* The BTW runtime is its own process. It never shares a transport with the main
  agent runtime, so a BTW failure, cancel, or crash cannot interrupt the main
  task and the main runtime's tools are not reachable from a side chat.
* One process serves many BTW sessions. ``SharedDshRuntime`` already rejects a
  second concurrent prompt on the same session while allowing prompts on
  different sessions, and ``session/cancel`` is addressed by session id, so
  cancelling one side chat leaves the others running.
* Startup is fail-closed: before the ACP handshake, a completed
  ``--dump-config`` must prove every tool row is disabled and the sandbox is
  read-only; otherwise the process is not started at all. There is no
  prompt-only fallback.
* Sessions are opened with the fixed ``session/new`` params builder, which
  rejects client-supplied MCP servers.
"""

from __future__ import annotations

import asyncio
import json
import os
import stat
import uuid
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any

from .btw_config import BTW_DISABLED_ROW_IDS, build_btw_profile_patches, btw_budget
from .dsh_acp_config import (
    ACP_ROW_APPROVAL,
    ACP_ROW_SANDBOX_POLICY,
    build_acp_subprocess_env,
    validate_controlled_root,
)
from .dsh_acp_events import DshAcpEventProjector
from .dsh_acp_session import (
    _EXPECTED_RUNTIME_VERSION,
    _installed_runtime_version,
    _is_patch_warning,
    _row_block,
    _run_policy_preflight,
    _scalar_equals,
    _verify_token_meter_row,
    _yaml_key_values,
)
from .dsh_acp_transport import DshAcpError, DshAcpTransport
from .dsh_config import DerivedBudget, DshProviderConfig, _validate_config_snapshot
from .dsh_runtime_host import SharedDshRuntime
from .settings import AgentConfigError

__all__ = [
    "BTW_RUNTIME_SANDBOX_MODE",
    "BtwRuntime",
    "BtwRuntimeError",
    "verify_btw_dump",
]

# Mirrors ``btw_config.BTW_SANDBOX_MODE``; kept as a literal here so the
# preflight assertion cannot drift from the builder through an edit.
BTW_RUNTIME_SANDBOX_MODE = "read-only"
BTW_RUNTIME_APPROVAL_POLICY = "never"
_COMPACTION_FIELDS = (
    "auto",
    "thresholdRatio",
    "headroomTokens",
    "retainRatio",
    "maxTokens",
)


class BtwRuntimeError(RuntimeError):
    """A BTW runtime failure with a stable, user-facing message."""


def _ensure_private_dir(path: Path) -> Path:
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not path.is_dir():
            raise BtwRuntimeError(f"BTW storage path must be a directory: {path}")
    else:
        path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        raise BtwRuntimeError(f"BTW storage path is not a private directory: {path}")
    return path


def verify_btw_dump(dump: str, budget: DerivedBudget) -> None:
    """Fail unless the dumped BTW config proves a tool-free runtime.

    Every row in ``BTW_DISABLED_ROW_IDS`` must be present exactly once with
    ``disabled: true``. The approval policy, sandbox mode, compaction values and
    the shipped ``token-meter`` row are checked through the same helpers the
    main runtime preflight uses, so a row the runtime silently ignores cannot
    pass. Any failure names the row id and never echoes a credential.
    """
    for row_id in BTW_DISABLED_ROW_IDS:
        block = _row_block(dump, row_id)
        if block is None:
            raise AgentConfigError(
                f"BTW runtime dump-config is missing the {row_id!r} row or it "
                "appears more than once; refusing to start"
            )
        values = _yaml_key_values(block, "disabled")
        if values is None:
            raise AgentConfigError(
                f"BTW runtime dump-config row {row_id!r} is not disabled; "
                "refusing to start"
            )
        if values[0].strip().lower() not in ("true", "yes", "on"):
            raise AgentConfigError(
                f"BTW runtime dump-config row {row_id!r} is not disabled; "
                "refusing to start"
            )
    approval = _row_block(dump, ACP_ROW_APPROVAL)
    if approval is None or _yaml_key_values(approval, "policy") != [
        BTW_RUNTIME_APPROVAL_POLICY
    ]:
        raise AgentConfigError(
            "BTW runtime dump-config does not pin the approval policy; "
            "refusing to start"
        )
    sandbox = _row_block(dump, ACP_ROW_SANDBOX_POLICY)
    if sandbox is None or _yaml_key_values(sandbox, "mode") != [
        BTW_RUNTIME_SANDBOX_MODE
    ]:
        raise AgentConfigError(
            "BTW runtime dump-config does not pin the read-only sandbox; "
            "refusing to start"
        )
    compaction = _row_block(dump, "compaction-basic")
    if compaction is None:
        raise AgentConfigError(
            "BTW runtime dump-config is missing the 'compaction-basic' row; "
            "refusing to start"
        )
    expected = {
        "auto": budget.compaction_enabled,
        "thresholdRatio": budget.threshold_ratio,
        "headroomTokens": budget.headroom,
        "retainRatio": budget.retain_ratio,
        "maxTokens": budget.summary_max_tokens,
    }
    for key in _COMPACTION_FIELDS:
        if not _scalar_equals(compaction, key, expected[key]):
            raise AgentConfigError(
                "BTW runtime dump-config compaction-basic field "
                f"{key!r} does not match the effective budget; refusing to start"
            )
    _verify_token_meter_row(dump)


class BtwRuntime:
    """Owner of the single dedicated BTW runtime process and its sessions."""

    def __init__(
        self,
        *,
        config: DshProviderConfig,
        workspace_root: str | Path,
        storage_root: str | Path,
        runtime_version: Callable[[], str] | None = None,
        policy_preflight: Callable[..., Awaitable[tuple[int, str, str]]] | None = None,
        request_timeout: float = 30.0,
        prompt_timeout: float = 600.0,
        startup_timeout: float = 15.0,
        preflight_timeout: float = 30.0,
        close_timeout: float = 5.0,
    ) -> None:
        if not isinstance(config, DshProviderConfig):
            raise BtwRuntimeError("config must be a DshProviderConfig instance")
        _validate_config_snapshot(config)
        root = Path(workspace_root)
        if not root.is_absolute() or not root.is_dir():
            raise BtwRuntimeError("workspace_root must be an existing absolute directory")
        self._config = config
        self._workspace_root = root
        self._storage_root = Path(storage_root)
        if not self._storage_root.is_absolute():
            raise BtwRuntimeError("storage_root must be an absolute path")
        self._runtime_version = runtime_version or _installed_runtime_version
        self._policy_preflight = policy_preflight or _run_policy_preflight
        self._request_timeout = request_timeout
        self._prompt_timeout = prompt_timeout
        self._startup_timeout = startup_timeout
        self._preflight_timeout = preflight_timeout
        self._close_timeout = close_timeout
        self._lock = asyncio.Lock()
        self._runtime: SharedDshRuntime | None = None
        self._transport: DshAcpTransport | None = None
        self._home: Path | None = None
        self._dsh_home: Path | None = None
        self._patch_path: Path | None = None
        self._generation = 0
        self._sessions: set[str] = set()
        # Sessions with a prompt in flight, tracked here because a prompt is
        # started by ``prompt`` rather than by the runtime's tracked-task API.
        self._prompting: set[str] = set()
        self._prompting_lock = asyncio.Lock()

    @property
    def running(self) -> bool:
        return self._runtime is not None and self._transport is not None

    @property
    def generation(self) -> int:
        return self._generation

    def status(self) -> dict[str, Any]:
        """Return a credential-free snapshot the panel can display."""
        return {
            "running": self.running,
            "generation": self._generation,
            "sessions": len(self._sessions),
            "tools": "disabled",
            "sandbox": BTW_RUNTIME_SANDBOX_MODE,
        }

    async def _ensure_runtime(self) -> SharedDshRuntime:
        async with self._lock:
            if self._runtime is not None and self._transport is not None:
                proc = getattr(self._transport, "_proc", None)
                if proc is None or getattr(proc, "returncode", None) is None:
                    return self._runtime
                # A dead child is released before a replacement is built.
                await self._runtime.close()
                self._runtime = None
                self._transport = None
            await self._start_locked()
            assert self._runtime is not None
            return self._runtime

    def _assert_pinned_runtime(self) -> None:
        try:
            installed = self._runtime_version()
        except Exception as exc:  # noqa: BLE001 - normalized below
            raise BtwRuntimeError(
                "cannot determine the installed DSH runtime version"
            ) from exc
        if installed != _EXPECTED_RUNTIME_VERSION:
            raise BtwRuntimeError(
                "DSH runtime version must be "
                f"{_EXPECTED_RUNTIME_VERSION}; refusing to start BTW"
            )

    async def _start_locked(self) -> None:
        self._assert_pinned_runtime()
        root = _ensure_private_dir(self._storage_root / "btw")
        self._home = _ensure_private_dir(root / "home")
        self._dsh_home = _ensure_private_dir(root / "dsh")
        validate_controlled_root(self._home, name="home")
        validate_controlled_root(self._dsh_home, name="dsh_home")
        budget = btw_budget(self._config)
        patch_path = root / "patch.json"
        text = _render_patch(self._config, self._workspace_root)
        if self._config.token in text:  # defensive: the builder never emits it
            raise BtwRuntimeError(
                "rendered BTW profile patch must not contain the API token"
            )
        patch_path.write_text(text, encoding="utf-8")
        os.chmod(patch_path, 0o600)
        self._patch_path = patch_path
        env = build_acp_subprocess_env(
            os.environ,
            home=self._home,
            dsh_home=self._dsh_home,
            config=self._config,
        )
        transport = DshAcpTransport(
            patch_path=patch_path,
            cwd=self._workspace_root,
            env=env,
            default_request_timeout=self._request_timeout,
            startup_timeout=self._startup_timeout,
            close_timeout=self._close_timeout,
        )
        await self._verify_tool_free(transport, env, budget)
        await transport.start()
        if any(_is_patch_warning(line) for line in transport.stderr_tail()):
            await transport.close()
            raise BtwRuntimeError(
                "DSH runtime did not apply the BTW tool-free overlay; refusing to start"
            )
        runtime = SharedDshRuntime(transport)
        runtime.bind_transport(
            transport, snapshot=budget, preflight_proven=True
        )
        await runtime.start()
        self._transport = transport
        self._runtime = runtime
        self._generation += 1

    async def _verify_tool_free(
        self,
        transport: DshAcpTransport,
        env: Mapping[str, str],
        budget: DerivedBudget,
    ) -> None:
        try:
            code, stdout, stderr = await self._policy_preflight(
                transport.argv,
                self._workspace_root,
                env,
                self._preflight_timeout,
            )
        except Exception as exc:  # noqa: BLE001 - never echo the payload
            raise BtwRuntimeError(
                "BTW runtime policy preflight failed; refusing to start"
            ) from exc
        if code != 0:
            raise BtwRuntimeError(
                "BTW runtime policy preflight failed; refusing to start"
            )
        lines = stdout.splitlines() + stderr.splitlines()
        if any(_is_patch_warning(line) for line in lines):
            raise BtwRuntimeError(
                "DSH runtime did not apply the BTW tool-free overlay; refusing to start"
            )
        try:
            verify_btw_dump(stdout, budget)
        except AgentConfigError as exc:
            # A row the runtime ignored is a configuration failure, not a spawn
            # failure; keep the row id visible and never echo the payload.
            raise BtwRuntimeError(str(exc)) from exc

    async def open_session(self, cwd: str | Path | None = None) -> str:
        runtime = await self._ensure_runtime()
        try:
            session_id = await runtime.open_session(cwd or self._workspace_root)
        except Exception as exc:  # noqa: BLE001 - stable message
            raise BtwRuntimeError(f"cannot open a BTW session: {exc}") from exc
        self._sessions.add(session_id)
        return session_id

    async def resume_session(
        self, session_id: str, cwd: str | Path | None = None
    ) -> None:
        runtime = await self._ensure_runtime()
        try:
            await runtime.resume_session(
                session_id, cwd or self._workspace_root
            )
        except Exception as exc:  # noqa: BLE001 - stable message
            raise BtwRuntimeError(
                "the saved BTW session could not be resumed; it was not "
                "replaced with a new session"
            ) from exc
        self._sessions.add(session_id)

    async def prompt(self, session_id: str, text: str) -> dict[str, Any]:
        """Run one prompt and return its bounded answer plus terminal state.

        A concurrent prompt on the same session is rejected by
        ``SharedDshRuntime`` (``BtwRuntimeError``) instead of being queued.
        """
        runtime = await self._ensure_runtime()
        run_id = f"btw-run-{uuid.uuid4().hex}"
        projector = DshAcpEventProjector(session_id, self._runtime_id(), run_id)
        chunks: dict[str, str] = {}
        order: list[str] = []

        def sink(message: dict[str, Any]) -> None:
            for event in projector.project_notification(
                message.get("method"), message.get("params")
            ):
                self._collect_text(event, chunks, order)

        async with self._prompting_lock:
            if session_id in self._prompting:
                raise BtwRuntimeError(
                    "another prompt is already active in this BTW session"
                )
            self._prompting.add(session_id)
        runtime.subscribe(session_id, sink)
        try:
            result = await runtime.prompt(
                session_id, text, timeout=self._prompt_timeout
            )
            terminal = projector.finish(result)
        except BtwRuntimeError:
            raise
        except DshAcpError as exc:
            terminal = projector.finish_error(exc)
            raise BtwRuntimeError(f"BTW prompt failed: {exc}") from exc
        except Exception as exc:  # noqa: BLE001 - no raw payloads
            projector.finish_error(exc)
            raise BtwRuntimeError("BTW prompt failed") from exc
        finally:
            runtime.unsubscribe(session_id)
            async with self._prompting_lock:
                self._prompting.discard(session_id)
        finished = terminal[0] if terminal else {}
        status = finished.get("status", "failed")
        reason = finished.get("reason", "failed")
        return {
            "status": status,
            "reason": reason,
            "text": "".join(chunks[mid] for mid in order),
        }

    @staticmethod
    def _collect_text(
        event: Mapping[str, Any], chunks: dict[str, str], order: list[str]
    ) -> None:
        kind = event.get("type")
        if kind not in {"dsh/v1/text.snapshot", "dsh/v1/text.delta"}:
            return
        message_id = str(event.get("messageId", ""))
        if kind.endswith("snapshot"):
            if message_id not in chunks:
                order.append(message_id)
            chunks[message_id] = str(event.get("text", ""))
            return
        if message_id not in chunks:
            order.append(message_id)
            chunks[message_id] = ""
        chunks[message_id] += str(event.get("delta", ""))

    def _runtime_id(self) -> str:
        return f"btw-runtime-{self._generation}-{id(self):x}"

    async def cancel(self, session_id: str) -> bool:
        """Cancel one BTW session's prompt; other sessions are untouched."""
        runtime = self._runtime
        if runtime is None:
            return False
        async with self._prompting_lock:
            active = session_id in self._prompting
        if not active:
            return False
        try:
            await runtime.cancel_session(session_id)
        except Exception as exc:  # noqa: BLE001 - stable message
            raise BtwRuntimeError(f"BTW cancel failed: {exc}") from exc
        return True

    async def close_session(self, session_id: str) -> None:
        runtime = self._runtime
        self._sessions.discard(session_id)
        if runtime is None:
            return
        try:
            await runtime.shutdown_workspace(session_id)
        except Exception:  # noqa: BLE001 - release is best effort
            pass

    async def close(self) -> None:
        """Stop every BTW session and the dedicated process."""
        async with self._lock:
            runtime = self._runtime
            self._runtime = None
            self._transport = None
            self._sessions.clear()
            async with self._prompting_lock:
                self._prompting.clear()
            if runtime is not None:
                try:
                    await runtime.close()
                except Exception:  # noqa: BLE001 - shutdown is best effort
                    pass
            elif self._transport is not None:
                try:
                    await self._transport.close()
                except Exception:  # noqa: BLE001 - shutdown is best effort
                    pass


def _render_patch(config: DshProviderConfig, root: Path) -> str:
    return json.dumps(
        build_btw_profile_patches(config, workspace_root=root),
        ensure_ascii=True,
        indent=2,
    )
