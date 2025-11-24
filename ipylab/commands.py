# Copyright (c) ipylab contributors.
# Distributed under the terms of the Modified BSD License.

from __future__ import annotations
import json
from uuid import uuid4
from collections import defaultdict
from typing import Any, TYPE_CHECKING, Protocol

from ipywidgets import Widget, register
from traitlets import List, Unicode, Bool

if TYPE_CHECKING:
    from collections.abc import Callable

from ._frontend import module_name, module_version


def _noop(*args: Any, **kwargs: Any):
    pass


@register
class CommandPalette(Widget):
    _model_name = Unicode("CommandPaletteModel").tag(sync=True)
    _model_module = Unicode(module_name).tag(sync=True)
    _model_module_version = Unicode(module_version).tag(sync=True)

    _items = List([], read_only=True).tag(sync=True)

    def add_item(self, command_id, category, *, args=None, rank=None):
        args = args or {}
        self.send(
            {
                "func": "addItem",
                "payload": {
                    "id": command_id,
                    "category": category,
                    "args": args,
                    "rank": rank,
                },
            }
        )


class ExecuteHandler(Protocol):
    def __call__(self, result: Any, errors: list[Any]) -> None: ...

@register
class CommandRegistry(Widget):
    _model_name = Unicode("CommandRegistryModel").tag(sync=True)
    _model_module = Unicode(module_name).tag(sync=True)
    _model_module_version = Unicode(module_version).tag(sync=True)

    _command_list = List(Unicode, read_only=True).tag(sync=True)
    _commands = List([], read_only=True).tag(sync=True)

    _execute_callbacks = defaultdict(_noop)
    _result_callbacks = defaultdict(_noop)

    validate_execute_args = Bool(
        default=False,
        help="whether to validate args before execution",
    ).tag(sync=True)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.on_msg(self._on_frontend_msg)

    def _on_frontend_msg(self, _, content, buffers):
        event = content.get("event")

        if event == "execute":
            command_id = content.get("id")
            result_id = content.get("result_id")
            args = content.get("args")
            result = None
            errors = []
            try:
                result = self._execute_callbacks[command_id](**args)
            except Exception as err:
                errors += [err]
            payload = {
                "id": command_id,
                "result_id": result_id,
                "result": result,
                "errors": errors
            }
            self.send({"func": "finishExecute", "payload": payload})

        if event in {"executed", "described"}:
            result_id = content.get("result_id")
            result = content.get("result")
            errors = content.get("errors", [])
            callback = self._result_callbacks[result_id]
            callback(result, errors)

    def _make_result_handler(self, handler: ExecuteHandler) -> str:
        result_id = f"{uuid4()}"

        def _on_executed(result: Any, errors: list[Any]) -> None:
            try:
                self._result_callbacks.pop(result_id, _noop)
                handler(result, errors)
            except Exception as err:
                self.log.error("handler error %s", err)

        self._result_callbacks[result_id] = _on_executed
        return result_id

    def execute(
        self,
        command_id: str,
        args: dict[str, Any] | None=None,
        handler: ExecuteHandler | None=None,
        *,
        validate: bool | None=None,
    ):
        payload = {
            "id": command_id,
            "args": args or {},
            "validate": validate if validate is not None else self.validate_execute_args,
            "result_id": self._make_result_handler(handler) if handler else None,
        }
        self.send({"func": "execute", "payload": payload})

    def describe(self, command_id: str, args: dict[str, Any], handler: ExecuteHandler) -> None:
        payload = {
            "id": command_id,
            "args": args or {},
            "result_id": self._make_result_handler(handler),
        }
        self.send({"func": "describe", "payload": payload})

    def list_commands(self):
        return self._command_list

    def add_command(
        self,
        command_id,
        execute,
        *,
        caption="",
        label="",
        icon_class="",
        icon=None,
        described_by=None,
    ):
        if command_id in self._command_list:
            raise Exception(f"Command {command_id} is already registered")
        # TODO: support other parameters (isEnabled, isVisible...)
        self._execute_callbacks[command_id] = execute
        self.send(
            {
                "func": "addCommand",
                "payload": {
                    "id": command_id,
                    "caption": caption,
                    "label": label,
                    "iconClass": icon_class,
                    "icon": f"IPY_MODEL_{icon.model_id}" if icon else None,
                    "describedBy": described_by
                },
            }
        )

    def remove_command(self, command_id):
        # TODO: check whether to keep this method, or return disposables like in lab
        self.send({"func": "removeCommand", "payload": {"id": command_id}})
