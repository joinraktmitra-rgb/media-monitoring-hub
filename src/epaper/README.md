# ePaper CLI (`clis/epaper`)

Zero-dependency Bun TypeScript CLI for downloading Indian newspaper PDFs from `indiags.com` (*The Hindu*, *Indian Express*, *Business Line*, *Economic Times*, *Dainik Jagran*) and `dailyepaper.in` (88+ national & regional newspapers with historical archives).

## Quick Usage (Agent-Friendly `--json` Supported)

```bash
# List all newspapers
bun run epaper list --json
bun run epaper list --search hindu --json

# Check dated issues & direct links on dailyepaper.in
bun run epaper issues times-of-india --limit 5 --json

# Download a single paper (auto-routes The Hindu / Indian Express -> indiags, others -> dailyepaper)
bun run epaper download the-hindu --out ./downloads --json
bun run epaper download times-of-india --date "14 Nov 2026" --out ./downloads --json

# Batch download multiple papers in one command
bun run epaper batch the-hindu,indian-express,times-of-india,economic-times --out ./downloads --json
```
