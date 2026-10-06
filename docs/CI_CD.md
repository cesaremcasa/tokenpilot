# Validation and distribution

| Gate | What it proves |
| --- | --- |
| Linux and macOS CI | Tests, typecheck, build, installer smoke, npm-tarball smoke and clean generated checkout |
| Tarball release smoke | Package checksum/SBOM, clean npm install, execution after source removal and uninstall |
| GitHub merge | Reviewed source and documentation are present on the default branch; verify the PR and final files |
| npm publication | A separate authenticated publishing step; passing release smoke does not prove publication |

The repository currently has CI on pull requests and main pushes. Automatic npm deployment is not configured. Public npm publication was blocked by authentication E401; do not describe CI as completed npm CD. Check the registry version before using public install commands to obtain new policies.

Workflow: [ci.yml](../.github/workflows/ci.yml). Live status: [GitHub Actions](https://github.com/cesaremcasa/tokenpilot/actions). Reproducible checks: `npm test`, `npm run check`, `npm run build`, `npm run test:install`, `npm run test:release`.

Model reductions and skill invocation are separate validations. Passing software tests or CI alone does not establish token savings, successful cloud skill installation or Claude authentication.
