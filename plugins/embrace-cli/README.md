# embrace-cli — Claude Code plugin

Sign in to an Embrace instance from Claude Code (PKCE paste-code OAuth), then call
tRPC query procedures as yourself. Built for [core-v3#2933](https://github.com/moreton-blue-software/core-v3/issues/2933)
(requires the core-v3 OIDC bearer branch deployed on the target instance).

Two pieces:

- **Helper** — `helper/cli.ts`, a Bun script the plugin spawns as a normal process
  (outside the plugin sandbox). Owns the whole OAuth flow, token custody and
  authenticated tRPC calls. Also usable standalone in a terminal.
- **Plugin** — `.claude-plugin/`, `hooks/`, `types/`. Adds `/embrace-login`
  (origin picker → authorize URL → paste the one-time code) and a signed-in
  status line. tRPC queries run through the helper's `call` command.

Scope: **login + query procedures only**. Mutations (e.g. agent thread
approve/reject) are deferred to [the separate follow-up](https://github.com/moreton-blue-software/mb-agents/issues/269); the helper sends only GET requests for tRPC calls and never falls back to POST.
The server rejects mutation procedures requested over GET. This is a client
restriction, not a read-only OAuth scope on the access token.

## Requirements

- [Bun](https://bun.sh) on `PATH` (the plugin runs the helper with it).
- An Embrace origin with the `claude-embrace-cli` public OAuth client registered
  (core-v3 settings-doc or `OIDC_CLIENTS`), e.g. `https://mbdev.app.embracegrowth.ai`
  or a review environment. For a local dev server use `http://localhost:5173`.

## Install

Marketplace (from this repository):

```
/plugin install embrace-cli --marketplace moreton-blue-software/mb-skills
```

Confirm adding the marketplace when prompted, then choose an installation scope.
The public repository requires no membership in the Moreton Blue GitHub organization.

Or from a checkout:

```
claude --plugin-dir /path/to/mb-skills/plugins/embrace-cli
```

## Usage

```
/embrace-login                       # pick an origin, sign in, paste the code
```

Then, as the signed-in user:

```
bun helper/cli.ts call --origin https://mbdev.app.embracegrowth.ai v3.common.topBar.getCurrentUser
bun helper/cli.ts call --origin <url> v3.agent.listThreads
bun helper/cli.ts call --origin <url> v3.agent.getThread '{"threadId":"..."}'
bun helper/cli.ts status [--json]    # signed-in origins
bun helper/cli.ts logout --origin <url>
```

The login flow: the helper prints an authorize URL (PKCE S256, no client
secret — public client); you open it in any browser, sign in, and the finish
page shows a one-time code you paste back. The helper exchanges it and stores
tokens in a 0600 file under `${XDG_STATE_HOME:-~/.local/state}/embrace-cli/`.

## Agent instructions for CRM, Projects, and other records

The plugin adds a short instruction section to Claude's session prompt pointing
to the installed [query guide](QUERYING.md) and helper. Claude must read the guide
before a business query: choose the intended signed-in instance, obtain a verified
query/input contract, use bounded filters and pagination, and interpret denial,
validation errors, and partial results honestly. It must never read stored tokens
or switch identities to work around RBAC.

This is instruction-guided helper use, not a model-callable query tool. Claude
invokes the helper through its normal command tool, subject to that session's
permissions. No business query name, filter shape, or record ID should be guessed.

### New and future procedures

The helper already accepts any valid `v3.*` name and uses the same GET-only
transport; new query procedures do not require adding a plugin allowlist.
On Core versions supporting discovery, use:

```text
bun helper/cli.ts discover --origin <url> --search crm.company --limit 20
bun helper/cli.ts describe --origin <url> <returned-query-name>
bun helper/cli.ts call --origin <url> <verified-query-name> '<input-json>'
```

These commands use authenticated `v3.discovery.listQueries` and
`v3.discovery.describeQuery` queries. Responses include deployment provenance;
inspect supported input/output structural contracts before execution. Discovery
is permission-filtered and excludes mutations and input-dependent/public/service
APIs. Unsupported schema statuses are explicit, never empty permissive fallbacks.
The helper stores no persistent schema cache and does not fetch all metadata
implicitly. See [the query guide](QUERYING.md) for pagination and version handling.

New authorized query names and parser contracts come from the instance's deployed
router, without another plugin release. Older Core versions may not implement
discovery: report that requirement and request a matching operator-supplied
contract instead of guessing. Customers need no private GitHub access.

## Security notes

- Token custody stays in the helper and its 0600 state file; the plugin module
  never sees a token, and helper output is sanitized before printing anywhere.
- The OAuth client is public (PKCE, `token_endpoint_auth_method: none`); no
  client secret exists to leak. One-time codes are single-use and short-lived.
- Helper errors expose only OAuth error enums and an allowlist of fixed diagnostic descriptions.
- Bun and a Claude Code build supporting hooks modules (`$.command`, `$.ui`,
  `$.process`, and `$.plugin.root`) are required. This plugin is not an ordinary
  SKILL.md; `npx skills add` does not install its UI/runtime.

## Development

```
bun test                 # helper unit tests (PKCE, store, transport, flow)
claude plugin validate .
bunx tsc -p . --noEmit   # after loading the plugin once to generate engine types
```
