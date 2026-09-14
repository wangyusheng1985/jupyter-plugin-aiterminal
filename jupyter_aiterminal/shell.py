from __future__ import annotations

import asyncio
import os
import secrets
import shlex
import shutil
import signal
import tempfile
from collections.abc import Awaitable, Callable
from typing import Any

OutputCallback = Callable[[str], Awaitable[None]]


class PersistentShell:
    """A long-lived, non-TTY bash for Command cells.

    cwd and environment persist across runs in the same workspace tab.
    Command stdout/stderr go to a temp file so pipe buffering cannot hide
    the completion marker, which is printed on bash stderr (unbuffered).
    The outfile is polled while the command runs so ping-style output can
    stream to the cell. There is no timeout; interrupt() SIGINTs the
    process group without killing bash itself.
    """

    def __init__(self, cwd: str):
        self.cwd = cwd
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._start_lock = asyncio.Lock()
        self._stderr = ""
        self._data = asyncio.Event()
        self._stdout_reader: asyncio.Task[None] | None = None
        self._stderr_reader: asyncio.Task[None] | None = None

    async def start(self) -> None:
        async with self._start_lock:
            await self._start_unlocked()

    async def _start_unlocked(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            return
        env = os.environ.copy()
        env["PS1"] = ""
        env["PS2"] = ""
        env["PS4"] = ""
        env["PROMPT_COMMAND"] = ""
        env["TERM"] = "dumb"
        env["PYTHONUNBUFFERED"] = "1"
        await _apply_line_buffering(env)
        self._proc = await asyncio.create_subprocess_exec(
            "/bin/bash",
            "--noprofile",
            "--norc",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.cwd,
            env=env,
            start_new_session=True,
        )
        self._stderr = ""
        self._stdout_reader = asyncio.create_task(self._drain_stdout())
        self._stderr_reader = asyncio.create_task(self._read_stderr())
        # Ignore INT in bash so the shell survives Ctrl+C; children still
        # get SIG_DFL and die. `trap '' INT` would be inherited as SIG_IGN.
        marker = secrets.token_hex(8)
        await self._write(
            "trap ':' INT; unset PROMPT_COMMAND; PS1=; PS2=; PS4=; "
            f"set +e; set +o posix; printf '%s\\n' '{marker}' >&2\n"
        )
        await self._wait_marker(marker)
        self._stderr = ""

    async def run(
        self,
        command: str,
        on_output: OutputCallback | None = None,
    ) -> dict[str, Any]:
        await self.start()
        async with self._lock:
            return await self._run_locked(command, on_output)

    async def interrupt(self) -> None:
        proc = self._proc
        if proc is None or proc.pid is None or proc.returncode is not None:
            return
        try:
            os.killpg(proc.pid, signal.SIGINT)
        except ProcessLookupError:
            return

    async def close(self) -> None:
        proc = self._proc
        self._proc = None
        for task in (self._stdout_reader, self._stderr_reader):
            if task is not None:
                task.cancel()
        self._stdout_reader = None
        self._stderr_reader = None
        if proc is None:
            return
        if proc.returncode is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), 2)
            except (asyncio.TimeoutError, ProcessLookupError):
                proc.kill()
                await proc.wait()

    async def _run_locked(
        self,
        command: str,
        on_output: OutputCallback | None,
    ) -> dict[str, Any]:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.returncode is not None:
            raise RuntimeError("Command shell is not running.")
        marker = secrets.token_hex(16)
        script = _write_script(command)
        outfile = script + ".out"
        try:
            self._stderr = ""
            payload = (
                f"set +e\n"
                f"__classic_ssh_status=0\n"
                f"if . {shlex.quote(script)} </dev/null "
                f"> {shlex.quote(outfile)} 2>&1; then\n"
                f"  __classic_ssh_status=0\n"
                f"else\n"
                f"  __classic_ssh_status=$?\n"
                f"fi\n"
                f"set +e\n"
                f'printf "%s\\n" "{marker} $__classic_ssh_status $PWD" >&2\n'
            )
            await self._write(payload)
            output, line = await self._wait_output(outfile, marker, on_output)
            _, returncode, cwd = _parse_done(line, marker)
            self.cwd = cwd or self.cwd
            return {"output": output, "returncode": returncode, "cwd": self.cwd}
        finally:
            for path in (script, outfile):
                try:
                    os.unlink(path)
                except OSError:
                    pass

    async def _write(self, text: str) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise RuntimeError("Command shell is not running.")
        proc.stdin.write(text.encode("utf-8"))
        await proc.stdin.drain()

    async def _drain_stdout(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            while await proc.stdout.read(4096):
                pass
        except (asyncio.CancelledError, OSError):
            return

    async def _read_stderr(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            while True:
                chunk = await proc.stderr.read(4096)
                if not chunk:
                    self._data.set()
                    return
                self._stderr += chunk.decode("utf-8", errors="replace")
                self._data.set()
        except (asyncio.CancelledError, OSError):
            self._data.set()
            return

    async def _wait_marker(self, marker: str) -> str:
        while True:
            line = _marker_line(self._stderr, marker)
            if line is not None:
                return line
            proc = self._proc
            if proc is None or proc.returncode is not None:
                raise RuntimeError("Command shell exited.")
            self._data.clear()
            if _marker_line(self._stderr, marker) is not None:
                continue
            await self._data.wait()

    async def _wait_output(
        self,
        outfile: str,
        marker: str,
        on_output: OutputCallback | None,
    ) -> tuple[str, str]:
        sent = 0
        while True:
            output = _read_output(outfile)
            if on_output and len(output) > sent:
                await on_output(output[sent:])
                sent = len(output)
            line = _marker_line(self._stderr, marker)
            if line is not None:
                output = _read_output(outfile)
                if on_output and len(output) > sent:
                    await on_output(output[sent:])
                return output, line
            proc = self._proc
            if proc is None or proc.returncode is not None:
                raise RuntimeError("Command shell exited.")
            self._data.clear()
            try:
                await asyncio.wait_for(self._data.wait(), 0.05)
            except asyncio.TimeoutError:
                pass


async def _apply_line_buffering(env: dict[str, str]) -> None:
    """Force line-buffered child stdio so ping-style output streams to a file."""
    stdbuf = shutil.which("stdbuf")
    if not stdbuf:
        return
    try:
        proc = await asyncio.create_subprocess_exec(
            stdbuf,
            "-oL",
            "-eL",
            "env",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), 2)
    except (OSError, asyncio.TimeoutError):
        return
    for line in stdout.decode("utf-8", errors="replace").splitlines():
        key, sep, value = line.partition("=")
        if sep and key in {"LD_PRELOAD", "_STDBUF_O", "_STDBUF_E", "_STDBUF_I"}:
            env[key] = value


def _write_script(command: str) -> str:
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        prefix="aiterminal-exec-",
        suffix=".sh",
        delete=False,
    )
    with handle:
        handle.write(command)
        if command and not command.endswith("\n"):
            handle.write("\n")
    os.chmod(handle.name, 0o600)
    return handle.name


def _read_output(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return ""


def _marker_line(buffer: str, marker: str) -> str | None:
    prefix = f"{marker} "
    exact = marker
    for line in buffer.splitlines():
        if line == exact or line.startswith(prefix):
            return line
    return None


def _parse_done(line: str, marker: str) -> tuple[str, int, str]:
    if line == marker:
        return "", 0, ""
    rest = line[len(marker) + 1 :]
    code_text, _, cwd = rest.partition(" ")
    try:
        returncode = int(code_text)
    except ValueError:
        returncode = 1
    return "", returncode, cwd
