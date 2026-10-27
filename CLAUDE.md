# Repository Instructions

## Mandatory Plugin Version Bumps

- Every change to a shipped plugin's code, hooks, helper, bundled guidance, or
  other distributed files MUST increase its semantic version before release.
  Never publish changed plugin contents under an unchanged version.
- Update the plugin's `.claude-plugin/plugin.json` and its corresponding entry
  in the repository's `.claude-plugin/marketplace.json` together in the same
  commit. Their versions MUST match. Keep the plugin's `package.json` version
  aligned when present.
- Use a patch bump for compatible fixes and guidance changes; use the appropriate
  minor or major bump for new features or breaking changes.
- Before committing, verify the versions match and run `claude plugin validate`
  for the changed plugin. Report the validation result accurately.
- Claude Code prioritizes the manifest version over the marketplace version.
  With a pinned version, new Git commits alone do not update installed plugin
  contents. A marketplace refresh, restart, or reload is not a substitute for
  publishing a newer version. Never promise otherwise or recommend deleting
  login credentials or cache files as the normal update procedure.

These rules do not authorize pushing to a default branch, merging, publishing,
or deploying. Follow the user's authorization for those actions separately.
