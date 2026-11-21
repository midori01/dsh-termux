// Terminal chat for dsh: an ACP client that runs `dsh --profile acp` and talks to it over stdio.
// Usage: node chat.mjs <dsh version dir> [-r|--resume [id]] [-m|--model <name>] [-y|--yes] [prompt]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";

const root = path.resolve(process.argv[2]);
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const tty = process.stdout.isTTY;
const sgr = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const [bold, dim, italic, red, green, yellow, blue, cyan] = [1, 2, 3, 31, 32, 33, 34, 36].map(sgr);
const accent = sgr("38;5;69");
const home = (p) => (p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : p);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();

const usage = `Usage: dsh chat [options] [prompt]

  -r, --resume [id]   continue a session (the latest one in this directory without an id)
  -m, --model <name>  start with this model (id or display name, e.g. deepseek-v4-pro)
  -e, --effort <lvl>  start with this reasoning effort
  -y, --yes           allow every tool call without asking
  -h, --help          show this help`;

const opts = { resume: undefined, model: undefined, effort: undefined, yes: false, prompt: [] };
for (let a = process.argv.slice(3); a.length; ) {
  const arg = a.shift();
  if (arg === "-h" || arg === "--help") (console.log(usage), process.exit(0));
  else if (arg === "-r" || arg === "--resume") opts.resume = a[0] && !a[0].startsWith("-") && /^[\w-]{8,}$/.test(a[0]) ? a.shift() : "";
  else if (arg === "-m" || arg === "--model") opts.model = a.shift();
  else if (arg === "-e" || arg === "--effort") opts.effort = a.shift();
  else if (arg === "-y" || arg === "--yes") opts.yes = true;
  else if (arg === "--") opts.prompt.push(...a.splice(0));
  else if (arg.startsWith("-")) (console.error(`dsh chat: unknown option ${arg}\n\n${usage}`), process.exit(2));
  else opts.prompt.push(arg);
}

// ---- dsh --profile acp over newline-delimited JSON-RPC ----

const log = path.join(os.tmpdir(), `dsh-chat-${process.pid}.log`);
const logFd = fs.openSync(log, "w");
const child = spawn(
  process.execPath,
  ["--expose-internals", "--import", path.join(root, "termux/preload.mjs"),
    path.join(root, "node_modules/@deepseek-ai/dsh/lib/bin.js"), "--profile", "acp"],
  { stdio: ["pipe", "pipe", logFd], detached: true },
);
let exiting = false;
let nextId = 1;
const pending = new Map();
const send = (msg) => child.stdin.writable && child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });

readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.reject(Object.assign(new Error(msg.error.message), { data: msg.error.data }));
    else p?.resolve(msg.result);
  } else if (msg.method === "session/update") {
    if (msg.params.sessionId === session?.id) onUpdate(msg.params.update);
  } else if (msg.method === "session/request_permission") {
    askPermission(msg.params).then((outcome) => send({ id: msg.id, result: { outcome } }));
  } else if (msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: `method not supported: ${msg.method}` } });
  }
});

child.on("exit", (code, signal) => {
  for (const p of pending.values()) p.reject(new Error("dsh exited"));
  if (exiting) return;
  const tail = fs.readFileSync(log, "utf8").trim().split("\n").slice(-15).join("\n");
  print(red(`dsh exited (${signal ?? code})`) + (tail ? "\n" + dim(tail) : ""));
  print(dim(`log: ${log}`));
  restoreTerminal();
  process.exit(1);
});

// ---- terminal ----

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty, historySize: 500 });
const PROMPT = accent("› ");
let promptShown = false;
let spinner;
let busySince = 0;
let question;
let inputClosed = false;
let ready = false;
let turnStart = 0;
const queue = [];

function print(text = "") {
  if (tty) {
    readline.cursorTo(process.stdout, 0);
    readline.clearScreenDown(process.stdout);
  }
  process.stdout.write(text + "\n");
  if (promptShown || spinner) rl.prompt(true);
}

function idle() {
  if (inputClosed) return quit();
  clearInterval(spinner);
  spinner = undefined;
  rl.setPrompt(PROMPT);
  promptShown = true;
  rl.prompt(true);
}

