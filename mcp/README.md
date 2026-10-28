# optiq-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI agents optimise the images in a project with
[Optiq](https://baukaalm.github.io/optiq/). It runs locally over stdio, and nothing is uploaded.

```sh
claude mcp add optiq -- npx -y optiq-mcp          # Claude Code
```

```json
{ "mcpServers": { "optiq": { "command": "npx", "args": ["-y", "optiq-mcp"] } } }
```

The JSON form is for Claude Desktop, Cursor and other clients. For VS Code (`.vscode/mcp.json`), use
`{ "servers": { "optiq": { "type": "stdio", "command": "npx", "args": ["-y", "optiq-mcp"] } } }`.

## Tools

| Tool | Writes | What it does |
|---|---|---|
| `analyze_images` | no (`readOnlyHint`) | Dry run. For each image it reports the chosen format, the bytes before and after, and the measured quality (SSIM, or pixel-exact) |
| `optimize_images` | yes | `write: "in-place"` keeps formats and names, so references in code stay valid. `write: "out-dir"` may change formats |

What each mode guarantees:
- `lossless`: pixels are verified identical;
- `visually-lossless`: SSIM ≥ 0.99;
- `balanced` (the default): SSIM ≥ 0.975;
- `fast`: the same threshold as `balanced`, but no AVIF and fewer encodes.

A file is replaced only when the result passes the check and is smaller. Lossy outputs carry a ~20-byte marker, so
running `optimize_images` again does not re-encode them and cannot compound the loss (`reoptimize: true`
overrides this).

Other options:
- `mode`;
- `keepFormat`;
- `formats`;
- `maxSize` (downscale the longest side);
- `stripMetadata` (removes EXIF including GPS, and XMP);
- `minQuality`;
- `minSaving`.

Full docs: https://baukaalm.github.io/optiq/guide/agents

Requires Node ≥ 20. Apache-2.0. The codec licences are listed in the
[optiq-image NOTICE](https://github.com/Baukaalm/optiq/blob/main/NOTICE).
