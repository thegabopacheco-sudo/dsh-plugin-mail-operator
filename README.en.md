# dsh-plugin-mail-operator — Mail Operator

Operador de correo para DeepSeek Harness: lista y busca correos por IMAP, lee mensajes y envia con confirmacion por SMTP, con lista blanca de destinatarios, read-only y auditoria.

## Tools

| Tool | Qué hace |
|---|---|
| `status` | Estado |
| `inbox` | Bandeja de entrada |
| `search` | Buscar correos |
| `read` | Leer correo |
| `send` | Enviar correo |

## Instalación

Desde **DSH → Settings → Plugins** instala `github:thegabopacheco-sudo/dsh-plugin-mail-operator` y permite el script de instalación.

```
dsh plugin --profile <perfil> add github:thegabopacheco-sudo/dsh-plugin-mail-operator
```

## Seguridad

- Lectura por defecto; escritura solo con `confirm:true` y pedido explícito.
- `DSH_MAIL_OPERATOR_MODE=read-only` desactiva acciones.
- Listas blancas y auditoría en `<DSH_HOME>\cache\mail-operator\audit.jsonl`.

## Licencia

MIT © thegabopacheco-sudo
