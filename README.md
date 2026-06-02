# 🐎 Laocoön — Supply Chain Guard

> *"Timeo Danaos et dona ferentes"* — Laocoön, on accepting gifts from strangers.

A GitHub Action that inspects **dependency lockfile changes** in a pull request and uses an LLM to flag likely **supply chain attacks** — specifically freshly-injected trojans hiding inside an otherwise-trusted package upgrade.

It is **ecosystem-pluggable** and ships with three:

| Ecosystem | Lockfiles | Registry | Diffs |
|---|---|---|---|
| **Elixir / Hex** | `mix.lock` | hex.pm | published `.tar` (inner `contents.tar.gz`) |
| **JavaScript / npm** | `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml` | registry.npmjs.org | published `.tgz` (strips `package/`) |
| **Python / PyPI** | `poetry.lock`, `uv.lock`, `Pipfile.lock`, pinned `requirements.txt` | pypi.org | published sdist `.tar.gz` |

Each ecosystem surfaces its own prime attack surface to the model — Hex/release hooks, npm **lifecycle scripts** (`postinstall`, …), Python **`setup.py` / build hooks**.

## The core idea: soaked-baseline diffing

The biggest real-world supply chain risk isn't a long-standing malicious package — those get caught by the ecosystem over time. It's a **freshly published trojan release** of a trusted package (maintainer account takeover, compromised CI) that you pick up early, before anyone notices.

So instead of diffing the version you *had* against the version you're *getting*, Laocoön diffs against a **soaked baseline**:

> the newest release on the **same version lineage** that is older than the soak window (default **60 days**).

A version that's been public for 60+ days has had time for the ecosystem to catch a compromise, so it's treated as presumed-clean. Everything in the diff from that baseline to the adopted version is **novel, un-vetted surface** — exactly where an injected payload would live.

**Lineage-aware:** adopting `1.1.2` diffs against the newest soaked `1.1.x` (e.g. `1.1.0`), **not** `1.2.x`, so you see the real intended changes on the line you're tracking, not unrelated churn. Fallback ladder: same `major.minor` → same `major` → any → (none → flagged in the comment).

## How it works

1. **Detect** which known lockfiles changed in the PR (`mix.lock`, …), diffing PR base → head (the cumulative net change).
2. For each changed/added dependency: **select the soaked baseline**, **download and unpack the published artifacts** (the actual tarballs — not the git repo, which can differ), and **diff the file trees**.
3. Gather **registry signals**: release age, downloads, owners, publisher (account-takeover check), repository link, retirement/yank.
4. **Binaries & minified blobs are never sent to the LLM** — they can't be statically reviewed. A binary that's *new or changed* vs the soaked baseline is flagged as elevated risk rather than silently passed as clean.
5. **Two-stage Gemini cascade:** a cheap model (`gemini-3.1-flash-lite`) triages every PR; a stronger model (`gemini-3.5-flash`) re-reviews only when triage flags risk, install/build hooks changed, a binary changed, or no soaked baseline exists.
6. **Post / update one PR comment** + job summary; **fail the check** when risk ≥ `fail-on`.

### Idempotency

The action fingerprints the **net lockfile diff** and stores it in the PR comment. Pushes that don't change the net dependency set reuse the existing analysis instead of re-calling the LLM. Pair with `concurrency: cancel-in-progress` (see the example workflow) so rapid pushes cancel superseded runs.

## Usage

```yaml
# .github/workflows/supply-chain-guard.yml
name: Laocoön Supply Chain Guard
on:
  pull_request:
    paths: ["**/mix.lock"] # add package-lock.json, poetry.lock, … as needed
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: laocoon-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 } # need base + head
      - uses: u2i/laocoon@v1
        with:
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `gemini-api-key` | — (required) | Google Gemini API key. |
| `github-token` | `${{ github.token }}` | Used to read the PR diff and post the comment. |
| `triage-model` | `gemini-3.1-flash-lite` | Cheap model run on every PR. |
| `deep-model` | `gemini-3.5-flash` | Stronger model used only on escalation. |
| `soak-days` | `60` | A release older than this is a presumed-clean baseline. |
| `ecosystems` | _(auto)_ | Restrict to `hex,npm,pypi`. Empty = auto-detect. |
| `lockfile` | _(auto)_ | Restrict to a single lockfile path. |
| `base-ref` | _(PR base)_ | Ref to diff against. |
| `fail-on` | `high` | `critical`/`high`/`medium`/`low`/`none`. |
| `comment` | `true` | Post/update a PR comment. |
| `max-diff-bytes` | `60000` | Byte cap on the artifact diff sent to the LLM per ecosystem. |

## Outputs

| Output | Description |
|---|---|
| `risk-level` | Highest risk (`none`…`critical`, or `skipped`). |
| `findings-json` | Structured findings as JSON. |

## Cost

Cost ≈ diff bytes × per-token price. The triage model runs on every analyzed PR (fractions of a cent); the deep model fires only on the small fraction of PRs that warrant it. The fingerprint-skip means you only pay when the net dependency set actually changes.

## Adding an ecosystem

Drop a module in `src/ecosystems/` exporting `id`, `displayName`, `lockfiles`, `parse(contents, filename)`, `isRegistryBacked`, `packageKey`, `fetchContext`, `getReleases`, `fetchArtifact`, and register it in `src/ecosystems/index.mjs`. Use the shared `baseContext`/`computeCadence` from `registry-context.mjs` so the LLM payload looks identical across registries. The core (diff, soak selection, artifact diff, LLM cascade, GitHub, reporting) is entirely ecosystem-agnostic.

### Known per-ecosystem limitations

- **PyPI**: the JSON API exposes no maintainer accounts or download counts, so those signals are absent (author name is a weak proxy). Wheel-only releases (no sdist) can't be source-diffed and are flagged.
- **npm**: `yarn.lock`/`pnpm-lock.yaml` parsing is tolerant but not a full grammar; exotic entries may be skipped (logged, not silently dropped).
- **requirements.txt**: only fully-pinned (`==`) lines are analyzable; ranges/unpinned lines have no exact version to soak-diff.

## Limitations

- Heuristic, LLM-based review — **not a guarantee**. Treat it as a high-signal reviewer, not a gate of last resort.
- Binary / precompiled / minified files cannot be statically reviewed; they're flagged, not read. Verify their provenance yourself.
- Artifact diffs are byte-capped; dropped files are logged.

## Development

```bash
node --test "test/**/*.test.mjs"
```

The parser, soak selection, artifact diff, and tar unpacker are unit-tested; the Hex artifact fetch/unpack/diff path is verified against live hex.pm.