function busy(label) {
  busySince = Date.now();
  promptShown = false;
  if (!tty) return;
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let i = 0;
  const draw = () => {
    if (question) return;
    const secs = Math.floor((Date.now() - busySince) / 1000);
    rl.setPrompt(accent(frames[i++ % frames.length]) + dim(` ${label} ${secs}s · ctrl+c to stop `));
    rl.prompt(true);
  };
  clearInterval(spinner);
  spinner = setInterval(draw, 100);
  draw();
}

function ask(text) {
  if (inputClosed) return Promise.resolve("\x03");
  return new Promise((resolve) => {
    question = resolve;
    rl.setPrompt(text);
    rl.prompt(true);
  });
}

function restoreTerminal() {
  clearInterval(spinner);
  if (tty) {
    readline.cursorTo(process.stdout, 0);
    readline.clearScreenDown(process.stdout);
  }
  rl.close();
}

// Lines that arrive together are a paste: send them as one message.
let pasteBuf = [];
let pasteTimer;
rl.on("line", (line) => {
  if (question) {
    const resolve = question;
    question = undefined;
    if (spinner) busy("working");
    return resolve(line.trim());
  }
  pasteBuf.push(line);
  clearTimeout(pasteTimer);
  pasteTimer = setTimeout(() => {
    pasteTimer = undefined;
    let text = pasteBuf.join("\n");
    pasteBuf = [];
    if (text.endsWith("\\")) {
      pasteBuf.push(text.slice(0, -1));
      rl.setPrompt(dim("… "));
      return rl.prompt(true);
    }
    text = text.trim();
    if (!text) return inputClosed && !turn ? quit() : promptShown && rl.prompt(true);
    if (turn || !ready) {
      queue.push(text);
      if (ready) print(dim(`  queued: ${clip(oneLine(text), 70)}`));
    } else submit(text);
  }, 30);
});

let lastSigint = 0;
rl.on("SIGINT", () => {
  if (question) {
    const resolve = question;
    question = undefined;
    resolve("\x03");
    return;
  }
  if (turn) {
    queue.length = 0;
    send({ method: "session/cancel", params: { sessionId: session.id } });
    print(dim("  stopping…"));
    return;
  }
  if (rl.line) {
    rl.write(null, { ctrl: true, name: "e" });
    rl.write(null, { ctrl: true, name: "u" });
    return;
  }
  if (Date.now() - lastSigint < 2000) return quit();
  lastSigint = Date.now();
  print(dim("  press ctrl+c again or ctrl+d to exit"));
});
rl.on("close", () => {
  inputClosed = true;
  if (question) {
    const resolve = question;
    question = undefined;
    resolve("\x03");
  }
  if (ready && !turn && !pasteTimer) quit();
});

// ---- rendering ----

const tools = new Map();
let usageInfo;
let showThoughts = false;

