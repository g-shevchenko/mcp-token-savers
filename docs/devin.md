# Devin Desktop / CLI

Devin Local uses the Devin CLI MCP configuration, independently of legacy
Windsurf configuration. The installer supports `--clients=devin` and writes
project `.devin/mcp_config.json`, preserving other server entries and backing up
existing files. It also adds a managed block to `AGENTS.md` and the shared guide.
The default `auto` client list includes Devin.

From an inspected checkout:

```bash
bash install.sh --clients=devin --profile=core --dry-run
bash install.sh --clients=devin --profile=core
```

Dry-run prints proposed writes and defers runtime doctor until installation/build.
After installation, restart Devin or open a new chat, then inspect `devin mcp list`
and make a small read-only call. A config entry alone does not prove connection.
Project settings override user settings with the same server name; review the
configuration before installing into a project with existing integrations.

Start with core and skip prep on small exact-file tasks. Compress data at its
source where possible; copying a large log from model context back into a tool
cannot undo the first input charge. Measurements of character reduction are not
measurements of ChatGPT subscription allowance. No universal saving is promised.

References: [Devin MCP configuration](https://docs.devin.ai/cli/extensibility/mcp/configuration).
