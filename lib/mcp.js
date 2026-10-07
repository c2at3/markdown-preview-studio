'use strict';

// Minimal MCP server (Streamable HTTP transport, JSON responses, stateless).
//
// Every tool is a thin wrapper that calls this app's own REST API over
// loopback with the caller's own API key, so the MCP surface can never do
// more than the key already can (the /api middleware enforces the allowlist)
// and all validation/error messages stay in one place.

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const SEVERITY_COLORS = { critical: 'purple', high: 'red', medium: 'orange', low: 'green', info: 'gray' };
const SEVERITIES = Object.keys(SEVERITY_COLORS);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const INSTRUCTIONS =
  'Notes server: read, write and organise Markdown notes (files in folders) and upload images. ' +
  'Notes are addressed by folder path ("TEST/Bug bounty") plus filename. ' +
  'Use create_vuln_report to file security findings - it picks the right icon and colour for you.';

const STR = (description) => ({ type: 'string', description });
const FOLDER = STR('Folder path, nested folders separated by "/" (e.g. "TEST/Bug bounty"). Omit for the root.');

function skeleton(title, severity, verified) {
  return [
    '# ' + title,
    '',
    '**Severity:** ' + cap(severity),
    '**Status:** ' + (verified ? 'Verified' : 'Unverified'),
    '',
    '## Summary',
    '_One or two sentences describing the vulnerability._',
    '',
    '## Affected asset',
    '- ',
    '',
    '## Steps to reproduce',
    '1. ',
    '',
    '## Impact',
    '',
    '## Remediation',
    '',
    '## References',
    '- ',
    ''
  ].join('\n');
}

// Keep the Severity/Status lines of an existing report in step with its icon
// and colour when it is re-triaged without new content.
function relabel(content, severity, verified) {
  return String(content || '')
    .replace(/^(\*\*Severity:\*\*)[ \t]*.*$/m, '$1 ' + cap(severity))
    .replace(/^(\*\*Status:\*\*)[ \t]*.*$/m, '$1 ' + (verified ? 'Verified' : 'Unverified'));
}

const TOOLS = [
  {
    name: 'list_files',
    description: 'List every folder (with its full path) and every file (with its folder path, icon and colour, but not its content).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (args, api) => api('GET', '/api/files/list')
  },
  {
    name: 'read_file',
    description: 'Read one note, including its Markdown content.',
    inputSchema: {
      type: 'object',
      properties: { filename: STR('Name of the note.'), folder: FOLDER },
      required: ['filename'], additionalProperties: false
    },
    annotations: { readOnlyHint: true },
    run: async (args, api) => api('GET', '/api/files/view', { query: { folder: args.folder, filename: args.filename } })
  },
  {
    name: 'write_file',
    description:
      'Create a note, or overwrite it in place if one with that name already exists in the folder. ' +
      'Missing folders are created unless auto_create is false. On update, omit content to leave the existing content untouched.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: STR('Name of the note.'),
        folder: FOLDER,
        content: STR('Markdown source.'),
        icon: STR('Icon name: default, note, bug, vulnerability, lock, warning, work, checklist, idea, book, chart, star, flag, rocket, calendar, code.'),
        color_file: STR('Colour name for the file: red, orange, yellow, green, blue, purple, pink, teal, gray.'),
        color_folder: STR('Colour name applied only to folders newly created by this call.'),
        auto_create: { type: 'boolean', description: 'Default true. false = fail with 404 instead of creating missing folders.' }
      },
      required: ['filename'], additionalProperties: false
    },
    run: async (args, api) => api('POST', '/api/files/upload', { json: args })
  },
  {
    name: 'delete_file',
    description: 'Delete one note. This cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: { filename: STR('Name of the note.'), folder: FOLDER },
      required: ['filename'], additionalProperties: false
    },
    annotations: { destructiveHint: true },
    run: async (args, api) => api('DELETE', '/api/files/upload', { json: { folder: args.folder, filename: args.filename } })
  },
  {
    name: 'delete_folder',
    description:
      'Delete the last folder of the given path (not its parents) and all sub-folders inside it. ' +
      'Notes are never deleted this way - they are moved to the root. This cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: { folder: STR('Folder path to delete, e.g. "TEST/Bug bounty".') },
      required: ['folder'], additionalProperties: false
    },
    annotations: { destructiveHint: true },
    run: async (args, api) => api('DELETE', '/api/files/upload', { json: { folder: args.folder } })
  },
  {
    name: 'upload_images',
    description:
      'Upload 1-10 images (PNG, JPEG, GIF or WebP, up to 5MB each) given as base64 data URIs. All-or-nothing. ' +
      'Returns each image\'s id and a ready-to-paste Markdown snippet; embed it in a note as ![](/uploads/<id>).',
    inputSchema: {
      type: 'object',
      properties: {
        images: {
          type: 'array', minItems: 1, maxItems: 10,
          items: { type: 'string', description: 'A data URI, e.g. "data:image/png;base64,iVBORw0..."' },
          description: 'The images to upload.'
        }
      },
      required: ['images'], additionalProperties: false
    },
    run: async (args, api) => api('POST', '/api/images/upload', { json: { data: args.images } })
  },
  {
    name: 'create_vuln_report',
    description:
      'File a vulnerability report as a note, with the icon and colour chosen from its status and severity. ' +
      'Icon: verified = "bug", not yet verified = "warning". ' +
      'Colour by severity: critical = purple, high = red, medium = orange, low = green, info = gray. ' +
      'If content is omitted a standard report template is created (Summary, Affected asset, Steps to reproduce, Impact, Remediation, References). ' +
      'Calling it again for the same title and folder updates the report: omit content to only re-triage it ' +
      '(icon, colour and the Severity/Status lines change, the rest of the text is kept).',
    inputSchema: {
      type: 'object',
      properties: {
        title: STR('Report title; used as the note name, e.g. "Report 001 - Stored XSS in comments".'),
        severity: { type: 'string', enum: SEVERITIES, description: 'critical, high, medium, low or info.' },
        verified: { type: 'boolean', description: 'true if the vulnerability has been verified/reproduced; false if not yet verified.' },
        content: STR('Full Markdown body of the report. Omit to use the template (new report) or keep the existing text (update).'),
        folder: FOLDER
      },
      required: ['title', 'severity', 'verified'], additionalProperties: false
    },
    run: async (args, api) => {
      const severity = String(args.severity || '').toLowerCase();
      if (!SEVERITY_COLORS[severity]) return { status: 400, body: { error: 'severity must be one of: ' + SEVERITIES.join(', ') } };
      if (typeof args.verified !== 'boolean') return { status: 400, body: { error: 'verified must be true or false' } };
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) return { status: 400, body: { error: 'title is required' } };

      const icon = args.verified ? 'bug' : 'warning';
      const color = SEVERITY_COLORS[severity];

      let content = args.content;
      let contentSource = 'provided';
      if (content === undefined) {
        const existing = await api('GET', '/api/files/view', { query: { folder: args.folder, filename: title } });
        if (existing.status === 200) {
          content = relabel(existing.body.content, severity, args.verified);
          contentSource = 'kept';
        } else if (existing.status === 404) {
          content = skeleton(title, severity, args.verified);
          contentSource = 'template';
        } else {
          return existing;
        }
      }

      const res = await api('POST', '/api/files/upload', {
        json: { folder: args.folder, filename: title, content, icon, color_file: color }
      });
      if (res.status >= 400) return res;
      return {
        status: res.status,
        body: {
          id: res.body.id, name: res.body.name, folder: args.folder || '', action: res.body.action,
          severity, verified: args.verified, icon, color, content: contentSource
        }
      };
    }
  }
];

