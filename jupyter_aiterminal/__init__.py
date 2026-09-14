try:
    from ._version import __version__
except ImportError:
    __version__ = "dev"


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "jupyter-aiterminal"}]


def _jupyter_server_extension_points():
    return [{"module": "jupyter_aiterminal"}]


def _load_jupyter_server_extension(server_app):
    from .handlers import setup_handlers

    contents = getattr(server_app, "contents_manager", None)
    cwd = getattr(contents, "root_dir", None) or getattr(server_app, "root_dir", ".")
    setup_handlers(server_app.web_app, cwd)
    server_app.log.info("Registered jupyter-aiterminal AI Terminal")
