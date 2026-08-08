# Building Pixel City

The project uses **Vite** for bundling and **TypeScript** (strict) for type
safety. Everything is a static site — the production build is a folder of HTML,
JS and a source map that can be hosted anywhere.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server with HMR at <http://localhost:5173> |
| `npm run build` | `tsc --noEmit` (type-check) **then** `vite build` → `dist/` |
| `npm run preview` | Serve the built `dist/` locally to verify the bundle |
| `npm run typecheck` | Type-check only (`tsc --noEmit`) |
| `npm run lint` | ESLint over `src/**/*.ts` |
| `npm run lint:fix` | ESLint with autofix |
| `npm run format` | Prettier write over `src/**/*.ts` |

## Production build

```bash
npm run build
```

Output lands in `dist/`:

```
dist/
├── index.html
└── assets/
    ├── index-*.js     # game code (~130 kB, ~40 kB gzipped)
    ├── phaser-*.js    # Phaser runtime, split into its own chunk for caching
    └── *.map          # source maps
```

The Phaser runtime is deliberately split into a separate chunk (see
`vite.config.ts` → `manualChunks`) so it caches independently of game code.

## Configuration

- **`vite.config.ts`** — dev server, the `@` → `src` path alias, and the Phaser
  chunk split. `base: './'` makes the build portable to any sub-path host.
- **`tsconfig.json`** — strict TypeScript for the app (`@/*` alias).
- **`tsconfig.node.json`** — TypeScript for the Vite config itself.
- **`.eslintrc.cjs` / `.prettierrc.json`** — lint + format rules.

## Deploying

The `dist/` folder is a static site. Host it on any static host:

```bash
# GitHub Pages / Netlify / Vercel / S3 / nginx — just serve dist/ as the root.
npm run build
# then upload the contents of dist/
```

Because `base` is `./`, the build works from a domain root **or** a sub-folder
without changes.

## CI check (recommended)

```bash
npm ci
npm run typecheck && npm run lint && npm run build
```

A green run of those three commands is the project's definition of "buildable".
