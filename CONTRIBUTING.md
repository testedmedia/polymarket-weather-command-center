# Contributing

Thanks for the interest. A few things to know before opening a PR.

## What this repo is

The Command Center UI (Next.js) plus a thin read-only proxy. The forecast engine (cron, ingest, scoring, Supabase schema) is being packaged as a follow-up release; until then, engine PRs can't be accepted here because the code isn't public yet.

## Good PR targets right now

- UI: table rendering, city cards, mobile layout, accessibility
- Demo/mock data mode so `npm run dev` shows a populated dashboard without an engine (see the good first issue)
- Docs: clarifying how to read the dashboard, data-source explanations
- Types: the payload schema in `app/page.tsx`

## Ground rules

- Trading-logic changes (bucket math, edge calculation, Wilson intervals) need an issue first with the reasoning and a source. This tool informs real-money decisions; correctness beats cleverness.
- No new runtime dependencies without an issue first.
- Screenshots in PRs for anything visual.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev   # http://localhost:3210
```

## Questions

Use [GitHub Discussions](https://github.com/testedmedia/polymarket-weather-command-center/discussions).
