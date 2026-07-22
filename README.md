# Markdown Live Preview

A self-hosted markdown live preview editor with file management, folder organization, sharing, and full mermaid diagram support.

Inspired by [markdownlivepreview.com](https://markdownlivepreview.com/).

## Features

- **Live preview** — Split-pane editor with real-time markdown rendering
- **File management** — Create, rename, pin, delete files via sidebar
- **Folders** — Organize files into folders with drag & drop
- **Share** — Generate shareable links; recipients can fork a copy
- **Image upload** — Upload from computer, paste from clipboard, or insert by URL
- **Lightbox zoom** — Click images/diagrams to view full-screen with zoom, pan, and keyboard controls
- **Mermaid diagrams** — Full support with Vietnamese text, custom font, and error handling
- **Code highlighting** — Syntax highlighting via highlight.js
- **Dark mode** — Toggle with persistent preference
- **Sync scroll** — Synchronized scrolling between editor and preview
- **Export PDF** — Print or save as PDF
- **Status bar** — Line/word/char count and cursor position
- **Toolbar** — Bold, italic, heading, link, code, table, image shortcuts (undo-friendly)
- **SQLite storage** — Persistent database via sql.js
- **Docker ready** — Dockerfile + docker-compose included

## Quick Start

```bash
npm install
npm start
# Open http://localhost:3456
```

## Docker

```bash
docker-compose up -d
# Open http://localhost:3456
```

## Tech Stack & Third-Party Libraries

| Library | License | Usage |
|---------|---------|-------|
| [Express](https://expressjs.com/) | MIT | HTTP server |
| [sql.js](https://github.com/sql-js/sql.js) | MIT | SQLite database (pure JS) |
| [nanoid](https://github.com/ai/nanoid) | MIT | Unique ID generation |
| [marked](https://github.com/markedjs/marked) | MIT | Markdown parser |
| [mermaid](https://github.com/mermaid-js/mermaid) | MIT | Diagram rendering |
| [highlight.js](https://github.com/highlightjs/highlight.js) | BSD-3-Clause | Code syntax highlighting |
| [Inter](https://github.com/rsms/inter) | OFL-1.1 | Font (Google Fonts CDN) |

All dependencies are MIT or BSD-3-Clause licensed. The Inter font is licensed under SIL Open Font License 1.1.

## Image Upload Security

- **Whitelist**: Only `png`, `jpg`, `gif`, `webp` allowed
- **Magic bytes validation**: File header verified against declared type
- **Size limit**: 5MB max
- **Path traversal protection**: Random filenames, path validation
- **Security headers**: `Content-Security-Policy`, `X-Content-Type-Options: nosniff` on uploads

## License

MIT — See [LICENSE](LICENSE) for details.
