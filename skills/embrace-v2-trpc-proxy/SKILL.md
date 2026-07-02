---
name: embrace-v2-trpc-proxy
description: Call Embrace v2 tRPC procedures through the configured proxy endpoint. Use when an agent needs read or mutation access to DJRDEV Embrace v2 tRPC via EMBRACE_V2_TRPC_PROXY_ENDPOINT and EMBRACE_V2_TRPC_PROXY_TOKEN, while preserving the backend tRPC response under trpc and never exposing credentials.
---

# Embrace v2 tRPC Proxy

Use this skill to call Embrace v2 tRPC procedures through the configured proxy endpoint.

## When To Use

Use this skill when the user asks to:

- query Embrace v2 or DJRDEV data from an agent
- call an Embrace v2 tRPC procedure through the proxy endpoint
- test the Embrace v2 proxy
- inspect project, task, member, or DJRDEV records through tRPC
- validate that Claude Code or another agent can use the proxy

Do not use this skill for direct Cognito auth, direct upstream infrastructure credentials, direct database access, or core-v3 MB3 tRPC calls.

## Required Environment

The caller must provide both variables:

```bash
EMBRACE_V2_TRPC_PROXY_ENDPOINT=<proxy endpoint URL>
EMBRACE_V2_TRPC_PROXY_TOKEN=<embrace-v2-user-id-or-proxy-token>
```

Rules:

- Send the token only as `Authorization: Bearer <token>`.
- Never put tokens in query parameters.
- Never print the token, Authorization header, cookies, upstream credentials, proxy service keys, or credential payloads.
- If either variable is missing, stop and ask the user to provide it through the runtime environment or secret store.

## Request Contract

Send a JSON POST request to `EMBRACE_V2_TRPC_PROXY_ENDPOINT`:

```json
{
  "path": "core.project.query",
  "type": "query",
  "input": {
    "body": {
      "size": 5,
      "query": { "match_all": {} }
    }
  }
}
```

Fields:

| Field | Rule |
| --- | --- |
| `path` | Required full Embrace v2 tRPC procedure path. |
| `type` | Required. Use `query` or `mutation`. |
| `input` | Optional procedure input object. Use `{}` when no input is needed. |

## Safe Curl Pattern

Use this pattern for manual checks. It does not print the token:

```bash
curl -sS "$EMBRACE_V2_TRPC_PROXY_ENDPOINT" \
  -H "Authorization: Bearer $EMBRACE_V2_TRPC_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "path": "core.project.query",
    "type": "query",
    "input": {
      "body": {
        "size": 5,
        "query": { "match_all": {} }
      }
    }
  }'
```

## Safe Python Pattern

Use this pattern when you need structured parsing or assertions:

```python
import json
import os
import urllib.request

endpoint = os.environ.get("EMBRACE_V2_TRPC_PROXY_ENDPOINT")
token = os.environ.get("EMBRACE_V2_TRPC_PROXY_TOKEN")
if not endpoint or not token:
    raise SystemExit("Missing EMBRACE_V2_TRPC_PROXY_ENDPOINT or EMBRACE_V2_TRPC_PROXY_TOKEN")

payload = {
    "path": "core.project.query",
    "type": "query",
    "input": {
        "body": {
            "size": 5,
            "query": {"match_all": {}},
        }
    },
}

request = urllib.request.Request(
    endpoint,
    data=json.dumps(payload).encode(),
    method="POST",
    headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
    },
)

with urllib.request.urlopen(request, timeout=120) as response:
    data = json.loads(response.read().decode())

print(json.dumps({
    "ok": data.get("ok"),
    "statusCode": data.get("statusCode"),
    "hasTrpc": "trpc" in data,
    "path": data.get("meta", {}).get("path"),
}, indent=2))
```

## Response Contract

Successful proxy responses preserve backend output under `trpc`:

```json
{
  "ok": true,
  "trpc": [
    {
      "result": {
        "data": {
          "json": {}
        }
      }
    }
  ],
  "lambda": {
    "statusCode": 200,
    "headers": {}
  },
  "meta": {
    "path": "core.project.query",
    "type": "query",
    "requestId": "proxy-request-id"
  },
  "statusCode": 200
}
```

Important rules:

- Read business data from `trpc`, usually `trpc[0].result.data.json` for batched tRPC responses.
- Do not expect a proxy-owned `data.records` field.
- Do not unwrap, rename, or infer new business-data shapes unless the user explicitly asks for a local summary.
- Keep proxy metadata (`lambda`, `meta`, `statusCode`) separate from backend business data.

## Known Good Smoke Query

Use this query to confirm the proxy can reach DJRDEV project data:

```json
{
  "path": "core.project.query",
  "type": "query",
  "input": {
    "body": {
      "size": 5,
      "query": { "match_all": {} }
    }
  }
}
```

Expected behavior:

- valid proxy user returns `ok: true`
- response includes `trpc`
- project results are nested in the backend tRPC result, not in proxy-owned `data.records`

## Error Handling

| Status | Meaning | Action |
| --- | --- | --- |
| `400` | Invalid request body, path, type, or query-param token. | Fix request shape. |
| `401` | Missing or malformed bearer auth. | Provide `EMBRACE_V2_TRPC_PROXY_TOKEN` in the Authorization header only. |
| `403` | Proxy user did not validate through `core.member.user.get`. | Use a valid Embrace v2 user id/proxy token. |
| `502` | Upstream service or tRPC failure. | Report path, safe error message, and whether `trpc.error` exists. |
| `504` | Timeout. | Retry once, then report timeout with requested path/type only. |

## Security Checklist

Before returning output to the user:

- Redact all Authorization headers and bearer strings.
- Redact cookies, upstream credential-like keys, proxy service keys, and secret-like fields.
- Do not print `EMBRACE_V2_TRPC_PROXY_TOKEN`.
- Do not include full raw responses if they contain sensitive business data; summarize only the requested fields.
- If debugging, report procedure path, status code, `ok`, and safe error message only.

## Claude Code CLI Testing

For Claude Code skill testing, use Z.AI Coding Plan through the Anthropic-compatible endpoint and GLM-4.7 model mapping:

```bash
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic \
ANTHROPIC_AUTH_TOKEN=<zai-coding-plan key> \
API_TIMEOUT_MS=3000000 \
ANTHROPIC_DEFAULT_SONNET_MODEL=glm-4.7 \
ANTHROPIC_DEFAULT_OPUS_MODEL=glm-4.7 \
ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-4.5-air \
claude -p --model sonnet "Use the embrace-v2-trpc-proxy skill to call core.project.query with size 5 and report ok/status/path only."
```

If the Z.AI key is already available in OpenCode auth, read it from `~/.local/share/opencode/auth.json` provider `zai-coding-plan.key` without printing it.

## Source Of Truth

Runtime endpoint ownership lives outside this portable skill. The skill only consumes `EMBRACE_V2_TRPC_PROXY_ENDPOINT` and `EMBRACE_V2_TRPC_PROXY_TOKEN` from the environment.

Do not hardcode deployment domains, proxy implementation details, or environment-specific URLs in this skill. Add those values only through runtime environment variables or the caller's secret store.
