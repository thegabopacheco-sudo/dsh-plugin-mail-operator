# Cómo funciona dsh-plugin-mail-operator

Operador de correo para DeepSeek Harness: lista y busca correos por IMAP, lee mensajes y envia con confirmacion por SMTP, con lista blanca de destinatarios, read-only y auditoria.

## Arquitectura

```
DSH ──MCP stdio──► server.mjs (bundle single-file)
                    └─ lógica local del plugin
```

## Herramientas reales

- `status`: Estado
- `inbox`: Bandeja de entrada
- `search`: Buscar correos
- `read`: Leer correo
- `send`: Enviar correo

## Seguridad

- Lectura por defecto; acciones con `confirm:true`.
- Modo `read-only` por variable de entorno.
- Listas blancas cuando aplique.
- Auditoría en `<DSH_HOME>\cache\mail-operator\audit.jsonl`.
- Rate limit de acciones.

## Verificación

Tests end-to-end con el cliente MCP oficial (`@modelcontextprotocol/client@2.2.0`)
y artefacto empaquetado (`npm pack` → `postinstall` → servidor desplegado).
