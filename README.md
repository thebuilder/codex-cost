# Codex Cost

Local CLI for estimating Codex usage cost from JSONL session files.

<img width="1774" height="887" alt="image" src="https://github.com/user-attachments/assets/db1394ea-dd5e-4f27-a016-ac8ef1514ff2" />

**Features**

- See Codex usage and estimated cost by project or thread
- Attribute work to projects and clients automatically
- Filter reports by recent ranges or month names
- Export clean JSON, CSV, and Excel reports
- Tune pricing with an editable rate card


## Requirements

- Node.js 22 or newer
- Local Codex files under `~/.codex`

## Install

From npm:

```bash
npm install -g codex-cost
```

## Usage

Interactive picker:

```bash
codex-cost
```

Interactive mode starts with:

- Report
- Export
- Rates

Report mode asks for a date range before scanning:

- All time
- Past 1 day
- Past 1 week
- Past 1 month
- Specific month

Export mode prompts for format, date range, and filename. The filename prompt includes a timestamped default.

Terminal reports:

```bash
codex-cost report --project <project-id>
codex-cost report --thread <thread-id>
```

Exports:

```bash
codex-cost export
codex-cost export --out report.xlsx
codex-cost export --range 1w
codex-cost export --range april
codex-cost export --format xlsx --out report.xlsx
codex-cost export --format csv --out report.csv
codex-cost export --format json --out report.json
```

`--range` accepts `all`, `1d`, `1w`, `1m`, or a month name. Month names resolve to the nearest current or past month, so `may` in April 2026 resolves to May 2025.

Rate card:

```bash
codex-cost rates
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
