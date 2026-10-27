# Repository Instructions

## Mandatory Plugin Commit Tracking

- Plugins distributed through this Git-hosted marketplace MUST use commit
  tracking. Omit `version` from BOTH the plugin's `.claude-plugin/plugin.json`
  and its entry in the repository's `.claude-plugin/marketplace.json`.
- Never add a pinned version or a literal `"latest"` version to either file
  without explicit user approval to change the distribution policy. Either
  version field overrides commit tracking and can leave users on stale code.
- Claude Code derives the plugin version from the source Git commit SHA when
  both loader version fields are absent. New commits on the tracked marketplace
  branch can therefore become plugin updates; validate distributed changes
  before pushing them. A private `package.json` version does not control this
  loader behavior and does not need a bump for each plugin change.
- Before committing plugin changes, verify both loader version fields are absent
  and run `claude plugin validate` for the changed plugin. Report validation
  results accurately.
- The supported user update sequence is `claude plugin marketplace update
  mb-skills`, then `claude plugin update embrace-claude-mod@mb-skills`, followed
  by a restart or supported `/reload-plugins`. A fresh conversation avoids old
  conversational instructions. These commands pick up the tracked branch, not
  an unmerged feature branch.
- In `plugin@marketplace`, the suffix names the marketplace, not a version;
  `@latest` is not a latest-version selector. Never recommend deleting login
  credentials or cache files as the normal update procedure.

These rules do not authorize pushing to a default branch, merging, publishing,
or deploying. Follow the user's authorization for those actions separately.
