import asyncio
import shlex
import sys

from jupyter_aiterminal.shell import PersistentShell


def test_pwd_and_cd_persist(tmp_path):
    async def run():
        shell = PersistentShell(str(tmp_path))
        try:
            first = await shell.run("pwd")
            assert first["returncode"] == 0
            assert first["output"].strip() == str(tmp_path)
            nested = tmp_path / "nested"
            nested.mkdir()
            second = await shell.run(f"cd {nested}")
            assert second["returncode"] == 0
            third = await shell.run("pwd")
            assert third["output"].strip() == str(nested)
            assert third["cwd"] == str(nested)
        finally:
            await shell.close()

    asyncio.run(run())


def test_export_persists_across_runs(tmp_path):
    async def run():
        shell = PersistentShell(str(tmp_path))
        try:
            await shell.run("export AITERMINAL_FLAG=1")
            result = await shell.run('printf "%s" "$AITERMINAL_FLAG"')
            assert result["output"] == "1"
            assert result["returncode"] == 0
        finally:
            await shell.close()

    asyncio.run(run())


def test_nonzero_status(tmp_path):
    async def run():
        shell = PersistentShell(str(tmp_path))
        try:
            result = await shell.run("false")
            assert result["returncode"] != 0
            assert result["output"] == ""
        finally:
            await shell.close()

    asyncio.run(run())


def test_interrupt_does_not_kill_shell(tmp_path):
    async def run():
        shell = PersistentShell(str(tmp_path))
        try:
            task = asyncio.create_task(shell.run("sleep 30"))
            await asyncio.sleep(0.2)
            await shell.interrupt()
            result = await asyncio.wait_for(task, 5)
            assert result["returncode"] != 0
            follow = await shell.run("pwd")
            assert follow["returncode"] == 0
            assert follow["output"].strip() == str(tmp_path)
        finally:
            await shell.close()

    asyncio.run(run())


def test_run_streams_output_before_completion(tmp_path):
    async def run():
        shell = PersistentShell(str(tmp_path))
        chunks: list[str] = []

        async def on_output(text: str) -> None:
            chunks.append(text)

        python = shlex.quote(sys.executable)
        command = (
            f"{python} -c "
            "'import time; print(\"one\", flush=True); "
            "time.sleep(0.5); print(\"two\", flush=True)'"
        )
        try:
            task = asyncio.create_task(shell.run(command, on_output=on_output))
            for _ in range(40):
                if any("one" in chunk for chunk in chunks):
                    break
                await asyncio.sleep(0.05)
            else:
                raise AssertionError(f"output did not stream, chunks={chunks!r}")
            assert not any("two" in chunk for chunk in chunks)
            result = await asyncio.wait_for(task, 5)
            assert "one" in result["output"]
            assert "two" in result["output"]
            assert "".join(chunks) == result["output"]
        finally:
            await shell.close()

    asyncio.run(run())


def test_stderr_is_captured(tmp_path):
    async def run():
        shell = PersistentShell(str(tmp_path))
        try:
            result = await shell.run("printf err >&2")
            assert "err" in result["output"]
        finally:
            await shell.close()

    asyncio.run(run())
