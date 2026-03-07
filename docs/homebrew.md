# Homebrew

## Install (users)
Use this repository as a tap:

```bash
brew tap ryanreh99/skills-sync
brew install ryanreh99/skills-sync/skills-sync
```

## Publish/Update (maintainers)
This formula installs a release tarball produced by `npm pack`, with bundled runtime dependencies.

1. Bump `package.json` version.
2. Run release checks:
   ```bash
   npm ci
   npm run prepublishOnly
   ```
3. Create the tarball:
   ```bash
   npm pack
   ```
   Example output: `skills-sync-1.0.0.tgz`
4. Regenerate the formula with the release URL and local tarball hash:
   ```bash
   npm run brew:formula -- \
     --url https://github.com/ryanreh99/skills-sync/releases/download/v1.0.0/skills-sync-1.0.0.tgz \
     --tarball ./skills-sync-1.0.0.tgz
   ```
5. Commit `Formula/skills-sync.rb` (and any version/changelog updates) to the repository.
6. Create/publish GitHub release tag `v<version>`.
7. Upload the same `skills-sync-<version>.tgz` file from step 3 to that release.
8. Optionally publish to npm:
   ```bash
   npm publish
   ```

If you already published to npm and want to generate directly from the npm tarball:

```bash
npm run brew:formula
```

The default URL for `npm run brew:formula` is:
`https://registry.npmjs.org/<name>/-/<name>-<version>.tgz`
