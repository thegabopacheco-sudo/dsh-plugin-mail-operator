#!/usr/bin/env python3
"""Helper IMAP/SMTP para dsh-plugin-mail-operator.
Recibe un JSON por stdin: {"cmd": "list|search|read|send|status", ...}
Devuelve un JSON por stdout. Nunca imprime credenciales.
"""
import base64
import email
import email.header
import imaplib
import json
import re
import smtplib
import ssl
import sys
from email.message import EmailMessage


def decode_header(value):
    if not value:
        return ""
    parts = []
    for chunk, encoding in email.header.decode_header(value):
        if isinstance(chunk, bytes):
            parts.append(chunk.decode(encoding or "utf-8", errors="replace"))
        else:
            parts.append(chunk)
    return "".join(parts)


def body_of(message, limit=20000):
    if message.is_multipart():
        for part in message.walk():
            if part.get_content_type() == "text/plain" and "attachment" not in str(part.get("Content-Disposition", "")):
                try:
                    return part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="replace")[:limit]
                except Exception:
                    continue
        for part in message.walk():
            if part.get_content_type() == "text/html":
                try:
                    html = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="replace")
                    text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", html, flags=re.I)
                    text = re.sub(r"<[^>]+>", " ", text)
                    return re.sub(r"\s+", " ", text).strip()[:limit]
                except Exception:
                    continue
        return ""
    try:
        payload = message.get_payload(decode=True)
        if payload is None:
            return str(message.get_payload())[:limit]
        return payload.decode(message.get_content_charset() or "utf-8", errors="replace")[:limit]
    except Exception:
        return ""


def imap_connect(config):
    imap = config.get("imap") or {}
    host = imap.get("host") or ""
    if not host:
        raise RuntimeError("falta imap.host en la config")
    port = int(imap.get("port") or (993 if imap.get("secure", True) else 143))
    if imap.get("secure", True):
        client = imaplib.IMAP4_SSL(host, port, timeout=20)
    else:
        client = imaplib.IMAP4(host, port, timeout=20)
    client.login(imap.get("user") or "", imap.get("password") or "")
    return client


def parse_fetch(data):
    """Devuelve lista de dicts {uid, raw_headers} desde respuestas FETCH de imaplib."""
    results = []
    for item in data or []:
        if not isinstance(item, tuple) or len(item) < 2:
            continue
        meta = item[0] if isinstance(item[0], bytes) else b""
        raw = item[1] if isinstance(item[1], bytes) else b""
        uid_match = re.search(rb"UID (\d+)", meta)
        uid = int(uid_match.group(1)) if uid_match else None
        message = email.message_from_bytes(raw)
        results.append({
            "uid": uid,
            "from": decode_header(message.get("From")),
            "subject": decode_header(message.get("Subject")),
            "date": decode_header(message.get("Date")),
        })
    results.sort(key=lambda row: row["uid"] or 0, reverse=True)
    return results


def cmd_list(payload):
    config = payload.get("config") or {}
    limit = int(payload.get("limit") or 10)
    criteria = payload.get("criteria") or "ALL"
    client = imap_connect(config)
    try:
        client.select("INBOX", readonly=True)
        status, data = client.uid("search", None, criteria)
        uids = [int(x) for x in (data[0] or b"").split() if x.isdigit()]
        if not uids:
            return {"ok": True, "messages": [], "total": 0}
        selected = uids[-limit:]
        status, fetched = client.uid("fetch", ",".join(str(u) for u in selected), "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
        return {"ok": True, "messages": parse_fetch(fetched), "total": len(uids), "criteria": criteria}
    finally:
        try:
            client.logout()
        except Exception:
            pass


def cmd_read(payload):
    config = payload.get("config") or {}
    uid = str(payload.get("uid") or "")
    if not uid.isdigit():
        raise RuntimeError("uid inválido")
    client = imap_connect(config)
    try:
        client.select("INBOX", readonly=True)
        status, data = client.uid("fetch", uid, "(RFC822)")
        raw = next((item[1] for item in data or [] if isinstance(item, tuple) and len(item) > 1), None)
        if not raw:
            raise RuntimeError(f"no se encontró el correo uid {uid}")
        message = email.message_from_bytes(raw)
        return {
            "ok": True,
            "uid": int(uid),
            "from": decode_header(message.get("From")),
            "to": decode_header(message.get("To")),
            "subject": decode_header(message.get("Subject")),
            "date": decode_header(message.get("Date")),
            "body": body_of(message),
        }
    finally:
        try:
            client.logout()
        except Exception:
            pass


def cmd_send(payload):
    config = payload.get("config") or {}
    smtp = config.get("smtp") or {}
    message = payload.get("message") or {}
    host = smtp.get("host") or ""
    if not host:
        raise RuntimeError("falta smtp.host en la config")
    to = (message.get("to") or "").strip()
    subject = (message.get("subject") or "").strip()
    body = message.get("body") or ""
    if not to or not subject or not body:
        raise RuntimeError("to, subject y body son obligatorios")
    port = int(smtp.get("port") or (465 if smtp.get("secure", True) else 587))
    sender = smtp.get("from") or smtp.get("user") or ""
    mail = EmailMessage()
    mail["From"] = sender
    mail["To"] = to
    mail["Subject"] = subject
    mail.set_content(body)
    context = ssl.create_default_context()
    if smtp.get("secure", True):
        client = smtplib.SMTP_SSL(host, port, timeout=20, context=context)
    else:
        client = smtplib.SMTP(host, port, timeout=20)
        if smtp.get("starttls"):
            client.starttls(context=context)
    try:
        if smtp.get("user"):
            client.login(smtp.get("user"), smtp.get("password") or "")
        refused = client.send_message(mail)
        return {"ok": True, "to": to, "subject": subject, "refused": list(refused.keys())}
    finally:
        try:
            client.quit()
        except Exception:
            pass


def cmd_status(payload):
    config = payload.get("config") or {}
    imap = config.get("imap") or {}
    smtp = config.get("smtp") or {}
    return {
        "ok": True,
        "imap": {"host": imap.get("host") or "", "port": imap.get("port"), "secure": bool(imap.get("secure", True)), "user": imap.get("user") or ""},
        "smtp": {"host": smtp.get("host") or "", "port": smtp.get("port"), "secure": bool(smtp.get("secure", True)), "user": smtp.get("user") or ""},
    }


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        cmd = payload.get("cmd") or ""
        handlers = {"list": cmd_list, "search": cmd_list, "read": cmd_read, "send": cmd_send, "status": cmd_status}
        if cmd not in handlers:
            raise RuntimeError(f"comando desconocido: {cmd}")
        result = handlers[cmd](payload)
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        sys.stdout.write(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(0)


if __name__ == "__main__":
    main()
