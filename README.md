# CatchyCatcher

Frontend for **CatchyCatcher** — record audio, ship it to an API, then build an
interactive scratch-style arrangement (drag blocks, play back audio, save your
work).

This repo is `catchycatcher.github.io`, so it is published at the domain root:
**https://catchycatcher.github.io**

## Stack

- [SvelteKit](https://svelte.dev/docs/kit) with [`adapter-static`](https://svelte.dev/docs/kit/adapter-static) — real components, routes and state management instead of hand-written HTML, compiled down to plain static files that GitHub Pages can serve.
- [Svelte 5](https://svelte.dev/docs/svelte/what-are-runes) runes (`$state`, `$props`, …) for reactivity.
- [Tailwind CSS v4](https://tailwindcss.com) for styling.
- TypeScript, ESLint and Prettier.

Everything is prerendered at build time (see `src/routes/+layout.ts`), so there is
no server to run and no GitHub Pages base-path configuration needed.

## Local development

Requires Node 22+ (this project was set up with Node 24).

```sh
npm install
npm run dev -- --open   # dev server at http://localhost:5173
```

Other scripts:

```sh
npm run build      # static site -> ./build
npm run preview    # serve the production build locally
npm run check      # svelte-check + TypeScript
npm run lint       # prettier --check && eslint
npm run format     # prettier --write
```

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the site
and publishes `./build` to GitHub Pages.

One-time setup in the GitHub repo: **Settings → Pages → Build and deployment →
Source: GitHub Actions**.

## Project layout

```
src/
  app.html            # HTML shell
  routes/
    +layout.svelte    # shared layout (imports layout.css, favicon)
    +layout.ts        # prerender = true (required by adapter-static)
    layout.css        # Tailwind entry point
    +page.svelte      # the blank home page — start here
  lib/                # shared code ($lib alias)
static/               # files copied to the site root as-is (.nojekyll lives here)
```

`static/.nojekyll` disables Jekyll on GitHub Pages so SvelteKit's `_app/`
asset directory is served correctly. Don't delete it.
