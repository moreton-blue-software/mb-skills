# Embrace Claude Mod

Moreton Blue's Embrace integration, not an Anthropic product.

Sign in to an Embrace instance from Claude Code (PKCE paste-code OAuth), then call
tRPC queries and supported non-delete mutations as yourself. Built for [core-v3#2933](https://github.com/moreton-blue-software/core-v3/issues/2933)
(requires the core-v3 OIDC bearer branch deployed on the target instance).

Two pieces:

- **Helper** — `helper/cli.ts`, a Bun script the plugin spawns as a normal process
  (outside the plugin sandbox). Owns the whole OAuth flow, token custody and
  authenticated tRPC calls. Also usable standalone in a terminal.
- **Plugin** — `.claude-plugin/`, `hooks/`, `types/`. Adds `/embrace-connect`
  (instance picker → authorize URL → paste the one-time code; switching between
  already-connected instances needs no new login) and a signed-in status line.
  `/embrace-login` remains as an alias. tRPC queries run through the helper's
  `call` command.

Scope: **login + queries + permission-filtered non-delete mutations** on compatible Core
instances. See [the mutation follow-up](https://github.com/moreton-blue-software/mb-agents/issues/269).
The current public release remains 0.1.0/read-only until this candidate is released;
this branch does not publish or bump that version. The helper keeps `call` GET-only
and POSTs explicit `mutate` commands directly to the discovered tRPC procedure.
There is no additional Mod approval gate. Hard/soft deletes, file deletion and mixed
business-record deletion are unsupported; schema-unsupported mutations stay hidden server-side.
The server rejects mutation procedures requested over GET. Delete exclusion is a
helper-side restriction, not an extra server authorization layer or non-delete
OAuth token scope; actual procedure permissions still apply.

## Requirements

- [Bun](https://bun.sh) on `PATH` (the plugin runs the helper with it).
- An Embrace origin with the `claude-embrace-cli` public OAuth client registered
  (core-v3 settings-doc or `OIDC_CLIENTS`), e.g. `https://mbdev.app.embracegrowth.ai`
  or a review environment. For a local dev server use `http://localhost:5173`.

## Install

Marketplace (from this repository):

```
/plugin install embrace-claude-mod --marketplace moreton-blue-software/mb-skills
```

Confirm adding the marketplace when prompted, then choose an installation scope.
The public repository requires no membership in the Moreton Blue GitHub organization.

Or from a checkout:

```
claude --plugin-dir /path/to/mb-skills/plugins/embrace-claude-mod
```

## Usage

```
/embrace-connect                     # pick a connected instance to switch to, or add one
/embrace-connect https://<origin>    # sign in to a new instance, paste the code
/embrace-login                       # legacy alias of /embrace-connect
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
The pane closes after a successful code submission. Use **Close**, its focused
`x` shortcut, or Escape to dismiss it without signing out. In Claude Code's inline
terminal renderer, mouse clicks on the frame's × may not be delivered; focus the
pane with Ctrl+X then Tab, then press `x`, or use Ctrl+X then X. The native × was
pointer-verified in the fullscreen renderer (`CLAUDE_CODE_NO_FLICKER=1`).

## Agent instructions for CRM, Projects, and other records

The plugin adds a short instruction section to Claude's session prompt pointing
to the installed [query guide](QUERYING.md), [write guide](MUTATING.md) and helper. Claude must read the query guide
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

## Supported writes

Read [MUTATING.md](MUTATING.md) before a requested record change. A compatible
Core deployment must expose `v3.discovery.listMutations` and `describeMutation`;
older instances retain queries but cannot use this write lane. Core supplies the
discovered operation metadata, auto-enumerated on newer versions and filtered to the
user's RBAC write permissions and faithful input schemas; the helper uses it for
client eligibility, while the
actual mutation endpoint independently preserves normal user RBAC.

```text
bun helper/cli.ts discover --type mutation --origin <url> --search company --limit 20
bun helper/cli.ts describe --type mutation --origin <url> <returned-name>
bun helper/cli.ts mutate --origin <url> <described-name> '<input-json>'
```

The helper fetches a fresh contract, requires supported schemas and known
deployment provenance, then POSTs the actual input directly to
`/trpc/<described-name>` using the existing SuperJSON envelope. It returns the
actual procedure result, without an execution proxy, request IDs, stored receipts
or replay state.
There is no automatic write retry or server-side duplicate-submission protection;
submitting the same write twice can execute it twice. After an uncertain response,
check the existing record before another attempt. Query discovery defaults and
`call` remain unchanged.

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

## Stable login identity

The official plugin ID is `embrace-claude-mod`; `/embrace-connect` is the current
command and `/embrace-login` remains as an alias. The OAuth client ID remains
`claude-embrace-cli` and the private local state directory remains `embrace-cli`
so the rename does not invalidate existing logins. Multiple instances stay
connected simultaneously; `/embrace-connect` switches the active one.
The initial public release supports login and read-only queries. This candidate
adds permission-filtered non-delete writes without changing the stable login identity.
