# Codex Cost

Local CLI for estimating Codex usage cost from JSONL session files.

It reads local Codex thread history, attributes usage to projects, prices token usage from an editable rate card, and exports terminal, JSON, CSV, and Excel reports.

## Requirements

- Node.js 22 or newer
- Local Codex files under `~/.codex`

## Install

From npm:

```bash
npm install -g codex-cost
```

From a packed tarball:

```bash
npm install -g ./codex-cost-0.1.0.tgz
```

For local development:

```bash
pnpm install
pnpm codex-cost scan --json
```

## Usage

Interactive picker:

```bash
codex-cost
```

Terminal reports:

```bash
codex-cost report --project <project-id>
codex-cost report --thread <thread-id>
```

Exports:

```bash
codex-cost export
codex-cost export --out report.xlsx
codex-cost export --format xlsx --out report.xlsx
codex-cost export --format csv --out report.csv
codex-cost export --format json --out report.json
```

Debug scan:

```bash
codex-cost scan --json
```

## Data Included

By default, reports include all readable local Codex JSONL files from:

- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/*.jsonl`

The CLI also reads `~/.codex/session_index.jsonl` for thread names.

No date range is applied by default. Exact duplicate token-count events are deduplicated.

## Configuration

The CLI loads config from the current working directory first:

```text
codex-cost.config.json
```

Then falls back to:

```text
~/.config/codex-cost/config.json
```

Example:

```json
{
  "codexHome": "~/.codex",
  "currency": "USD",
  "projectRules": [
    {
      "id": "client-a",
      "name": "Client A",
      "pathPrefix": "/Users/you/Projects/client-a"
    }
  ],
  "threadOverrides": {
    "thread-id": {
      "projectId": "client-a",
      "projectName": "Client A",
      "name": "Renamed Thread"
    }
  },
  "rateCards": {
    "custom-model": {
      "inputPerMillion": 1.25,
      "cachedInputPerMillion": 0.125,
      "outputPerMillion": 10
    }
  },
  "speedOverrides": {}
}
```

Project attribution uses:

1. Per-thread overrides
2. Ordered path-prefix rules
3. Fallback project id from the session cwd basename

## Excel Reports

The Excel workbook includes:

- `Summary`
- `Projects`
- `Threads`
- `Turns`
- `RateCard`

Cost columns are formulas. Updating values in `RateCard` recalculates `Turns`, then rolls up into `Threads`, `Projects`, and `Summary`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm pack
```
