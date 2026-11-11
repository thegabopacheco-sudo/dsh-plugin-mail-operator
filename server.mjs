#!/usr/bin/env node
// dsh-plugin-mail-operator — correo IMAP/SMTP para DeepSeek Harness.
// Tools: status, inbox, search, read, send.

import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const VERSION = '0.1.0';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DSH_HOME = (() => {
  const v = process.env.DSH_HOME && process.env.DSH_HOME.trim();
  return v || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');
})();
const CONFIG_FILE = path.join(DSH_HOME, 'mail-operator', 'config.json');
const CACHE_DIR = path.join(DSH_HOME, 'cache', 'mail-operator');
const AUDIT_FILE = path.join(CACHE_DIR, 'audit.jsonl');
const HELPER = path.join(HERE, 'scripts', 'mail_helper.py');
const READ_ONLY = String(process.env.DSH_MAIL_MODE || '').toLowerCase() === 'read-only';
const SEND_LIMIT = 6;
const SEND_WINDOW_MS = 60_000;
const log = (m) => process.stderr.write(`[mail] ${m}\n`);

function audit(entry) {
  try { mkdirSync(CACHE_DIR, { recursive: true }); appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch { /* best effort */ }
}
function loadConfig() {
  const defaults = { imap: { host: '', port: 993, secure: true, user: '', password: '' }, smtp: { host: '', port: 465, secure: true, user: '', password: '', from: '' }, allowedRecipients: [], maxMessages: 10, pythonPath: '' };
  try {
    if (existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {};
      return { ...defaults, ...parsed, imap: { ...defaults.imap, ...(parsed.imap || {}) }, smtp: { ...defaults.smtp, ...(parsed.smtp || {}) } };
    }
  } catch (error) { log(`config: ${error.message}`); }
  return defaults;
}
function saveConfig(config) { mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8'); }

function findPython(config) {
  const candidates = [];
  if (process.env.DSH_PYTHON) candidates.push(process.env.DSH_PYTHON);
  if (config.pythonPath) candidates.push(config.pythonPath);
  try {
    for (const entry of readdirSync(path.join(DSH_HOME, 'dsh-runtimes'), { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(DSH_HOME, 'dsh-runtimes', entry.name, 'dependencies', 'python', 'python.exe'));
    }
  } catch { /* sin runtimes */ }
  candidates.push('python');
  return candidates.find((candidate) => candidate === 'python' || existsSync(candidate)) || 'python';
}

function runHelper(config, payload) {
  return new Promise((resolve, reject) => {
    const python = findPython(config);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(python, [HELPER], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch { /* ignora */ } reject(new Error('el helper de correo agotó el tiempo')); } }, 40_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`no se pudo ejecutar python (${python}): ${error.message}`)); } });
    child.on('close', () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      let parsed;
      try { parsed = JSON.parse(stdout.trim()); } catch { reject(new Error(`respuesta inválida del helper: ${stdout.slice(0, 300)} ${stderr.slice(0, 200)}`)); return; }
      if (!parsed.ok) reject(new Error(parsed.error || 'el helper falló'));
      else resolve(parsed);
    });
    child.stdin.end(JSON.stringify({ config: configForHelper(config), cmd: payload.cmd, ...payload }));
  });
}

function configForHelper(config) {
  const imapPassword = process.env.DSH_MAIL_IMAP_PASSWORD && process.env.DSH_MAIL_IMAP_PASSWORD.trim() ? process.env.DSH_MAIL_IMAP_PASSWORD.trim() : (config.imap.password || '');
  const smtpPassword = process.env.DSH_MAIL_SMTP_PASSWORD && process.env.DSH_MAIL_SMTP_PASSWORD.trim() ? process.env.DSH_MAIL_SMTP_PASSWORD.trim() : (config.smtp.password || '');
  return {
    imap: { host: config.imap.host, port: config.imap.port, secure: config.imap.secure, user: config.imap.user, password: imapPassword },
    smtp: { host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, starttls: config.smtp.starttls, user: config.smtp.user, password: smtpPassword, from: config.smtp.from || config.smtp.user },
  };
}

const sendTimestamps = [];
function checkSendRate() {
  const now = Date.now();
  while (sendTimestamps.length && now - sendTimestamps[0] > SEND_WINDOW_MS) sendTimestamps.shift();
  if (sendTimestamps.length >= SEND_LIMIT) throw new Error(`límite de envíos (${SEND_LIMIT}/minuto)`);
  sendTimestamps.push(now);
}

function ensureRecipientAllowed(config, to) {
  const list = (config.allowedRecipients || []).map((v) => String(v).toLowerCase().trim());
  if (list.length === 0) return;
  const target = String(to).toLowerCase();
  const allowed = list.some((entry) => target === entry || target.endsWith(`@${entry}`) || target.endsWith(entry));
  if (!allowed) throw new Error(`destinatario no permitido: ${to}. Lista blanca: ${list.join(', ')}`);
}

function textResult(t) { return { content: [{ type: 'text', text: t }] }; }
function line(m) { return `${m.uid}. ${m.date || ''} · ${m.from || '(sin remitente)'} · ${m.subject || '(sin asunto)'}`; }