function markdown(text) {
  if (!tty) return text;
  let fence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) return (fence = !fence), dim(line);
      if (fence) return cyan(line);
      if (/^#{1,6} /.test(line)) return bold(line.replace(/^#+ /, ""));
      if (/^\s*>/.test(line)) return dim(line);
      return line
        .replace(/^(\s*)[-*] /, "$1• ")
        .replace(/`([^`]+)`/g, (_, c) => cyan(c))
        .replace(/\*\*([^*]+)\*\*/g, (_, b) => bold(b));
    })
    .join("\n");
}

function toolSummary(input) {
  if (input === undefined || input === null) return "";
  if (typeof input !== "object") return oneLine(input);
  for (const key of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description", "prompt"]) {
    if (typeof input[key] === "string") return oneLine(input[key]);
  }
  return oneLine(JSON.stringify(input));
}

function contentText(content) {
  return (content ?? [])
    .map((c) => (c.content?.type === "text" ? c.content.text : c.content ? `[${c.content.type}]` : ""))
    .join("\n")
    .trim();
}

function onUpdate(u) {
  switch (u.sessionUpdate) {
    case "agent_thought_chunk": {
      const text = u.content?.text?.trim();
      if (!text) break;
      const lines = text.split("\n");
      if (showThoughts) print(dim(italic(text)));
      else print(dim(italic(`✻ ${clip(oneLine(lines[0]), 90)}`)) + (lines.length > 1 ? dim(` (+${lines.length - 1} lines, /thoughts)`) : ""));
      break;
    }
    case "agent_message_chunk":
      print((u.content?.type === "text" ? markdown(u.content.text.trim()) : dim(`[${u.content?.type}]`)) + "\n");
      break;
    case "tool_call": {
      const summary = toolSummary(u.rawInput);
      tools.set(u.toolCallId, { title: u.title, summary, input: u.rawInput });
      print(`${blue("●")} ${bold(u.title)}${summary ? " " + dim(clip(summary, 100)) : ""}`);
      break;
    }
    case "tool_call_update": {
      if (u.status !== "completed" && u.status !== "failed") break;
      const lines = contentText(u.content).split("\n").filter(Boolean);
      const head = lines.length ? clip(oneLine(lines[0]), 100) : "(no output)";
      const more = lines.length > 1 ? dim(` (+${lines.length - 1} lines)`) : "";
      print(u.status === "failed" ? `  ${red("⎿ " + head)}${more}` : `  ${dim("⎿ " + head)}${more}`);
      break;
    }
    case "usage_update":
      usageInfo = u;
      break;
    case "config_option_update":
      if (session) session.config = u.configOptions;
      break;
  }
}

// ---- permissions ----

const alwaysAllowed = new Set();

async function askPermission({ toolCall, options }) {
  const pick = (kind) => options.find((o) => o.kind === kind)?.optionId;
  const tool = tools.get(toolCall.toolCallId) ?? { title: toolCall.title ?? "tool", summary: "" };
  if (opts.yes || alwaysAllowed.has(tool.title)) return { outcome: "selected", optionId: pick("allow_once") };
  const detail =
    typeof tool.input === "object" && tool.input !== null
      ? Object.entries(tool.input)
          .map(([k, v]) => `    ${dim(k + ":")} ${clip(typeof v === "string" ? v : JSON.stringify(v), 300)}`)
          .join("\n")
      : "";
  print(`${yellow("?")} ${bold(tool.title)} needs your permission` + (detail ? "\n" + detail : ""));
  for (;;) {
    const answer = (await ask(yellow(`  allow? [y]es / [a]lways for ${tool.title} / [n]o › `))).toLowerCase();
    if (answer === "\x03") return { outcome: "cancelled" };
    if (answer === "y" || answer === "yes") return { outcome: "selected", optionId: pick("allow_once") };
    if (answer === "a" || answer === "always") {
      alwaysAllowed.add(tool.title);
      return { outcome: "selected", optionId: pick("allow_once") };
    }
    if (answer === "n" || answer === "no") return { outcome: "selected", optionId: pick("reject_once") };
  }
}

// ---- sessions ----

let session;
let turn;
let prompted = false;

function projection(id) {
  for (const name of [`${id}.json`, `session-${id}.json`]) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dshHome, "storages/session_projcache/sessions", name), "utf8")).record;
    } catch {}
  }
}

function sessionLabel(id) {
  const rec = projection(id);
  const title = rec?.rows?.title?.val || rec?.rows?.turnOutline?.val?.turns?.[0]?.prompt || "(untitled)";
  const when = rec?.identity?.createdAt ? new Date(rec.identity.createdAt).toLocaleString() : "";
  return { title: clip(oneLine(title), 60), when };
}

const option = (id) => session?.config?.find((o) => o.id === id);
const flatChoices = (opt) => (opt?.options ?? []).flatMap((o) => o.options ?? [o]);
const choiceName = (opt) => flatChoices(opt).find((o) => o.value === opt?.currentValue)?.name ?? opt?.currentValue;

async function setOption(id, wanted) {
  const opt = option(id);
  if (!opt) throw new Error(`this model has no ${id === "model" ? "model" : "reasoning effort"} setting`);
  const choices = flatChoices(opt);
  const w = String(wanted).toLowerCase();
  const hit =
    choices[Number(wanted) - 1] ??
    choices.find((c) => c.value.toLowerCase() === w || c.name.toLowerCase() === w) ??
    choices.find((c) => c.value.toLowerCase().includes(w) || c.name.toLowerCase().includes(w));
  if (!hit) throw new Error(`no ${id} matches "${wanted}"`);
  const res = await request("session/set_config_option", { sessionId: session.id, configId: id, value: hit.value });
  session.config = res.configOptions;
}

async function openSession(resumeId) {
  const cwd = process.cwd();
  const res = resumeId
    ? await request("session/resume", { sessionId: resumeId, cwd, mcpServers: [] })
    : await request("session/new", { cwd, mcpServers: [] });
  session = { id: resumeId ?? res.sessionId, config: res.configOptions };
  tools.clear();
  alwaysAllowed.clear();
  usageInfo = undefined;
  prompted = Boolean(resumeId);
}

// Open the new session before closing the old one, so a failed resume keeps the current session.
async function switchSession(resumeId) {
  const old = session;
  await openSession(resumeId);
  if (old) await request("session/close", { sessionId: old.id }).catch(() => {});
}

async function closeSession() {
  if (!session) return;
  const id = session.id;
  session = undefined;
  await request("session/close", { sessionId: id }).catch(() => {});
}

// Earlier sessions in this directory that have at least one turn, newest first.
async function pastSessions() {
  const res = await request("session/list", { cwd: process.cwd() });
  return res.sessions
    .filter((s) => s.sessionId !== session?.id)
    .map((s) => ({ ...s, turns: history(s.sessionId).length }))
    .filter((s) => s.turns > 0);
}

function header() {
  const effort = option("reasoning_effort");
  const model = choiceName(option("model")) + (effort ? ` (${choiceName(effort)})` : "");
  print(`${accent(bold("dsh"))} ${dim(version)}  ${model}  ${dim(home(process.cwd()))}`);
}

// ACP resumes without replaying old updates; read the last turns from the session log instead.
function history(id) {
  const textOf = (content) => (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const turns = [];
  try {
    const base = path.join(dshHome, "sessions");
    const dir = fs
      .readdirSync(base)
      .flatMap((d) => [id, `session-${id}`].map((n) => path.join(base, d, n)))
      .find((d) => fs.existsSync(d));
    const file = dir && fs.readdirSync(dir).find((f) => /\.jsonl(\.zstd)?$/.test(f));
    if (!file) return turns;
    const raw = fs.readFileSync(path.join(dir, file));
    for (const line of (file.endsWith(".zstd") ? zlib.zstdDecompressSync(raw) : raw).toString().split("\n")) {
      if (!line) continue;
      const e = JSON.parse(line);
      if (e.type === "user/message" && e.data?.source?.kind === "user") turns.push({ prompt: textOf(e.data.content), response: "" });
      else if (e.type === "assistant/message" && turns.length) turns.at(-1).response = textOf(e.data?.message?.content) || turns.at(-1).response;
    }
  } catch {}
  return turns;
}

function showResumed(id) {
  const { title } = sessionLabel(id);
  const turns = history(id);
  print(dim(`resumed ${id} · ${title}`));
  for (const t of turns.slice(-3)) {
    print(`${accent("›")} ${clip(oneLine(t.prompt ?? ""), 100)}`);
    if (t.response) print(dim(`  ${clip(oneLine(t.response), 160)}`));
  }
}

// ---- commands ----

const help = `${bold("Commands")}
  /new                 start a new session
  /resume [n|id]       list sessions in this directory, or continue one
  /model [n|name]      list models, or switch
  /effort [n|level]    list reasoning efforts, or switch
  /thoughts            show or fold the model's reasoning
  /status              session, model and context usage
  /exit                quit (also ctrl+d, or ctrl+c twice)
