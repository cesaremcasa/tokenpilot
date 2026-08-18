# Contributing to TokenPilot

TokenPilot is developed by Mycellium Lab and welcomes focused, privacy-preserving contributions.

## Before opening a change

1. Read [Security](SECURITY.md), [Architecture](docs/ARCHITECTURE.md), and [Measurement methodology](docs/MEASUREMENT.md).
2. Search existing issues and pull requests.
3. Open an issue before implementing a new provider adapter, telemetry source, persistent field, or optimization policy. These changes require an explicit privacy and evidence review.

Never attach real prompts, responses, source code, credentials, provider histories, raw provider logs, or a personal TokenPilot database to an issue or pull request.

## Local development

```sh
git clone https://github.com/cesaremcasa/tokenpilot.git
cd tokenpilot
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run test:install
```

Node.js 22.5 or newer is required. Tests must use synthetic, content-free fixtures.

## Pull requests

A pull request should:

- explain the problem and user impact;
- keep provider-specific behavior behind a version/help capability probe;
- preserve arguments, TTY behavior, signals, output streams, and fail-open behavior;
- add tests for success, unsupported versions, missing counters, and privacy rejection;
- update the relevant documentation and changelog; and
- leave `npm run check`, `npm test`, `npm run build`, and `git diff --check` green.

Do not mix providers in one token comparison. Do not estimate unavailable counters. Do not label a cache shift as a reduction.

## Adapter evidence requirements

A new measurement source must be documented by the provider and correlated to the exact wrapped session. Ambient histories, timestamps, transcript directories, JSONL files, terminal scraping, and provider logs are not acceptable correlation mechanisms.

A new treatment must:

- use session-scoped, locally advertised controls;
- have a versioned policy identifier;
- fail open when its complete probe fails;
- retain an immediate bypass; and
- be evaluated against a matching baseline before a reduction claim is documented.

## Commit and review hygiene

Keep commits small and intentional. Generated artifacts, databases, personal reports, and provider output do not belong in Git. Security-sensitive findings should follow [SECURITY.md](SECURITY.md), not a public issue.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
