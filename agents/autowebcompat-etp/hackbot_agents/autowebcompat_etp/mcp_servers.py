"""Stdio config for the Firefox DevTools MCP server the agent drives.

The MCP server is an npm package pinned in ``package.json`` and installed into
the image with ``npm ci`` (see the Dockerfile).
"""

from pathlib import Path

from claude_agent_sdk.types import McpStdioServerConfig

# WebDriver's recommended preferences point Remote Settings at a dummy server,
# which leaves only the exception list bundled in the build. Use the live server
# so the agent sees the same ETP exceptions as real users.
REMOTE_SETTINGS_SERVER = "https://firefox.settings.services.mozilla.com/v1"


def resolve_bin(bin_name: str) -> str:
    """Resolve an installed MCP server binary to an absolute path."""
    binary = Path("/app/etp") / "node_modules" / ".bin" / bin_name
    if not binary.exists():
        raise RuntimeError(
            f"MCP server binary not found at {binary}; the image should install "
            f"it with `npm ci` (see the Dockerfile)."
        )
    return str(binary)


def build_firefox_devtools_server(
    firefox_path: Path, *, headless: bool = True
) -> McpStdioServerConfig:
    """Build the stdio config for the Firefox DevTools MCP server.

    The privileged tools are always enabled: the agent switches ETP modes and
    tests candidate exceptions at runtime with ``set_etp_mode`` and
    ``set_firefox_prefs``, and reads the content blocking log with
    ``get_content_blocking_log`` (the ETP tools come from mcp/patch-mcp.mjs).
    """
    args = [
        "--enable-script",
        "--enable-privileged-context",
        "--firefox-path",
        str(firefox_path),
        "--pref",
        f"services.settings.server={REMOTE_SETTINGS_SERVER}",
    ]
    if headless:
        args.append("--headless")

    return McpStdioServerConfig(
        command=resolve_bin("firefox-devtools-mcp-moz"),
        args=args,
        env={"MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"},
    )
