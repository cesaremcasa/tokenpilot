## Summary

Describe the user-visible change and why it is needed.

## Privacy and measurement review

- [ ] No prompt, response, reasoning text, code, path, command, argument, credential, raw log, or provider identity is persisted.
- [ ] Provider comparisons remain separate and unavailable counters are not estimated.
- [ ] Cache reads, new input, cache creation, pressure, and complete total remain distinct.
- [ ] New telemetry is documented and correlated to the exact wrapped session.
- [ ] New treatments are versioned, capability-gated, reversible, and fail-open.

## Validation

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `git diff --check`
- [ ] Documentation and changelog updated

Do not attach a personal TokenPilot database, provider output, credentials, or company data.
