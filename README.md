# MB Skills

Portable Moreton Blue agent skills compatible with the open agent skills ecosystem.

## Install Skills

Install all skills from this repository:

```bash
npx skills add moreton-blue-software/mb-skills
```

Install a specific skill:

```bash
npx skills add moreton-blue-software/mb-skills --skill embrace-v2-trpc-proxy
```

Install to specific agents:

```bash
npx skills add moreton-blue-software/mb-skills --skill embrace-v2-trpc-proxy -a claude-code -a opencode
```

Install globally:

```bash
npx skills add moreton-blue-software/mb-skills --skill embrace-v2-trpc-proxy -g
```

### Claude Code CLI

For Claude Code, target the `claude-code` agent explicitly so the skill is installed under `.claude/skills/`:

```bash
npx skills add moreton-blue-software/mb-skills --skill embrace-v2-trpc-proxy -a claude-code -y --copy
```

With current `skills` CLI versions, the installation preview may mention `.agents/skills`, but the final Claude Code install path should be:

```text
./.claude/skills/embrace-v2-trpc-proxy
```

If Claude Code does not detect the skill, verify that `SKILL.md` exists at that path and restart Claude Code.

## Use Without Installing

Generate a prompt for one skill:

```bash
npx skills use moreton-blue-software/mb-skills --skill embrace-v2-trpc-proxy
```

Start a supported agent with the generated skill prompt:

```bash
npx skills use moreton-blue-software/mb-skills --skill embrace-v2-trpc-proxy --agent claude-code
```

## Source Formats

```bash
# GitHub shorthand
npx skills add moreton-blue-software/mb-skills

# Full GitHub URL
npx skills add https://github.com/moreton-blue-software/mb-skills

# Direct path to a skill
npx skills add https://github.com/moreton-blue-software/mb-skills/tree/master/skills/embrace-v2-trpc-proxy

# Local checkout
npx skills add ./projects/mb-skills
```

## Useful Commands

```bash
# List available skills without installing
npx skills add moreton-blue-software/mb-skills --list

# Install non-interactively
npx skills add moreton-blue-software/mb-skills --skill embrace-v2-trpc-proxy -y

# Install all skills to all detected agents
npx skills add moreton-blue-software/mb-skills --all

# Update installed skills
npx skills update

# List installed skills
npx skills list
```

## Skills

- `embrace-v2-trpc-proxy`: call Embrace v2 tRPC procedures through a configured proxy endpoint using `EMBRACE_V2_TRPC_PROXY_ENDPOINT` and `EMBRACE_V2_TRPC_PROXY_TOKEN`.

## Runtime Configuration

Skills in this repository avoid hardcoded deployment endpoints and credentials. Configure runtime values through environment variables or your agent secret store.
