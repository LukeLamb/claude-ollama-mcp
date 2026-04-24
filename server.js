#!/usr/bin/env node
// Ollama MCP server for Claude Desktop.
// Pure Node, no npm deps. Calls the Ollama HTTP API directly.
// https://github.com/LukeLamb/claude-ollama-mcp — MIT License.

'use strict';

const http = require('http');
const https = require('https');
const readline = require('readline');
const { URL } = require('url');

// ─── CLI args ─────────────────────────────────────────────────────────────
function parseArgv() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--ollama-url' && i + 1 < a.length) out.ollamaUrl = a[++i];
  }
  return out;
}

const ARGS = parseArgv();
// Claude Desktop substitutes ${user_config.X} only when the user set a value;
// a blank field passes the literal placeholder through as argv (observed
// v0.3.1 bug in claude-terminal-mcp). Detect that and fall back to default.
const OLLAMA_URL = (() => {
  const raw = ARGS.ollamaUrl && ARGS.ollamaUrl.trim();
  if (!raw || raw.startsWith('${user_config')) return 'http://localhost:11434';
  return raw.replace(/\/+$/, '');
})();
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes; generation can take a while

// ─── Logging (stderr) ─────────────────────────────────────────────────────
function log(...args) {
  try {
    process.stderr.write('[ollama-mcp] ' + args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' ') + '\n');
  } catch (_) {}
}

