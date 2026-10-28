# AI agents: MCP server, skill, llms.txt

Coding agents (Claude Code, Cursor, Codex, Copilot and others) can use Optiq to optimise the images in a project.
Three ways, from most to least integrated:

| | What the agent gets | Needs |
|---|---|---|
| [MCP server](#mcp-server) `optiq-mcp` | Two typed tools: `analyze_images` (read-only) and `optimize_images` | An MCP client |
| [Agent Skill](#agent-skill) | Instructions for using the CLI well | An agent that loads skills, and a shell |
| [CLI](./static#cli) `--json` | A machine-readable report | A shell |

All three run the same engine locally. Nothing is uploaded.

## MCP server

**Claude Code**

```sh
claude mcp add optiq -- npx -y optiq-mcp
```

**Claude Desktop, Cursor** (`claude_desktop_config.json`, `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "optiq": { "command": "npx", "args": ["-y", "optiq-mcp"] }
  }
}
```

**VS Code** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "optiq": { "type": "stdio", "command": "npx", "args": ["-y", "optiq-mcp"] }
  }
}
```

### Tools

**`analyze_images`** is read-only (`readOnlyHint`), so clients can allow it without asking. It runs the full
optimisation in memory and reports, per image, the format Optiq would pick, bytes before and after, and the
measured quality. Formats are kept by default, as for in-place writes.

**`optimize_images`** writes, with either `write: "in-place"` or `write: "out-dir"`:

- `write: "in-place"` keeps each file's format and name, so references in code stay valid. Files are replaced
  atomically, and only when the result is smaller and passes the quality check.
- `write: "out-dir"` writes to `outDir`, mirrors the folder structure, and may change formats (and therefore
  extensions).

Calling `optimize_images` twice is safe (`idempotentHint`): lossy outputs are tagged, and tagged files are not
re-encoded, as described in [Running it again is safe](./static#running-it-again-is-safe).

Both tools take the same options:

| Argument | Default | |
|---|---|---|
| `paths` | – | Files and/or folders. Folders are searched recursively; dot-folders are skipped |
| `mode` | `balanced` | `lossless`, `visually-lossless`, `balanced`, `fast` ([modes](./modes)) |
| `keepFormat` | `true` (in place, analysis) / `false` (out-dir) | Never change the format |
| `formats` | all four | Formats allowed when the format may change |
| `maxSize` | – | Downscale the longest side |
| `stripMetadata` | `false` | Remove EXIF (including GPS) and XMP |
| `minQuality`, `minSaving` | per mode / `0.02` | SSIM threshold; minimum saving to replace a file |
| `reoptimize` | `false` | (`optimize_images` only) re-encode files that are already tagged |

Results come as text for the model and as `structuredContent` that matches the declared `outputSchema`.
The file list is capped at 200 entries; `totals` always cover every file. Progress notifications are sent per
file when the client asks for them, and cancelling a call stops the worker threads.

### What it looks like

We gave Claude Code (Sonnet, headless, with only this server connected) a folder with three sample images and the
prompt *"The images in public/images make our site slow. Make them smaller without visible quality loss; image
references in code must keep working."* It made these calls:

1. It called `analyze_images` with `mode: "visually-lossless"`.
2. It called `optimize_images` with `write: "in-place"` and `mode: "visually-lossless"`.

It then reported the following:
- The images went from 285 KB to 234 KB (−18%).
- The two PNGs were recompressed losslessly, with pixel-exact verification.
- The JPEG was kept unchanged, because no encode was smaller while staying above the threshold.
- It pointed out that WebP/AVIF would save more, but that this would change the file extensions.

This is one run, not a benchmark.

## Agent Skill

[`skills/optiq/SKILL.md`](https://github.com/Baukaalm/optiq/blob/main/skills/optiq/SKILL.md) tells an agent how to
use the CLI:
- do a dry run first;
- use in-place for referenced files;
- pick a mode by kind of image;
- strip GPS before publishing;
- never pass `--reoptimize` unprompted.

For Claude Code, copy the folder to `.claude/skills/optiq/` in a project, or to `~/.claude/skills/optiq/` for every
project.

## llms.txt

[`llms.txt`](https://baukaalm.github.io/optiq/llms.txt) is a short plain-text summary of the library, the CLI and the MCP server for models that read
documentation sites.
