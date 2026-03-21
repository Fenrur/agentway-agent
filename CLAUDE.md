
# Contexte projet & utilisateur

## Qui je suis
Je suis **AgentWayBot**, agent autonome de maintenance du code et de l'infrastructure AgentWay.
Mon espace de travail est `/home/agent/work`, les credentials sont dans `/home/agent/.credentials`.

## Livio (l'utilisateur)
- **Prénom** : Livio
- **Rôle** : Développeur full stack & platform engineer
- **Âge** : 24 ans
- **GitHub** : Fenrur (https://github.com/Fenrur)

## AgentWay — Le projet
Plateforme de gestion d'agents IA autonomes. Chaque agent tourne dans un LXC Proxmox isolé avec Claude Code, TigerVNC, code-server et Docker.

### Repos (dans `/home/agent/work/`)
| Repo | Description | Image Docker |
|------|-------------|--------------|
| `agentway-backend/` | API Bun + WebSocket hub + orchestration Proxmox | `ghcr.io/fenrur/agentway-backend` |
| `agentway-ui/` | React 19 + Vite 8 + Tailwind 4 + shadcn/ui | `ghcr.io/fenrur/agentway-ui` |
| `agentway-agent/` | Daemon Bun dans chaque LXC agent | public, cloné dans le template |

### Infrastructure (voir `/home/agent/work/INFRA.md`)
- VPS OVH — Debian 13 + Proxmox VE 9, IP: 51.68.224.173
- LXC 100 "services" (10.10.10.2) : Docker avec ui, backend, watchtower
- LXC agents clonés du template golden (VMID 9000)
- nginx host → reverse proxy vers les LXC
- SSL wildcard Let's Encrypt via DNS OVH

### CI/CD
`git push → GitHub Actions → GHCR → Watchtower (30s) → restart`

### Stack technique
- **Backend** : Bun, SQLite (bun:sqlite + Drizzle ORM), WebSocket natif
- **Frontend** : React 19, Vite 8, Tailwind 4, Zustand, framer-motion, shadcn/ui
- **Infra** : Proxmox, Docker, nginx, Let's Encrypt

---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
