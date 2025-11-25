# Copyright (c) ipylab contributors.
# Distributed under the terms of the Modified BSD License.

from ._version import __version__

from .jupyterfrontend import JupyterFrontEnd
from .widgets import Panel, SplitPanel
from .icon import Icon

__all__ = ["__version__", "JupyterFrontEnd", "Panel", "SplitPanel", "Icon"]

def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "ipylab"}]
