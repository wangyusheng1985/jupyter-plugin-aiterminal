try:
    from ._version import __version__
except ImportError:
    __version__ = "dev"


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "jupyter-aiterminal"}]


def _jupyter_server_extension_points():
    return [{"module": "jupyter_aiterminal"}]


def _load_jupyter_server_extension(server_app):
    from .btw_service import BtwService
    from .dsh_runtime_host import SharedDshRuntime
    from .handlers import setup_handlers
    from .session_registry import SessionRegistry

    contents = getattr(server_app, "contents_manager", None)
    cwd = getattr(contents, "root_dir", None) or getattr(server_app, "root_dir", ".")
    web_app = server_app.web_app
    web_app.settings.setdefault("aiterminal_sessions", SessionRegistry())
    web_app.settings.setdefault("aiterminal_runtime", SharedDshRuntime())
    setup_handlers(web_app, cwd)

    async def _close_ai_runtime() -> None:
        registry = web_app.settings.get("aiterminal_sessions")
        runtime = web_app.settings.get("aiterminal_runtime")
        btw = web_app.settings.get("aiterminal_btw")
        if isinstance(registry, SessionRegistry):
            await registry.close()
        if isinstance(runtime, SharedDshRuntime):
            await runtime.close()
        if isinstance(btw, BtwService):
            await btw.close()

    cleanup = getattr(server_app, "cleanup_functions", None)
    if isinstance(cleanup, list):
        cleanup.append(_close_ai_runtime)
    server_app.log.info("Registered jupyter-aiterminal AI Terminal")