function buildInstructions() {
  return [
    'Mail Operator: correo IMAP/SMTP para WENDIGO.',
    '',
    `Config: ${CONFIG_FILE}`,
    '',
    'Herramientas: status, inbox, search, read, send.',
    '',
    'Reglas:',
    '- inbox/search/read son solo lectura; send requiere confirm:true y pedido explícito del usuario.',
    '- No inventes correos ni remitentes: usa los uid que devuelve inbox/search.',
    '- Nunca muestres contraseñas ni tokens; la config local las guarda.',
    '- Si hay lista blanca de destinatarios, respétala.',
  ].join('\n');
}

function buildServer() {
  const server = new McpServer({ name: 'dsh-plugin-mail-operator', version: VERSION }, { capabilities: { tools: {} }, instructions: buildInstructions() });

  server.registerTool(
    'status',
    { title: 'Estado', description: 'Hosts configurados, python detectado, lista blanca y modo (sin mostrar contraseñas).', inputSchema: z.object({}) },
    async () => {
      const config = loadConfig();
      const python = findPython(config);
      return textResult([
        `Modo: ${READ_ONLY ? 'read-only' : 'normal'}`,
        `Config: ${CONFIG_FILE}`,
        `IMAP: ${config.imap.host || '(sin host)'}:${config.imap.port} · usuario ${config.imap.user || '(sin usuario)'} · contraseña ${(process.env.DSH_MAIL_IMAP_PASSWORD || config.imap.password) ? 'configurada' : 'NO configurada'}`,
        `SMTP: ${config.smtp.host || '(sin host)'}:${config.smtp.port} · remitente ${config.smtp.from || config.smtp.user || '(sin remitente)'}`,
        `Python: ${python}`,
        `Destinatarios permitidos: ${(config.allowedRecipients || []).join(', ') || 'todos (solo con confirmación)'}`,
        `Helper: ${HELPER} (${existsSync(HELPER) ? 'presente' : 'FALTA'})`,
      ].join('\n'));
    },
  );

  server.registerTool(
    'inbox',
    { title: 'Bandeja de entrada', description: 'Lista los correos más recientes de INBOX.', inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }) },
    async (args) => {
      const config = loadConfig();
      const result = await runHelper(config, { cmd: 'list', limit: args.limit ?? config.maxMessages, criteria: 'ALL' });
      if (!result.messages || result.messages.length === 0) return textResult('INBOX vacío (o sin permisos).');
      return textResult([`INBOX: ${result.total} correo(s); mostrando ${result.messages.length}.`, '', ...result.messages.map(line)].join('\n'));
    },
  );

  server.registerTool(
    'search',
    { title: 'Buscar correos', description: 'Busca por texto en remitente o asunto (sobre los últimos 50 correos).', inputSchema: z.object({ query: z.string().min(2).max(120), limit: z.number().int().min(1).max(50).optional() }) },
    async (args) => {
      const config = loadConfig();
      const result = await runHelper(config, { cmd: 'list', limit: 50, criteria: 'ALL' });
      const query = args.query.toLowerCase();
      const matches = (result.messages || []).filter((m) => `${m.from} ${m.subject}`.toLowerCase().includes(query)).slice(0, args.limit ?? 10);
      if (matches.length === 0) return textResult(`Sin resultados para "${args.query}".`);
      return textResult([`Resultados: ${matches.length}`, '', ...matches.map(line)].join('\n'));
    },
  );

  server.registerTool(
    'read',
    { title: 'Leer correo', description: 'Lee el cuerpo de un correo por uid.', inputSchema: z.object({ uid: z.number().int().min(1) }) },
    async (args) => {
      const config = loadConfig();
      const result = await runHelper(config, { cmd: 'read', uid: String(args.uid) });
      const body = String(result.body || '').slice(0, 20_000);
      return textResult([`${result.subject || '(sin asunto)'}`, `De: ${result.from}`, `Para: ${result.to}`, `Fecha: ${result.date}`, '', body || '(sin texto)'].join('\n'));
    },
  );

  server.registerTool(
    'send',
    {
      title: 'Enviar correo',
      description: 'Envía un correo por SMTP. Requiere confirm:true y pedido explícito del usuario.',
      inputSchema: z.object({
        to: z.string().min(3).describe('destinatario (email)'),
        subject: z.string().min(1).max(200),
        body: z.string().min(1).max(50_000),
        confirm: z.boolean().optional(),
      }),
    },
    async (args) => {
      if (READ_ONLY) throw new Error('modo read-only: send deshabilitado');
      if (args.confirm !== true) throw new Error('send requiere confirm:true y confirmación explícita del usuario');
      checkSendRate();
      const config = loadConfig();
      ensureRecipientAllowed(config, args.to);
      const result = await runHelper(config, { cmd: 'send', message: { to: args.to, subject: args.subject, body: args.body } });
      audit({ tool: 'send', to: args.to, subjectLength: args.subject.length, ok: true });
      return textResult(`Correo enviado a ${result.to}: "${result.subject}"${result.refused?.length ? ` (rechazados: ${result.refused.join(', ')})` : ''}.`);
    },
  );

  return server;
}

try {
  if (!existsSync(CONFIG_FILE)) saveConfig(loadConfig());
  mkdirSync(CACHE_DIR, { recursive: true });
} catch (e) { log(`init: ${e.message}`); }
log(`modo ${READ_ONLY ? 'read-only' : 'normal'} · config: ${CONFIG_FILE} · python: ${findPython(loadConfig())}`);
serveStdio(buildServer, { onerror: (e) => log(`serveStdio: ${e.message}`) });
process.on('uncaughtException', (e) => log(`excepción: ${e.message}`));
process.on('unhandledRejection', (e) => log(`rechazo: ${e && e.message ? e.message : String(e)}`));