${bold("Input")}
  end a line with \\ to continue it; pasted lines are sent as one message
  ctrl+c stops the current reply; messages typed meanwhile are queued`;

let lastList = [];

async function command(line) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "help":
    case "?":
      return print(help);
    case "exit":
    case "quit":
      return quit();
    case "new":
      await switchSession();
      return header();
    case "thoughts":
      showThoughts = !showThoughts;
      return print(dim(`  reasoning ${showThoughts ? "shown in full" : "folded"}`));
    case "status": {
      const ctx = usageInfo ? `${Math.round((usageInfo.used / usageInfo.size) * 100)}% of ${Math.round(usageInfo.size / 1000)}k` : "-";
      return print(
        `  session  ${session.id}\n  model    ${choiceName(option("model"))}\n  effort   ${choiceName(option("reasoning_effort")) ?? "-"}\n  context  ${ctx}\n  cwd      ${home(process.cwd())}`,
      );
    }
    case "model":
    case "effort": {
      const id = cmd === "model" ? "model" : "reasoning_effort";
      if (arg) {
        await setOption(id, arg);
        return header();
      }
      const opt = option(id);
      if (!opt) return print(dim(`  this model has no ${cmd} setting`));
      return print(
        flatChoices(opt)
          .map((c, i) => `  ${c.value === opt.currentValue ? green("●") : " "} ${i + 1}. ${c.name}` + (c.description ? dim(` — ${clip(c.description, 70)}`) : ""))
          .join("\n"),
      );
    }
    case "resume": {
      if (!arg) {
        lastList = (await pastSessions()).slice(0, 20);
        if (!lastList.length) return print(dim("  no other sessions in this directory"));
        return print(
          lastList
            .map((s, i) => {
              const l = sessionLabel(s.sessionId);
              return `  ${String(i + 1).padStart(2)}. ${l.title} ${dim(`· ${s.turns} turn${s.turns > 1 ? "s" : ""}${l.when ? " · " + l.when : ""}`)}`;
            })
            .join("\n") + dim("\n  /resume <n> to continue"),
        );
      }
      const id = lastList[Number(arg) - 1]?.sessionId ?? arg;
      await switchSession(id);
      header();
      return showResumed(id);
    }
    default:
      return print(dim(`  unknown command /${cmd} — /help lists them`));
  }
}

async function submit(text) {
  if (text.startsWith("/") && !text.startsWith("//")) {
    promptShown = false;
    const lines = text.split("\n");
    for (const line of lines.every((l) => l.startsWith("/")) ? lines : [text]) {
      try {
        await command(line);
      } catch (error) {
        print(red(`  ${error.message}`));
      }
    }
    return exiting || idle();
  }
  if (text.startsWith("//")) text = text.slice(1);
  print(tty ? "" : dim("› " + text.split("\n").join("\n  ")) + "\n");
  prompted = true;
  turnStart = Date.now();
  busy("working");
  turn = request("session/prompt", { sessionId: session.id, prompt: [{ type: "text", text }] });
  try {
    const { stopReason } = await turn;
    if (stopReason === "cancelled") print(dim("  stopped"));
    else if (stopReason && stopReason !== "end_turn") print(yellow(`  stopped: ${stopReason}`));
  } catch (error) {
    print(red(`  ${error.message}`));
    if (/ACCOUNT_SIGN_IN_REQUIRED|sign.?in/i.test(error.message + JSON.stringify(error.data ?? ""))) {
      print(dim("  sign in to your DeepSeek account in `dsh web`, then try again"));
    }
  } finally {
    turn = undefined;
  }
  if (usageInfo) print(dim(`  ${Math.round((usageInfo.used / usageInfo.size) * 100)}% context · ${((Date.now() - turnStart) / 1000).toFixed(1)}s`));
  if (queue.length) return submit(queue.splice(0).join("\n\n"));
  idle();
}

async function quit() {
  if (exiting) return;
  exiting = true;
  clearInterval(spinner);
  const id = session?.id;
  if (session) {
    send({ method: "session/cancel", params: { sessionId: id } });
    await Promise.race([closeSession(), new Promise((r) => setTimeout(r, 3000))]);
  }
  restoreTerminal();
  child.stdin.end();
  const killer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }, 5000);
  killer.unref();
  child.once("exit", () => {
    fs.rmSync(log, { force: true });
    if (id && prompted) process.stdout.write(dim(`resume with: dsh chat --resume ${id}`) + "\n");
    process.exit(0);
  });
}

// ---- start ----

const version = JSON.parse(fs.readFileSync(path.join(root, "node_modules/@deepseek-ai/dsh/package.json"), "utf8")).version;
busy("starting dsh");
try {
  await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "dsh-termux-chat", version } });
  const resumeId = opts.resume === "" ? (await pastSessions())[0]?.sessionId : opts.resume;
  if (opts.resume === "" && !resumeId) print(dim("no earlier session in this directory; starting a new one"));
  await openSession(resumeId);
  if (opts.model) await setOption("model", opts.model);
  if (opts.effort) await setOption("reasoning_effort", opts.effort);
} catch (error) {
  exiting = true;
  restoreTerminal();
  console.error(red(`dsh chat: ${error.message}`));
  child.kill();
  process.exit(1);
}
clearInterval(spinner);
spinner = undefined;
header();
if (session && opts.resume !== undefined && prompted) showResumed(session.id);
print(dim("/help for commands · ctrl+c stops a reply · ctrl+d exits") + "\n");
ready = true;
if (opts.prompt.length) queue.unshift(opts.prompt.join(" "));
if (queue.length) submit(queue.splice(0).join("\n\n"));
else idle();
