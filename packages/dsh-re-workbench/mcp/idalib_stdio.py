#!/usr/bin/env python3
"""
idalib stdio MCP server — 无头 IDA 分析，通过 stdio 提供 MCP 工具。

与 ida_pro_mcp.idalib_server 的唯一区别是使用 stdio 传输
（原版固定用 SSE/HTTP），以便 dsh-re-workbench 的 stdio 代理直接对接。

用法:
    python idalib_stdio.py <目标文件> [--unsafe] [--verbose]
"""

import sys
import logging
import argparse
import importlib
from pathlib import Path

# idapro 必须最先导入以初始化 idalib
import idapro

import ida_auto
import ida_hexrays

from mcp.server.fastmcp import FastMCP

logger = logging.getLogger(__name__)

mcp = FastMCP("ida-pro-mcp-idalib-stdio", log_level="ERROR")


def fixup_tool_argument_descriptions(mcp: FastMCP):
    """把 Annotated 里的参数说明拼进工具 schema（照抄原版逻辑）。"""
    try:
        import typing_inspection.introspection as intro
    except ImportError:
        return
    for tool in mcp._tool_manager._tools.values():
        try:
            params = list(tool.fn.__annotations__.items())
        except Exception:
            continue
        props = tool.parameters.get("properties", {})
        for name, annotation in params:
            if name == "return":
                continue
            desc = None
            try:
                hints = intro.get_type_hints(tool.fn, include_extras=True)
                ann = hints.get(name)
                if ann is not None and hasattr(ann, "__metadata__"):
                    for m in ann.__metadata__:
                        if isinstance(m, str):
                            desc = m
                            break
            except Exception:
                pass
            if desc and name in props:
                props[name]["description"] = desc


def main():
    parser = argparse.ArgumentParser(description="MCP server for IDA Pro via idalib (stdio)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show debug messages")
    parser.add_argument("--unsafe", action="store_true", help="Enable unsafe functions (DANGEROUS)")
    parser.add_argument("input_path", type=Path, help="Path to the input file to analyze.")
    args = parser.parse_args()

    if args.verbose:
        log_level = logging.DEBUG
        idapro.enable_console_messages(True)
    else:
        log_level = logging.INFO
        idapro.enable_console_messages(False)

    logging.basicConfig(level=log_level)
    logging.getLogger().setLevel(log_level)

    if not args.input_path.exists():
        print(f"error: input file not found: {args.input_path}", file=sys.stderr)
        return 2

    logger.info("opening database: %s", args.input_path)
    if idapro.open_database(str(args.input_path), run_auto_analysis=True):
        print(f"error: failed to analyze {args.input_path}", file=sys.stderr)
        return 3

    logger.debug("idalib: waiting for analysis...")
    ida_auto.auto_wait()

    if not ida_hexrays.init_hexrays_plugin():
        print("error: failed to initialize Hex-Rays decompiler", file=sys.stderr)
        return 4

    plugin = importlib.import_module("ida_pro_mcp.mcp-plugin")
    for name, callable_ in plugin.rpc_registry.methods.items():
        if args.unsafe or name not in plugin.rpc_registry.unsafe:
            mcp.add_tool(callable_, name)

    fixup_tool_argument_descriptions(mcp)

    logger.info("MCP server ready (stdio); %d tools", len(plugin.rpc_registry.methods))
    try:
        mcp.run(transport="stdio")
    except KeyboardInterrupt:
        pass
    finally:
        try:
            idapro.close_database()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