// ─── JSON-RPC plumbing ────────────────────────────────────────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
function error(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined && { data }) } });
}
function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────
function httpRequest(method, path, body) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(path, OLLAMA_URL);
    } catch (e) {
      resolve({ error: `invalid URL: ${e.message}` });
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { 'accept': 'application/json' },
    };
    let bodyBuf = null;
    if (body !== undefined) {
      bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
      opts.headers['content-type'] = 'application/json';
      opts.headers['content-length'] = bodyBuf.length;
    }
    const req = lib.request(opts, (res) => {
      let chunks = Buffer.alloc(0);
      res.on('data', (d) => { chunks = Buffer.concat([chunks, d]); });
      res.on('end', () => {
        const text = chunks.toString('utf8');
        if (res.statusCode >= 400) {
          resolve({ status: res.statusCode, error: `HTTP ${res.statusCode}: ${text.slice(0, 500)}` });
          return;
        }
        // Some endpoints return text/plain (e.g. GET /); try JSON first, fall back to text.
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch (_) { resolve({ status: res.statusCode, data: null, text }); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', (e) => {
      // Give a friendly connection-refused message.
      const msg = /ECONNREFUSED|ENOTFOUND/.test(e.code || e.message)
        ? `cannot reach Ollama at ${OLLAMA_URL} — is the server running? Start it with \`ollama serve\` or open the Ollama app.`
        : e.message;
      resolve({ error: msg });
    });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function requireString(args, field) {
  if (typeof args[field] !== 'string' || !args[field].trim()) {
    return `${field} is required (non-empty string)`;
  }
  return null;
}

// ─── Tool: ollama_status ──────────────────────────────────────────────────
async function ollamaStatus() {
  const root = await httpRequest('GET', '/');
  if (root.error) return errorResult(root.error);
  const ver = await httpRequest('GET', '/api/version');
  return textResult({
    url: OLLAMA_URL,
    reachable: true,
    root_message: root.text || (root.data ? JSON.stringify(root.data) : ''),
    version: ver.data?.version || null,
  });
}

// ─── Tool: list_models ────────────────────────────────────────────────────
async function listModels() {
  const r = await httpRequest('GET', '/api/tags');
  if (r.error) return errorResult(r.error);
  const models = (r.data?.models || []).map((m) => ({
    name: m.name,
    size_bytes: m.size,
    digest: m.digest,
    modified_at: m.modified_at,
    family: m.details?.family || null,
    parameter_size: m.details?.parameter_size || null,
    quantization_level: m.details?.quantization_level || null,
  }));
  return textResult({ count: models.length, models });
}

// ─── Tool: list_running ───────────────────────────────────────────────────
async function listRunning() {
  const r = await httpRequest('GET', '/api/ps');
  if (r.error) return errorResult(r.error);
  const models = (r.data?.models || []).map((m) => ({
    name: m.name,
    size_bytes: m.size,
    size_vram_bytes: m.size_vram,
    expires_at: m.expires_at,
    digest: m.digest,
  }));
  return textResult({ count: models.length, models });
}

// ─── Tool: show_model ─────────────────────────────────────────────────────
async function showModel(args) {
  const bad = requireString(args, 'name');
  if (bad) return errorResult(bad);
  const r = await httpRequest('POST', '/api/show', { name: args.name });
  if (r.error) return errorResult(r.error);
  const d = r.data || {};
  return textResult({
    name: args.name,
    modelfile_excerpt: typeof d.modelfile === 'string' ? d.modelfile.slice(0, 500) : null,
    parameters: d.parameters || null,
    template: d.template || null,
    capabilities: d.capabilities || [],
    details: d.details || null,
    model_info_keys: d.model_info ? Object.keys(d.model_info).slice(0, 30) : [],
    modified_at: d.modified_at || null,
  });
}

// ─── Tool: generate ───────────────────────────────────────────────────────
async function generate(args) {
  const badModel = requireString(args, 'model');
  if (badModel) return errorResult(badModel);
  const badPrompt = requireString(args, 'prompt');
  if (badPrompt) return errorResult(badPrompt);

  const body = {
    model: args.model,
    prompt: args.prompt,
    stream: false,
  };
  if (args.system && typeof args.system === 'string') body.system = args.system;
  if (args.options && typeof args.options === 'object') body.options = args.options;

  const r = await httpRequest('POST', '/api/generate', body);
  if (r.error) return errorResult(r.error);
  const d = r.data || {};
  return textResult({
    model: d.model || args.model,
    response: d.response || '',
    done_reason: d.done_reason || null,
    eval_count: d.eval_count || null,
    eval_duration_ms: d.eval_duration ? Math.round(d.eval_duration / 1e6) : null,
    prompt_eval_count: d.prompt_eval_count || null,
    total_duration_ms: d.total_duration ? Math.round(d.total_duration / 1e6) : null,
    tokens_per_second: d.eval_count && d.eval_duration
      ? Math.round((d.eval_count / (d.eval_duration / 1e9)) * 100) / 100
      : null,
  });
}

// ─── Tool: chat ───────────────────────────────────────────────────────────
async function chat(args) {
  const badModel = requireString(args, 'model');
  if (badModel) return errorResult(badModel);
  if (!Array.isArray(args.messages) || !args.messages.length) {
    return errorResult('messages is required (non-empty array of {role, content} objects)');
  }
  for (const m of args.messages) {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string' || typeof m.content !== 'string') {
      return errorResult('each message must be {role: "system"|"user"|"assistant", content: string}');
    }
  }

  const body = {
    model: args.model,
    messages: args.messages,
    stream: false,
  };
  if (args.options && typeof args.options === 'object') body.options = args.options;

  const r = await httpRequest('POST', '/api/chat', body);
  if (r.error) return errorResult(r.error);
  const d = r.data || {};
  return textResult({
    model: d.model || args.model,
    message: d.message || null,
    done_reason: d.done_reason || null,
    eval_count: d.eval_count || null,
    eval_duration_ms: d.eval_duration ? Math.round(d.eval_duration / 1e6) : null,
    prompt_eval_count: d.prompt_eval_count || null,
    total_duration_ms: d.total_duration ? Math.round(d.total_duration / 1e6) : null,
    tokens_per_second: d.eval_count && d.eval_duration
      ? Math.round((d.eval_count / (d.eval_duration / 1e9)) * 100) / 100
      : null,
  });
}

// ─── Tool: pull_model ─────────────────────────────────────────────────────
async function pullModel(args) {
  const bad = requireString(args, 'name');
  if (bad) return errorResult(bad);
  // Use stream:false — Ollama buffers and returns a single final event.
  // For very large models this can block the connection for a long time;
  // users pulling multi-GB models are better served by `ollama pull` in a
  // terminal where they can see progress. Documented in the README.
  const r = await httpRequest('POST', '/api/pull', { name: args.name, stream: false });
  if (r.error) return errorResult(r.error);
  const d = r.data || {};
  return textResult({
    name: args.name,
    status: d.status || 'unknown',
    success: d.status === 'success',
  });
}

// ─── Tool: delete_model ───────────────────────────────────────────────────
async function deleteModel(args) {
  const bad = requireString(args, 'name');
  if (bad) return errorResult(bad);
  const r = await httpRequest('DELETE', '/api/delete', { name: args.name });
  if (r.error) return errorResult(r.error);
  return textResult({ name: args.name, deleted: true });
}

// ─── Tool registry ────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'ollama_status',
    description: 'Health check: whether the Ollama server is reachable and its version. Use this as a precondition before other tools if you\'re unsure whether Ollama is running.',
    annotations: { title: 'Ollama server status', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_models',
    description: 'List locally-installed models: name, size in bytes, digest, modified timestamp, family (e.g. llama), parameter size (e.g. 8.0B), and quantization level (e.g. Q4_K_M).',
    annotations: { title: 'List installed models', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_running',
    description: 'List models currently loaded into VRAM with their size, VRAM footprint, and expiry timestamp. Empty list means Ollama is idle.',
    annotations: { title: 'List running models', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'show_model',
    description: 'Show detailed information for a specific model: modelfile excerpt, parameters, template, capabilities, architecture details, quantization level.',
    annotations: { title: 'Show model details', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Model name (e.g. "llama3.1:8b" or "forge:b6c1").' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate',
    description: 'Run a one-shot text completion against a local model (non-streaming). Returns the full response text plus timing and tokens/second.',
    annotations: { title: 'Generate text', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model name (e.g. "llama3.1:8b").' },
        prompt: { type: 'string', description: 'Prompt text.' },
        system: { type: 'string', description: 'Optional system prompt.' },
        options: {
          type: 'object',
          description: 'Ollama sampling/decoding options — e.g. {"temperature": 0.7, "num_predict": 100, "top_p": 0.9}.',
          additionalProperties: true,
        },
      },
      required: ['model', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'chat',
    description: 'Run a chat completion against a local model with message history (non-streaming). Returns the assistant\'s reply plus timing.',
    annotations: { title: 'Chat completion', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model name.' },
        messages: {
          type: 'array',
          description: 'Chat history. Each item: {role: "system"|"user"|"assistant", content: string}.',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
        },
        options: {
          type: 'object',
          description: 'Ollama sampling/decoding options.',
          additionalProperties: true,
        },
      },
      required: ['model', 'messages'],
      additionalProperties: false,
    },
  },
  {
    name: 'pull_model',
    description: 'Download a model from the Ollama registry. Blocks until complete — can take a long time for multi-GB models. For very large pulls, prefer `ollama pull` in a terminal where you can watch progress.',
    annotations: { title: 'Pull model', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Model name to pull (e.g. "llama3.1:8b").' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_model',
    description: 'Delete a locally-installed model. Does not affect the remote registry copy. Free the disk space of a model you no longer need.',
    annotations: { title: 'Delete model', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Model name to delete.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  ollama_status: ollamaStatus,
  list_models: listModels,
  list_running: listRunning,
  show_model: showModel,
  generate: generate,
  chat: chat,
  pull_model: pullModel,
  delete_model: deleteModel,
};

// ─── JSON-RPC dispatch ────────────────────────────────────────────────────
async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ollama-mcp', version: '0.1.0' },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') { respond(id, {}); return; }
  if (method === 'tools/list') { respond(id, { tools: TOOLS }); return; }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    const handler = HANDLERS[name];
    if (!handler) { error(id, -32601, `unknown tool: ${name}`); return; }
    try {
      const result = await Promise.resolve(handler(args));
      respond(id, result);
    } catch (e) {
      log('tool error:', name, e.message, e.stack);
      respond(id, errorResult(`tool ${name} threw: ${e.message}`));
    }
    return;
  }

  if (id !== undefined && id !== null) error(id, -32601, `method not found: ${method}`);
}

// ─── Main loop ────────────────────────────────────────────────────────────
let inflight = 0;
let stdinClosed = false;
function maybeExit() { if (stdinClosed && inflight === 0) process.exit(0); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (e) { log('bad JSON on stdin:', e.message); return; }
  inflight++;
  handle(msg)
    .catch((e) => {
      log('handler crash:', e.message, e.stack);
      if (msg && msg.id !== undefined) error(msg.id, -32603, e.message);
    })
    .finally(() => { inflight--; maybeExit(); });
});
rl.on('close', () => { stdinClosed = true; maybeExit(); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log('server started, pid', process.pid, 'ollama_url=' + OLLAMA_URL);