function createMcpHandler({ port, version, validateApiKey }) {
  const base = 'http://127.0.0.1:' + port;

  function makeApi(authorization) {
    return async function api(method, path, { query, json } = {}) {
      let url = base + path;
      if (query) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, String(v));
        if ([...qs].length) url += '?' + qs;
      }
      const headers = { Authorization: authorization };
      const init = { method, headers };
      if (json !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
      const r = await fetch(url, init);
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch (e) { body = { error: text.slice(0, 300) }; }
      return { status: r.status, body };
    };
  }

  async function callTool(name, args, api) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { code: -32602, message: 'Unknown tool: ' + name };
    let r;
    try { r = await tool.run(args || {}, api); }
    catch (e) { return { result: { content: [{ type: 'text', text: 'Request failed: ' + e.message }], isError: true } }; }
    const ok = r.status >= 200 && r.status < 300;
    const text = ok ? JSON.stringify(r.body, null, 2) : 'Error ' + r.status + ': ' + (r.body && r.body.error ? r.body.error : JSON.stringify(r.body));
    return { result: { content: [{ type: 'text', text }], ...(ok ? {} : { isError: true }) } };
  }

  async function dispatch(msg, api) {
    const isRequest = msg && typeof msg === 'object' && msg.id !== undefined && typeof msg.method === 'string';
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      return { jsonrpc: '2.0', id: (msg && msg.id) ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    if (!isRequest) return null; // notification (e.g. notifications/initialized): no response

    const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    const p = msg.params || {};

    switch (msg.method) {
      case 'initialize': {
        const wanted = p.protocolVersion;
        return ok({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'markdown-preview-studio', version },
          instructions: INSTRUCTIONS
        });
      }
      case 'ping': return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
      case 'tools/call': {
        if (typeof p.name !== 'string') return err(-32602, 'params.name is required');
        const out = await callTool(p.name, p.arguments, api);
        return out.code ? err(out.code, out.message) : ok(out.result);
      }
      default: return err(-32601, 'Method not found: ' + msg.method);
    }
  }

  return async function mcpHandler(req, res) {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return res.status(401).set('WWW-Authenticate', 'Bearer realm="mcp"')
        .json({ error: 'Missing API key. Send "Authorization: Bearer mdpk_..." (create one with the key icon in the app).' });
    }
    const key = await validateApiKey(m[1].trim());
    if (!key) return res.status(401).set('WWW-Authenticate', 'Bearer realm="mcp"').json({ error: 'Invalid API key' });

    const api = makeApi(req.headers.authorization);
    const body = req.body;
    try {
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map((x) => dispatch(x, api)))).filter(Boolean);
        return out.length ? res.json(out) : res.status(202).end();
      }
      const out = await dispatch(body, api);
      return out ? res.json(out) : res.status(202).end();
    } catch (e) {
      console.error('[mcp error]', e);
      return res.status(500).json({ jsonrpc: '2.0', id: (body && body.id) ?? null, error: { code: -32603, message: 'Internal error' } });
    }
  };
}

module.exports = { createMcpHandler, SEVERITY_COLORS };
