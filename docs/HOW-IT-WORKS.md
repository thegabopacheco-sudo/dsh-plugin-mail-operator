# How dsh-plugin-mail-operator works

Operador de correo para DeepSeek Harness: lista y busca correos por IMAP, lee mensajes y envia con confirmacion por SMTP, con lista blanca de destinatarios, read-only y auditoria.

## Architecture

```
DSH ──MCP stdio──► server.mjs (single-file bundle)
                    └─ local plugin logic
```

## Safety

- Read by default; actions require `confirm:true`.
- `read-only` mode via environment variable.
- Allowlists where applicable.
- Audit at `<DSH_HOME>\cache\mail-operator\audit.jsonl`.
- Action rate limit.

## Validation

End-to-end tests with the official MCP client (`@modelcontextprotocol/client@2.2.0`)
and the packaged artifact (`npm pack` → `postinstall` → deployed server).
