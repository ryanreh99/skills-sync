# Security Policy

## Credential Handling

- Never commit tokens, secrets, credentials, or private endpoints to this repository.
- Keep real profile packs and machine-specific overrides in `workspace/` only.
- Keep upstream clone cache data in `upstreams_cache/` only.
- Store authentication material in environment variables consumed by MCP server commands.

## Repository Safety Expectations

- `examples/` must remain secret-free.
- `manifests/` and `schemas/` must remain secret-free.
- `dist/`, `workspace/`, and `upstreams_cache/` are generated/local and ignored by git.

## Prohibited Content

Do not commit any of the following:

- API keys or bearer tokens
- OAuth client secrets
- username/password credentials
- personal/private internal endpoints
- `.env` files containing sensitive data

## Reporting

If a secret is committed accidentally:

1. Revoke or rotate the secret immediately.
2. Remove it from repository history.
3. Re-run `doctor` and verify all examples/manifests remain clean.
