// Test end-to-end de mail-operator: mock IMAP + SMTP locales y Python bundled.
import path from 'node:path';
import net from 'node:net';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const packageDir = path.resolve(import.meta.dirname, '..');
const tmpDir = path.join(packageDir, 'test', 'tmp');
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(path.join(tmpDir, 'dsh-home', 'mail-operator'), { recursive: true });

const EMAILS = [
  { uid: 1, from: 'Cliente Uno <cliente1@example.com>', subject: 'Presupuesto para bot', date: 'Mon, 10 Nov 2026 10:00:00 -0600', body: 'Hola, quiero un bot de tickets. ¿Cuánto sale?' },
  { uid: 2, from: 'Proveedor <proveedor@example.com>', subject: 'Factura 123', date: 'Tue, 11 Nov 2026 09:00:00 -0600', body: 'Adjunto la factura del mes.' },
];

function imapResponse(tag, extra) { return `${extra}${tag} OK done\r\n`; }
function literal(text) { const buf = Buffer.from(text, 'utf8'); return `{${buf.length}}\r\n${text}`; }

const imapServer = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.write('* OK mock IMAP ready\r\n');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const tag = line.split(' ')[0];
      const upper = line.toUpperCase();
      if (upper.includes(' CAPABILITY')) socket.write(imapResponse(tag, '* CAPABILITY IMAP4rev1\r\n'));
      else if (upper.includes(' LOGIN')) socket.write(imapResponse(tag, ''));
      else if (upper.includes(' SELECT')) socket.write(`* 2 EXISTS\r\n* OK [UIDVALIDITY 1]\r\n${tag} OK [READ-ONLY] SELECT done\r\n`);
      else if (upper.includes(' UID SEARCH')) socket.write(`* SEARCH 1 2\r\n${tag} OK SEARCH done\r\n`);
      else if (upper.includes(' UID FETCH')) {
        const isFull = upper.includes('RFC822');
        let out = '';
        for (const email of EMAILS) {
          if (isFull) {
            const raw = `From: ${email.from}\r\nTo: me@example.com\r\nSubject: ${email.subject}\r\nDate: ${email.date}\r\n\r\n${email.body}`;
            out += `* 1 FETCH (UID ${email.uid} RFC822 ${literal(raw)})\r\n`;
          } else {
            const raw = `From: ${email.from}\r\nSubject: ${email.subject}\r\nDate: ${email.date}\r\n\r\n`;
            out += `* 1 FETCH (UID ${email.uid} BODY[HEADER.FIELDS (FROM SUBJECT DATE)] ${literal(raw)})\r\n`;
          }
        }
        socket.write(out + `${tag} OK FETCH done\r\n`);
      } else if (upper.includes(' LOGOUT')) { socket.write(`* BYE\r\n${tag} OK LOGOUT done\r\n`); socket.end(); }
      else socket.write(imapResponse(tag, ''));
    }
  });
});
await new Promise((resolve) => imapServer.listen(0, '127.0.0.1', resolve));
const imapPort = imapServer.address().port;

let smtpSession = { auth: 0, data: '', message: '' };
const smtpServer = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.write('220 mock SMTP ready\r\n');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const upper = line.toUpperCase();
      if (smtpSession.auth === 1) { smtpSession.auth = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); continue; }
      if (smtpSession.auth === 2) { smtpSession.auth = 3; socket.write('235 2.7.0 Authentication successful\r\n'); continue; }
      if (upper.startsWith('EHLO')) { smtpSession = { auth: 0, data: '', message: '' }; socket.write('250-mock\r\n250 AUTH LOGIN\r\n'); }
      else if (upper.startsWith('AUTH LOGIN')) { smtpSession.auth = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
      else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO') || upper.startsWith('RSET')) socket.write('250 OK\r\n');
      else if (upper.startsWith('DATA')) { smtpSession.data = ''; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
      else if (line === '.') { smtpSession.message = smtpSession.data; socket.write('250 OK queued\r\n'); }
      else if (upper.startsWith('QUIT')) { socket.write('221 Bye\r\n'); socket.end(); }
      else if (smtpSession.data !== undefined) { smtpSession.data += line + '\r\n'; }
      else socket.write('250 OK\r\n');
    }
  });
});
await new Promise((resolve) => smtpServer.listen(0, '127.0.0.1', resolve));
const smtpPort = smtpServer.address().port;

const configFile = path.join(tmpDir, 'dsh-home', 'mail-operator', 'config.json');
writeFileSync(configFile, JSON.stringify({
  imap: { host: '127.0.0.1', port: imapPort, secure: false, user: 'me@example.com', password: 'secret-imap' },
  smtp: { host: '127.0.0.1', port: smtpPort, secure: false, user: 'me@example.com', password: 'secret-smtp', from: 'me@example.com' },
  allowedRecipients: ['example.com'],
}, null, 2), 'utf8');

function makeClient(extraEnv = {}) {
  const entry = process.env.MAIL_SERVER ? path.resolve(process.env.MAIL_SERVER) : path.join(packageDir, 'server.mjs');
  const bundledPython = 'C:\\Users\\desco\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME || process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP, DSH_HOME: path.join(tmpDir, 'dsh-home'), DSH_PYTHON: process.env.DSH_PYTHON || bundledPython, ...extraEnv }, stderr: 'pipe' });
  transport.stderr?.on('data', (c) => process.stderr.write(`[server] ${c}`));
  const client = new Client({ name: 'mail-test', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  return client.connect(transport).then(() => ({ client, transport }));
}
const textOf = (r) => (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

const { client, transport } = await makeClient();
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
console.log('--- status ---'); console.log(textOf(await client.callTool({ name: 'status', arguments: {} })).slice(0, 500));
const inbox = await client.callTool({ name: 'inbox', arguments: { limit: 5 } });
console.log('--- inbox ---'); console.log(textOf(inbox));
console.log('inbox tiene factura:', textOf(inbox).includes('Factura'));
const search = await client.callTool({ name: 'search', arguments: { query: 'presupuesto' } });
console.log('--- search ---'); console.log(textOf(search));
const read = await client.callTool({ name: 'read', arguments: { uid: 1 } });
console.log('--- read ---'); console.log(textOf(read).slice(0, 400));
console.log('read trae cuerpo:', textOf(read).includes('bot de tickets'));
const noConfirm = await client.callTool({ name: 'send', arguments: { to: 'cliente1@example.com', subject: 'Hola', body: 'Mensaje' } });
console.log('send sin confirm isError:', noConfirm.isError === true);
const denied = await client.callTool({ name: 'send', arguments: { to: 'otro@dominio-peligroso.com', subject: 'Hola', body: 'Mensaje', confirm: true } });
console.log('destinatario no permitido isError:', denied.isError === true);
const sent = await client.callTool({ name: 'send', arguments: { to: 'cliente1@example.com', subject: 'Respuesta WENDIGO', body: 'Hola, te paso el presupuesto.', confirm: true } });
console.log('--- send ---'); console.log(textOf(sent));
console.log('smtp capturó asunto:', smtpSession.message.includes('Respuesta WENDIGO'));
await client.close(); try { await transport.close?.(); } catch {}
const { client: roClient, transport: roTransport } = await makeClient({ DSH_MAIL_MODE: 'read-only' });
const roSend = await roClient.callTool({ name: 'send', arguments: { to: 'cliente1@example.com', subject: 'x', body: 'y', confirm: true } });
console.log('read-only send isError:', roSend.isError === true);
await roClient.close(); try { await roTransport.close?.(); } catch {}
imapServer.close(); smtpServer.close();
console.log('OK');
