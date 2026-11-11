#!/usr/bin/env python3
"""Developer probe for the BTW tool-free claim (not part of the runtime).

Run against the pinned runtime and the rendered BTW patch: it starts a fake
OpenAI-completions endpoint, drives one ACP prompt, and prints the ``tools``
field the runtime actually sent. See ``docs/btw-runtime.md``.

Loopback probe: prove the BTW runtime advertises no tools to the model.

Starts a fake OpenAI-completions server on 127.0.0.1, launches the pinned DSH
runtime with a profile patch, drives one ACP prompt, and records the exact
``tools`` field of the outbound model request. No real upstream is contacted.

Usage::

    python btw-probe-no-tools.py <runtime> raw-btw
    python btw-probe-no-tools.py <runtime> raw-acp
    python btw-probe-no-tools.py <runtime> runtime
    python btw-probe-no-tools.py <runtime> runtime-multi

``raw-btw``/``raw-acp`` build the patch inside this script (control comparison).
``runtime`` drives the real ``jupyter_aiterminal.dsh_btw.BtwRuntime`` with the
production overlay and its startup preflight, so it is the evidence that the
shipped code path is tool-free. Prints a JSON verdict to stdout.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RUNNING = {"body": None}
TOOL_ROW_IDS = [
    "tool-fs",
    "tool-fs-search",
    "tool-bash",
    "tool-pwsh",
    "tool-jobs",
    "tool-web",
    "tool-skill",
    "tool-todo",
    "tool-goal",
    "tool-subagent",
    "tool-subagent-fork",
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "tool-workflow",
    "tool-working-directory",
    "mcp-resources",
    "plan-mode",
    "user-questions",
    "commands",
    "command-feedback",
    "command-goal",
    "command-compact",
    "skill",
    "skill-filesystem",
    "agent-instructions",
    "subagent",
    "subagent-spawn-in-process",
    "subagent-fork-in-process",
    "workflow-ptc",
    "web",
    "repeat-tool-reminder",
    "tool-result-pruner",
    "image-offload",
    "attachment-local",
    "session-title",
    "session-title-llm",
]


class Fake(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = {"raw": raw.decode("utf-8", "replace")}
        RUNNING["body"] = body
        RUNNING.setdefault("bodies", []).append(body)
        text = json.dumps(body.get("messages") or [])
        if "SLOW" in text:
            # Give the cancel probe a window to cancel while this stream runs.
            time.sleep(3)
        body = RUNNING["body"] or {}
        if body.get("stream"):
            chunks = [
                {"id": "chatcmpl-probe", "object": "chat.completion.chunk",
                 "created": int(time.time()), "model": "probe-model",
                 "choices": [{"index": 0, "delta": {"role": "assistant", "content": "probe-answer"}}]},
                {"id": "chatcmpl-probe", "object": "chat.completion.chunk",
                 "created": int(time.time()), "model": "probe-model",
                 "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            ]
            data = b"".join(
                b"data: " + json.dumps(c).encode() + b"\n\n" for c in chunks
            ) + b"data: [DONE]\n\n"
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        payload = {
            "id": "chatcmpl-probe",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": "probe-model",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "probe-answer"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # silence
        return


def _provider_row(port: int) -> dict:
    return {
        "id": "llm-pi-ai",
        "config": {
            "providers": {
                "jupyter-aiterminal": {
                    "api": "openai-completions",
                    "baseURL": f"http://127.0.0.1:{port}/v1",
                    "apiKeyEnv": "JUPYTER_AITERMINAL_DSH_API_KEY",
                    "models": [
                        {
                            "id": "probe-model",
                            "name": "probe-model",
                            "contextWindow": 1000000,
                            "maxTokens": 384000,
                        }
                    ],
                    "defaultMaxTokens": 384000,
                    "retryPolicy": {"mode": "normal", "maxRetries": 0},
                }
            }
        },
    }


def build_patch(kind: str, port: int) -> list[dict]:
    rows: list[dict] = [
        _provider_row(port),
        {
            "id": "agent-default-model",
            "config": {"provider": "jupyter-aiterminal", "model": "probe-model"},
        },
        {
            "id": "acp",
            "config": {"provider": "jupyter-aiterminal", "model": "probe-model"},
        },
        {"id": "approval", "config": {"policy": "never"}},
        {
            "id": "sandbox-policy",
            "config": {"mode": "read-only", "workspaceRoot": os.getcwd()},
        },
        {
            "id": "compaction-basic",
            "config": {
                "auto": True,
                "thresholdRatio": 0.8,
                "headroomTokens": 1000000 - 384000,
                "retainRatio": 0.16,
                "maxTokens": 100000,
            },
        },
    ]
    if kind == "btw":
        rows.extend({"id": row_id, "disabled": True} for row_id in TOOL_ROW_IDS)
    return rows


def production_runtime_probe(port: int) -> dict:
    """Drive the real BtwRuntime against the loopback model."""
    import asyncio
    import tempfile

    from jupyter_aiterminal.dsh_btw import BtwRuntime
    from jupyter_aiterminal.dsh_config import (
        DshProviderConfig,
        derive_dsh_budget,
    )

    workdir = Path(tempfile.mkdtemp(prefix="btw-runtime-probe-"))
    workspace = workdir / "ws"
    workspace.mkdir()
    budget = derive_dsh_budget(
        {}, context_window=1000000, max_output_tokens=384000
    )
    config = DshProviderConfig(
        api_protocol="openai-completions",
        base_url=f"http://127.0.0.1:{port}/v1",
        model="probe-model",
        context_window=budget.context_window,
        max_output_tokens=budget.max_output_tokens,
        token="probe-key-not-a-credential",
        budget=budget,
    )
    result: dict = {"kind": "runtime"}

    async def main() -> None:
        btw = BtwRuntime(
            config=config,
            workspace_root=workspace,
            storage_root=workdir / "store",
        )
        try:
            session_id = await btw.open_session()
            answer = await btw.prompt(
                session_id,
                "Run `ls -la` with your shell tool and show the output.",
            )
            result["status"] = answer["status"]
            result["answer"] = answer["text"][:60]
            result["status_report"] = btw.status()
        finally:
            await btw.close()

    asyncio.run(main())
    body = RUNNING["body"] or {}
    tools = body.get("tools")
    result["requestToolCount"] = len(tools) if isinstance(tools, list) else 0
    result["toolsFieldPresent"] = "tools" in body
    return result


def production_multiplex_probe(port: int) -> dict:
    """Two BTW sessions on one process: independent cancel, no interference."""
    import asyncio
    import tempfile

    from jupyter_aiterminal.dsh_btw import BtwRuntime
    from jupyter_aiterminal.dsh_config import (
        DshProviderConfig,
        derive_dsh_budget,
    )

    workdir = Path(tempfile.mkdtemp(prefix="btw-multi-probe-"))
    workspace = workdir / "ws"
    workspace.mkdir()
    budget = derive_dsh_budget(
        {}, context_window=1000000, max_output_tokens=384000
    )
    config = DshProviderConfig(
        api_protocol="openai-completions",
        base_url=f"http://127.0.0.1:{port}/v1",
        model="probe-model",
        context_window=budget.context_window,
        max_output_tokens=budget.max_output_tokens,
        token="probe-key-not-a-credential",
        budget=budget,
    )
    result: dict = {"kind": "runtime-multi"}

    async def main() -> None:
        btw = BtwRuntime(
            config=config,
            workspace_root=workspace,
            storage_root=workdir / "store",
        )
        try:
            slow = await btw.open_session()
            fast = await btw.open_session()
            slow_task = asyncio.create_task(btw.prompt(slow, "SLOW answer please"))
            await asyncio.sleep(0.5)
            fast_task = asyncio.create_task(btw.prompt(fast, "quick answer"))
            cancelled = await btw.cancel(slow)
            slow_result = await slow_task
            fast_result = await fast_task
            result.update(
                {
                    "cancelled": cancelled,
                    "slowStatus": slow_result["status"],
                    "fastStatus": fast_result["status"],
                    "fastAnswer": fast_result["text"][:40],
                    "sessions": btw.status()["sessions"],
                }
            )
        finally:
            await btw.close()

    asyncio.run(main())
    tools = [
        len(body["tools"]) if isinstance(body.get("tools"), list) else 0
        for body in RUNNING.get("bodies", [])
    ]
    result["requestToolCounts"] = tools
    return result


def main() -> int:
    runtime = sys.argv[1]
    kind = sys.argv[2] if len(sys.argv) > 2 else "btw"
    if kind in ("runtime", "runtime-multi"):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            port = server.server_address[1]
            verdict = (
                production_runtime_probe(port)
                if kind == "runtime"
                else production_multiplex_probe(port)
            )
        finally:
            server.shutdown()
        print(json.dumps(verdict, indent=2))
        return 0
    server = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    workdir = Path(tempfile.mkdtemp(prefix="btw-probe-"))
    home = workdir / "home"
    dsh_home = workdir / "dsh"
    cwd = workdir / "ws"
    for p in (home, dsh_home, cwd):
        p.mkdir(parents=True)
    patch_path = workdir / "patch.json"
    patch_path.write_text(json.dumps(build_patch(kind, port)), encoding="utf-8")
    env = {
        "HOME": str(home),
        "DSH_HOME": str(dsh_home),
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "JUPYTER_AITERMINAL_DSH_API_KEY": "probe-key-not-a-credential",
    }
    proc = subprocess.Popen(
        [runtime, "--profile", "acp", "--patch", str(patch_path)],
        cwd=str(cwd),
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    next_id = [0]

    def send(method, params, request=True):
        frame = {"jsonrpc": "2.0", "method": method, "params": params}
        if request:
            next_id[0] += 1
            frame["id"] = next_id[0]
        proc.stdin.write(json.dumps(frame) + "\n")
        proc.stdin.flush()
        if not request:
            return None
        deadline = time.time() + 90
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("runtime closed stdout")
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("id") == frame["id"]:
                return message
        raise RuntimeError("timeout waiting for response")

    verdict: dict = {"kind": kind, "ok": False}
    try:
        init = send(
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": {"readTextFile": False, "writeTextFile": False},
                    "terminal": False,
                },
            },
        )
        verdict["protocolVersion"] = (init.get("result") or {}).get(
            "protocolVersion"
        )
        new = send(
            "session/new", {"cwd": str(cwd), "mcpServers": []}
        )
        session_id = (new.get("result") or {}).get("sessionId")
        verdict["sessionId"] = bool(session_id)
        prompt = send(
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [
                    {
                        "type": "text",
                        "text": "Run `ls -la` with your shell tool and show the output.",
                    }
                ],
            },
        )
        verdict["promptError"] = prompt.get("error")
        body = RUNNING["body"] or {}
        tools = body.get("tools")
        verdict["requestToolCount"] = len(tools) if isinstance(tools, list) else 0
        verdict["toolsFieldPresent"] = "tools" in body
        verdict["toolNames"] = [
            (t.get("function") or {}).get("name")
            for t in tools
            if isinstance(t, dict)
        ][:20] if isinstance(tools, list) else []
        verdict["stream"] = body.get("stream")
        verdict["bodyKeys"] = sorted(body)
        verdict["ok"] = True
    except Exception as exc:  # noqa: BLE001
        verdict["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        server.shutdown()
    print(json.dumps(verdict, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
