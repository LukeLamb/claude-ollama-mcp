# Claude Ollama

Lets [Claude Desktop](https://claude.ai/download) query and manage a local [Ollama](https://ollama.com/) server. List installed models, inspect them, run one-shot `generate`/`chat` completions against any local model, or pull/delete models from the registry — all without opening a terminal.

Typical use: comparing Claude's answer to a local model on the same prompt, running cheap bulk completions against a quantized model, or checking custom training-checkpoint models you've imported into Ollama.

## Requirements

- A running Ollama server (`ollama serve` or the Ollama app).
- Default endpoint is `http://localhost:11434`. Override via the **`ollama_url`** user config in Claude Desktop's extension settings if you run Ollama on a different host or port.
- No npm dependencies — pure Node over the HTTP API.

## Install (Claude Desktop)

1. Download the latest `Ollama.mcpb` from the [Releases](https://github.com/LukeLamb/claude-ollama-mcp/releases) page.
2. In Claude Desktop: **Settings → Extensions → Extension Developer → Install Extension** → pick the `.mcpb`.
3. (Optional) In the extension's settings, set `Ollama server URL` if you run Ollama on a non-default host/port. Leave blank for `http://localhost:11434`.

## Tools

| Tool | Annotation | Purpose |
|---|---|---|
| `ollama_status` | read-only | Health check + server version |
| `list_models` | read-only | Local models with size, digest, family, parameter size, quantization |
| `list_running` | read-only | Models currently loaded in VRAM |
| `show_model` | read-only | Model details: modelfile, parameters, template, capabilities |
| `generate` | open-world | One-shot text completion (non-streaming) |
| `chat` | open-world | Chat completion with message history (non-streaming) |
| `pull_model` | open-world | Download a model from the registry |
| `delete_model` | destructive | Remove a locally-installed model |

## Example prompts

> _"Which local models do I have installed, and which one is currently loaded in VRAM?"_
>
> _"Run `forge:b6c1` on this prompt: '<blah>'. Compare that output to your own answer."_
>
> _"Show me the modelfile for `forge:b7c1` — I want to check the temperature setting."_
>
> _"Pull `llama3.1:70b`." (expect a long wait for large models)_
>
> _"Delete the `forge:b5c3` model — I don't need that checkpoint anymore."_

## Privacy policy

This extension runs entirely on your local machine and sends HTTP requests only to your Ollama server (default `http://localhost:11434`). **No data leaves your machine** unless you explicitly configure `ollama_url` to point at a remote Ollama instance, in which case the prompts and responses travel to that server.

The information visible to Claude includes:

- **All prompts and chat messages you pass to `generate` and `chat`** (these go to the Ollama server, which may log them depending on its configuration).
- **Full text of completions** returned by Ollama.
- **Metadata for every installed model** (names, digests, sizes, quantization, modelfile contents).
- **Which models are currently loaded in VRAM** and their size footprint.

If you have installed models containing proprietary fine-tunes or modelfiles with sensitive metadata, note that Claude will see that information when you call `show_model` or `list_models`.

`delete_model` is destructive and cannot be undone from this extension — the model must be re-pulled from the registry (or re-imported from source blobs) if deleted by mistake.

## Troubleshooting

**"cannot reach Ollama at http://localhost:11434 — is the server running?"** — Start Ollama with `ollama serve` or launch the Ollama app. Verify with `curl http://localhost:11434/` (should return "Ollama is running").

**`pull_model` hangs for a long time** — Ollama's pull API with `stream: false` blocks until the full download completes, which for multi-GB models can take many minutes. If you're pulling a huge model, run `ollama pull <name>` in a terminal instead — you'll see streaming progress there, and subsequent MCP calls will find the model already installed.

**Custom/remote Ollama endpoint** — Set `ollama_url` in the extension's settings (e.g. `http://192.168.1.42:11434`). Requires restart of the extension.

**`list_running` shows a model after you stopped using it** — Ollama keeps models hot in VRAM for a configurable TTL (default 5 minutes). The `expires_at` timestamp tells you when it'll unload. This is Ollama's behavior, not the extension's.

## Development

Single ~400-line Node.js script, zero npm dependencies. Rebuild the `.mcpb`:

```bash
cd bundle-source
zip -j ../Ollama.mcpb manifest.json package.json server.js README.md LICENSE icon.png glama.json
```

## License

MIT. See [LICENSE](LICENSE).

## Related

- [claude-terminal-mcp](https://github.com/LukeLamb/claude-terminal-mcp) — shell, filesystem, and background jobs.
- [claude-rocm-mcp](https://github.com/LukeLamb/claude-rocm-mcp) — AMD GPU monitoring; pairs well for checking whether Ollama's loaded model is saturating VRAM.
- [claude-sessions-mcp](https://github.com/LukeLamb/claude-sessions-mcp) — tmux session management for long-running jobs.
- [claude-linux-mcp](https://github.com/LukeLamb/claude-linux-mcp) — X11 desktop control.
