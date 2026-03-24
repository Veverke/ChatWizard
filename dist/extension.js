"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode14 = __toESM(require("vscode"));

// src/index/sessionIndex.ts
function toSummary(session) {
  const userMessageCount = session.messages.filter((m) => m.role === "user").length;
  const assistantMessageCount = session.messages.filter((m) => m.role === "assistant").length;
  const lastMsg = session.messages[session.messages.length - 1];
  const interrupted = lastMsg?.role === "user" ? true : void 0;
  return {
    id: session.id,
    title: session.title,
    source: session.source,
    workspaceId: session.workspaceId,
    workspacePath: session.workspacePath,
    model: session.model,
    filePath: session.filePath,
    fileSizeBytes: session.fileSizeBytes,
    messageCount: session.messages.length,
    userMessageCount,
    assistantMessageCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    interrupted,
    hasParseErrors: (session.parseErrors?.length ?? 0) > 0 || void 0
  };
}
function byUpdatedAtDesc(a, b) {
  return b.updatedAt.localeCompare(a.updatedAt);
}
var SessionIndex = class {
  sessions;
  _changeListeners = [];
  _typedChangeListeners = [];
  _version = 0;
  _codeBlockCache = null;
  _promptCache = null;
  constructor() {
    this.sessions = /* @__PURE__ */ new Map();
  }
  /** Monotonically-increasing counter — incremented on every upsert, remove, or batchUpsert. */
  get version() {
    return this._version;
  }
  addChangeListener(fn) {
    this._changeListeners.push(fn);
    return { dispose: () => {
      this._changeListeners = this._changeListeners.filter((l) => l !== fn);
    } };
  }
  addTypedChangeListener(fn) {
    this._typedChangeListeners.push(fn);
    return { dispose: () => {
      this._typedChangeListeners = this._typedChangeListeners.filter((l) => l !== fn);
    } };
  }
  _notifyListeners() {
    for (const fn of this._changeListeners) {
      fn();
    }
  }
  _notifyTyped(event) {
    for (const fn of this._typedChangeListeners) {
      fn(event);
    }
  }
  _invalidateCaches() {
    this._codeBlockCache = null;
    this._promptCache = null;
  }
  /** Add or replace a session by id. */
  upsert(session) {
    this.sessions.set(session.id, session);
    this._version++;
    this._invalidateCaches();
    this._notifyTyped({ type: "upsert", session });
    this._notifyListeners();
  }
  /**
   * Remove a session by id.
   * Returns true if the session existed and was removed, false otherwise.
   */
  remove(sessionId) {
    const removed = this.sessions.delete(sessionId);
    if (removed) {
      this._version++;
      this._invalidateCaches();
      this._notifyTyped({ type: "remove", sessionId });
      this._notifyListeners();
    }
    return removed;
  }
  /**
   * Insert or replace all sessions in the array, then fire one typed 'batch' event
   * and one plain change notification.
   */
  batchUpsert(sessions) {
    for (const session of sessions) {
      this.sessions.set(session.id, session);
    }
    if (sessions.length > 0) {
      this._version++;
      this._invalidateCaches();
    }
    this._notifyTyped({ type: "batch", sessions });
    this._notifyListeners();
  }
  /** Get a full session by id. Returns undefined if not found. */
  get(sessionId) {
    return this.sessions.get(sessionId);
  }
  /** Get all sessions as lightweight summaries, sorted by updatedAt descending. */
  getAllSummaries() {
    return Array.from(this.sessions.values()).map(toSummary).sort(byUpdatedAtDesc);
  }
  /** Get summaries filtered to a specific source, sorted by updatedAt descending. */
  getSummariesBySource(source) {
    return Array.from(this.sessions.values()).filter((s) => s.source === source).map(toSummary).sort(byUpdatedAtDesc);
  }
  /** Get summaries filtered to a specific workspaceId, sorted by updatedAt descending. */
  getSummariesByWorkspace(workspaceId) {
    return Array.from(this.sessions.values()).filter((s) => s.workspaceId === workspaceId).map(toSummary).sort(byUpdatedAtDesc);
  }
  /**
   * Extract all user-turn prompts across every session.
   * Order is: sessions in insertion order, messages in message order.
   * Result is cached; invalidated on any mutation.
   */
  getAllPrompts() {
    if (this._promptCache !== null) {
      return this._promptCache;
    }
    const prompts = [];
    for (const session of this.sessions.values()) {
      session.messages.forEach((message, messageIndex) => {
        if (message.role === "user") {
          prompts.push({
            content: message.content,
            sessionId: session.id,
            messageIndex,
            timestamp: message.timestamp
          });
        }
      });
    }
    this._promptCache = prompts;
    return prompts;
  }
  /**
   * Extract all fenced code blocks across every session, with session metadata attached.
   * Order: sessions in insertion order, messages in message order, blocks in occurrence order.
   * Result is cached; invalidated on any mutation.
   */
  getAllCodeBlocks() {
    if (this._codeBlockCache !== null) {
      return this._codeBlockCache;
    }
    const blocks = [];
    for (const session of this.sessions.values()) {
      for (const message of session.messages) {
        for (const block of message.codeBlocks) {
          blocks.push({
            language: block.language,
            content: block.content,
            sessionId: block.sessionId,
            messageIndex: block.messageIndex,
            blockIndexInMessage: block.blockIndexInMessage,
            messageRole: message.role,
            sessionTitle: session.title,
            sessionSource: session.source,
            sessionUpdatedAt: session.updatedAt,
            sessionWorkspacePath: session.workspacePath
          });
        }
      }
    }
    this._codeBlockCache = blocks;
    return blocks;
  }
  /** Number of indexed code blocks, without allocating a new array. */
  getCodeBlockCount() {
    if (this._codeBlockCache !== null) {
      return this._codeBlockCache.length;
    }
    let count = 0;
    for (const session of this.sessions.values()) {
      for (const message of session.messages) {
        count += message.codeBlocks.length;
      }
    }
    return count;
  }
  /** Number of sessions currently held in the index. */
  get size() {
    return this.sessions.size;
  }
  /** Remove all sessions from the index. Fires a typed 'clear' event and a plain change notification. */
  clear() {
    this.sessions.clear();
    this._version++;
    this._invalidateCaches();
    this._notifyTyped({ type: "clear" });
    this._notifyListeners();
  }
  /**
   * Basic full-text search across sessions.
   *
   * - Case-insensitive substring match against message content.
   * - `searchPrompts`  (default true): search user messages.
   * - `searchResponses` (default true): search assistant messages.
   * - `source`: when provided, only sessions from that source are considered.
   *
   * Returns SessionSummary[] sorted by updatedAt descending.
   */
  search(query, options) {
    const searchPrompts = options?.searchPrompts !== false;
    const searchResponses = options?.searchResponses !== false;
    const sourceFilter = options?.source;
    const lowerQuery = query.toLowerCase();
    const results = [];
    for (const session of this.sessions.values()) {
      if (sourceFilter !== void 0 && session.source !== sourceFilter) {
        continue;
      }
      const matched = session.messages.some((message) => {
        if (message.role === "user" && !searchPrompts) {
          return false;
        }
        if (message.role === "assistant" && !searchResponses) {
          return false;
        }
        return message.content.toLowerCase().includes(lowerQuery);
      });
      if (matched) {
        results.push(toSummary(session));
      }
    }
    return results.sort(byUpdatedAtDesc);
  }
};

// src/watcher/fileWatcher.ts
var vscode = __toESM(require("vscode"));
var path12 = __toESM(require("path"));
var fs11 = __toESM(require("fs"));

// src/parsers/copilot.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var MAX_LINE_CHARS = 1e6;
var MAX_DEEPSET_DEPTH = 64;
var MAX_ARRAY_INDEX = 1e5;
function msToIso(ms) {
  return new Date(ms).toISOString();
}
function deepSet(obj, keys, value) {
  if (keys.length === 0 || keys.length > MAX_DEEPSET_DEPTH) {
    return;
  }
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (Array.isArray(current) && typeof key === "number") {
      if (key < 0 || key > MAX_ARRAY_INDEX) {
        return;
      }
      current = current[key];
    } else if (typeof current === "object" && current !== null) {
      current = current[String(key)];
    } else {
      return;
    }
  }
  const lastKey = keys[keys.length - 1];
  if (Array.isArray(current) && typeof lastKey === "number") {
    if (lastKey < 0 || lastKey > MAX_ARRAY_INDEX) {
      return;
    }
    current[lastKey] = value;
  } else if (typeof current === "object" && current !== null) {
    current[String(lastKey)] = value;
  }
}
function extractCodeBlocks(content, sessionId, messageIndex) {
  const blocks = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const language = match[1].trim();
    const blockContent = match[2].trim();
    blocks.push({ language, content: blockContent, sessionId, messageIndex, blockIndexInMessage: blocks.length });
  }
  return blocks;
}
function parseCopilotSession(filePath, workspaceId, workspacePath) {
  const errors = [];
  const fallbackId = path.basename(filePath, path.extname(filePath));
  const emptySession = () => ({
    id: fallbackId,
    title: "Untitled Session",
    source: "copilot",
    workspaceId,
    workspacePath,
    messages: [],
    filePath,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Failed to read file: ${msg}`);
    return { session: emptySession(), errors };
  }
  const lines = raw.split("\n");
  let state;
  const patches = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    if (line.length > MAX_LINE_CHARS) {
      errors.push(`Line ${i + 1}: skipped \u2014 length ${line.length} exceeds limit`);
      continue;
    }
    try {
      const obj = JSON.parse(line);
      if (obj.kind === 0) {
        state = obj.v;
      } else if ((obj.kind === 1 || obj.kind === 2) && Array.isArray(obj.k)) {
        patches.push(obj);
      }
    } catch {
      errors.push(`Line ${i + 1}: invalid JSON`);
    }
  }
  if (!state) {
    errors.push("No initial state snapshot (kind:0) found");
    return { session: emptySession(), errors };
  }
  for (const patch of patches) {
    try {
      deepSet(state, patch.k, patch.v);
    } catch {
    }
  }
  const sessionId = state.sessionId ?? fallbackId;
  const customTitle = state.customTitle;
  const creationDateMs = state.creationDate;
  const inputState = state.inputState;
  const model = inputState?.selectedModel?.metadata?.name ?? state.selectedModel?.metadata?.name;
  const allRequests = state.requests ?? [];
  const turns = allRequests.filter((r) => r.kind === null || r.kind === void 0);
  const messages = [];
  for (const turn of turns) {
    const userText = turn.message?.text ?? "";
    const timestampMs = turn.timestamp;
    const timestampIso = timestampMs !== void 0 ? msToIso(timestampMs) : void 0;
    const requestId = turn.requestId;
    if (userText) {
      const userMsgIndex = messages.length;
      messages.push({
        id: requestId ?? `${sessionId}-${userMsgIndex}`,
        role: "user",
        content: userText,
        codeBlocks: extractCodeBlocks(userText, sessionId, userMsgIndex),
        timestamp: timestampIso
      });
    }
    const responseItems = turn.response ?? [];
    const aiTextParts = responseItems.filter((item) => typeof item.value === "string" && !item.kind).map((item) => item.value);
    const aiText = aiTextParts.join("\n").trim();
    if (aiText) {
      const asstMsgIndex = messages.length;
      messages.push({
        id: `${requestId ?? sessionId}-response`,
        role: "assistant",
        content: aiText,
        codeBlocks: extractCodeBlocks(aiText, sessionId, asstMsgIndex),
        timestamp: timestampIso
      });
    }
  }
  const firstUserMsg = messages.find((m) => m.role === "user");
  let title;
  if (customTitle) {
    title = customTitle;
  } else if (firstUserMsg) {
    const fl = firstUserMsg.content.split("\n")[0];
    title = fl.length > 120 ? fl.slice(0, 120) + "\u2026" : fl || firstUserMsg.content.slice(0, 120);
  } else {
    title = "Untitled Session";
  }
  let fileSizeBytes;
  let fileBirthtime;
  let fileMtime;
  try {
    const stat = fs.statSync(filePath);
    fileSizeBytes = stat.size;
    fileBirthtime = stat.birthtime.toISOString();
    fileMtime = stat.mtime.toISOString();
  } catch {
  }
  const createdAt = creationDateMs !== void 0 ? msToIso(creationDateMs) : fileBirthtime ?? (/* @__PURE__ */ new Date()).toISOString();
  let updatedAt = fileMtime ?? createdAt;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].timestamp !== void 0) {
      updatedAt = messages[i].timestamp;
      break;
    }
  }
  return {
    session: {
      id: sessionId,
      title,
      source: "copilot",
      workspaceId,
      workspacePath,
      model,
      messages,
      filePath,
      fileSizeBytes,
      createdAt,
      updatedAt
    },
    errors
  };
}

// src/parsers/claude.ts
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));
var DEFAULT_MAX_LINE_CHARS = 1e6;
function isInjectedContext(text) {
  return /^\s*<[\w-]+>[\s\S]*?<\/[\w-]+>\s*$/.test(text);
}
function extractTextContent(contentParts) {
  return contentParts.filter((part) => part.type === "text" && typeof part.text === "string" && !isInjectedContext(part.text)).map((part) => part.text).join("");
}
function extractCodeBlocks2(content, sessionId, messageIndex) {
  const blocks = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    blocks.push({
      language: match[1] ?? "",
      content: match[2].trim(),
      sessionId,
      messageIndex,
      blockIndexInMessage: blocks.length
    });
  }
  return blocks;
}
function parseClaudeSession(filePath, maxLineChars = DEFAULT_MAX_LINE_CHARS) {
  const errors = [];
  const filenameId = path2.basename(filePath, path2.extname(filePath));
  const emptySession = {
    id: filenameId,
    title: filenameId,
    source: "claude",
    workspaceId: filenameId,
    workspacePath: void 0,
    messages: [],
    filePath,
    createdAt: (/* @__PURE__ */ new Date(0)).toISOString(),
    updatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
  };
  let raw;
  try {
    raw = fs2.readFileSync(filePath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`Failed to read file: ${message}`);
    return { session: emptySession, errors };
  }
  const lines = raw.split("\n");
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    if (line.length > maxLineChars) {
      errors.push(`Line ${i + 1}: skipped \u2014 length ${line.length} exceeds limit`);
      const typeMatch = /^[^"]*"type"\s*:\s*"(human|user)"/.exec(line);
      const placeholderRole = typeMatch ? "user" : "assistant";
      entries.push({
        type: placeholderRole === "user" ? "human" : "assistant",
        uuid: `__skipped_line_${i + 1}__`,
        message: {
          role: placeholderRole,
          content: `__SKIPPED__:${line.length}:${maxLineChars}`
        }
      });
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {
      errors.push(`Line ${i + 1}: Invalid JSON \u2014 ${line.slice(0, 80)}`);
    }
  }
  let summaryText;
  let sessionId;
  let workspacePath;
  let model;
  let createdAt;
  let updatedAt;
  for (const entry of entries) {
    if (entry.type === "summary" && entry.summary) {
      summaryText = entry.summary;
    }
    if ((entry.type === "human" || entry.type === "user" || entry.type === "assistant") && entry.sessionId && !sessionId) {
      sessionId = entry.sessionId;
    }
    if ((entry.type === "human" || entry.type === "user") && entry.cwd && !workspacePath) {
      workspacePath = entry.cwd;
    }
    if (entry.type === "assistant" && entry.message?.model && entry.message.model !== "<synthetic>" && !model) {
      model = entry.message.model;
    }
    if (entry.timestamp) {
      if (!createdAt) {
        createdAt = entry.timestamp;
      }
      updatedAt = entry.timestamp;
    }
  }
  const resolvedId = sessionId ?? filenameId;
  const messages = [];
  for (const entry of entries) {
    if (entry.type !== "human" && entry.type !== "user" && entry.type !== "assistant") {
      continue;
    }
    const role = entry.type === "human" || entry.type === "user" ? "user" : "assistant";
    const rawContent = entry.message?.content ?? [];
    const rawContentStr = Array.isArray(rawContent) ? "" : String(rawContent);
    const skippedMatch = /^__SKIPPED__:(\d+):(\d+)$/.exec(rawContentStr);
    if (skippedMatch) {
      const lineLen = parseInt(skippedMatch[1], 10);
      const limitLen = parseInt(skippedMatch[2], 10);
      const messageIndex2 = messages.length;
      messages.push({
        id: entry.uuid ?? `${resolvedId}-${messageIndex2}`,
        role,
        content: "",
        codeBlocks: [],
        timestamp: entry.timestamp,
        skipped: true,
        skippedLineLength: lineLen,
        skippedLineLimit: limitLen
      });
      continue;
    }
    const contentParts = Array.isArray(rawContent) ? rawContent : [{ type: "text", text: rawContentStr }];
    const content = extractTextContent(contentParts);
    if (!content.trim()) {
      continue;
    }
    const messageIndex = messages.length;
    messages.push({
      id: entry.uuid ?? `${resolvedId}-${messageIndex}`,
      role,
      content,
      codeBlocks: extractCodeBlocks2(content, resolvedId, messageIndex),
      timestamp: entry.timestamp
    });
  }
  let title;
  if (summaryText) {
    title = summaryText;
  } else {
    const firstUserMessage = messages.find((m) => m.role === "user");
    const raw2 = firstUserMessage?.content ?? "";
    const firstLine = raw2.split("\n")[0];
    title = firstUserMessage ? firstLine.length > 120 ? firstLine.slice(0, 120) + "\u2026" : firstLine || raw2.slice(0, 120) : resolvedId;
  }
  let fallbackTime;
  let fileSizeBytes;
  try {
    const stat = fs2.statSync(filePath);
    fileSizeBytes = stat.size;
    if (!createdAt || !updatedAt) {
      fallbackTime = stat.mtime.toISOString();
    }
  } catch {
  }
  return {
    session: {
      id: resolvedId,
      title,
      source: "claude",
      workspaceId: resolvedId,
      workspacePath,
      model,
      messages,
      filePath,
      fileSizeBytes,
      createdAt: createdAt ?? fallbackTime ?? (/* @__PURE__ */ new Date(0)).toISOString(),
      updatedAt: updatedAt ?? fallbackTime ?? (/* @__PURE__ */ new Date(0)).toISOString()
    },
    errors
  };
}

// src/readers/copilotWorkspace.ts
var fs3 = __toESM(require("fs"));
var path3 = __toESM(require("path"));
var os = __toESM(require("os"));
function getWorkspaceStorageRoot() {
  const platform = process.platform;
  if (platform === "win32") {
    return path3.join(process.env["APPDATA"] || os.homedir(), "Code", "User", "workspaceStorage");
  } else if (platform === "darwin") {
    return path3.join(os.homedir(), "Library", "Application Support", "Code", "User", "workspaceStorage");
  } else {
    return path3.join(process.env["XDG_CONFIG_HOME"] || path3.join(os.homedir(), ".config"), "Code", "User", "workspaceStorage");
  }
}
function readWorkspaceJson(storageHashDir) {
  try {
    const workspaceJsonPath = path3.join(storageHashDir, "workspace.json");
    const raw = fs3.readFileSync(workspaceJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    const folder = parsed.folder;
    if (!folder) {
      return void 0;
    }
    let decoded = decodeURIComponent(folder.replace("file://", ""));
    if (process.platform === "win32" && decoded.startsWith("/")) {
      decoded = decoded.slice(1);
    }
    return decoded;
  } catch {
    return void 0;
  }
}
function discoverCopilotWorkspaces() {
  try {
    const root = getWorkspaceStorageRoot();
    const entries = fs3.readdirSync(root);
    const results = [];
    for (const entry of entries) {
      const storageDir = path3.join(root, entry);
      const chatSessionsDir = path3.join(storageDir, "chatSessions");
      let hasChatSessions = false;
      try {
        hasChatSessions = fs3.statSync(chatSessionsDir).isDirectory();
      } catch {
      }
      if (!hasChatSessions) {
        continue;
      }
      const workspacePath = readWorkspaceJson(storageDir);
      if (workspacePath === void 0) {
        continue;
      }
      results.push({
        workspaceId: entry,
        workspacePath,
        storageDir
      });
    }
    return results;
  } catch {
    return [];
  }
}
function listSessionFiles(storageHashDir) {
  try {
    const chatSessionsDir = path3.join(storageHashDir, "chatSessions");
    const files = fs3.readdirSync(chatSessionsDir);
    return files.filter((f) => f.endsWith(".jsonl")).map((f) => path3.join(chatSessionsDir, f));
  } catch {
    return [];
  }
}
async function readWorkspaceJsonAsync(storageHashDir) {
  try {
    const workspaceJsonPath = path3.join(storageHashDir, "workspace.json");
    const raw = await fs3.promises.readFile(workspaceJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    const folder = parsed.folder;
    if (!folder) {
      return void 0;
    }
    let decoded = decodeURIComponent(folder.replace("file://", ""));
    if (process.platform === "win32" && decoded.startsWith("/")) {
      decoded = decoded.slice(1);
    }
    return decoded;
  } catch {
    return void 0;
  }
}
async function discoverCopilotWorkspacesAsync() {
  try {
    const root = getWorkspaceStorageRoot();
    const entries = await fs3.promises.readdir(root);
    const results = await Promise.all(entries.map(async (entry) => {
      const storageDir = path3.join(root, entry);
      const chatSessionsDir = path3.join(storageDir, "chatSessions");
      try {
        const stat = await fs3.promises.stat(chatSessionsDir);
        if (!stat.isDirectory()) {
          return null;
        }
      } catch {
        return null;
      }
      const workspacePath = await readWorkspaceJsonAsync(storageDir);
      if (workspacePath === void 0) {
        return null;
      }
      try {
        await fs3.promises.access(workspacePath);
      } catch {
        return null;
      }
      return { workspaceId: entry, workspacePath, storageDir };
    }));
    return results.filter((r) => r !== null);
  } catch {
    return [];
  }
}
async function listSessionFilesAsync(storageHashDir) {
  try {
    const chatSessionsDir = path3.join(storageHashDir, "chatSessions");
    const files = await fs3.promises.readdir(chatSessionsDir);
    return files.filter((f) => f.endsWith(".jsonl")).map((f) => path3.join(chatSessionsDir, f));
  } catch {
    return [];
  }
}

// src/watcher/configPaths.ts
var path7 = __toESM(require("path"));
var os5 = __toESM(require("os"));

// src/readers/clineWorkspace.ts
var fs4 = __toESM(require("fs"));
var path4 = __toESM(require("path"));
var os2 = __toESM(require("os"));
var MAX_TASK_DIRS = 1e4;
function getClineStorageRoot() {
  return getClineCompatStorageRoot("saoudrizwan.claude-dev");
}
function getClineCompatStorageRoot(extensionId) {
  const platform = process.platform;
  let globalStorageBase;
  if (platform === "win32") {
    globalStorageBase = path4.join(
      process.env["APPDATA"] || os2.homedir(),
      "Code",
      "User",
      "globalStorage"
    );
  } else if (platform === "darwin") {
    globalStorageBase = path4.join(
      os2.homedir(),
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage"
    );
  } else {
    globalStorageBase = path4.join(
      process.env["XDG_CONFIG_HOME"] || path4.join(os2.homedir(), ".config"),
      "Code",
      "User",
      "globalStorage"
    );
  }
  return path4.join(globalStorageBase, extensionId, "tasks");
}
function getRooCodeStorageRoot() {
  return getClineCompatStorageRoot("rooveterinaryinc.roo-cline");
}
async function discoverClineTasksAsync(override) {
  const root = override !== void 0 && override !== "" ? override : getClineStorageRoot();
  let entries;
  try {
    entries = await fs4.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.length > MAX_TASK_DIRS) {
    console.warn(
      `[Chat Wizard] Cline: found ${entries.length} task directories \u2014 only the first ${MAX_TASK_DIRS} will be scanned.`
    );
    entries = entries.slice(0, MAX_TASK_DIRS);
  }
  const results = await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) {
      return null;
    }
    const taskDir = path4.join(root, entry.name);
    try {
      const lstat = await fs4.promises.lstat(taskDir);
      if (lstat.isSymbolicLink()) {
        return null;
      }
    } catch {
      return null;
    }
    const conversationFile = path4.join(taskDir, "api_conversation_history.json");
    try {
      const stat = await fs4.promises.stat(conversationFile);
      if (!stat.isFile()) {
        return null;
      }
    } catch {
      return null;
    }
    return { taskId: entry.name, storageDir: taskDir, conversationFile };
  }));
  return results.filter((r) => r !== null);
}
async function discoverRooCodeTasksAsync(override) {
  const root = override !== void 0 && override !== "" ? override : getRooCodeStorageRoot();
  return discoverClineTasksAsync(root);
}

// src/readers/cursorWorkspace.ts
var fs5 = __toESM(require("fs"));
var path5 = __toESM(require("path"));
var os3 = __toESM(require("os"));
var MAX_VSCDB_BYTES = 500 * 1024 * 1024;
function getCursorStorageRoot() {
  const platform = process.platform;
  if (platform === "win32") {
    return path5.join(
      process.env["APPDATA"] || os3.homedir(),
      "Cursor",
      "User",
      "workspaceStorage"
    );
  } else if (platform === "darwin") {
    return path5.join(
      os3.homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "workspaceStorage"
    );
  } else {
    return path5.join(
      process.env["XDG_CONFIG_HOME"] || path5.join(os3.homedir(), ".config"),
      "Cursor",
      "User",
      "workspaceStorage"
    );
  }
}
async function readWorkspaceJsonAsync2(storageHashDir) {
  try {
    const workspaceJsonPath = path5.join(storageHashDir, "workspace.json");
    const raw = await fs5.promises.readFile(workspaceJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    const folder = parsed.folder;
    if (!folder) {
      return void 0;
    }
    let decoded = decodeURIComponent(folder.replace("file://", ""));
    if (process.platform === "win32" && decoded.startsWith("/")) {
      decoded = decoded.slice(1);
    }
    return decoded;
  } catch {
    return void 0;
  }
}
async function discoverCursorWorkspacesAsync(override) {
  const root = override !== void 0 && override !== "" ? override : getCursorStorageRoot();
  let entries;
  try {
    entries = await fs5.promises.readdir(root);
  } catch {
    return [];
  }
  const results = await Promise.all(entries.map(async (entry) => {
    const storageDir = path5.join(root, entry);
    try {
      const lstat = await fs5.promises.lstat(storageDir);
      if (!lstat.isDirectory() || lstat.isSymbolicLink()) {
        return null;
      }
    } catch {
      return null;
    }
    const vscdbPath = path5.join(storageDir, "state.vscdb");
    try {
      const lstat = await fs5.promises.lstat(vscdbPath);
      if (!lstat.isFile() || lstat.isSymbolicLink()) {
        return null;
      }
      if (lstat.size > MAX_VSCDB_BYTES) {
        return null;
      }
    } catch {
      return null;
    }
    const workspacePath = await readWorkspaceJsonAsync2(storageDir);
    if (workspacePath === void 0) {
      return null;
    }
    try {
      await fs5.promises.access(workspacePath);
    } catch {
      return null;
    }
    return {
      id: entry,
      source: "cursor",
      workspacePath,
      storageDir
    };
  }));
  return results.filter((r) => r !== null);
}

// src/readers/windsurfWorkspace.ts
var fs6 = __toESM(require("fs"));
var path6 = __toESM(require("path"));
var os4 = __toESM(require("os"));
var MAX_VSCDB_BYTES2 = 500 * 1024 * 1024;
function getWindsurfStorageRoot() {
  const platform = process.platform;
  if (platform === "win32") {
    return path6.join(
      process.env["APPDATA"] || os4.homedir(),
      "Windsurf",
      "User",
      "workspaceStorage"
    );
  } else if (platform === "darwin") {
    return path6.join(
      os4.homedir(),
      "Library",
      "Application Support",
      "Windsurf",
      "User",
      "workspaceStorage"
    );
  } else {
    return path6.join(
      process.env["XDG_CONFIG_HOME"] || path6.join(os4.homedir(), ".config"),
      "Windsurf",
      "User",
      "workspaceStorage"
    );
  }
}
async function readWorkspaceJsonAsync3(storageHashDir) {
  try {
    const workspaceJsonPath = path6.join(storageHashDir, "workspace.json");
    const raw = await fs6.promises.readFile(workspaceJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    const folder = parsed.folder;
    if (!folder) {
      return void 0;
    }
    let decoded = decodeURIComponent(folder.replace("file://", ""));
    if (process.platform === "win32" && decoded.startsWith("/")) {
      decoded = decoded.slice(1);
    }
    return decoded;
  } catch {
    return void 0;
  }
}
async function discoverWindsurfWorkspacesAsync(override) {
  const root = override !== void 0 && override !== "" ? override : getWindsurfStorageRoot();
  let entries;
  try {
    entries = await fs6.promises.readdir(root);
  } catch {
    return [];
  }
  const results = await Promise.all(entries.map(async (entry) => {
    const storageDir = path6.join(root, entry);
    try {
      const lstat = await fs6.promises.lstat(storageDir);
      if (!lstat.isDirectory() || lstat.isSymbolicLink()) {
        return null;
      }
    } catch {
      return null;
    }
    const vscdbPath = path6.join(storageDir, "state.vscdb");
    try {
      const lstat = await fs6.promises.lstat(vscdbPath);
      if (!lstat.isFile() || lstat.isSymbolicLink()) {
        return null;
      }
      if (lstat.size > MAX_VSCDB_BYTES2) {
        return null;
      }
    } catch {
      return null;
    }
    const workspacePath = await readWorkspaceJsonAsync3(storageDir);
    if (workspacePath === void 0) {
      return null;
    }
    try {
      await fs6.promises.access(workspacePath);
    } catch {
      return null;
    }
    return {
      id: entry,
      source: "windsurf",
      workspacePath,
      storageDir
    };
  }));
  return results.filter((r) => r !== null);
}

// src/watcher/configPaths.ts
function resolveClaudeProjectsPath(override) {
  if (override !== void 0 && override !== "") {
    return override;
  }
  try {
    const vscode15 = require("vscode");
    const cfg = vscode15.workspace.getConfiguration("chatwizard");
    const configured = cfg.get("claudeProjectsPath");
    if (configured && configured !== "") {
      return configured;
    }
  } catch {
  }
  return path7.join(os5.homedir(), ".claude", "projects");
}
function resolveClineStoragePath(override) {
  if (override !== void 0 && override !== "") {
    return override;
  }
  try {
    const vscode15 = require("vscode");
    const cfg = vscode15.workspace.getConfiguration("chatwizard");
    const configured = cfg.get("clineStoragePath");
    if (configured && configured !== "") {
      return configured;
    }
  } catch {
  }
  return getClineStorageRoot();
}
function resolveRooCodeStoragePath(override) {
  if (override !== void 0 && override !== "") {
    return override;
  }
  try {
    const vscode15 = require("vscode");
    const cfg = vscode15.workspace.getConfiguration("chatwizard");
    const configured = cfg.get("rooCodeStoragePath");
    if (configured && configured !== "") {
      return configured;
    }
  } catch {
  }
  return getRooCodeStorageRoot();
}
function resolveCursorStoragePath(override) {
  if (override !== void 0 && override !== "") {
    return override;
  }
  try {
    const vscode15 = require("vscode");
    const cfg = vscode15.workspace.getConfiguration("chatwizard");
    const configured = cfg.get("cursorStoragePath");
    if (configured && configured !== "") {
      return configured;
    }
  } catch {
  }
  return getCursorStorageRoot();
}
function resolveWindsurfStoragePath(override) {
  if (override !== void 0 && override !== "") {
    return override;
  }
  try {
    const vscode15 = require("vscode");
    const cfg = vscode15.workspace.getConfiguration("chatwizard");
    const configured = cfg.get("windsurfStoragePath");
    if (configured && configured !== "") {
      return configured;
    }
  } catch {
  }
  return getWindsurfStorageRoot();
}

// src/watcher/workspaceScope.ts
var fs7 = __toESM(require("fs"));
var path8 = __toESM(require("path"));
var STORAGE_KEY = "chatwizard.selectedWorkspaceIds";
var LEGACY_MANUAL_KEY = "chatwizard.workspaceScopeManuallySet";
var WorkspaceScopeManager = class {
  _context;
  constructor(context) {
    this._context = context;
  }
  /** Returns the normalised, lowercase paths of currently open VS Code workspace folders. */
  _getOpenFolderPaths() {
    try {
      const vscode15 = require("vscode");
      return (vscode15.workspace.workspaceFolders ?? []).map(
        (f) => path8.normalize(f.uri.fsPath).toLowerCase()
      );
    } catch {
      return [];
    }
  }
  /**
   * Called on every activation. Always overwrites the persisted scope with the
   * currently open VS Code workspace folder(s).
   *
   * - Open workspace found in `available` → scope = those IDs only.
   * - Open workspace not yet in `available` (no chat history) → scope = `[]`.
   * - No workspace open → scope = `[]`.
   *
   * On Windows path comparison is case-insensitive; both sides are `path.normalize()`d.
   */
  async initDefault(available) {
    const openFolderPaths = this._getOpenFolderPaths();
    let ids;
    if (openFolderPaths.length === 0) {
      ids = [];
    } else {
      ids = available.filter((ws) => openFolderPaths.includes(path8.normalize(ws.workspacePath).toLowerCase())).map((ws) => ws.id);
    }
    await this._context.globalState.update(STORAGE_KEY, ids);
  }
  /** Returns the currently persisted list of selected workspace IDs. */
  getSelectedIds() {
    return this._context.globalState.get(STORAGE_KEY) ?? [];
  }
  /** Persists a new selection of workspace IDs. */
  setSelectedIds(ids) {
    void this._context.globalState.update(STORAGE_KEY, ids);
  }
  /**
   * Clears the persisted scope so `initDefault()` re-detects on next activation.
   * Also clears any legacy manual-mode flag from earlier versions.
   */
  resetToDefault() {
    void this._context.globalState.update(STORAGE_KEY, void 0);
    void this._context.globalState.update(LEGACY_MANUAL_KEY, void 0);
  }
};
async function calcWorkspaceSizeBytes(storageDir, source) {
  try {
    if (source === "copilot") {
      const dir = path8.join(storageDir, "chatSessions");
      const entries = await fs7.promises.readdir(dir);
      const sizes = await Promise.all(
        entries.filter((e) => e.endsWith(".jsonl")).map(async (f) => {
          try {
            return (await fs7.promises.stat(path8.join(dir, f))).size;
          } catch {
            return 0;
          }
        })
      );
      return sizes.reduce((acc, s) => acc + s, 0);
    }
    if (source === "claude") {
      const entries = await fs7.promises.readdir(storageDir);
      const sizes = await Promise.all(
        entries.filter((e) => e.endsWith(".jsonl")).map(async (f) => {
          try {
            return (await fs7.promises.stat(path8.join(storageDir, f))).size;
          } catch {
            return 0;
          }
        })
      );
      return sizes.reduce((acc, s) => acc + s, 0);
    }
    if (source === "cline" || source === "roocode") {
      const entries = await fs7.promises.readdir(storageDir, { withFileTypes: true });
      const sizes = await Promise.all(
        entries.filter((e) => e.isDirectory()).map(async (entry) => {
          const convFile = path8.join(storageDir, entry.name, "api_conversation_history.json");
          try {
            return (await fs7.promises.stat(convFile)).size;
          } catch {
            return 0;
          }
        })
      );
      return sizes.reduce((acc, s) => acc + s, 0);
    }
    if (source === "cursor" || source === "windsurf") {
      const vscdb = path8.join(storageDir, "state.vscdb");
      try {
        return (await fs7.promises.stat(vscdb)).size;
      } catch {
        return 0;
      }
    }
    if (source === "aider") {
      const histFile = path8.join(storageDir, ".aider.chat.history.md");
      try {
        return (await fs7.promises.stat(histFile)).size;
      } catch {
        return 0;
      }
    }
    return 0;
  } catch {
    return 0;
  }
}
async function countWorkspaceSessions(storageDir, source) {
  try {
    if (source === "copilot") {
      const dir = path8.join(storageDir, "chatSessions");
      const entries = await fs7.promises.readdir(dir);
      return entries.filter((e) => e.endsWith(".jsonl")).length;
    }
    if (source === "claude") {
      const entries = await fs7.promises.readdir(storageDir);
      return entries.filter((e) => e.endsWith(".jsonl")).length;
    }
    if (source === "cline" || source === "roocode") {
      const entries = await fs7.promises.readdir(storageDir, { withFileTypes: true });
      const counts = await Promise.all(
        entries.filter((e) => e.isDirectory()).map(async (entry) => {
          const convFile = path8.join(storageDir, entry.name, "api_conversation_history.json");
          try {
            await fs7.promises.access(convFile);
            return 1;
          } catch {
            return 0;
          }
        })
      );
      return counts.reduce((acc, c) => acc + c, 0);
    }
    if (source === "cursor" || source === "windsurf") {
      const vscdb = path8.join(storageDir, "state.vscdb");
      try {
        await fs7.promises.access(vscdb);
        return 1;
      } catch {
        return 0;
      }
    }
    if (source === "aider") {
      const histFile = path8.join(storageDir, ".aider.chat.history.md");
      try {
        await fs7.promises.access(histFile);
        return 1;
      } catch {
        return 0;
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

// src/parsers/cline.ts
var fs8 = __toESM(require("fs"));
var path9 = __toESM(require("path"));
var MAX_FILE_BYTES = 50 * 1024 * 1024;
var MAX_ARRAY_LENGTH = 5e4;
var MAX_TITLE_CHARS = 120;
function extractContent(content) {
  if (typeof content === "string") {
    return content;
  }
  return content.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
}
function extractClineCodeBlocks(content, sessionId, messageIndex) {
  return extractCodeBlocks2(content, sessionId, messageIndex);
}
async function parseClineTask(taskDir, _maxLineChars, source = "cline") {
  const taskId = path9.basename(taskDir);
  const errors = [];
  const emptySession = {
    id: taskId,
    title: "Untitled Task",
    source,
    workspaceId: taskId,
    workspacePath: void 0,
    messages: [],
    filePath: taskDir,
    createdAt: (/* @__PURE__ */ new Date(0)).toISOString(),
    updatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
  };
  const conversationFile = path9.join(taskDir, "api_conversation_history.json");
  let apiEntries = [];
  try {
    const stat = await fs8.promises.stat(conversationFile);
    if (stat.size > MAX_FILE_BYTES) {
      errors.push(`api_conversation_history.json exceeds 50 MB size limit (${stat.size} bytes) \u2014 skipped`);
      return { session: emptySession, errors };
    }
    const raw = await fs8.promises.readFile(conversationFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      errors.push("api_conversation_history.json root value is not an array");
      return { session: emptySession, errors };
    }
    if (parsed.length > MAX_ARRAY_LENGTH) {
      errors.push(`api_conversation_history.json has ${parsed.length} entries \u2014 truncating to ${MAX_ARRAY_LENGTH}`);
      apiEntries = parsed.slice(0, MAX_ARRAY_LENGTH);
    } else {
      apiEntries = parsed;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Failed to read/parse api_conversation_history.json: ${msg}`);
    return { session: emptySession, errors };
  }
  let uiMessages = [];
  const uiFile = path9.join(taskDir, "ui_messages.json");
  try {
    const stat = await fs8.promises.stat(uiFile);
    if (stat.size <= MAX_FILE_BYTES) {
      const raw = await fs8.promises.readFile(uiFile, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        uiMessages = parsed;
      }
    }
  } catch {
  }
  let createdAt;
  let updatedAt;
  let workspacePath;
  let model;
  for (const ui of uiMessages) {
    if (typeof ui.ts === "number" && ui.ts > 0) {
      const iso = new Date(ui.ts).toISOString();
      if (!createdAt) {
        createdAt = iso;
      }
      updatedAt = iso;
    }
    if (!workspacePath && typeof ui.cwd === "string" && ui.cwd) {
      workspacePath = ui.cwd;
    }
    if (!model && typeof ui.modelInfo?.modelId === "string" && ui.modelInfo.modelId) {
      model = ui.modelInfo.modelId;
    }
    if (!model && typeof ui.model === "string" && ui.model) {
      model = ui.model;
    }
    if (!model && ui.say === "api_req_started" && typeof ui.text === "string") {
      try {
        const parsed = JSON.parse(ui.text);
        if (typeof parsed["model"] === "string" && parsed["model"]) {
          model = parsed["model"];
        }
      } catch {
      }
    }
  }
  if (!workspacePath) {
    const RE_CWD = /# Current Working Directory \(([^)]+)\)/;
    for (const entry of apiEntries) {
      if (entry.role === "user") {
        const text = extractContent(entry.content);
        const m = text.match(RE_CWD);
        if (m) {
          workspacePath = m[1];
        }
        break;
      }
    }
  }
  const messages = [];
  for (const entry of apiEntries) {
    const role = entry.role === "user" ? "user" : "assistant";
    const content = extractContent(entry.content);
    if (!content.trim()) {
      continue;
    }
    const messageIndex = messages.length;
    messages.push({
      id: `${taskId}-${messageIndex}`,
      role,
      content,
      codeBlocks: extractClineCodeBlocks(content, taskId, messageIndex)
    });
  }
  let title = "Untitled Task";
  const taskUiMsg = uiMessages.find((m) => m.say === "task" && typeof m.text === "string" && m.text?.trim());
  if (taskUiMsg) {
    const text = taskUiMsg.text.trim();
    const firstLine = text.split("\n")[0] || text;
    title = firstLine.length > MAX_TITLE_CHARS ? firstLine.slice(0, MAX_TITLE_CHARS) + "\u2026" : firstLine;
  } else {
    const firstUserMsg = messages.find((m) => m.role === "user");
    if (firstUserMsg) {
      const taskMatch = firstUserMsg.content.match(/<task>\s*([\s\S]*?)\s*<\/task>/);
      const base = taskMatch ? taskMatch[1].split("\n")[0] || taskMatch[1] : firstUserMsg.content.split("\n").find((l) => l.trim() && !l.startsWith("<")) ?? firstUserMsg.content;
      title = base.length > MAX_TITLE_CHARS ? base.slice(0, MAX_TITLE_CHARS) + "\u2026" : base;
    }
  }
  let fileSizeBytes;
  if (!createdAt || !updatedAt) {
    try {
      const stat = await fs8.promises.stat(conversationFile);
      fileSizeBytes = stat.size;
      const mtime = stat.mtime.toISOString();
      if (!createdAt) {
        createdAt = mtime;
      }
      if (!updatedAt) {
        updatedAt = mtime;
      }
    } catch {
    }
  } else {
    try {
      fileSizeBytes = (await fs8.promises.stat(conversationFile)).size;
    } catch {
    }
  }
  return {
    session: {
      id: taskId,
      title,
      source,
      workspaceId: taskId,
      workspacePath,
      model,
      messages,
      filePath: taskDir,
      fileSizeBytes,
      createdAt: createdAt ?? (/* @__PURE__ */ new Date(0)).toISOString(),
      updatedAt: updatedAt ?? (/* @__PURE__ */ new Date(0)).toISOString()
    },
    errors
  };
}

// src/parsers/cursor.ts
var path10 = __toESM(require("path"));
var MAX_COMPOSERS = 5e3;
var MAX_TITLE_CHARS2 = 120;
function extractCursorCodeBlocks(content, sessionId, messageIndex) {
  return extractCodeBlocks2(content, sessionId, messageIndex);
}
async function parseCursorWorkspace(vscdbPath, workspaceId, workspacePath) {
  const fatalResult = (msg) => [{
    session: {
      id: `${workspaceId}-cursor-error`,
      title: "Cursor workspace (parse error)",
      source: "cursor",
      workspaceId,
      workspacePath,
      messages: [],
      filePath: vscdbPath,
      createdAt: (/* @__PURE__ */ new Date(0)).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
    },
    errors: [msg]
  }];
  let rawValue = null;
  try {
    const Database = require("better-sqlite3");
    const db = new Database(vscdbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare(
        "SELECT value FROM ItemTable WHERE key = 'composer.composerData'"
      ).get();
      rawValue = row?.value ?? null;
    } finally {
      db.close();
    }
  } catch (err) {
    return fatalResult(
      `Failed to open/query state.vscdb: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (rawValue == null) {
    return fatalResult("Missing 'composer.composerData' key in state.vscdb");
  }
  let composerData;
  try {
    composerData = JSON.parse(rawValue);
  } catch (err) {
    return fatalResult(
      `Failed to parse composer.composerData JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const allComposers = composerData?.allComposers;
  if (!Array.isArray(allComposers)) {
    return fatalResult("composer.composerData.allComposers is not an array");
  }
  if (allComposers.length === 0) {
    return [];
  }
  const composers = allComposers.slice(0, MAX_COMPOSERS);
  return composers.map((composer) => {
    const composerId = typeof composer.composerId === "string" && composer.composerId ? composer.composerId : `${workspaceId}-${path10.basename(vscdbPath)}-unknown`;
    const errors = [];
    const conversation = Array.isArray(composer.conversation) ? composer.conversation : [];
    const messages = [];
    for (const item of conversation) {
      if (item.type !== 1 && item.type !== 2) {
        continue;
      }
      const role = item.type === 1 ? "user" : "assistant";
      const content = typeof item.text === "string" && item.text ? item.text : typeof item.richText === "string" ? item.richText : "";
      if (!content.trim()) {
        continue;
      }
      const messageIndex = messages.length;
      messages.push({
        id: `${composerId}-${messageIndex}`,
        role,
        content,
        codeBlocks: extractCursorCodeBlocks(content, composerId, messageIndex),
        timestamp: typeof item.unixMs === "number" && item.unixMs > 0 ? new Date(item.unixMs).toISOString() : void 0
      });
    }
    const firstUserMsg = messages.find((m) => m.role === "user");
    let title;
    if (typeof composer.name === "string" && composer.name.trim()) {
      title = composer.name.trim();
    } else if (firstUserMsg) {
      const firstLine = firstUserMsg.content.split("\n")[0];
      const base = firstLine || firstUserMsg.content;
      title = base.length > MAX_TITLE_CHARS2 ? base.slice(0, MAX_TITLE_CHARS2) + "\u2026" : base;
    } else {
      title = "Untitled";
    }
    const createdAt = typeof composer.createdAt === "number" && composer.createdAt > 0 ? new Date(composer.createdAt).toISOString() : messages.find((m) => m.timestamp)?.timestamp ?? (/* @__PURE__ */ new Date(0)).toISOString();
    const lastTimestampMsg = [...messages].reverse().find((m) => m.timestamp);
    const updatedAt = lastTimestampMsg?.timestamp ?? createdAt;
    return {
      session: {
        id: composerId,
        title,
        source: "cursor",
        workspaceId,
        workspacePath,
        messages,
        filePath: vscdbPath,
        createdAt,
        updatedAt
      },
      errors
    };
  });
}

// src/parsers/windsurf.ts
var MAX_SESSIONS = 5e3;
var MAX_TITLE_CHARS3 = 120;
function extractWindsurfCodeBlocks(content, sessionId, messageIndex) {
  return extractCodeBlocks2(content, sessionId, messageIndex);
}
async function parseWindsurfWorkspace(vscdbPath, workspaceId, workspacePath) {
  const fatalResult = (msg) => [{
    session: {
      id: `${workspaceId}-windsurf-error`,
      title: "Windsurf workspace (parse error)",
      source: "windsurf",
      workspaceId,
      workspacePath,
      messages: [],
      filePath: vscdbPath,
      createdAt: (/* @__PURE__ */ new Date(0)).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
    },
    errors: [msg]
  }];
  let rawValue = null;
  try {
    const Database = require("better-sqlite3");
    const db = new Database(vscdbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare(
        "SELECT value FROM ItemTable WHERE key = 'cascade.sessionData'"
      ).get();
      rawValue = row?.value ?? null;
    } finally {
      db.close();
    }
  } catch (err) {
    return fatalResult(
      `Failed to open/query state.vscdb: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (rawValue == null) {
    return fatalResult("Missing 'cascade.sessionData' key in state.vscdb");
  }
  let cascadeData;
  try {
    cascadeData = JSON.parse(rawValue);
  } catch (err) {
    return fatalResult(
      `Failed to parse cascade.sessionData JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const allSessions = cascadeData?.sessions;
  if (!Array.isArray(allSessions)) {
    return fatalResult("cascade.sessionData.sessions is not an array");
  }
  if (allSessions.length === 0) {
    return [];
  }
  const sessions = allSessions.slice(0, MAX_SESSIONS);
  return sessions.map((cascadeSession) => {
    const sessionId = typeof cascadeSession.sessionId === "string" && cascadeSession.sessionId ? cascadeSession.sessionId : `${workspaceId}-windsurf-unknown`;
    const errors = [];
    const rawMessages = Array.isArray(cascadeSession.messages) ? cascadeSession.messages : [];
    const messages = [];
    for (const msg of rawMessages) {
      if (msg.role !== "user" && msg.role !== "assistant") {
        continue;
      }
      const content = typeof msg.content === "string" ? msg.content : "";
      if (!content.trim()) {
        continue;
      }
      const messageIndex = messages.length;
      messages.push({
        id: `${sessionId}-${messageIndex}`,
        role: msg.role,
        content,
        codeBlocks: extractWindsurfCodeBlocks(content, sessionId, messageIndex),
        timestamp: typeof msg.timestamp === "number" && msg.timestamp > 0 ? new Date(msg.timestamp).toISOString() : void 0
      });
    }
    const firstUserMsg = messages.find((m) => m.role === "user");
    let title;
    if (typeof cascadeSession.title === "string" && cascadeSession.title.trim()) {
      title = cascadeSession.title.trim();
    } else if (firstUserMsg) {
      const firstLine = firstUserMsg.content.split("\n")[0];
      const base = firstLine || firstUserMsg.content;
      title = base.length > MAX_TITLE_CHARS3 ? base.slice(0, MAX_TITLE_CHARS3) + "\u2026" : base;
    } else {
      title = "Untitled";
    }
    const createdAt = typeof cascadeSession.createdAt === "number" && cascadeSession.createdAt > 0 ? new Date(cascadeSession.createdAt).toISOString() : messages.find((m) => m.timestamp)?.timestamp ?? (/* @__PURE__ */ new Date(0)).toISOString();
    const lastTimestampMsg = [...messages].reverse().find((m) => m.timestamp);
    const updatedAt = lastTimestampMsg?.timestamp ?? createdAt;
    return {
      session: {
        id: sessionId,
        title,
        source: "windsurf",
        workspaceId,
        workspacePath,
        messages,
        filePath: vscdbPath,
        createdAt,
        updatedAt
      },
      errors
    };
  });
}

// src/readers/aiderWorkspace.ts
var fs9 = __toESM(require("fs"));
var path11 = __toESM(require("path"));
var AIDER_HISTORY_FILENAME = ".aider.chat.history.md";
var AIDER_CONFIG_FILENAME = ".aider.conf.yml";
var MAX_HISTORY_BYTES = 20 * 1024 * 1024;
var DEFAULT_AIDER_SEARCH_DEPTH = 3;
var MAX_AIDER_SEARCH_DEPTH = 5;
async function searchDirAsync(rootDir, maxDepth) {
  const results = [];
  await _walkAsync(rootDir, rootDir, 1, maxDepth, results);
  return results;
}
async function _walkAsync(currentDir, _rootDir, currentDepth, maxDepth, results) {
  let entries;
  try {
    entries = await fs9.promises.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      continue;
    }
    if (entry.name !== AIDER_HISTORY_FILENAME) {
      continue;
    }
    const historyFile = path11.join(currentDir, entry.name);
    try {
      const lstat = await fs9.promises.lstat(historyFile);
      if (!lstat.isFile() || lstat.isSymbolicLink()) {
        continue;
      }
      if (lstat.size > MAX_HISTORY_BYTES) {
        continue;
      }
    } catch {
      continue;
    }
    const workspacePath = currentDir;
    let configFile;
    const candidate = path11.join(currentDir, AIDER_CONFIG_FILENAME);
    try {
      const cfgStat = await fs9.promises.lstat(candidate);
      if (cfgStat.isFile() && !cfgStat.isSymbolicLink()) {
        configFile = candidate;
      }
    } catch {
    }
    results.push({ historyFile, workspacePath, configFile });
  }
  if (currentDepth < maxDepth) {
    await Promise.all(
      entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => _walkAsync(path11.join(currentDir, e.name), _rootDir, currentDepth + 1, maxDepth, results))
    );
  }
}
async function discoverAiderHistoryFilesAsync(roots, maxDepth = DEFAULT_AIDER_SEARCH_DEPTH) {
  const depth = Math.min(Math.max(1, maxDepth), MAX_AIDER_SEARCH_DEPTH);
  const allResults = await Promise.all(roots.map((r) => searchDirAsync(r, depth)));
  const seen = /* @__PURE__ */ new Set();
  const merged = [];
  for (const batch of allResults) {
    for (const info of batch) {
      if (!seen.has(info.historyFile)) {
        seen.add(info.historyFile);
        merged.push(info);
      }
    }
  }
  return merged;
}

// src/parsers/aider.ts
var fs10 = __toESM(require("fs"));
var crypto = __toESM(require("crypto"));
var DEFAULT_MAX_LINE_CHARS2 = 1e6;
var MAX_MESSAGE_BYTES = 1024 * 1024;
var MAX_TITLE_CHARS4 = 120;
var RE_SESSION_START = /^#\s+aider chat started at\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/i;
var USER_PREFIX = "#### ";
var CMD_PREFIX = "> ";
function extractAiderCodeBlocks(content, sessionId, messageIndex) {
  return extractCodeBlocks2(content, sessionId, messageIndex);
}
function parseAiderHistory(info, maxLineChars = DEFAULT_MAX_LINE_CHARS2) {
  const sessionId = crypto.createHash("sha1").update(info.historyFile).digest("hex");
  const errors = [];
  let rawContent;
  try {
    rawContent = fs10.readFileSync(info.historyFile, "utf8");
  } catch (err) {
    const msg = `Failed to read ${info.historyFile}: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    return {
      session: _emptySession(sessionId, info, errors),
      errors
    };
  }
  const model = _readModel(info.configFile);
  let mtimeIso;
  try {
    const st = fs10.statSync(info.historyFile);
    mtimeIso = st.mtime.toISOString();
  } catch {
    mtimeIso = (/* @__PURE__ */ new Date(0)).toISOString();
  }
  if (rawContent.trim() === "") {
    return {
      session: {
        ..._emptySession(sessionId, info, errors),
        model,
        updatedAt: mtimeIso
      },
      errors
    };
  }
  const lines = rawContent.split("\n");
  let createdAt;
  const messages = [];
  let assistantLines = [];
  let assistantByteCount = 0;
  let assistantTruncated = false;
  function flushAssistant() {
    if (assistantLines.length === 0) {
      return;
    }
    let content = assistantLines.join("\n").trim();
    if (!content) {
      assistantLines = [];
      assistantByteCount = 0;
      assistantTruncated = false;
      return;
    }
    if (assistantTruncated) {
      content += "\n[...truncated \u2014 exceeded 1 MB limit]";
      errors.push(`Assistant message truncated at 1 MB in ${info.historyFile}`);
    }
    const messageIndex = messages.length;
    messages.push({
      id: `${sessionId}-${messageIndex}`,
      role: "assistant",
      content,
      codeBlocks: extractAiderCodeBlocks(content, sessionId, messageIndex)
    });
    assistantLines = [];
    assistantByteCount = 0;
    assistantTruncated = false;
  }
  for (const rawLine of lines) {
    if (rawLine.length > maxLineChars) {
      errors.push(`Line skipped \u2014 length ${rawLine.length} exceeds limit ${maxLineChars} in ${info.historyFile}`);
      continue;
    }
    const startMatch = RE_SESSION_START.exec(rawLine);
    if (startMatch) {
      createdAt = new Date(startMatch[1].replace(" ", "T")).toISOString();
      continue;
    }
    if (rawLine.startsWith(USER_PREFIX)) {
      flushAssistant();
      const userText = rawLine.slice(USER_PREFIX.length).trim();
      if (userText) {
        const messageIndex = messages.length;
        messages.push({
          id: `${sessionId}-${messageIndex}`,
          role: "user",
          content: userText,
          codeBlocks: extractAiderCodeBlocks(userText, sessionId, messageIndex)
        });
      }
      continue;
    }
    if (rawLine.startsWith(CMD_PREFIX)) {
      continue;
    }
    if (rawLine.trim() === "") {
      if (assistantLines.length > 0) {
        assistantLines.push("");
      }
      continue;
    }
    if (!assistantTruncated) {
      const lineBytes = Buffer.byteLength(rawLine, "utf8");
      if (assistantByteCount + lineBytes > MAX_MESSAGE_BYTES) {
        assistantTruncated = true;
      } else {
        assistantLines.push(rawLine);
        assistantByteCount += lineBytes;
      }
    }
  }
  flushAssistant();
  const finalCreatedAt = createdAt ?? mtimeIso;
  const finalUpdatedAt = mtimeIso;
  const firstUserMsg = messages.find((m) => m.role === "user");
  let title;
  if (firstUserMsg) {
    const firstLine = firstUserMsg.content.split("\n")[0];
    const base = firstLine || firstUserMsg.content;
    title = base.length > MAX_TITLE_CHARS4 ? base.slice(0, MAX_TITLE_CHARS4) + "\u2026" : base;
  } else {
    title = "Untitled Aider Session";
  }
  return {
    session: {
      id: sessionId,
      title,
      source: "aider",
      workspaceId: sessionId,
      workspacePath: info.workspacePath,
      model,
      messages,
      filePath: info.historyFile,
      createdAt: finalCreatedAt,
      updatedAt: finalUpdatedAt
    },
    errors
  };
}
function _emptySession(sessionId, info, errors) {
  return {
    id: sessionId,
    title: "Untitled Aider Session",
    source: "aider",
    workspaceId: sessionId,
    workspacePath: info.workspacePath,
    messages: [],
    filePath: info.historyFile,
    createdAt: (/* @__PURE__ */ new Date(0)).toISOString(),
    updatedAt: (/* @__PURE__ */ new Date(0)).toISOString(),
    parseErrors: errors.length > 0 ? errors : void 0
  };
}
function _readModel(configFile) {
  if (!configFile) {
    return void 0;
  }
  try {
    const raw = fs10.readFileSync(configFile, "utf8");
    for (const line of raw.split("\n")) {
      const match = /^model:\s*(.+)/.exec(line.trim());
      if (match) {
        return match[1].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
  }
  return void 0;
}

// src/watcher/fileWatcher.ts
var ChatWizardWatcher = class _ChatWizardWatcher {
  disposables = [];
  index;
  channel;
  scopeManager;
  constructor(index, channel, scopeManager) {
    this.index = index;
    this.channel = channel;
    this.scopeManager = scopeManager;
  }
  // SEC-6: Symlink traversal guards — ensure resolved path stays within base directory.
  /**
   * Returns true if `filePath`, after resolving all symlinks, is contained within
   * `resolvedBase`. Prevents symlink-based path traversal to files outside the
   * expected session directories.
   */
  static _isSafeFilePath(resolvedBase, filePath) {
    try {
      const realPath = fs11.realpathSync(filePath);
      return realPath.startsWith(resolvedBase + path12.sep) || realPath === resolvedBase;
    } catch {
      return false;
    }
  }
  static async _isSafeFilePathAsync(resolvedBase, filePath) {
    try {
      const realPath = await fs11.promises.realpath(filePath);
      return realPath.startsWith(resolvedBase + path12.sep) || realPath === resolvedBase;
    } catch {
      return false;
    }
  }
  async start() {
    const cfg = vscode.workspace.getConfiguration("chatwizard");
    const enabled = cfg.get("enabled", true);
    const indexClaude = cfg.get("indexClaude", true);
    const indexCopilot = cfg.get("indexCopilot", true);
    const indexCline = cfg.get("indexCline", true);
    const indexRooCode = cfg.get("indexRooCode", true);
    const indexCursor = cfg.get("indexCursor", true);
    const indexWindsurf = cfg.get("indexWindsurf", true);
    const indexAider = cfg.get("indexAider", true);
    if (!enabled) {
      this.channel.appendLine("[Chat Wizard] Extension disabled via chatwizard.enabled setting \u2014 skipping indexing and file watching.");
      this.index.batchUpsert([]);
      return;
    }
    await this.buildInitialIndex(indexClaude, indexCopilot, indexCline, indexRooCode, indexCursor, indexWindsurf, indexAider);
    if (indexClaude) {
      const claudeBaseDir = resolveClaudeProjectsPath();
      const claudePattern = new vscode.RelativePattern(
        vscode.Uri.file(claudeBaseDir),
        "**/*.jsonl"
      );
      const claudeWatcher = vscode.workspace.createFileSystemWatcher(claudePattern);
      claudeWatcher.onDidCreate((uri) => this.onFileChanged(uri, "claude"));
      claudeWatcher.onDidChange((uri) => this.onFileChanged(uri, "claude"));
      claudeWatcher.onDidDelete((uri) => {
        const sessionId = path12.basename(uri.fsPath, ".jsonl");
        this.index.remove(sessionId);
        this.channel.appendLine(`[live] removed session ${sessionId}`);
      });
      this.disposables.push(claudeWatcher);
    }
    if (indexCopilot) {
      let copilotWorkspaces = [];
      try {
        const all = discoverCopilotWorkspaces();
        const selectedIds = this.scopeManager.getSelectedIds();
        copilotWorkspaces = all.filter((ws) => selectedIds.includes(ws.workspaceId));
      } catch (err) {
        this.channel.appendLine(`[error] Failed to discover Copilot workspaces for watching: ${err}`);
      }
      for (const workspace7 of copilotWorkspaces) {
        const chatSessionsDir = path12.join(workspace7.storageDir, "chatSessions");
        const copilotPattern = new vscode.RelativePattern(
          vscode.Uri.file(chatSessionsDir),
          "*.jsonl"
        );
        const copilotWatcher = vscode.workspace.createFileSystemWatcher(copilotPattern);
        copilotWatcher.onDidCreate(
          (uri) => this.onFileChanged(uri, "copilot", workspace7.workspaceId, workspace7.workspacePath)
        );
        copilotWatcher.onDidChange(
          (uri) => this.onFileChanged(uri, "copilot", workspace7.workspaceId, workspace7.workspacePath)
        );
        copilotWatcher.onDidDelete((uri) => {
          const sessionId = path12.basename(uri.fsPath, ".jsonl");
          this.index.remove(sessionId);
          this.channel.appendLine(`[live] removed session ${sessionId}`);
        });
        this.disposables.push(copilotWatcher);
      }
    }
    if (indexCline) {
      const clineRoot = resolveClineStoragePath();
      const clinePattern = new vscode.RelativePattern(
        vscode.Uri.file(clineRoot),
        "**/api_conversation_history.json"
      );
      const clineWatcher = vscode.workspace.createFileSystemWatcher(clinePattern);
      clineWatcher.onDidCreate((uri) => this.onClineFileChanged(uri));
      clineWatcher.onDidChange((uri) => this.onClineFileChanged(uri));
      clineWatcher.onDidDelete((uri) => {
        const taskId = path12.basename(path12.dirname(uri.fsPath));
        this.index.remove(taskId);
        this.channel.appendLine(`[live] removed cline session ${taskId}`);
      });
      this.disposables.push(clineWatcher);
    }
    if (indexRooCode) {
      const rooCodeRoot = resolveRooCodeStoragePath();
      const rooCodePattern = new vscode.RelativePattern(
        vscode.Uri.file(rooCodeRoot),
        "**/api_conversation_history.json"
      );
      const rooCodeWatcher = vscode.workspace.createFileSystemWatcher(rooCodePattern);
      rooCodeWatcher.onDidCreate((uri) => this.onRooCodeFileChanged(uri));
      rooCodeWatcher.onDidChange((uri) => this.onRooCodeFileChanged(uri));
      rooCodeWatcher.onDidDelete((uri) => {
        const taskId = path12.basename(path12.dirname(uri.fsPath));
        this.index.remove(taskId);
        this.channel.appendLine(`[live] removed roocode session ${taskId}`);
      });
      this.disposables.push(rooCodeWatcher);
    }
    if (indexCursor) {
      const cursorRoot = resolveCursorStoragePath();
      const cursorPattern = new vscode.RelativePattern(
        vscode.Uri.file(cursorRoot),
        "**/state.vscdb"
      );
      const cursorWatcher = vscode.workspace.createFileSystemWatcher(cursorPattern);
      cursorWatcher.onDidCreate((uri) => this.onCursorFileChanged(uri));
      cursorWatcher.onDidChange((uri) => this.onCursorFileChanged(uri));
      cursorWatcher.onDidDelete((uri) => {
        const vscdbPath = uri.fsPath;
        this.channel.appendLine(`[live] cursor state.vscdb deleted: ${vscdbPath}`);
      });
      this.disposables.push(cursorWatcher);
    }
    if (indexWindsurf) {
      const windsurfRoot = resolveWindsurfStoragePath();
      const windsurfPattern = new vscode.RelativePattern(
        vscode.Uri.file(windsurfRoot),
        "**/state.vscdb"
      );
      const windsurfWatcher = vscode.workspace.createFileSystemWatcher(windsurfPattern);
      windsurfWatcher.onDidCreate((uri) => this.onWindsurfFileChanged(uri));
      windsurfWatcher.onDidChange((uri) => this.onWindsurfFileChanged(uri));
      windsurfWatcher.onDidDelete((uri) => {
        const vscdbPath = uri.fsPath;
        this.channel.appendLine(`[live] windsurf state.vscdb deleted: ${vscdbPath}`);
      });
      this.disposables.push(windsurfWatcher);
    }
    if (indexAider) {
      const aiderWatcher = vscode.workspace.createFileSystemWatcher("**/.aider.chat.history.md");
      aiderWatcher.onDidCreate((uri) => this.onAiderFileChanged(uri));
      aiderWatcher.onDidChange((uri) => this.onAiderFileChanged(uri));
      aiderWatcher.onDidDelete((uri) => {
        const sessionId = require("crypto").createHash("sha1").update(uri.fsPath).digest("hex");
        this.index.remove(sessionId);
        this.channel.appendLine(`[live] removed aider session ${uri.fsPath}`);
      });
      this.disposables.push(aiderWatcher);
    }
  }
  /**
   * Stops all active file watchers, clears the session index, and re-runs the full
   * discovery + indexing flow. Used when the workspace scope changes.
   */
  async restart() {
    this.dispose();
    this.index.clear();
    await this.start();
  }
  dispose() {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
  async buildInitialIndex(indexClaude, indexCopilot, indexCline, indexRooCode = true, indexCursor = true, indexWindsurf = true, indexAider = true) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: "Chat Wizard: indexing sessions\u2026",
        cancellable: false
      },
      async (progress) => {
        const onProgress = (current, total) => {
          progress.report({ message: `${current}/${total}` });
        };
        const selectedIds = this.scopeManager.getSelectedIds();
        if (selectedIds.length === 0) {
          this.channel.appendLine("[Chat Wizard] Scope is empty \u2014 no sessions will be indexed.");
        } else {
          this.channel.appendLine(`[Chat Wizard] Building index with scope filter: [${selectedIds.join(", ")}]`);
        }
        const [claudeSessions, copilotSessions, clineSessions, rooCodeSessions, cursorSessions, windsurfSessions, aiderSessions] = await Promise.all([
          // Always pass selectedIds (even empty array) — empty = index nothing, no fallback to all.
          indexClaude ? this.collectClaudeSessionsAsync(onProgress, selectedIds) : Promise.resolve([]),
          indexCopilot ? this.collectCopilotSessionsAsync(onProgress, selectedIds) : Promise.resolve([]),
          indexCline ? this.collectClineTasksAsync(onProgress) : Promise.resolve([]),
          indexRooCode ? this.collectRooCodeTasksAsync(onProgress) : Promise.resolve([]),
          indexCursor ? this.collectCursorSessionsAsync(onProgress) : Promise.resolve([]),
          indexWindsurf ? this.collectWindsurfSessionsAsync(onProgress) : Promise.resolve([]),
          indexAider ? this.collectAiderSessionsAsync(onProgress) : Promise.resolve([])
        ]);
        const cfg = vscode.workspace.getConfiguration("chatwizard");
        const all = applySessionFilters([...claudeSessions, ...copilotSessions, ...clineSessions, ...rooCodeSessions, ...cursorSessions, ...windsurfSessions, ...aiderSessions], cfg, this.channel);
        this.index.batchUpsert(all);
        this.channel.appendLine(`[init] Batch indexed ${all.length} sessions`);
      }
    );
  }
  /** Async: parse all Claude sessions using non-blocking directory reads.
   *
   * @param onProgress           Optional progress callback.
   * @param selectedIds          When provided, only project directories whose name appears in
   *                             this list are processed (used for workspace scope filtering).
   * @param _claudeBaseDirOverride  Test-only: override the Claude projects base directory.
   */
  async collectClaudeSessionsAsync(onProgress, selectedIds, _claudeBaseDirOverride) {
    const claudeProjectsDir = resolveClaudeProjectsPath(_claudeBaseDirOverride);
    try {
      let exists = false;
      try {
        exists = (await fs11.promises.stat(claudeProjectsDir)).isDirectory();
      } catch {
      }
      if (!exists) {
        return [];
      }
      const resolvedBase = await fs11.promises.realpath(claudeProjectsDir).catch(() => claudeProjectsDir);
      const projectDirEntries = await fs11.promises.readdir(claudeProjectsDir, { withFileTypes: true });
      const allDirEntries = projectDirEntries.filter((d) => d.isDirectory());
      const dirEntries = selectedIds ? allDirEntries.filter((d) => selectedIds.includes(d.name)) : allDirEntries;
      const fileLists = await Promise.all(dirEntries.map(async (d) => {
        const projectPath = path12.join(claudeProjectsDir, d.name);
        try {
          const files = await fs11.promises.readdir(projectPath, { withFileTypes: true });
          return { projectPath, files: files.filter((f) => f.isFile() && f.name.endsWith(".jsonl")) };
        } catch {
          return { projectPath, files: [] };
        }
      }));
      const total = fileLists.reduce((s, { files }) => s + files.length, 0);
      let current = 0;
      const dirResults = await Promise.all(fileLists.map(async ({ projectPath, files }) => {
        const dirSessions = [];
        for (const file of files) {
          const filePath = path12.join(projectPath, file.name);
          if (!await _ChatWizardWatcher._isSafeFilePathAsync(resolvedBase, filePath)) {
            this.channel.appendLine(`[security] Skipping ${filePath}: resolves outside base directory`);
            current++;
            onProgress?.(current, total);
            continue;
          }
          const session = this.parseFile(filePath, "claude");
          if (session) {
            dirSessions.push(session);
          }
          current++;
          onProgress?.(current, total);
        }
        return dirSessions;
      }));
      return dirResults.flat();
    } catch (err) {
      this.channel.appendLine(`[error] Failed to collect Claude sessions: ${err}`);
      return [];
    }
  }
  /** Async: parse all Copilot sessions using non-blocking discovery + parallel workspace reads. */
  async collectCopilotSessionsAsync(onProgress, selectedIds) {
    try {
      const all = await discoverCopilotWorkspacesAsync();
      const workspaces = selectedIds ? all.filter((ws) => selectedIds.includes(ws.workspaceId)) : all;
      if (selectedIds && workspaces.length === 0 && all.length > 0) {
        this.channel.appendLine(
          `[Chat Wizard] Copilot scope filter produced 0 matches from ${all.length} discovered workspace(s). Filter IDs: [${selectedIds.join(", ")}]. Discovered: [${all.map((ws) => ws.workspaceId).join(", ")}]`
        );
      }
      const fileListsPerWorkspace = await Promise.all(
        workspaces.map((ws) => listSessionFilesAsync(ws.storageDir))
      );
      const total = fileListsPerWorkspace.reduce((s, files) => s + files.length, 0);
      let current = 0;
      const wsResults = await Promise.all(workspaces.map(async (workspace7, idx) => {
        const files = fileListsPerWorkspace[idx];
        const wsSessions = [];
        const resolvedBase = await fs11.promises.realpath(workspace7.storageDir).catch(() => workspace7.storageDir);
        for (const filePath of files) {
          if (!await _ChatWizardWatcher._isSafeFilePathAsync(resolvedBase, filePath)) {
            this.channel.appendLine(`[security] Skipping ${filePath}: resolves outside workspace storage`);
            current++;
            onProgress?.(current, total);
            continue;
          }
          const session = this.parseFile(filePath, "copilot", workspace7.workspaceId, workspace7.workspacePath);
          if (session) {
            wsSessions.push(session);
          }
          current++;
          onProgress?.(current, total);
        }
        return wsSessions;
      }));
      return wsResults.flat();
    } catch (err) {
      this.channel.appendLine(`[error] Failed to collect Copilot sessions: ${err}`);
      return [];
    }
  }
  /** Async: parse all Cline tasks using non-blocking directory reads. */
  async collectClineTasksAsync(onProgress, _clineRootOverride) {
    const root = _clineRootOverride ?? resolveClineStoragePath();
    try {
      const tasks = await discoverClineTasksAsync(root);
      const total = tasks.length;
      let current = 0;
      const results = await Promise.all(tasks.map(async (task) => {
        const result = await parseClineTask(task.storageDir);
        current++;
        onProgress?.(current, total);
        if (result.errors.length > 0) {
          this.channel.appendLine(`[warn] Cline parse errors in ${task.storageDir}: ${result.errors.join("; ")}`);
        }
        if (result.session.messages.length === 0 || result.session.createdAt === (/* @__PURE__ */ new Date(0)).toISOString()) {
          return null;
        }
        return result.session;
      }));
      return results.filter((s) => s !== null);
    } catch (err) {
      this.channel.appendLine(`[error] Failed to collect Cline tasks: ${err}`);
      return [];
    }
  }
  /** Async: parse all Roo Code tasks using non-blocking directory reads. */
  async collectRooCodeTasksAsync(onProgress, _rooCodeRootOverride) {
    const root = _rooCodeRootOverride ?? resolveRooCodeStoragePath();
    try {
      const tasks = await discoverRooCodeTasksAsync(root);
      const total = tasks.length;
      let current = 0;
      const results = await Promise.all(tasks.map(async (task) => {
        const result = await parseClineTask(task.storageDir, void 0, "roocode");
        current++;
        onProgress?.(current, total);
        if (result.errors.length > 0) {
          this.channel.appendLine(`[warn] Roo Code parse errors in ${task.storageDir}: ${result.errors.join("; ")}`);
        }
        if (result.session.messages.length === 0 || result.session.createdAt === (/* @__PURE__ */ new Date(0)).toISOString()) {
          return null;
        }
        return result.session;
      }));
      return results.filter((s) => s !== null);
    } catch (err) {
      this.channel.appendLine(`[error] Failed to collect Roo Code tasks: ${err}`);
      return [];
    }
  }
  /** Async: parse all Cursor sessions by reading state.vscdb files across discovered workspaces. */
  async collectCursorSessionsAsync(onProgress, _cursorRootOverride) {
    const root = _cursorRootOverride ?? resolveCursorStoragePath();
    try {
      const workspaces = await discoverCursorWorkspacesAsync(root);
      const total = workspaces.length;
      let current = 0;
      const wsResults = await Promise.all(workspaces.map(async (ws) => {
        const vscdbPath = require("path").join(ws.storageDir, "state.vscdb");
        const parseResults = await parseCursorWorkspace(vscdbPath, ws.id, ws.workspacePath);
        current++;
        onProgress?.(current, total);
        const sessions = [];
        for (const result of parseResults) {
          if (result.errors.length > 0) {
            this.channel.appendLine(
              `[warn] Cursor parse errors in ${vscdbPath}: ${result.errors.join("; ")}`
            );
          }
          if (result.session.messages.length === 0 || result.session.createdAt === (/* @__PURE__ */ new Date(0)).toISOString()) {
            continue;
          }
          sessions.push(result.session);
        }
        return sessions;
      }));
      return wsResults.flat();
    } catch (err) {
      this.channel.appendLine(`[error] Failed to collect Cursor sessions: ${err}`);
      return [];
    }
  }
  /** Async: parse all Windsurf sessions by reading state.vscdb files across discovered workspaces. */
  async collectWindsurfSessionsAsync(onProgress, _windsurfRootOverride) {
    const root = _windsurfRootOverride ?? resolveWindsurfStoragePath();
    try {
      const workspaces = await discoverWindsurfWorkspacesAsync(root);
      const total = workspaces.length;
      let current = 0;
      const wsResults = await Promise.all(workspaces.map(async (ws) => {
        const vscdbPath = require("path").join(ws.storageDir, "state.vscdb");
        const parseResults = await parseWindsurfWorkspace(vscdbPath, ws.id, ws.workspacePath);
        current++;
        onProgress?.(current, total);
        const sessions = [];
        for (const result of parseResults) {
          if (result.errors.length > 0) {
            this.channel.appendLine(
              `[warn] Windsurf parse errors in ${vscdbPath}: ${result.errors.join("; ")}`
            );
          }
          if (result.session.messages.length === 0 || result.session.createdAt === (/* @__PURE__ */ new Date(0)).toISOString()) {
            continue;
          }
          sessions.push(result.session);
        }
        return sessions;
      }));
      return wsResults.flat();
    } catch (err) {
      this.channel.appendLine(`[error] Failed to collect Windsurf sessions: ${err}`);
      return [];
    }
  }
  /**
   * Async: parse all Aider sessions by scanning VS Code workspace folders and
   * any user-configured extra roots for `.aider.chat.history.md` files.
   */
  async collectAiderSessionsAsync(onProgress, _rootsOverride) {
    try {
      const cfg = vscode.workspace.getConfiguration("chatwizard");
      const extraRoots = cfg.get("aiderSearchRoots", []);
      const maxDepth = cfg.get("aiderSearchDepth", 3);
      const wsFolders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
      const roots = _rootsOverride ?? [...wsFolders, ...extraRoots];
      const infos = await discoverAiderHistoryFilesAsync(roots, maxDepth);
      const total = infos.length;
      let current = 0;
      const results = await Promise.all(infos.map(async (info) => {
        const result = parseAiderHistory(info);
        current++;
        onProgress?.(current, total);
        if (result.errors.length > 0) {
          this.channel.appendLine(`[warn] Aider parse errors in ${info.historyFile}: ${result.errors.join("; ")}`);
        }
        if (result.session.messages.length === 0 || result.session.createdAt === (/* @__PURE__ */ new Date(0)).toISOString()) {
          return null;
        }
        return result.session;
      }));
      return results.filter((s) => s !== null);
    } catch (err) {
      this.channel.appendLine(`[error] Failed to collect Aider sessions: ${err}`);
      return [];
    }
  }
  /** Synchronous collectors kept for internal use by live-update code paths. */
  collectClaudeSessions() {
    const sessions = [];
    const claudeProjectsDir = resolveClaudeProjectsPath();
    try {
      if (!fs11.existsSync(claudeProjectsDir)) {
        return sessions;
      }
      const resolvedBase = (() => {
        try {
          return fs11.realpathSync(claudeProjectsDir);
        } catch {
          return claudeProjectsDir;
        }
      })();
      const projectDirs = fs11.readdirSync(claudeProjectsDir, { withFileTypes: true });
      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) {
          continue;
        }
        const projectPath = path12.join(claudeProjectsDir, projectDir.name);
        try {
          const files = fs11.readdirSync(projectPath, { withFileTypes: true });
          for (const file of files) {
            if (!file.isFile() || !file.name.endsWith(".jsonl")) {
              continue;
            }
            const filePath = path12.join(projectPath, file.name);
            if (!_ChatWizardWatcher._isSafeFilePath(resolvedBase, filePath)) {
              this.channel.appendLine(`[security] Skipping ${filePath}: resolves outside base directory`);
              continue;
            }
            const session = this.parseFile(filePath, "claude");
            if (session) {
              sessions.push(session);
            }
          }
        } catch (err) {
          this.channel.appendLine(`[error] Failed to read Claude project directory ${projectPath}: ${err}`);
        }
      }
    } catch (err) {
      this.channel.appendLine(`[error] Failed to collect Claude sessions: ${err}`);
    }
    return sessions;
  }
  collectCopilotSessions() {
    const sessions = [];
    try {
      const workspaces = discoverCopilotWorkspaces();
      for (const workspace7 of workspaces) {
        try {
          const resolvedBase = (() => {
            try {
              return fs11.realpathSync(workspace7.storageDir);
            } catch {
              return workspace7.storageDir;
            }
          })();
          const sessionFiles = listSessionFiles(workspace7.storageDir);
          for (const filePath of sessionFiles) {
            if (!_ChatWizardWatcher._isSafeFilePath(resolvedBase, filePath)) {
              this.channel.appendLine(`[security] Skipping ${filePath}: resolves outside workspace storage`);
              continue;
            }
            const session = this.parseFile(filePath, "copilot", workspace7.workspaceId, workspace7.workspacePath);
            if (session) {
              sessions.push(session);
            }
          }
        } catch (err) {
          this.channel.appendLine(
            `[error] Failed to collect Copilot sessions for workspace ${workspace7.workspaceId}: ${err}`
          );
        }
      }
    } catch (err) {
      this.channel.appendLine(`[error] Failed to discover Copilot workspaces: ${err}`);
    }
    return sessions;
  }
  /**
   * Parse a single session file and return the Session object, or null if it
   * should be skipped (empty, epoch-dated, or parse error).
   * Does NOT modify the index — call index.upsert() or batchUpsert() separately.
   */
  parseFile(filePath, source, workspaceId, workspacePath) {
    try {
      if (source === "claude") {
        const maxLineChars = vscode.workspace.getConfiguration("chatwizard").get("maxLineLengthChars", DEFAULT_MAX_LINE_CHARS);
        const result = parseClaudeSession(filePath, maxLineChars);
        if (result.errors.length > 0) {
          this.channel.appendLine(`[warn] Parse errors in ${filePath}: ${result.errors.join("; ")}`);
        }
        const realErrors = result.errors.filter((e) => !e.includes("skipped \u2014 length"));
        const skippedErrors = result.errors.filter((e) => e.includes("skipped \u2014 length"));
        const sessionErrors = [...realErrors];
        if (skippedErrors.length > 0) {
          sessionErrors.push(
            `${skippedErrors.length} message(s) were not shown because their source lines exceed the size limit (chatwizard.maxLineLengthChars). Inline notices mark their position in the conversation.`
          );
        }
        if (sessionErrors.length > 0) {
          result.session.parseErrors = sessionErrors;
        }
        if (result.session.messages.length === 0 || result.session.createdAt === (/* @__PURE__ */ new Date(0)).toISOString()) {
          return null;
        }
        return result.session;
      } else if (source === "copilot") {
        const result = parseCopilotSession(filePath, workspaceId, workspacePath);
        if (result.errors.length > 0) {
          this.channel.appendLine(`[warn] Parse errors in ${filePath}: ${result.errors.join("; ")}`);
        }
        if (result.session.messages.length === 0) {
          return null;
        }
        return result.session;
      }
    } catch (err) {
      this.channel.appendLine(`[error] Failed to parse file ${filePath}: ${err}`);
    }
    return null;
  }
  /** Parse and immediately upsert a single file into the index (used for live file-change events). */
  indexFile(filePath, source, workspaceId, workspacePath) {
    const session = this.parseFile(filePath, source, workspaceId, workspacePath);
    if (session) {
      this.index.upsert(session);
    } else {
      this.channel.appendLine(`[skip] empty/epoch session ${filePath}`);
    }
  }
  async onClineFileChanged(uri) {
    const taskDir = path12.dirname(uri.fsPath);
    const taskId = path12.basename(taskDir);
    const result = await parseClineTask(taskDir);
    if (result.errors.length > 0) {
      this.channel.appendLine(`[warn] Cline parse errors in ${taskDir}: ${result.errors.join("; ")}`);
    }
    if (result.session.messages.length === 0 || result.session.createdAt === (/* @__PURE__ */ new Date(0)).toISOString()) {
      this.channel.appendLine(`[skip] empty/epoch cline session ${taskId}`);
      return;
    }
    const before = this.index.size;
    this.index.upsert(result.session);
    const verb = this.index.size > before ? "added" : "updated";
    this.channel.appendLine(`[live] ${verb} cline session ${taskId}`);
  }
  async onRooCodeFileChanged(uri) {
    const taskDir = path12.dirname(uri.fsPath);
    const taskId = path12.basename(taskDir);
    const result = await parseClineTask(taskDir, void 0, "roocode");
    if (result.errors.length > 0) {
      this.channel.appendLine(`[warn] Roo Code parse errors in ${taskDir}: ${result.errors.join("; ")}`);
    }
    if (result.session.messages.length === 0 || result.session.createdAt === (/* @__PURE__ */ new Date(0)).toISOString()) {
      this.channel.appendLine(`[skip] empty/epoch roocode session ${taskId}`);
      return;
    }
    const before = this.index.size;
    this.index.upsert(result.session);
    const verb = this.index.size > before ? "added" : "updated";
    this.channel.appendLine(`[live] ${verb} roocode session ${taskId}`);
  }
  async onCursorFileChanged(uri) {
    const vscdbPath = uri.fsPath;
    const workspaceId = path12.basename(path12.dirname(vscdbPath));
    let workspacePath;
    try {
      const wsJson = path12.join(path12.dirname(vscdbPath), "workspace.json");
      const raw = require("fs").readFileSync(wsJson, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.folder) {
        let decoded = decodeURIComponent(parsed.folder.replace("file://", ""));
        if (process.platform === "win32" && decoded.startsWith("/")) {
          decoded = decoded.slice(1);
        }
        workspacePath = decoded;
      }
    } catch {
    }
    const parseResults = await parseCursorWorkspace(vscdbPath, workspaceId, workspacePath);
    let upsertCount = 0;
    for (const result of parseResults) {
      if (result.errors.length > 0) {
        this.channel.appendLine(
          `[warn] Cursor parse errors in ${vscdbPath}: ${result.errors.join("; ")}`
        );
      }
      if (result.session.messages.length === 0 || result.session.createdAt === (/* @__PURE__ */ new Date(0)).toISOString()) {
        continue;
      }
      this.index.upsert(result.session);
      upsertCount++;
    }
    this.channel.appendLine(`[live] cursor updated ${upsertCount} session(s) from ${vscdbPath}`);
  }
  async onWindsurfFileChanged(uri) {
    const vscdbPath = uri.fsPath;
    const workspaceId = path12.basename(path12.dirname(vscdbPath));
    let workspacePath;
    try {
      const wsJson = path12.join(path12.dirname(vscdbPath), "workspace.json");
      const raw = require("fs").readFileSync(wsJson, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.folder) {
        let decoded = decodeURIComponent(parsed.folder.replace("file://", ""));
        if (process.platform === "win32" && decoded.startsWith("/")) {
          decoded = decoded.slice(1);
        }
        workspacePath = decoded;
      }
    } catch {
    }
    const parseResults = await parseWindsurfWorkspace(vscdbPath, workspaceId, workspacePath);
    let upsertCount = 0;
    for (const result of parseResults) {
      if (result.errors.length > 0) {
        this.channel.appendLine(
          `[warn] Windsurf parse errors in ${vscdbPath}: ${result.errors.join("; ")}`
        );
      }
      if (result.session.messages.length === 0 || result.session.createdAt === (/* @__PURE__ */ new Date(0)).toISOString()) {
        continue;
      }
      this.index.upsert(result.session);
      upsertCount++;
    }
    this.channel.appendLine(`[live] windsurf updated ${upsertCount} session(s) from ${vscdbPath}`);
  }
  onAiderFileChanged(uri) {
    const historyFile = uri.fsPath;
    const workspacePath = require("path").dirname(historyFile);
    const configFile = (() => {
      const candidate = require("path").join(workspacePath, ".aider.conf.yml");
      try {
        require("fs").accessSync(candidate);
        return candidate;
      } catch {
        return void 0;
      }
    })();
    const result = parseAiderHistory({ historyFile, workspacePath, configFile });
    if (result.errors.length > 0) {
      this.channel.appendLine(`[warn] Aider parse errors in ${historyFile}: ${result.errors.join("; ")}`);
    }
    if (result.session.messages.length === 0 || result.session.createdAt === (/* @__PURE__ */ new Date(0)).toISOString()) {
      this.channel.appendLine(`[skip] empty/epoch aider session ${historyFile}`);
      return;
    }
    const before = this.index.size;
    this.index.upsert(result.session);
    const verb = this.index.size > before ? "added" : "updated";
    this.channel.appendLine(`[live] ${verb} aider session ${historyFile}`);
  }
  onFileChanged(uri, source, workspaceId, workspacePath) {
    const before = this.index.size;
    this.indexFile(uri.fsPath, source, workspaceId, workspacePath);
    const sessionId = path12.basename(uri.fsPath, ".jsonl");
    const verb = this.index.size > before ? "added" : "updated";
    this.channel.appendLine(`[live] ${verb} session ${sessionId} (${source})`);
  }
};
function applySessionFilters(sessions, cfg, channel) {
  const oldestDate = cfg.get("oldestSessionDate", "").trim();
  const maxSessions = cfg.get("maxSessions", 0);
  let result = sessions;
  if (oldestDate) {
    const before = result.length;
    result = result.filter((s) => s.updatedAt.slice(0, 10) >= oldestDate);
    const dropped = before - result.length;
    channel.appendLine(`[Chat Wizard] Date filter (>= ${oldestDate}): kept ${result.length}, dropped ${dropped} session(s).`);
  } else {
    channel.appendLine(`[Chat Wizard] Date filter: not set, all ${result.length} session(s) kept.`);
  }
  if (maxSessions > 0 && result.length > maxSessions) {
    result = result.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, maxSessions);
    channel.appendLine(`[Chat Wizard] Session cap (${maxSessions}) applied \u2014 retained ${result.length} session(s).`);
  }
  return result;
}
async function startWatcher(index, channel, scopeManager) {
  const ch = channel ?? vscode.window.createOutputChannel("Chat Wizard");
  const mgr = scopeManager ?? new WorkspaceScopeManager({
    globalState: {
      get: () => void 0,
      update: (_key, _value) => Promise.resolve()
    }
  });
  const watcher2 = new ChatWizardWatcher(index, ch, mgr);
  await watcher2.start();
  return watcher2;
}

// src/readers/claudeWorkspace.ts
var fs12 = __toESM(require("fs"));
var path13 = __toESM(require("path"));
function resolveClaudeWorkspacePath(dirName) {
  if (!dirName || typeof dirName !== "string") {
    return void 0;
  }
  const winMatch = /^([a-z])--(.+)$/.exec(dirName);
  if (winMatch) {
    const drive = winMatch[1].toUpperCase();
    const rest = winMatch[2].replace(/-/g, "\\");
    return `${drive}:\\${rest}`;
  }
  if (dirName.startsWith("-")) {
    return "/" + dirName.slice(1).replace(/-/g, "/");
  }
  return void 0;
}
async function discoverClaudeWorkspacesAsync(override) {
  const claudeProjectsDir = resolveClaudeProjectsPath(override);
  try {
    let exists = false;
    try {
      exists = (await fs12.promises.stat(claudeProjectsDir)).isDirectory();
    } catch {
    }
    if (!exists) {
      return [];
    }
    const entries = await fs12.promises.readdir(claudeProjectsDir, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const workspacePath = resolveClaudeWorkspacePath(entry.name);
      if (workspacePath === void 0) {
        continue;
      }
      results.push({
        id: entry.name,
        source: "claude",
        workspacePath,
        storageDir: path13.join(claudeProjectsDir, entry.name)
      });
    }
    return results;
  } catch {
    return [];
  }
}

// src/views/sessionTreeProvider.ts
var vscode2 = __toESM(require("vscode"));
var path14 = __toESM(require("path"));
function friendlySourceName(source) {
  switch (source) {
    case "copilot":
      return "GitHub Copilot";
    case "claude":
      return "Claude Code";
    case "cline":
      return "Cline";
    case "roocode":
      return "Roo Code";
    case "cursor":
      return "Cursor";
    case "windsurf":
      return "Windsurf";
    case "aider":
      return "Aider";
  }
}
function sourceIconId(source) {
  switch (source) {
    case "copilot":
      return "github";
    case "claude":
      return "hubot";
    case "cline":
      return "plug";
    case "roocode":
      return "circuit-board";
    case "cursor":
      return "edit";
    case "windsurf":
      return "cloud";
    case "aider":
      return "terminal";
  }
}
function sourceBrandIcon(source, extensionUri) {
  switch (source) {
    case "cline":
    case "roocode":
    case "cursor":
    case "windsurf":
    case "aider":
      return {
        light: vscode2.Uri.joinPath(extensionUri, "resources", "icons", `${source}_light.svg`),
        dark: vscode2.Uri.joinPath(extensionUri, "resources", "icons", `${source}_dark.svg`)
      };
    default:
      return new vscode2.ThemeIcon(sourceIconId(source));
  }
}
var SessionTreeItem = class extends vscode2.TreeItem {
  summary;
  pinned;
  constructor(summary, pinned = false, extensionUri) {
    super(summary.title || "Untitled Session", vscode2.TreeItemCollapsibleState.None);
    this.summary = summary;
    this.pinned = pinned;
    const workspaceName = path14.basename(summary.workspacePath ?? summary.workspaceId);
    const date = summary.updatedAt.slice(0, 10);
    const msgCount = summary.messageCount;
    const sizeKb = summary.fileSizeBytes !== void 0 ? `${(summary.fileSizeBytes / 1024).toFixed(1)} KB` : void 0;
    this.description = sizeKb ? `${workspaceName} \xB7 ${date} \xB7 ${msgCount} msgs \xB7 ${sizeKb}` : `${workspaceName} \xB7 ${date} \xB7 ${msgCount} msgs`;
    const sourceName = friendlySourceName(summary.source);
    const modelLine = summary.model ? `

**Model:** ${summary.model}` : "";
    const sizeLine = sizeKb ? `

**Size:** ${msgCount} messages \xB7 ${sizeKb}` : `

**Size:** ${msgCount} messages`;
    const pinnedLine = pinned ? `

\u{1F4CC} *Pinned*` : "";
    const interruptedLine = summary.interrupted ? `

\u26A0 *Response not available \u2014 cancelled or incomplete*` : "";
    const parseErrorsLine = summary.hasParseErrors ? `

\u26A0 *This session has parse errors \u2014 some lines could not be read*` : "";
    const config = vscode2.workspace.getConfiguration("chatwizard");
    const labelColor = config.get("tooltipLabelColor", "");
    let tooltip;
    if (labelColor) {
      const lbl = (t) => `<span style="color:${labelColor};">${t}</span>`;
      const sizeText = sizeKb ? `${msgCount} messages \xB7 ${sizeKb}` : `${msgCount} messages`;
      tooltip = new vscode2.MarkdownString(
        `${lbl("Title:")} ${summary.title || "Untitled Session"}

${lbl("Source:")} ${sourceName}` + (summary.model ? `

${lbl("Model:")} ${summary.model}` : "") + `

${lbl("Workspace:")} ${workspaceName}

${lbl("Updated:")} ${summary.updatedAt.slice(0, 16).replace("T", " ")}

${lbl("Size:")} ${sizeText}

${summary.userMessageCount} prompts \xB7 ${summary.assistantMessageCount} responses` + pinnedLine + interruptedLine + parseErrorsLine
      );
      tooltip.isTrusted = true;
      tooltip.supportHtml = true;
    } else {
      tooltip = new vscode2.MarkdownString(
        `**Title:** ${summary.title || "Untitled Session"}

**Source:** ${sourceName}${modelLine}

**Workspace:** ${workspaceName}

**Updated:** ${summary.updatedAt.slice(0, 16).replace("T", " ")}` + sizeLine + `

${summary.userMessageCount} prompts \xB7 ${summary.assistantMessageCount} responses` + pinnedLine + interruptedLine + parseErrorsLine
      );
    }
    this.tooltip = tooltip;
    if (pinned) {
      this.iconPath = new vscode2.ThemeIcon("pinned");
    } else if (summary.interrupted) {
      const red = new vscode2.ThemeColor("list.errorForeground");
      this.iconPath = new vscode2.ThemeIcon(sourceIconId(summary.source), red);
    } else if (summary.hasParseErrors) {
      const yellow = new vscode2.ThemeColor("list.warningForeground");
      this.iconPath = new vscode2.ThemeIcon(sourceIconId(summary.source), yellow);
    } else if (extensionUri) {
      this.iconPath = sourceBrandIcon(summary.source, extensionUri);
    } else {
      this.iconPath = new vscode2.ThemeIcon(sourceIconId(summary.source));
    }
    if (summary.hasParseErrors) {
      this.resourceUri = vscode2.Uri.from({ scheme: "chatwizard-warn", path: "/" + summary.id });
    }
    this.contextValue = pinned ? "session.pinned" : "session";
    this.command = {
      command: "chatwizard.openSession",
      title: "Open Session",
      arguments: [summary]
    };
  }
};
var LoadingTreeItem = class extends vscode2.TreeItem {
  constructor() {
    super("Indexing sessions\u2026", vscode2.TreeItemCollapsibleState.None);
    this.iconPath = new vscode2.ThemeIcon("loading~spin");
    this.contextValue = "loading";
  }
};
var LoadMoreTreeItem = class extends vscode2.TreeItem {
  remaining;
  constructor(remaining) {
    super(`\u22EF Load more (${remaining} remaining)`, vscode2.TreeItemCollapsibleState.None);
    this.remaining = remaining;
    this.contextValue = "loadMore";
    this.command = {
      command: "chatwizard.loadMoreSessions",
      title: "Load More Sessions",
      arguments: []
    };
  }
};
var DEFAULT_DIRECTION = {
  date: "desc",
  workspace: "asc",
  length: "desc",
  title: "asc",
  model: "asc",
  source: "asc"
};
var SORT_KEY_LABELS = {
  date: "Date",
  workspace: "Workspace",
  length: "Message Count",
  title: "Title (A\u2013Z)",
  model: "AI Model",
  source: "Source"
};
var SHORT_LABEL = {
  date: "Date",
  workspace: "Workspace",
  length: "Length",
  title: "A\u2013Z",
  model: "Model",
  source: "Source"
};
function compareBy(key, a, b) {
  switch (key) {
    case "date":
      return a.updatedAt.localeCompare(b.updatedAt);
    case "workspace": {
      const wa = path14.basename(a.workspacePath ?? a.workspaceId);
      const wb = path14.basename(b.workspacePath ?? b.workspaceId);
      return wa.localeCompare(wb);
    }
    case "length":
      return a.messageCount - b.messageCount;
    case "title":
      return a.title.localeCompare(b.title);
    case "model": {
      const ma = a.model ?? "";
      const mb = b.model ?? "";
      return ma.localeCompare(mb);
    }
    case "source":
      return a.source.localeCompare(b.source);
  }
}
var SessionParseWarningDecorationProvider = class {
  provideFileDecoration(uri) {
    if (uri.scheme === "chatwizard-warn") {
      return {
        badge: "\u26A0",
        color: new vscode2.ThemeColor("list.warningForeground"),
        tooltip: "This session has parse errors",
        propagate: false
      };
    }
  }
};
var SessionTreeProvider = class {
  constructor(index, extensionUri) {
    this.index = index;
    this.extensionUri = extensionUri;
    index.addChangeListener(() => {
      this._loading = false;
      this._sortedCache = null;
      this.refresh();
    });
  }
  _onDidChangeTreeData = new vscode2.EventEmitter();
  onDidChangeTreeData = this._onDidChangeTreeData.event;
  sortStack = [{ key: "date", direction: "desc" }];
  _filter = {};
  /** Ordered list of pinned session IDs (first = top of list) */
  _pinnedIds = [];
  /** Full display order set by drag-and-drop; empty means use sort stack */
  _manualOrder = [];
  _sortedCache = null;
  _visibleCount = 200;
  _filterDebounceTimer = null;
  /** True until the first change event fires (initial batch index complete) */
  _loading = true;
  // ------------------------------------------------------------------
  // Pin management
  // ------------------------------------------------------------------
  pin(id) {
    if (!this._pinnedIds.includes(id)) {
      this._pinnedIds.push(id);
    }
  }
  unpin(id) {
    this._pinnedIds = this._pinnedIds.filter((p) => p !== id);
  }
  isPinned(id) {
    return this._pinnedIds.includes(id);
  }
  getPinnedIds() {
    return [...this._pinnedIds];
  }
  setPinnedIds(ids) {
    this._pinnedIds = ids;
  }
  getManualOrder() {
    return [...this._manualOrder];
  }
  setManualOrder(order) {
    this._manualOrder = order;
  }
  /**
   * Move `draggedIds` to just before `beforeId` in the full display order.
   * Saves the result to `_manualOrder` so unpinned items keep their new positions.
   */
  reorder(draggedIds, beforeId) {
    const current = this._buildOrderedSummaries().map((s) => s.id);
    const order = current.filter((id) => !draggedIds.includes(id));
    if (beforeId !== void 0) {
      const idx = order.indexOf(beforeId);
      idx >= 0 ? order.splice(idx, 0, ...draggedIds) : order.push(...draggedIds);
    } else {
      order.push(...draggedIds);
    }
    this._manualOrder = order;
    const pinnedSet = new Set(this._pinnedIds);
    this._pinnedIds = order.filter((id) => pinnedSet.has(id));
    this._sortedCache = null;
  }
  // ------------------------------------------------------------------
  // Sort stack
  // ------------------------------------------------------------------
  restoreStack(stack) {
    if (stack.length > 0) {
      this.sortStack = stack;
    }
  }
  setSortStack(stack) {
    if (stack.length > 0) {
      this.sortStack = stack;
      this._manualOrder = [];
      this.invalidateSortCache();
    }
  }
  getSortStack() {
    return this.sortStack.map((c) => ({ ...c }));
  }
  setSortMode(mode) {
    this.invalidateSortCache();
    this._manualOrder = [];
    if (this.sortStack[0]?.key === mode) {
      const cur = this.sortStack[0].direction;
      this.sortStack = [{ key: mode, direction: cur === "asc" ? "desc" : "asc" }];
    } else {
      this.sortStack = [{ key: mode, direction: DEFAULT_DIRECTION[mode] }];
    }
  }
  getPrimary() {
    const first = this.sortStack[0] ?? { key: "date", direction: "desc" };
    return { key: first.key, direction: first.direction };
  }
  // ------------------------------------------------------------------
  // Filters
  // ------------------------------------------------------------------
  setFilter(filter) {
    this._filter = filter;
    this.invalidateSortCache();
  }
  clearFilter() {
    this._filter = {};
    this.invalidateSortCache();
  }
  getFilter() {
    return { ...this._filter };
  }
  hasActiveFilter() {
    const f = this._filter;
    return !!(f.title || f.dateFrom || f.dateTo || f.model || f.minMessages !== void 0 || f.maxMessages !== void 0 || f.hideInterrupted || f.onlyWithWarnings);
  }
  _matchesFilter(s) {
    const f = this._filter;
    if (f.title && !s.title.toLowerCase().includes(f.title.toLowerCase())) {
      return false;
    }
    const day = s.updatedAt.slice(0, 10);
    if (f.dateFrom && day < f.dateFrom) {
      return false;
    }
    if (f.dateTo && day > f.dateTo) {
      return false;
    }
    if (f.model !== void 0 && f.model !== "") {
      if (!(s.model ?? "").toLowerCase().includes(f.model.toLowerCase())) {
        return false;
      }
    }
    if (f.minMessages !== void 0 && s.messageCount < f.minMessages) {
      return false;
    }
    if (f.maxMessages !== void 0 && s.messageCount > f.maxMessages) {
      return false;
    }
    if (f.hideInterrupted && s.interrupted) {
      return false;
    }
    if (f.onlyWithWarnings && !s.hasParseErrors) {
      return false;
    }
    return true;
  }
  _filterDescription() {
    const f = this._filter;
    const parts = [];
    if (f.title) {
      parts.push(`title:"${f.title}"`);
    }
    if (f.dateFrom || f.dateTo) {
      parts.push(`date:${f.dateFrom ?? "*"}\u2192${f.dateTo ?? "*"}`);
    }
    if (f.model) {
      parts.push(`model:"${f.model}"`);
    }
    if (f.minMessages !== void 0 || f.maxMessages !== void 0) {
      parts.push(`msgs:${f.minMessages ?? 0}\u2013${f.maxMessages ?? "\u221E"}`);
    }
    if (f.hideInterrupted) {
      parts.push("hide:interrupted");
    }
    if (f.onlyWithWarnings) {
      parts.push("warnings only");
    }
    return parts.length > 0 ? `\u2298 ${parts.join(" \xB7 ")}` : "";
  }
  // ------------------------------------------------------------------
  // Description (shown in TreeView subtitle)
  // ------------------------------------------------------------------
  getDescription() {
    const count = this.index.getAllSummaries().length;
    const countPart = `${count.toLocaleString()} session${count === 1 ? "" : "s"}`;
    const sortPart = this.sortStack.map((c) => `${SHORT_LABEL[c.key]} ${c.direction === "asc" ? "\u2191" : "\u2193"}`).join(" \xB7 ");
    const filterPart = this._filterDescription();
    const right = filterPart ? `${sortPart}  \xB7  ${filterPart}` : sortPart;
    return `${countPart}  \xB7  ${right}`;
  }
  // ------------------------------------------------------------------
  // Cache management
  // ------------------------------------------------------------------
  invalidateSortCache() {
    this._sortedCache = null;
    this._visibleCount = 200;
  }
  loadMore() {
    this._visibleCount += 200;
    this._onDidChangeTreeData.fire();
  }
  setFilterDebounced(filter) {
    this._filter = filter;
    this.invalidateSortCache();
    if (this._filterDebounceTimer) {
      clearTimeout(this._filterDebounceTimer);
    }
    this._filterDebounceTimer = setTimeout(() => {
      this._filterDebounceTimer = null;
      this._onDidChangeTreeData.fire();
    }, 150);
  }
  // ------------------------------------------------------------------
  // TreeDataProvider
  // ------------------------------------------------------------------
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element) {
    return element;
  }
  // Required by VS Code for treeView.reveal() to work — all items are root-level, so no parent.
  getParent(_element) {
    return void 0;
  }
  _buildOrderedSummaries() {
    if (this._sortedCache !== null) {
      return this._sortedCache;
    }
    let summaries = this.index.getAllSummaries();
    if (this.hasActiveFilter()) {
      summaries = summaries.filter((s) => this._matchesFilter(s));
    }
    if (this._manualOrder.length > 0) {
      const byId = new Map(summaries.map((s) => [s.id, s]));
      const ordered = this._manualOrder.map((id) => byId.get(id)).filter((s) => s !== void 0);
      const inManual = new Set(this._manualOrder);
      const extras = summaries.filter((s) => !inManual.has(s.id));
      this._sortedCache = [...ordered, ...extras];
      return this._sortedCache;
    }
    const pinnedSet = new Set(this._pinnedIds);
    const pinned = this._pinnedIds.map((id) => summaries.find((s) => s.id === id)).filter(Boolean);
    const unpinned = summaries.filter((s) => !pinnedSet.has(s.id));
    unpinned.sort((a, b) => {
      for (const criterion of this.sortStack) {
        const raw = compareBy(criterion.key, a, b);
        if (raw !== 0) {
          return criterion.direction === "asc" ? raw : -raw;
        }
      }
      return 0;
    });
    this._sortedCache = [...pinned, ...unpinned];
    return this._sortedCache;
  }
  getChildren() {
    if (this._loading) {
      return [new LoadingTreeItem()];
    }
    const pinnedSet = new Set(this._pinnedIds);
    const all = this._buildOrderedSummaries();
    const visible = all.slice(0, this._visibleCount);
    const items = visible.map((s) => new SessionTreeItem(s, pinnedSet.has(s.id), this.extensionUri));
    const remaining = all.length - visible.length;
    if (remaining > 0) {
      items.push(new LoadMoreTreeItem(remaining));
    }
    return items;
  }
  /** Returns sessions in the same order as the tree view (sort, pins, filters applied). */
  getSortedSummaries() {
    return this._buildOrderedSummaries();
  }
};

// src/views/codeBlockTreeProvider.ts
var vscode3 = __toESM(require("vscode"));
var CB_SORT_KEY_LABELS = {
  date: "Date",
  workspace: "Workspace",
  length: "Total Length",
  title: "Session Title",
  language: "Language"
};
var CB_DEFAULT_DIRECTION = {
  date: "desc",
  workspace: "asc",
  length: "desc",
  title: "asc",
  language: "asc"
};
function langToExtension(language) {
  const map = {
    // Web
    typescript: "ts",
    tsx: "tsx",
    javascript: "js",
    jsx: "jsx",
    html: "html",
    css: "css",
    scss: "scss",
    less: "less",
    vue: "vue",
    svelte: "svelte",
    // Systems
    rust: "rs",
    go: "go",
    "c++": "cpp",
    cpp: "cpp",
    c: "c",
    csharp: "cs",
    "c#": "cs",
    cs: "cs",
    java: "java",
    kotlin: "kt",
    swift: "swift",
    dart: "dart",
    scala: "scala",
    haskell: "hs",
    "f#": "fs",
    fsharp: "fs",
    // Scripting
    python: "py",
    py: "py",
    ruby: "rb",
    perl: "pl",
    lua: "lua",
    r: "r",
    php: "php",
    elixir: "ex",
    erlang: "erl",
    clojure: "clj",
    // Shell
    bash: "sh",
    sh: "sh",
    shell: "sh",
    zsh: "sh",
    fish: "fish",
    powershell: "ps1",
    ps1: "ps1",
    ps: "ps1",
    batch: "bat",
    bat: "bat",
    cmd: "bat",
    // Data / config
    json: "json",
    yaml: "yml",
    yml: "yml",
    toml: "toml",
    xml: "xml",
    ini: "ini",
    env: "env",
    csv: "csv",
    sql: "sql",
    // Docs / markup
    markdown: "md",
    md: "md",
    // Infrastructure
    dockerfile: "dockerfile",
    makefile: "makefile",
    terraform: "tf",
    tf: "tf",
    proto: "proto",
    graphql: "graphql",
    // Misc
    matlab: "m",
    objc: "m",
    "objective-c": "m",
    groovy: "groovy",
    gradle: "gradle",
    solidity: "sol",
    verilog: "v",
    vhdl: "vhd"
  };
  const key = language.toLowerCase().trim();
  return map[key] ?? "txt";
}
function getPrimaryLanguage(blocks) {
  const counts = /* @__PURE__ */ new Map();
  for (const b of blocks) {
    const lang = b.language || "";
    if (lang) {
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
  }
  let best = "";
  let bestCount = 0;
  for (const [lang, count] of counts) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  return best;
}
function groupBySession(blocks) {
  const map = /* @__PURE__ */ new Map();
  for (const block of blocks) {
    let group = map.get(block.sessionId);
    if (!group) {
      group = {
        sessionId: block.sessionId,
        sessionTitle: block.sessionTitle,
        sessionSource: block.sessionSource,
        sessionUpdatedAt: block.sessionUpdatedAt,
        sessionWorkspacePath: block.sessionWorkspacePath,
        blocks: [],
        primaryLanguage: "",
        totalLength: 0
      };
      map.set(block.sessionId, group);
    }
    group.blocks.push(block);
    group.totalLength += block.content.length;
  }
  for (const group of map.values()) {
    group.primaryLanguage = getPrimaryLanguage(group.blocks);
  }
  return Array.from(map.values());
}
var CodeBlockGroupItem = class extends vscode3.TreeItem {
  sessionRef;
  constructor(group) {
    super(group.sessionTitle, vscode3.TreeItemCollapsibleState.Collapsed);
    this.sessionRef = { sessionId: group.sessionId, blocks: group.blocks };
    const dateStr = group.sessionUpdatedAt ? group.sessionUpdatedAt.slice(0, 10) : "";
    const blockCount = group.blocks.length;
    const sourceLabel = group.sessionSource === "copilot" ? "Copilot" : "Claude";
    this.description = [
      dateStr,
      `${blockCount} snippet${blockCount === 1 ? "" : "s"}`,
      sourceLabel
    ].filter(Boolean).join(" \xB7 ");
    const lang = group.primaryLanguage.toLowerCase().trim();
    if (lang === "css") {
      this.iconPath = new vscode3.ThemeIcon("symbol-misc");
    } else {
      const ext = langToExtension(group.primaryLanguage);
      this.resourceUri = vscode3.Uri.file(`file.${ext}`);
    }
    const workspaceName = group.sessionWorkspacePath ? group.sessionWorkspacePath.replace(/\\/g, "/").split("/").pop() ?? "" : "";
    const shownBlocks = group.blocks.slice(0, 3);
    const blockPreviews = shownBlocks.map((b, i) => {
      const lang2 = b.language || "plain";
      const preview = b.content.length > 120 ? b.content.slice(0, 120) + "\u2026" : b.content;
      return `**Snippet ${i + 1}** (${lang2})
\`\`\`${lang2}
${preview}
\`\`\``;
    });
    if (group.blocks.length > 3) {
      blockPreviews.push(`_\u2026 and ${group.blocks.length - 3} more snippet(s)_`);
    }
    const langLabel = group.primaryLanguage || "plain";
    const meta = [
      `**Language:** ${langLabel}  |  **Source:** ${sourceLabel}  |  **Snippets:** ${blockCount}${dateStr ? `  |  **Date:** ${dateStr}` : ""}`,
      workspaceName ? `**Workspace:** ${workspaceName}` : ""
    ].filter(Boolean).join("\n\n");
    this.tooltip = new vscode3.MarkdownString(
      [`**${group.sessionTitle}**`, meta, "", ...blockPreviews].join("\n\n")
    );
    this.contextValue = "codeblock";
    this.command = {
      command: "chatwizard.openSessionFromCodeBlock",
      title: "Open Session",
      arguments: [this.sessionRef]
    };
  }
};
var CodeBlockLeafItem = class extends vscode3.TreeItem {
  block;
  sessionRef;
  constructor(block) {
    const langLabel = block.language || "plain";
    const preview = block.content.length > 60 ? block.content.slice(0, 60).replace(/\n/g, " ") + "\u2026" : block.content.replace(/\n/g, " ");
    super(`${langLabel}: ${preview}`, vscode3.TreeItemCollapsibleState.None);
    this.block = block;
    this.sessionRef = { sessionId: block.sessionId, blocks: [block] };
    const ext = langToExtension(block.language || "");
    this.resourceUri = vscode3.Uri.file(`file.${ext}`);
    const fullPreview = block.content.length > 300 ? block.content.slice(0, 300) + "\u2026" : block.content;
    this.tooltip = new vscode3.MarkdownString(
      `**${langLabel}** \xB7 ${block.messageRole}

\`\`\`${langLabel}
${fullPreview}
\`\`\``
    );
    this.contextValue = "codeblockLeaf";
    this.command = {
      command: "chatwizard.openSessionFromCodeBlock",
      title: "Open Session",
      arguments: [this.sessionRef]
    };
  }
};
var CodeBlockLoadMoreItem = class extends vscode3.TreeItem {
  remaining;
  constructor(remaining) {
    super(`\u22EF Load more (${remaining} remaining)`, vscode3.TreeItemCollapsibleState.None);
    this.remaining = remaining;
    this.contextValue = "cbLoadMore";
    this.command = {
      command: "chatwizard.loadMoreCodeBlocks",
      title: "Load More Code Blocks",
      arguments: []
    };
  }
};
var CodeBlockTreeProvider = class {
  constructor(index, engine) {
    this.index = index;
    this.engine = engine;
    index.addChangeListener(() => {
      this._groupCache = null;
      this.refresh();
    });
  }
  _onDidChangeTreeData = new vscode3.EventEmitter();
  onDidChangeTreeData = this._onDidChangeTreeData.event;
  _filter = {};
  _sortMode = "date";
  _sortDir = "desc";
  _groupCache = null;
  _visibleGroupCount = 200;
  // ------------------------------------------------------------------
  // Filter
  // ------------------------------------------------------------------
  setFilter(filter) {
    this._filter = filter;
    this._groupCache = null;
    this._visibleGroupCount = 200;
  }
  clearFilter() {
    this._filter = {};
    this._groupCache = null;
    this._visibleGroupCount = 200;
  }
  getFilter() {
    return { ...this._filter };
  }
  hasActiveFilter() {
    const f = this._filter;
    return !!(f.language || f.content || f.sessionSource || f.messageRole);
  }
  _blockMatchesFilter(block) {
    const f = this._filter;
    if (f.language && !block.language.toLowerCase().includes(f.language.toLowerCase())) {
      return false;
    }
    if (f.content && !block.content.toLowerCase().includes(f.content.toLowerCase())) {
      return false;
    }
    if (f.sessionSource && block.sessionSource !== f.sessionSource) {
      return false;
    }
    if (f.messageRole && block.messageRole !== f.messageRole) {
      return false;
    }
    return true;
  }
  _groupMatchesFilter(group) {
    if (!this.hasActiveFilter()) {
      return true;
    }
    return group.blocks.some((b) => this._blockMatchesFilter(b));
  }
  _filterDescription() {
    const f = this._filter;
    const parts = [];
    if (f.language) {
      parts.push(`lang:"${f.language}"`);
    }
    if (f.content) {
      parts.push(`content:"${f.content}"`);
    }
    if (f.sessionSource) {
      parts.push(`source:${f.sessionSource}`);
    }
    if (f.messageRole) {
      parts.push(`role:${f.messageRole}`);
    }
    return parts.length > 0 ? `\u2298 ${parts.join(" \xB7 ")}` : "";
  }
  // ------------------------------------------------------------------
  // Sort
  // ------------------------------------------------------------------
  setSortMode(mode) {
    this._groupCache = null;
    this._visibleGroupCount = 200;
    if (this._sortMode === mode) {
      this._sortDir = this._sortDir === "asc" ? "desc" : "asc";
    } else {
      this._sortMode = mode;
      this._sortDir = CB_DEFAULT_DIRECTION[mode];
    }
  }
  getSortMode() {
    return this._sortMode;
  }
  getSortDir() {
    return this._sortDir;
  }
  // ------------------------------------------------------------------
  // Load more
  // ------------------------------------------------------------------
  loadMore() {
    this._visibleGroupCount += 200;
    this._onDidChangeTreeData.fire();
  }
  // ------------------------------------------------------------------
  // Description (shown below view title)
  // ------------------------------------------------------------------
  _nonEmptyBlocks() {
    return this.index.getAllCodeBlocks().filter((b) => {
      if (b.content.trim().length === 0) {
        return false;
      }
      if (b.language === "") {
        const lines = b.content.trim().split("\n").filter((l) => l.trim().length > 0);
        if (lines.length > 0 && lines.every((l) => /^\s*(?:[-*+]|\d+\.)\s+/.test(l))) {
          return false;
        }
      }
      return true;
    });
  }
  _buildSortedGroups() {
    if (this._groupCache !== null) {
      return this._groupCache;
    }
    const groups = groupBySession(this._nonEmptyBlocks());
    const filtered = groups.filter((g) => this._groupMatchesFilter(g));
    const dir = this._sortDir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      let cmp = 0;
      switch (this._sortMode) {
        case "date":
          cmp = (a.sessionUpdatedAt ?? "").localeCompare(b.sessionUpdatedAt ?? "");
          break;
        case "workspace":
          cmp = (a.sessionWorkspacePath ?? "").localeCompare(b.sessionWorkspacePath ?? "");
          break;
        case "length":
          cmp = a.totalLength - b.totalLength;
          break;
        case "title":
          cmp = a.sessionTitle.localeCompare(b.sessionTitle);
          break;
        case "language": {
          const langKey = (lang) => lang && langToExtension(lang) !== "txt" ? lang.toLowerCase() : "\uFFFF";
          cmp = langKey(a.primaryLanguage).localeCompare(langKey(b.primaryLanguage));
          break;
        }
      }
      return cmp * dir;
    });
    this._groupCache = filtered;
    return this._groupCache;
  }
  getDescription() {
    const filtered = this._buildSortedGroups();
    const countPart = `${filtered.length} session${filtered.length === 1 ? "" : "s"}`;
    const dirArrow = this._sortDir === "asc" ? "\u2191" : "\u2193";
    const sortPart = `${CB_SORT_KEY_LABELS[this._sortMode]} ${dirArrow}`;
    const filterPart = this._filterDescription();
    return filterPart ? `${countPart}  \xB7  ${sortPart}  \xB7  ${filterPart}` : `${countPart}  \xB7  ${sortPart}`;
  }
  // ------------------------------------------------------------------
  // TreeDataProvider
  // ------------------------------------------------------------------
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element) {
    return element;
  }
  getChildren(element) {
    if (element instanceof CodeBlockGroupItem) {
      return element.sessionRef.blocks.map((b) => new CodeBlockLeafItem(b));
    }
    const allGroups = this._buildSortedGroups();
    const visible = allGroups.slice(0, this._visibleGroupCount);
    const items = visible.map((g) => new CodeBlockGroupItem(g));
    const remaining = allGroups.length - visible.length;
    if (remaining > 0) {
      items.push(new CodeBlockLoadMoreItem(remaining));
    }
    return items;
  }
};

// src/views/sessionWebviewPanel.ts
var vscode4 = __toESM(require("vscode"));

// src/webview/cwTheme.ts
function cwThemeCss() {
  return `
/* -- CW Design Tokens ------------------------------------------- */
:root {
  --cw-radius:    8px;
  --cw-radius-sm: 5px;
  --cw-radius-xs: 3px;
}

.vscode-dark, .vscode-high-contrast {
  --cw-accent:         #5B8AF5;
  --cw-accent-hover:   #4a7ae0;
  --cw-accent-text:    #ffffff;
  --cw-copilot:        #f0883e;
  --cw-claude:         #a67bf0;
  --cw-surface:        #181c2a;
  --cw-surface-raised: #1f2438;
  --cw-surface-subtle: #252b40;
  --cw-border:         rgba(255,255,255,0.07);
  --cw-border-strong:  rgba(255,255,255,0.13);
  --cw-text-muted:     #7a879f;
  --cw-shadow:         0 2px 12px rgba(0,0,0,0.35);
  --cw-shadow-hover:   0 4px 20px rgba(0,0,0,0.50);
  --cw-sk-base:        #1f2438;
  --cw-sk-shine:       #2a3050;
}

.vscode-light {
  --cw-accent:         #3b6fd4;
  --cw-accent-hover:   #2a5bbf;
  --cw-accent-text:    #ffffff;
  --cw-copilot:        #c05c00;
  --cw-claude:         #7b4fd4;
  --cw-surface:        #f4f6fb;
  --cw-surface-raised: #ffffff;
  --cw-surface-subtle: #eef1f8;
  --cw-border:         rgba(0,0,0,0.08);
  --cw-border-strong:  rgba(0,0,0,0.16);
  --cw-text-muted:     #6370a0;
  --cw-shadow:         0 2px 12px rgba(0,0,0,0.08);
  --cw-shadow-hover:   0 4px 20px rgba(0,0,0,0.14);
  --cw-sk-base:        #eef1f8;
  --cw-sk-shine:       #ffffff;
}

/* -- Skeleton shimmer ------------------------------------------- */
@keyframes cw-shimmer {
  0%   { background-position: -400px 0; }
  100% { background-position:  400px 0; }
}

.cw-skeleton {
  background: linear-gradient(
    90deg,
    var(--cw-sk-base)  25%,
    var(--cw-sk-shine) 50%,
    var(--cw-sk-base)  75%
  );
  background-size: 800px 100%;
  animation: cw-shimmer 1.6s infinite linear;
  border-radius: var(--cw-radius-xs);
}

/* -- Card ------------------------------------------------------- */
.cw-card {
  background:    var(--cw-surface-raised);
  border:        1px solid var(--cw-border);
  border-radius: var(--cw-radius);
  box-shadow:    var(--cw-shadow);
  overflow:      hidden;
}

.cw-card-header {
  background:    var(--cw-surface-subtle);
  border-bottom: 1px solid var(--cw-border);
  padding:       6px 10px;
  display:       flex;
  align-items:   center;
  gap:           8px;
}

/* -- Button ----------------------------------------------------- */
.cw-btn {
  font-size:     0.78em;
  padding:       2px 10px;
  border:        1px solid var(--cw-border-strong);
  border-radius: var(--cw-radius-xs);
  cursor:        pointer;
  background:    var(--cw-surface-subtle);
  color:         inherit;
  white-space:   nowrap;
  flex-shrink:   0;
  position:      relative;
  overflow:      hidden;
  transition:    background 0.12s, color 0.12s, border-color 0.12s;
}

.cw-btn:hover {
  background:   var(--cw-accent);
  color:        var(--cw-accent-text);
  border-color: var(--cw-accent);
}

/* -- Badges ----------------------------------------------------- */
.cw-badge-accent {
  display:       inline-block;
  font-size:     0.78em;
  font-weight:   700;
  padding:       2px 9px;
  border-radius: 10px;
  background:    var(--cw-accent);
  color:         var(--cw-accent-text);
  white-space:   nowrap;
  flex-shrink:   0;
}

.cw-badge-copilot {
  display:       inline-block;
  font-size:     0.73em;
  font-weight:   600;
  padding:       1px 6px;
  border-radius: var(--cw-radius-xs);
  background:    rgba(240,136,62,0.18);
  color:         var(--cw-copilot);
  border:        1px solid rgba(240,136,62,0.35);
  white-space:   nowrap;
}

.cw-badge-claude {
  display:       inline-block;
  font-size:     0.73em;
  font-weight:   600;
  padding:       1px 6px;
  border-radius: var(--cw-radius-xs);
  background:    rgba(166,123,240,0.18);
  color:         var(--cw-claude);
  border:        1px solid rgba(166,123,240,0.35);
  white-space:   nowrap;
}

/* -- Toolbar ---------------------------------------------------- */
.cw-toolbar {
  background:    var(--cw-surface);
  border-bottom: 1px solid var(--cw-border);
}

/* -- Custom scrollbars ------------------------------------------- */
::-webkit-scrollbar             { width: 6px; height: 6px; }
::-webkit-scrollbar-track       { background: transparent; }
::-webkit-scrollbar-thumb       { background: var(--cw-border-strong); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--cw-accent); }

/* -- Staggered fade-in ------------------------------------------- */
@keyframes cw-fade-up {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.cw-fade-item {
  animation:       cw-fade-up 0.22s ease both;
  animation-delay: calc(var(--cw-i, 0) * 35ms);
}

/* -- Toast notification ------------------------------------------ */
.cw-toast {
  position:       fixed;
  bottom:         20px;
  left:           50%;
  transform:      translateX(-50%) translateY(12px);
  background:     var(--cw-surface-raised);
  border:         1px solid var(--cw-border-strong);
  border-radius:  var(--cw-radius-sm);
  padding:        6px 18px;
  font-size:      0.88em;
  box-shadow:     var(--cw-shadow-hover);
  opacity:        0;
  pointer-events: none;
  transition:     opacity 0.16s, transform 0.16s;
  z-index:        9999;
  white-space:    nowrap;
  color:          var(--cw-accent);
}
.cw-toast.show {
  opacity:   1;
  transform: translateX(-50%) translateY(0);
}

/* -- Button ripple ----------------------------------------------- */
.cw-ripple-wave {
  position:       absolute;
  border-radius:  50%;
  background:     rgba(255,255,255,0.22);
  transform:      scale(0);
  animation:      cw-ripple-anim 0.4s linear;
  pointer-events: none;
}
@keyframes cw-ripple-anim {
  to { transform: scale(4); opacity: 0; }
}

/* -- Back-to-top FAB --------------------------------------------- */
.cw-back-top {
  position:       fixed;
  bottom:         20px;
  right:          20px;
  width:          34px;
  height:         34px;
  border-radius:  50%;
  background:     var(--cw-accent);
  color:          var(--cw-accent-text);
  border:         none;
  cursor:         pointer;
  font-size:      1.1em;
  line-height:    34px;
  text-align:     center;
  opacity:        0;
  transform:      translateY(8px);
  transition:     opacity 0.18s, transform 0.18s, background 0.12s;
  z-index:        200;
  box-shadow:     var(--cw-shadow-hover);
  pointer-events: none;
  padding:        0;
  user-select:    none;
}
.cw-back-top.visible { opacity: 0.85; transform: translateY(0); pointer-events: auto; }
.cw-back-top:hover   { opacity: 1; background: var(--cw-accent-hover); }
`;
}
function syntaxHighlighterCss() {
  return `
/* -- Syntax Highlight (fixed dark palette) --------------------- */
pre {
  background: #0d1117 !important;
  border-radius: var(--cw-radius-sm, 5px);
  border: 1px solid rgba(255,255,255,0.06);
}

pre code {
  background: transparent !important;
  color: #c9d1d9;
}

.tok-keyword  { color: #ff7b72; }
.tok-string   { color: #a5d6ff; }
.tok-comment  { color: #8b949e; font-style: italic; }
.tok-number   { color: #79c0ff; }
.tok-function { color: #d2a8ff; }
.tok-type     { color: #ffa657; }
`;
}
function cwInteractiveJs() {
  return `
(function() {
  // Ripple on buttons
  function spawnRipple(btn, e) {
    var s = getComputedStyle(btn).position;
    if (s === 'static') { btn.style.position = 'relative'; }
    btn.style.overflow = 'hidden';
    var rect = btn.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height) * 1.6;
    var x = e.clientX - rect.left - size / 2;
    var y = e.clientY - rect.top  - size / 2;
    var wave = document.createElement('span');
    wave.className = 'cw-ripple-wave';
    wave.style.width  = size + 'px';
    wave.style.height = size + 'px';
    wave.style.left   = x + 'px';
    wave.style.top    = y + 'px';
    btn.appendChild(wave);
    setTimeout(function() { if (wave.parentNode) { wave.parentNode.removeChild(wave); } }, 450);
  }
  document.addEventListener('mousedown', function(e) {
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (btn) { spawnRipple(btn, e); }
  });

  // Toast
  var _cwToast = null, _cwToastTimer = null;
  window.cwShowToast = function(msg) {
    if (!_cwToast) {
      _cwToast = document.createElement('div');
      _cwToast.className = 'cw-toast';
      document.body.appendChild(_cwToast);
    }
    _cwToast.textContent = msg;
    clearTimeout(_cwToastTimer);
    _cwToast.classList.add('show');
    _cwToastTimer = setTimeout(function() { _cwToast.classList.remove('show'); }, 1800);
  };

  // Copy-button morph
  window.cwMorphCopy = function(btn, origText) {
    btn.textContent   = '\\u2713 Copied';
    btn.style.background  = 'var(--cw-accent)';
    btn.style.color       = 'var(--cw-accent-text)';
    btn.style.borderColor = 'var(--cw-accent)';
    btn.disabled = true;
    setTimeout(function() {
      btn.textContent       = origText;
      btn.style.background  = '';
      btn.style.color       = '';
      btn.style.borderColor = '';
      btn.disabled = false;
    }, 2000);
    if (window.cwShowToast) { window.cwShowToast('Copied to clipboard'); }
  };
})();
`;
}

// src/analytics/modelNames.ts
function friendlyModelName(raw) {
  if (!raw) {
    return "Unknown";
  }
  const s = raw.trim();
  if (!s || s === "<synthetic>") {
    return "Unknown";
  }
  const c4 = s.match(/^claude-(opus|sonnet|haiku)-4(-(\d{1,2}))?(?:-\d{8})?$/i);
  if (c4) {
    const variant = cap(c4[1]);
    const minor = c4[3];
    return minor ? `Claude ${variant} 4.${minor}` : `Claude ${variant} 4`;
  }
  const c3 = s.match(/^claude-3(-(\d+))?-(opus|sonnet|haiku)(?:-\d{8})?$/i);
  if (c3) {
    const minor = c3[2];
    const variant = cap(c3[3]);
    return minor ? `Claude 3.${minor} ${variant}` : `Claude 3 ${variant}`;
  }
  if (/^claude-2(\.\d+)?(?:-\d+)?$/i.test(s)) {
    return "Claude 2";
  }
  if (/^claude-instant/i.test(s)) {
    return "Claude Instant";
  }
  if (/^gpt-4o-mini$/i.test(s)) {
    return "GPT-4o mini";
  }
  if (/^gpt-4o/i.test(s)) {
    return "GPT-4o";
  }
  if (/^gpt-4-turbo/i.test(s)) {
    return "GPT-4 Turbo";
  }
  if (/^gpt-4(?:-\d+)?$/i.test(s)) {
    return "GPT-4";
  }
  if (/^gpt-3\.5-turbo/i.test(s)) {
    return "GPT-3.5 Turbo";
  }
  if (/^o1-preview$/i.test(s)) {
    return "o1 Preview";
  }
  if (/^o1-mini$/i.test(s)) {
    return "o1 mini";
  }
  if (/^o1$/i.test(s)) {
    return "o1";
  }
  if (/^o3-mini$/i.test(s)) {
    return "o3 mini";
  }
  if (/^o3$/i.test(s)) {
    return "o3";
  }
  if (/^o4-mini$/i.test(s)) {
    return "o4 mini";
  }
  if (/^cursor-fast$/i.test(s)) {
    return "Cursor Fast";
  }
  if (/^cursor-small$/i.test(s)) {
    return "Cursor Small";
  }
  const gemVer = s.match(/^gemini-(\d+\.\d+)-(\w+)$/i);
  if (gemVer) {
    return `Gemini ${gemVer[1]} ${cap(gemVer[2])}`;
  }
  const gemPlain = s.match(/^gemini-(pro|ultra|flash)$/i);
  if (gemPlain) {
    return `Gemini ${cap(gemPlain[1])}`;
  }
  return s;
}
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// src/views/sessionRenderer.ts
var RE_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
var RE_NON_ASCII = /[^\x00-\x7F]/gu;
var RE_FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;
var RE_INLINE_CODE = /`([^`]+)`/g;
var RE_PLACEHOLDER_CB = /^\x00CB(\d+)\x00$/;
var RE_PLACEHOLDER_CB_G = /\x00CB(\d+)\x00/g;
var RE_PLACEHOLDER_IC_G = /\x00IC(\d+)\x00/g;
var RE_AMP = /&/g;
var RE_LT = /</g;
var RE_GT = />/g;
var RE_QUOT = /"/g;
var RE_APOS = /'/g;
var RE_INDENT = /^    /;
var RE_HEADING = /^(#{1,6})\s+(.+)$/;
var RE_HR = /^([-*_])\1\1+\s*$/;
var RE_BLOCKQUOTE = /^&gt;\s?(.*)$/;
var RE_TABLE_ROW = /^\|/;
var RE_TABLE_SEP = /^\|[\s|:-]+\|$/;
var RE_UL = /^[-*+]\s+(.+)$/;
var RE_OL = /^\d+\.\s+(.+)$/;
var RE_BOLD_ITALIC = /\*\*\*(.+?)\*\*\*/g;
var RE_BOLD = /\*\*(.+?)\*\*/g;
var RE_ITALIC = /\*(.+?)\*/g;
var RE_STRIKE = /~~(.+?)~~/g;
var RE_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;
var RE_ESC_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
function renderChunk(visibleMessages, renderedMessages, start, end, assistantLabel, withFade) {
  const parts = [];
  for (let i = start; i < end; i++) {
    const { msg, origIdx } = visibleMessages[i];
    const fadeIdx = withFade ? i - start : void 0;
    if (fadeIdx !== void 0 && fadeIdx < 16) {
      parts.push(renderMessage(msg, origIdx, i, visibleMessages, assistantLabel, fadeIdx));
      if (renderedMessages[i] === null) {
        renderedMessages[i] = renderMessage(
          msg,
          origIdx,
          i,
          visibleMessages,
          assistantLabel,
          void 0
        );
      }
    } else {
      if (renderedMessages[i] === null) {
        renderedMessages[i] = renderMessage(
          msg,
          origIdx,
          i,
          visibleMessages,
          assistantLabel,
          void 0
        );
      }
      parts.push(renderedMessages[i]);
    }
  }
  return parts.join("\n");
}
function renderMessage(msg, origIdx, visibleIdx, visibleMessages, assistantLabel, fadeIdx) {
  const roleClass = msg.role === "user" ? "user" : "assistant";
  const label = msg.role === "user" ? "You" : assistantLabel;
  const timestamp = msg.timestamp ? `<span class="timestamp">${escapeHtml(new Date(msg.timestamp).toLocaleString())}</span>` : "";
  const fadeStyle = fadeIdx !== void 0 && fadeIdx < 16 ? ` style="--cw-i:${fadeIdx}"` : "";
  if (msg.skipped) {
    const sizeKb = msg.skippedLineLength !== void 0 ? Math.round(msg.skippedLineLength / 1024) : "?";
    const limitKb = msg.skippedLineLimit !== void 0 ? Math.round(msg.skippedLineLimit / 1024) : "?";
    return `<div class="message ${roleClass} cw-fade-item"${fadeStyle} data-msg-idx="${origIdx}">
  <div class="message-header">
    <span class="role-label">${label}</span>${timestamp}
  </div>
  <div class="message-body skipped-notice">&#9888; Message not shown &mdash; source line is ${sizeKb}&nbsp;KB, exceeding the ${limitKb}&nbsp;KB limit. Raise <code>chatwizard.maxLineLengthChars</code> in settings to include it.</div>
</div>`;
  }
  const renderedContent = markdownToHtml(msg.content);
  let html = `<div class="message ${roleClass} cw-fade-item"${fadeStyle} data-msg-idx="${origIdx}">
  <div class="message-header">
    <span class="role-label">${label}</span>${timestamp}
  </div>
  <div class="message-body" data-raw="${escapeHtml(msg.content)}">${renderedContent}</div>
</div>`;
  const nextEntry = visibleMessages[visibleIdx + 1];
  if (msg.role === "user" && (!nextEntry || nextEntry.msg.role === "user")) {
    html += `
<div class="message assistant cw-role-response aborted">
  <div class="message-header"><span class="role-label">${assistantLabel}</span></div>
  <div class="message-body aborted-notice">&#9888; Response not available &mdash; cancelled or incomplete</div>
</div>`;
  }
  return html;
}
function escapeHtml(text) {
  return text.replace(RE_ESC_CONTROL, "").replace(RE_AMP, "&amp;").replace(RE_LT, "&lt;").replace(RE_GT, "&gt;").replace(RE_QUOT, "&quot;").replace(RE_APOS, "&#39;").replace(RE_NON_ASCII, (c) => `&#${c.codePointAt(0)};`);
}
function applyInline(text) {
  return text.replace(RE_BOLD_ITALIC, "<strong><em>$1</em></strong>").replace(RE_BOLD, "<strong>$1</strong>").replace(RE_ITALIC, "<em>$1</em>").replace(RE_STRIKE, "<del>$1</del>").replace(RE_LINK, '<a href="$2">$1</a>');
}
function markdownToHtml(markdown) {
  markdown = markdown.replace(RE_CONTROL, "");
  const codeBlocks = [];
  let text = markdown.replace(RE_FENCE, (_m, lang, code) => {
    const esc = code.replace(RE_AMP, "&amp;").replace(RE_LT, "&lt;").replace(RE_GT, "&gt;");
    const attr = lang.trim() ? ` class="language-${lang.trim()}"` : "";
    const fenceIdx = codeBlocks.length;
    codeBlocks.push(`<pre data-fence-idx="${fenceIdx}"><code${attr}>${esc}</code></pre>`);
    return `\0CB${codeBlocks.length - 1}\0`;
  });
  text = text.replace(RE_AMP, "&amp;").replace(RE_LT, "&lt;").replace(RE_GT, "&gt;");
  text = text.replace(RE_NON_ASCII, (c) => `&#${c.codePointAt(0)};`);
  const inlineCodes = [];
  text = text.replace(RE_INLINE_CODE, (_m, code) => {
    inlineCodes.push(`<code>${code}</code>`);
    return `\0IC${inlineCodes.length - 1}\0`;
  });
  const lines = text.split("\n");
  const out = [];
  let inUl = false, inOl = false, inTable = false;
  let columnAligns = [];
  let paragraphLines = [];
  const closeList = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      out.push("</tbody></table></div>");
      inTable = false;
      columnAligns = [];
    }
  };
  const alignAttr = (colIdx) => {
    const a = columnAligns[colIdx] ?? "";
    return a ? ` style="text-align:${a}"` : "";
  };
  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      out.push(`<p>${paragraphLines.join("<br>")}</p>`);
      paragraphLines = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cbMatch = line.trim().match(RE_PLACEHOLDER_CB);
    if (cbMatch) {
      flushParagraph();
      closeList();
      closeTable();
      out.push(codeBlocks[+cbMatch[1]]);
      continue;
    }
    if (RE_INDENT.test(line) && !inUl && !inOl) {
      flushParagraph();
      closeList();
      closeTable();
      const indentedLines = [line.slice(4)];
      while (i + 1 < lines.length && RE_INDENT.test(lines[i + 1])) {
        i++;
        indentedLines.push(lines[i].slice(4));
      }
      const esc = indentedLines.join("\n").replace(RE_AMP, "&amp;").replace(RE_LT, "&lt;").replace(RE_GT, "&gt;");
      out.push(`<pre><code>${esc}</code></pre>`);
      continue;
    }
    const hMatch = line.match(RE_HEADING);
    if (hMatch) {
      flushParagraph();
      closeList();
      closeTable();
      const lvl = hMatch[1].length;
      out.push(`<h${lvl}>${applyInline(hMatch[2])}</h${lvl}>`);
      continue;
    }
    if (RE_HR.test(line)) {
      flushParagraph();
      closeList();
      closeTable();
      out.push("<hr>");
      continue;
    }
    const bqMatch = line.match(RE_BLOCKQUOTE);
    if (bqMatch) {
      flushParagraph();
      closeList();
      closeTable();
      out.push(`<blockquote><p>${applyInline(bqMatch[1])}</p></blockquote>`);
      continue;
    }
    if (RE_TABLE_ROW.test(line.trim()) && line.trim().endsWith("|")) {
      const nextLine = lines[i + 1] ?? "";
      const isSeparator = RE_TABLE_SEP.test(nextLine.trim());
      if (isSeparator && !inTable) {
        flushParagraph();
        closeList();
        const headerCells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
        const sepCells = nextLine.trim().slice(1, -1).split("|").map((c) => c.trim());
        columnAligns = sepCells.map((c) => {
          if (c.startsWith(":") && c.endsWith(":")) {
            return "center";
          }
          if (c.endsWith(":")) {
            return "right";
          }
          if (c.startsWith(":")) {
            return "left";
          }
          return "";
        });
        out.push('<div class="table-wrap"><table><thead><tr>');
        for (let ci = 0; ci < headerCells.length; ci++) {
          out.push(`<th${alignAttr(ci)}>${applyInline(headerCells[ci])}</th>`);
        }
        out.push("</tr></thead><tbody>");
        inTable = true;
        i++;
        continue;
      }
      if (RE_TABLE_SEP.test(line.trim())) {
        continue;
      }
      if (inTable || !isSeparator && RE_TABLE_ROW.test(line.trim())) {
        if (!inTable) {
          flushParagraph();
          closeList();
          out.push('<div class="table-wrap"><table><tbody>');
          inTable = true;
        }
        const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
        out.push("<tr>");
        for (let ci = 0; ci < cells.length; ci++) {
          out.push(`<td${alignAttr(ci)}>${applyInline(cells[ci])}</td>`);
        }
        out.push("</tr>");
        continue;
      }
    } else if (inTable) {
      closeTable();
    }
    const ulMatch = line.match(RE_UL);
    if (ulMatch) {
      flushParagraph();
      closeTable();
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${applyInline(ulMatch[1])}</li>`);
      continue;
    }
    const olMatch = line.match(RE_OL);
    if (olMatch) {
      flushParagraph();
      closeTable();
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        out.push("<ol>");
        inOl = true;
      }
      out.push(`<li>${applyInline(olMatch[1])}</li>`);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      closeList();
      closeTable();
      continue;
    }
    closeList();
    closeTable();
    paragraphLines.push(applyInline(line));
  }
  flushParagraph();
  closeList();
  closeTable();
  let result = out.join("\n");
  result = result.replace(RE_PLACEHOLDER_IC_G, (_m, i) => inlineCodes[+i]);
  result = result.replace(RE_PLACEHOLDER_CB_G, (_m, i) => codeBlocks[+i]);
  return result;
}

// src/views/sessionWebviewPanel.ts
var INITIAL_WINDOW = 50;
var CHUNK_SIZE = 20;
var SessionWebviewPanel = class _SessionWebviewPanel {
  static _panels = /* @__PURE__ */ new Map();
  /** Cache: `sessionId::updatedAt` → rendered HTML per visible message (null = not yet rendered) */
  static _renderCache = /* @__PURE__ */ new Map();
  /** Per-panel window / streaming state */
  static _panelState = /* @__PURE__ */ new Map();
  // ── Public entry point ────────────────────────────────────────────────────
  static show(context, session, searchTerm, scrollToCodeBlock, targetBlockMessageIndex, _targetBlockContent, targetBlockIdx, highlightContainer) {
    const config = vscode4.workspace.getConfiguration("chatwizard");
    const userColor = config.get("userMessageColor", "#007acc") || "#007acc";
    const cbHighlightColor = scrollToCodeBlock ? config.get("codeBlockHighlightColor", "#EA5C00") || "" : "";
    const cbScroll = scrollToCodeBlock ? config.get("scrollToFirstCodeBlock", true) ?? false : false;
    const assistantLabel = session.source === "copilot" ? "Copilot" : "Claude";
    const visibleMessages = session.messages.map((msg, origIdx) => ({ msg, origIdx })).filter(({ msg }) => msg.content.trim() !== "" || !!msg.skipped);
    const total = visibleMessages.length;
    const initialSz = INITIAL_WINDOW;
    let windowStart = 0;
    if (targetBlockMessageIndex !== void 0) {
      const targetVisibleIdx = visibleMessages.findIndex(
        (vm) => vm.origIdx === targetBlockMessageIndex
      );
      if (targetVisibleIdx >= 0) {
        windowStart = Math.max(0, targetVisibleIdx - 3);
      }
    }
    const cacheKey = `${session.id}::${session.updatedAt}`;
    let renderedMessages = _SessionWebviewPanel._renderCache.get(cacheKey);
    if (!renderedMessages) {
      renderedMessages = new Array(total).fill(null);
      _SessionWebviewPanel._renderCache.set(cacheKey, renderedMessages);
    }
    const scrollInit = {
      targetMsgIdx: targetBlockMessageIndex ?? null,
      targetBlockIdx: targetBlockIdx ?? null,
      highlightColor: cbHighlightColor || null,
      shouldScroll: cbScroll
    };
    const initialWindowEnd = Math.min(windowStart + initialSz, total);
    const existing = _SessionWebviewPanel._panels.get(session.id);
    if (existing) {
      existing.reveal(vscode4.ViewColumn.One);
      const prev = _SessionWebviewPanel._panelState.get(session.id);
      const newVersion = (prev?.streamVersion ?? 0) + 1;
      _SessionWebviewPanel._panelState.set(session.id, {
        session,
        visibleMessages,
        renderedMessages,
        windowStart,
        windowEnd: initialWindowEnd,
        streamVersion: newVersion,
        assistantLabel,
        panel: existing
      });
      void _SessionWebviewPanel._startStream(
        session.id,
        newVersion,
        userColor,
        searchTerm,
        scrollInit,
        highlightContainer
      );
      return;
    }
    const panel = vscode4.window.createWebviewPanel(
      "chatwizardSession3",
      session.title,
      vscode4.ViewColumn.One,
      { enableScripts: true }
    );
    panel.webview.html = _SessionWebviewPanel._getShellHtml();
    _SessionWebviewPanel._panelState.set(session.id, {
      session,
      visibleMessages,
      renderedMessages,
      windowStart,
      windowEnd: initialWindowEnd,
      streamVersion: 0,
      assistantLabel,
      panel
    });
    _SessionWebviewPanel._panels.set(session.id, panel);
    panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg.type === "ready") {
          const st = _SessionWebviewPanel._panelState.get(session.id);
          void _SessionWebviewPanel._startStream(
            session.id,
            st?.streamVersion ?? 0,
            userColor,
            searchTerm,
            scrollInit,
            highlightContainer
          );
        } else if (msg.type === "loadMoreMessages") {
          void _SessionWebviewPanel._loadMoreMessages(session.id);
        } else if (msg.command === "exportExcerpt") {
          void vscode4.commands.executeCommand("chatwizard.exportExcerpt", session.id);
        } else if (msg.command === "exportSelection" && msg.text) {
          void _SessionWebviewPanel._saveSelection(msg.text, session.title);
        }
      },
      void 0,
      context.subscriptions
    );
    panel.onDidDispose(() => {
      _SessionWebviewPanel._panels.delete(session.id);
      _SessionWebviewPanel._panelState.delete(session.id);
    }, null, []);
  }
  // ── Streaming pipeline ────────────────────────────────────────────────────
  static async _startStream(panelId, myVersion, userColor, searchTerm, scrollInit, highlightContainer) {
    const state = _SessionWebviewPanel._panelState.get(panelId);
    if (!state || state.streamVersion !== myVersion) {
      return;
    }
    const { visibleMessages, renderedMessages, windowStart, assistantLabel, panel, session } = state;
    const total = visibleMessages.length;
    const windowEnd = state.windowEnd;
    const firstEnd = Math.min(windowStart + CHUNK_SIZE, windowEnd);
    const firstHtml = _SessionWebviewPanel._renderChunk(
      visibleMessages,
      renderedMessages,
      windowStart,
      firstEnd,
      assistantLabel,
      true
    );
    state.windowStart = windowStart;
    state.windowEnd = firstEnd;
    void panel.webview.postMessage({
      type: "render",
      title: session.title,
      source: session.source,
      userColor,
      term: searchTerm ?? null,
      scrollInit: null,
      // scroll sent separately after all chunks via cwScroll
      messagesHtml: firstHtml,
      windowStart,
      windowEnd: firstEnd,
      total,
      hasMore: windowEnd < total,
      userRequestCount: session.messages.filter((m) => m.role === "user").length,
      model: friendlyModelName(session.model),
      parseErrors: session.parseErrors ?? [],
      filePath: session.filePath
    });
    let cursor = firstEnd;
    while (cursor < windowEnd) {
      await new Promise((resolve) => setImmediate(resolve));
      if (_SessionWebviewPanel._panelState.get(panelId)?.streamVersion !== myVersion) {
        return;
      }
      const chunkEnd = Math.min(cursor + CHUNK_SIZE, windowEnd);
      const chunkHtml = _SessionWebviewPanel._renderChunk(
        visibleMessages,
        renderedMessages,
        cursor,
        chunkEnd,
        assistantLabel,
        false
      );
      state.windowEnd = chunkEnd;
      void panel.webview.postMessage({
        type: "appendChunk",
        messagesHtml: chunkHtml,
        position: "end",
        newWindowEnd: chunkEnd,
        hasMore: windowEnd < total
      });
      cursor = chunkEnd;
    }
    if (_SessionWebviewPanel._panelState.get(panelId)?.streamVersion === myVersion) {
      if (searchTerm) {
        const msgType = highlightContainer ? "cwHighlightMsg" : "cwSearch";
        void panel.webview.postMessage({ type: msgType, term: searchTerm });
      }
      if (scrollInit.highlightColor || scrollInit.shouldScroll) {
        void panel.webview.postMessage({ type: "cwScroll", ...scrollInit });
      }
    }
    let bgCursor = windowEnd;
    while (bgCursor < total) {
      await new Promise((resolve) => setImmediate(resolve));
      if (_SessionWebviewPanel._panelState.get(panelId)?.streamVersion !== myVersion) {
        return;
      }
      const bgEnd = Math.min(bgCursor + CHUNK_SIZE, total);
      for (let i = bgCursor; i < bgEnd; i++) {
        if (renderedMessages[i] === null) {
          renderedMessages[i] = renderMessage(
            visibleMessages[i].msg,
            visibleMessages[i].origIdx,
            i,
            visibleMessages,
            assistantLabel,
            void 0
          );
        }
      }
      bgCursor = bgEnd;
    }
  }
  static async _loadMoreMessages(panelId) {
    const state = _SessionWebviewPanel._panelState.get(panelId);
    if (!state) {
      return;
    }
    const { visibleMessages, renderedMessages, assistantLabel, panel } = state;
    const total = visibleMessages.length;
    if (state.windowEnd < total) {
      const newEnd = Math.min(total, state.windowEnd + CHUNK_SIZE);
      const chunkHtml = _SessionWebviewPanel._renderChunk(
        visibleMessages,
        renderedMessages,
        state.windowEnd,
        newEnd,
        assistantLabel,
        false
      );
      state.windowEnd = newEnd;
      void panel.webview.postMessage({
        type: "appendChunk",
        messagesHtml: chunkHtml,
        position: "end",
        newWindowEnd: newEnd,
        hasMore: newEnd < total
      });
    }
  }
  // ── Render helpers (delegate to sessionRenderer.ts) ─────────────────────
  static _renderChunk(visibleMessages, renderedMessages, start, end, assistantLabel, withFade) {
    return renderChunk(visibleMessages, renderedMessages, start, end, assistantLabel, withFade);
  }
  static _renderMessage(...args) {
    return renderMessage(...args);
  }
  // ── Shell HTML (set once, no user content) ───────────────────────────────
  static _getShellHtml() {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    ${cwThemeCss()}
    ${syntaxHighlighterCss()}
    :root { --cw-user-color: #007acc; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 16px 24px;
      line-height: 1.6;
    }
    h1 {
      font-size: 1.4em;
      margin-bottom: 4px;
      padding-bottom: 8px;
      border-bottom: none;
    }
    .session-meta {
      display: none;
      font-size: 0.82em;
      opacity: 0.7;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-textBlockQuote-background, #444);
      margin-bottom: 8px;
    }
    .session-meta span {
      font-weight: 600;
      opacity: 1;
    }
    .toolbar {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
      padding: 8px 0 10px;
      display: flex;
      gap: 8px;
      align-items: center;
      z-index: 10;
      border-bottom: 1px solid var(--cw-border);
      margin-bottom: 16px;
    }
    .toolbar button {
      background: var(--cw-surface-subtle);
      color: inherit;
      border: 1px solid var(--cw-border-strong);
      padding: 3px 10px;
      border-radius: var(--cw-radius-xs);
      cursor: pointer;
      font-size: 0.82em;
      font-family: var(--vscode-font-family, sans-serif);
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }
    .toolbar button:hover {
      background: var(--cw-accent);
      color: var(--cw-accent-text);
      border-color: var(--cw-accent);
    }
    :focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
    .search-group {
      display: flex;
      flex: 1;
      gap: 4px;
      align-items: center;
      min-width: 160px;
    }
    .message {
      margin-bottom: 14px;
      border-radius: var(--cw-radius);
      padding: 12px 16px;
      background: var(--cw-surface-raised);
      border: 1px solid var(--cw-border);
      box-shadow: var(--cw-shadow);
    }
    .message.user   { border-left: 3px solid var(--cw-user-color); }
    .message.assistant { border-left: 3px solid var(--cw-claude, #a67bf0); }
    .message-header {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 6px;
    }
    .role-label {
      font-weight: bold;
      font-size: 0.85em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      opacity: 0.75;
    }
    .message.user .role-label { color: var(--cw-user-color); }
    .timestamp { font-size: 0.78em; opacity: 0.5; }
    .message-body { word-wrap: break-word; }
    .message-body p { margin: 0.4em 0; }
    .message-body h1, .message-body h2, .message-body h3,
    .message-body h4, .message-body h5, .message-body h6 {
      margin: 0.8em 0 0.3em; font-weight: bold; line-height: 1.3;
    }
    .message-body h1 { font-size: 1.3em; }
    .message-body h2 { font-size: 1.15em; }
    .message-body h3 { font-size: 1.05em; }
    .message-body h4, .message-body h5, .message-body h6 { font-size: 1em; }
    .message-body ul, .message-body ol { margin: 0.4em 0; padding-left: 1.5em; }
    .message-body li { margin: 0.15em 0; }
    .message-body blockquote {
      margin: 0.5em 0; padding: 4px 12px;
      border-left: 3px solid var(--vscode-textPreformat-background, #555);
      opacity: 0.85;
    }
    .message-body blockquote p { margin: 0; }
    .message-body hr {
      border: none;
      border-top: 1px solid var(--vscode-textBlockQuote-background, #444);
      margin: 0.8em 0;
    }
    .message-body strong { font-weight: bold; }
    .message-body em { font-style: italic; }
    .message-body del { text-decoration: line-through; opacity: 0.75; }
    .table-wrap { overflow-x: auto; margin: 0.5em 0; max-width: 100%; }
    .message-body table { border-collapse: collapse; font-size: 0.92em; white-space: nowrap; }
    .message-body th, .message-body td {
      border: 1px solid var(--vscode-textBlockQuote-background, #444);
      padding: 4px 10px;
    }
    .message-body th {
      background-color: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.06));
      font-weight: bold; position: sticky; top: 0;
    }
    .message-body :not(pre) > code {
      background-color: var(--vscode-textPreformat-background, #2d2d2d);
      border-radius: 3px; padding: 1px 4px;
    }
    pre { border-radius: var(--cw-radius-sm); padding: 12px; overflow-x: auto; margin: 8px 0; white-space: pre; }
    code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; }
    .message.aborted {
      background-color: var(--vscode-editor-background);
      border-left: 3px solid var(--vscode-errorForeground, #f48771);
      opacity: 0.7;
    }
    .aborted-notice { font-style: italic; color: var(--vscode-errorForeground, #f48771); }
    .parse-errors-banner {
      background: rgba(200, 160, 0, 0.08);
      border: 1px solid rgba(200, 160, 0, 0.35);
      border-left: 3px solid #c8a800;
      border-radius: var(--cw-radius);
      padding: 10px 14px;
      margin-bottom: 14px;
      font-size: 0.85em;
      color: var(--vscode-editorWarning-foreground, #c8a800);
    }
    .parse-errors-banner ul { margin: 6px 0 0; padding-left: 1.5em; }
    .parse-errors-banner li { margin: 3px 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; }
    .parse-error-path { word-break: break-all; font-family: var(--vscode-editor-font-family, monospace); opacity: 0.8; }
    .skipped-notice { font-style: italic; color: var(--vscode-editorWarning-foreground, #c8a800); }
    mark {
      background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.33));
      color: inherit; border-radius: 2px; padding: 0 1px;
    }
    mark.cw-active {
      background-color: var(--vscode-editor-findMatchBackground, rgba(234,92,0,0.8));
      outline: 1px solid rgba(234,92,0,0.9);
    }
    .cw-msg-hl {
      outline: 2px solid var(--vscode-editor-findMatchHighlightBorder, rgba(234,92,0,0.5));
      border-radius: 4px;
    }
    .cw-msg-hl-active {
      outline: 2px solid var(--vscode-focusBorder, #007acc);
      border-radius: 4px;
      background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.12));
    }
    #search-input {
      flex: 1;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 3px; padding: 3px 6px; outline: none;
    }
    #search-input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
    .search-counter { font-size: 0.8em; opacity: 0.6; white-space: nowrap; min-width: 56px; text-align: right; }
    #sel-ctx-menu {
      position: fixed; z-index: 9999;
      background: var(--vscode-menu-background, #252526);
      border: 1px solid var(--vscode-menu-border, #454545);
      border-radius: 4px; padding: 4px 0;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      display: none; min-width: 200px;
    }
    .ctx-item {
      padding: 5px 14px; cursor: pointer; font-size: 0.92em;
      color: var(--vscode-menu-foreground, inherit); white-space: nowrap;
    }
    .ctx-item:hover {
      background: var(--vscode-menu-selectionBackground, #094771);
      color: var(--vscode-menu-selectionForeground, #fff);
    }
    #load-more-btn {
      display: none;
      width: 100%;
      margin: 6px 0;
      background: var(--cw-surface-subtle);
      color: inherit;
      border: 1px solid var(--cw-border-strong);
      padding: 5px 10px;
      border-radius: var(--cw-radius-xs);
      cursor: pointer;
      font-size: 0.82em;
      font-family: var(--vscode-font-family, sans-serif);
    }
    #load-more-btn:hover {
      background: var(--cw-accent);
      color: var(--cw-accent-text);
      border-color: var(--cw-accent);
    }
    .cw-filter-label {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 0.82em;
      opacity: 0.7;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
    }
    .cw-filter-label:hover { opacity: 1; }
    .cw-filter-label input { margin: 0; cursor: pointer; }
  </style>
</head>
<body>
  <h1 id="session-title"><span class="cw-skeleton" style="display:inline-block;height:1.1em;width:50%;vertical-align:middle"></span></h1>
  <div class="session-meta" id="session-meta">
    <span id="session-model-field" style="display:none">Model: <span id="session-model"></span></span>
    <span class="meta-sep" id="session-meta-sep" style="display:none"> &nbsp;\xB7&nbsp; </span>
    <span id="session-req-field" style="display:none">User Requests: <span id="session-user-req"></span></span>
  </div>
  <div class="toolbar">
    <div class="search-group">
      <input id="search-input" type="text" placeholder="Search in messages&#8230;" autocomplete="off" aria-label="Search within session messages" />
      <span class="search-counter" id="search-counter" aria-live="polite"></span>
      <button id="search-prev" title="Previous (Shift+Enter)" aria-label="Previous match">&#9650;</button>
      <button id="search-next" title="Next (Enter)" aria-label="Next match">&#9660;</button>
    </div>
    <button id="export-excerpt-btn" style="opacity:0.7;" title="Export an excerpt of this session as Markdown">Export Excerpt&#8230;</button>
    <label class="cw-filter-label" title="Show only your messages"><input type="checkbox" id="filter-prompts" /> You</label>
    <label class="cw-filter-label" title="Show only assistant responses"><input type="checkbox" id="filter-responses" /> <span id="filter-responses-label">Responses</span></label>
  </div>
  <div id="messages-container">
    <div class="message user cw-fade-item" style="--cw-i:0">
      <div class="message-header"><span class="cw-skeleton" style="display:inline-block;height:11px;width:32px"></span><span class="cw-skeleton" style="display:inline-block;height:10px;width:100px;margin-left:10px"></span></div>
      <div class="message-body"><div class="cw-skeleton" style="height:13px;width:72%;margin:6px 0"></div></div>
    </div>
    <div class="message assistant cw-fade-item" style="--cw-i:1">
      <div class="message-header"><span class="cw-skeleton" style="display:inline-block;height:11px;width:48px"></span><span class="cw-skeleton" style="display:inline-block;height:10px;width:110px;margin-left:10px"></span></div>
      <div class="message-body"><div class="cw-skeleton" style="height:13px;width:96%;margin:5px 0"></div><div class="cw-skeleton" style="height:13px;width:84%;margin:5px 0"></div><div class="cw-skeleton" style="height:13px;width:62%;margin:5px 0"></div></div>
    </div>
    <div class="message user cw-fade-item" style="--cw-i:2">
      <div class="message-header"><span class="cw-skeleton" style="display:inline-block;height:11px;width:32px"></span><span class="cw-skeleton" style="display:inline-block;height:10px;width:90px;margin-left:10px"></span></div>
      <div class="message-body"><div class="cw-skeleton" style="height:13px;width:88%;margin:6px 0"></div><div class="cw-skeleton" style="height:13px;width:55%;margin:5px 0"></div></div>
    </div>
    <div class="message assistant cw-fade-item" style="--cw-i:3">
      <div class="message-header"><span class="cw-skeleton" style="display:inline-block;height:11px;width:48px"></span><span class="cw-skeleton" style="display:inline-block;height:10px;width:105px;margin-left:10px"></span></div>
      <div class="message-body"><div class="cw-skeleton" style="height:13px;width:92%;margin:5px 0"></div><div class="cw-skeleton" style="height:13px;width:78%;margin:5px 0"></div><div class="cw-skeleton" style="height:60px;width:100%;margin:8px 0;border-radius:var(--cw-radius-sm)"></div><div class="cw-skeleton" style="height:13px;width:70%;margin:5px 0"></div></div>
    </div>
    <div class="message user cw-fade-item" style="--cw-i:4">
      <div class="message-header"><span class="cw-skeleton" style="display:inline-block;height:11px;width:32px"></span><span class="cw-skeleton" style="display:inline-block;height:10px;width:95px;margin-left:10px"></span></div>
      <div class="message-body"><div class="cw-skeleton" style="height:13px;width:65%;margin:6px 0"></div></div>
    </div>
  </div>
  <button id="load-more-btn">Load more messages&#8230;</button>
  <button class="cw-back-top" id="backToTop" title="Back to top">&#8593;</button>
  <div id="sel-ctx-menu">
    <div class="ctx-item" id="ctx-export-sel">Export selection as Markdown&#8230;</div>
  </div>
<script>
${cwInteractiveJs()}
(function() {
  var vscode = acquireVsCodeApi();

  // \u2500\u2500 State \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  var _hasMore     = false;
  var _loadingMore = false;

  // \u2500\u2500 Back to top \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  var backTopBtn = document.getElementById('backToTop');
  window.addEventListener('scroll', function() {
    backTopBtn.classList.toggle('visible', window.scrollY > 300);
  });
  backTopBtn.addEventListener('click', function() { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  // \u2500\u2500 Export excerpt \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  document.getElementById('export-excerpt-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'exportExcerpt' });
  });

  // \u2500\u2500 Load more button \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  var loadMoreBtn = document.getElementById('load-more-btn');
  loadMoreBtn.addEventListener('click', function() {
    if (_loadingMore || !_hasMore) { return; }
    _loadingMore = true;
    vscode.postMessage({ type: 'loadMoreMessages' });
  });

  function updateLoadMoreButton() {
    loadMoreBtn.style.display = _hasMore ? 'block' : 'none';
  }

  // \u2500\u2500 Role filter checkboxes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  var filterPromptsEl   = document.getElementById('filter-prompts');
  var filterResponsesEl = document.getElementById('filter-responses');
  function applyRoleFilter() {
    var showPromptsOnly   = filterPromptsEl.checked;
    var showResponsesOnly = filterResponsesEl.checked;
    // If both or neither checked, show everything
    if (showPromptsOnly === showResponsesOnly) {
      container.querySelectorAll('.message').forEach(function(el) { el.style.display = ''; });
      return;
    }
    container.querySelectorAll('.message').forEach(function(el) {
      var isUser = el.classList.contains('user');
      if (showPromptsOnly)   { el.style.display = isUser ? '' : 'none'; }
      if (showResponsesOnly) { el.style.display = isUser ? 'none' : ''; }
    });
  }
  filterPromptsEl.addEventListener('change', function() {
    if (filterPromptsEl.checked && filterResponsesEl.checked) { filterResponsesEl.checked = false; }
    applyRoleFilter();
  });
  filterResponsesEl.addEventListener('change', function() {
    if (filterResponsesEl.checked && filterPromptsEl.checked) { filterPromptsEl.checked = false; }
    applyRoleFilter();
  });

  // \u2500\u2500 Context menu \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  var ctxMenu = document.getElementById('sel-ctx-menu');
  var savedSelText = '';
  function hideMenu() { ctxMenu.style.display = 'none'; }
  document.addEventListener('contextmenu', function(e) {
    var sel = window.getSelection();
    var text = sel ? sel.toString().trim() : '';
    if (!text) { hideMenu(); return; }
    savedSelText = text;
    e.preventDefault();
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top  = e.clientY + 'px';
    ctxMenu.style.display = 'block';
    var rect = ctxMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth)   { ctxMenu.style.left = (e.clientX - rect.width)  + 'px'; }
    if (rect.bottom > window.innerHeight) { ctxMenu.style.top  = (e.clientY - rect.height) + 'px'; }
  });
  document.addEventListener('click', hideMenu);
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') { hideMenu(); } });
  document.getElementById('ctx-export-sel').addEventListener('click', function() {
    if (!savedSelText) { return; }
    vscode.postMessage({ command: 'exportSelection', text: savedSelText });
    savedSelText = '';
    hideMenu();
  });

  // \u2500\u2500 Syntax highlighter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  var KEYWORDS = new Set([
    'abstract','as','async','await','break','case','catch','class','const',
    'continue','debugger','declare','default','delete','do','else','enum',
    'export','extends','false','finally','for','from','function','get','if',
    'implements','import','in','instanceof','interface','let','namespace',
    'new','null','of','package','private','protected','public','readonly',
    'return','set','static','super','switch','this','throw','true','try',
    'type','typeof','undefined','var','void','while','with','yield',
    'def','elif','except','exec','lambda','nonlocal','pass','print','raise',
    'and','not','or','is',
    'fn','mut','pub','use','mod','impl','struct','trait','where',
    'int','float','double','char','long','short','byte','unsigned','signed',
    'auto','register','extern','volatile','inline','None','True','False','self'
  ]);
  function escH(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function sp(cls, text) { return '<span class="' + cls + '">' + escH(text) + '</span>'; }
  function tokenize(code) {
    var out = '', i = 0, len = code.length;
    while (i < len) {
      var ch = code[i];
      if (ch === '/' && code[i+1] === '*') {
        var ce = code.indexOf('*/', i+2); if (ce === -1) { ce = len-2; }
        out += sp('tok-comment', code.slice(i, ce+2)); i = ce+2; continue;
      }
      if (ch === '/' && code[i+1] === '/') {
        var nl = code.indexOf('\\n', i); if (nl === -1) { nl = len; }
        out += sp('tok-comment', code.slice(i, nl)); i = nl; continue;
      }
      if (ch === '#') {
        var nh = code.indexOf('\\n', i); if (nh === -1) { nh = len; }
        out += sp('tok-comment', code.slice(i, nh)); i = nh; continue;
      }
      if (ch === '"' || ch === "'") {
        var q = ch, j = i+1;
        while (j < len) { if (code[j] === '\\\\') { j+=2; continue; } if (code[j] === q) { j++; break; } j++; }
        out += sp('tok-string', code.slice(i, j)); i = j; continue;
      }
      if (ch >= '0' && ch <= '9') {
        var k = i;
        while (k < len) {
          var c = code[k];
          if (!((c>='0'&&c<='9')||c==='.'||c==='_'||c==='x'||c==='X'||(c>='a'&&c<='f')||(c>='A'&&c<='F'))) { break; }
          k++;
        }
        out += sp('tok-number', code.slice(i, k)); i = k; continue;
      }
      if ((ch>='a'&&ch<='z')||(ch>='A'&&ch<='Z')||ch==='_') {
        var m = i;
        while (m < len) {
          var mc = code[m];
          if (!((mc>='a'&&mc<='z')||(mc>='A'&&mc<='Z')||(mc>='0'&&mc<='9')||mc==='_')) { break; }
          m++;
        }
        var word = code.slice(i, m), next = code[m]||'';
        if (KEYWORDS.has(word))                    { out += sp('tok-keyword',  word); }
        else if (next === '(')                     { out += sp('tok-function', word); }
        else if (word[0]>='A' && word[0]<='Z')    { out += sp('tok-type',     word); }
        else                                       { out += escH(word); }
        i = m; continue;
      }
      out += escH(ch); i++;
    }
    return out;
  }
  var _deHighlighted = false;
  function highlightAll() {
    if (_deHighlighted) { return; } // don't overwrite de-highlighted state during active search
    document.querySelectorAll('pre code').forEach(function(block) {
      block.innerHTML = tokenize(block.textContent || '');
    });
  }
  function dehighlightCode() {
    if (_deHighlighted) { return; }
    document.querySelectorAll('pre code').forEach(function(block) {
      var text = block.textContent || '';
      while (block.firstChild) { block.removeChild(block.firstChild); }
      block.appendChild(document.createTextNode(text));
    });
    _deHighlighted = true;
  }

  // \u2500\u2500 Search \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  var cwMarks = [], cwIdx = -1;
  // Message-level marks for multi-line (stage-2) search
  var cwMsgMarks = [], cwMsgIdx = -1;
  // Pending prompt-library highlight: auto-loads more batches until the target is in DOM
  var _pendingHighlight = null;
  var srchInput   = document.getElementById('search-input');
  var srchCounter = document.getElementById('search-counter');
  var srchPrev    = document.getElementById('search-prev');
  var srchNext    = document.getElementById('search-next');
  function escRx(s) { return s.replace(/[.*+?^{}()|$[]\\]/g, '\\$&'); }
  function clearMsgMarks() {
    cwMsgMarks.forEach(function(el) { el.classList.remove('cw-msg-hl', 'cw-msg-hl-active'); });
    cwMsgMarks = []; cwMsgIdx = -1;
  }
  function clearMarks() {
    cwMarks.forEach(function(mk) {
      var p = mk.parentNode;
      if (p) { p.replaceChild(document.createTextNode(mk.textContent), mk); p.normalize(); }
    });
    cwMarks = []; cwIdx = -1;
    if (_deHighlighted) { _deHighlighted = false; highlightAll(); }
    clearMsgMarks();
  }
  function setActiveMsg(idx) {
    cwMsgMarks.forEach(function(el, ii) {
      el.classList.toggle('cw-msg-hl-active', ii === idx);
      el.classList.toggle('cw-msg-hl', ii !== idx);
    });
    if (cwMsgMarks[idx]) { cwScrollTo(cwMsgMarks[idx]); }
    srchCounter.textContent = cwMsgMarks.length > 0
      ? (idx + 1) + ' / ' + cwMsgMarks.length + ' message' + (cwMsgMarks.length === 1 ? '' : 's')
      : 'No matches';
  }
  function walkBody(root, rx) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var nodes = [], n;
    while ((n = walker.nextNode())) { nodes.push(n); }
    nodes.forEach(function(textNode) {
      var text = textNode.nodeValue;
      if (!rx.test(text)) { rx.lastIndex = 0; return; }
      rx.lastIndex = 0;
      var frag = document.createDocumentFragment(), last = 0, mm;
      while ((mm = rx.exec(text)) !== null) {
        if (mm.index > last) { frag.appendChild(document.createTextNode(text.slice(last, mm.index))); }
        var mark = document.createElement('mark');
        mark.textContent = mm[0];
        frag.appendChild(mark);
        cwMarks.push(mark);
        last = rx.lastIndex;
      }
      if (last < text.length) { frag.appendChild(document.createTextNode(text.slice(last))); }
      textNode.parentNode.replaceChild(frag, textNode);
    });
  }
  function setActive(idx) {
    cwMarks.forEach(function(mk, ii) { mk.classList.toggle('cw-active', ii === idx); });
    if (cwMarks[idx]) { cwMarks[idx].scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    srchCounter.textContent = cwMarks.length > 0 ? (idx + 1) + ' / ' + cwMarks.length : 'No matches';
  }
  function runSearch(query) {
    // Inline mark removal without re-highlighting (avoids unnecessary highlight/de-highlight cycle)
    cwMarks.forEach(function(mk) {
      var p = mk.parentNode;
      if (p) { p.replaceChild(document.createTextNode(mk.textContent), mk); p.normalize(); }
    });
    cwMarks = []; cwIdx = -1;
    clearMsgMarks();
    if (!query) {
      if (_deHighlighted) { _deHighlighted = false; highlightAll(); }
      srchCounter.textContent = '';
      return;
    }
    dehighlightCode(); // flatten spans so multi-word searches work across tokens

    // Stage 1: exact regex match within text nodes (works for single-line content)
    var rx = new RegExp(escRx(query), 'gi');
    document.querySelectorAll('.message-body').forEach(function(body) { walkBody(body, rx); });
    if (cwMarks.length > 0) { cwIdx = 0; setActive(cwIdx); return; }

    // Stage 2: whitespace-collapse match \u2014 uses the raw source content stored in data-raw
    // (avoids markdown rendering artefacts such as list markers lost from innerText).
    // Both query and content are normalised to single spaces before comparing.
    var normQuery = query.trim().replace(/\\s+/g, ' ').toLowerCase();
    document.querySelectorAll('.message-body').forEach(function(body) {
      var raw = (body.dataset && body.dataset.raw !== undefined)
        ? body.dataset.raw
        : (body.innerText !== undefined ? body.innerText : (body.textContent || ''));
      var normBody = raw.replace(/\\s+/g, ' ').trim().toLowerCase();
      if (normBody.indexOf(normQuery) !== -1) { cwMsgMarks.push(body); }
    });
    if (cwMsgMarks.length > 0) { cwMsgIdx = 0; setActiveMsg(cwMsgIdx); return; }

    srchCounter.textContent = 'No matches';
  }
  function navSearch(dir) {
    if (cwMarks.length > 0) {
      cwIdx = (cwIdx + dir + cwMarks.length) % cwMarks.length;
      setActive(cwIdx);
    } else if (cwMsgMarks.length > 0) {
      cwMsgIdx = (cwMsgIdx + dir + cwMsgMarks.length) % cwMsgMarks.length;
      setActiveMsg(cwMsgIdx);
    }
  }
  srchInput.addEventListener('input',   function() { runSearch(srchInput.value); });
  srchPrev.addEventListener('click',    function() { navSearch(-1); });
  srchNext.addEventListener('click',    function() { navSearch(1); });
  srchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter')  { navSearch(e.shiftKey ? -1 : 1); e.preventDefault(); }
    else if (e.key === 'Escape') { srchInput.value = ''; runSearch(''); }
  });

  // \u2500\u2500 Scroll helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  var _toolbar = document.querySelector('.toolbar');
  function cwScrollTo(el) {
    var toolbarH = _toolbar ? _toolbar.offsetHeight : 0;
    var rect = el.getBoundingClientRect();
    var targetY = window.scrollY + rect.top - toolbarH - 8;
    window.scrollTo(0, Math.max(0, targetY));
  }

  function cwDoScroll(p) {
    if (!p || (!p.highlightColor && !p.shouldScroll)) { return; }
    if (p.targetMsgIdx !== null && p.targetMsgIdx !== undefined) {
      var el = document.querySelector('[data-msg-idx="' + p.targetMsgIdx + '"]');
      if (el) {
        // Use data-fence-idx to reliably locate the correct fenced code block
        var fencedPres = Array.from(el.querySelectorAll('pre[data-fence-idx]'));
        if (fencedPres.length > 0) {
          var idx = (p.targetBlockIdx !== null && p.targetBlockIdx !== undefined) ? p.targetBlockIdx : 0;
          var target = fencedPres[idx] || fencedPres[0];
          if (p.highlightColor) { target.style.boxShadow = '0 0 0 2px ' + p.highlightColor; }
          cwScrollTo(target);
          return;
        }
        cwScrollTo(el); return;
      }
    }
    // Fallback: scroll to first fenced code block in the document (group-level click)
    var pres = Array.from(document.querySelectorAll('pre[data-fence-idx]'));
    if (pres.length === 0) { pres = Array.from(document.querySelectorAll('pre')); }
    if (p.highlightColor) { pres.forEach(function(x) { x.style.boxShadow = '0 0 0 2px ' + p.highlightColor; }); }
    if (p.shouldScroll && pres.length > 0) { cwScrollTo(pres[0]); }
  }

  // \u2500\u2500 DOM helpers for appending/prepending message chunks \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  var container = document.getElementById('messages-container');

  function appendHtml(html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    while (tmp.firstChild) { container.appendChild(tmp.firstChild); }
    highlightAll();
    applyRoleFilter();
  }

  // Try to find and highlight the pending prompt in the DOM.
  // If not found and more messages are available, request another batch.
  function tryHighlightMsg() {
    if (!_pendingHighlight) { return; }
    var needle = _pendingHighlight.replace(/\\s+/g, ' ').trim().toLowerCase();
    var matchEl = null;
    document.querySelectorAll('.message.user').forEach(function(msgEl) {
      if (matchEl) { return; }
      var body = msgEl.querySelector('.message-body');
      var raw = body ? ((body.dataset && body.dataset.raw !== undefined)
        ? body.dataset.raw
        : (body.innerText !== undefined ? body.innerText : (body.textContent || ''))) : '';
      var normBody = raw.replace(/\\s+/g, ' ').trim().toLowerCase();
      if (normBody.indexOf(needle) !== -1) { matchEl = msgEl; }
    });
    if (matchEl) {
      _pendingHighlight = null;
      clearMsgMarks();
      matchEl.classList.add('cw-msg-hl-active');
      cwMsgMarks.push(matchEl);
      cwMsgIdx = 0;
      cwScrollTo(matchEl);
    } else if (_hasMore) {
      // Target not yet loaded \u2014 request next batch
      _loadingMore = true;
      vscode.postMessage({ type: 'loadMoreMessages' });
    } else {
      // All messages loaded, target not found
      _pendingHighlight = null;
    }
  }

  // \u2500\u2500 Message handler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  window.addEventListener('message', function(event) {
    var data = event.data;

    if (data.type === 'render') {
      document.getElementById('session-title').textContent = data.title;
      document.documentElement.style.setProperty('--cw-user-color', data.userColor || '#007acc');
      if (data.source) {
        var srcLabel = data.source === 'copilot' ? 'GitHub Copilot' : 'Claude';
        var respLabelEl = document.getElementById('filter-responses-label');
        if (respLabelEl) { respLabelEl.textContent = srcLabel; }
      }
      var metaEl      = document.getElementById('session-meta');
      var modelField  = document.getElementById('session-model-field');
      var modelEl     = document.getElementById('session-model');
      var reqField    = document.getElementById('session-req-field');
      var reqEl       = document.getElementById('session-user-req');
      var sepEl       = document.getElementById('session-meta-sep');
      var showModel   = data.model && data.model !== 'Unknown';
      var showReq     = data.userRequestCount !== undefined;
      if (metaEl && (showModel || showReq)) {
        if (showModel && modelField && modelEl) {
          modelEl.textContent = data.model;
          modelField.style.display = 'inline';
        }
        if (showReq && reqField && reqEl) {
          reqEl.textContent = data.userRequestCount;
          reqField.style.display = 'inline';
        }
        if (showModel && showReq && sepEl) { sepEl.style.display = 'inline'; }
        metaEl.style.display = 'block';
      }
      container.innerHTML = data.messagesHtml;

      // Parse-errors banner \u2014 prepended before messages when the session has read errors
      if (data.parseErrors && data.parseErrors.length > 0) {
        var banner = document.createElement('div');
        banner.className = 'parse-errors-banner';
        var errItems = data.parseErrors.map(function(e) {
          return '<li>' + escH(e) + '</li>';
        }).join('');
        banner.innerHTML =
          '&#9888; <strong>Parse errors in this session</strong>' +
          (data.filePath ? ' &mdash; <span class="parse-error-path">' + escH(data.filePath) + '</span>' : '') +
          '<ul>' + errItems + '</ul>';
        container.insertBefore(banner, container.firstChild);
      }

      highlightAll();

      _hasMore     = !!data.hasMore;
      _loadingMore = false;
      updateLoadMoreButton();

      clearMarks();
      // Pre-fill the input now so the user sees the pending term immediately;
      // runSearch() is deferred to the cwSearch message which arrives after all
      // appendChunk messages have been processed (full window in DOM).
      if (data.term) { srchInput.value = data.term; srchCounter.textContent = ''; }
      else           { srchInput.value = ''; srchCounter.textContent = ''; }

    }

    if (data.type === 'cwSearch') {
      // Arrives after all initial appendChunk messages \u2014 full window is in DOM.
      if (data.term) { srchInput.value = data.term; runSearch(data.term); }
    }

    if (data.type === 'cwHighlightMsg') {
      // Highlight the full user message container (no text marks) \u2014 used when opening from Prompt Library.
      // If the target is not yet in the DOM (beyond the initial batch), auto-load more batches.
      clearMarks();
      if (!data.term) { return; }
      // Prefill search bar with a truncated version for context
      var displayTerm = data.term.replace(/\\s+/g, ' ').trim();
      if (displayTerm.length > 80) { displayTerm = displayTerm.substring(0, 80) + '\\u2026'; }
      srchInput.value = displayTerm;
      srchCounter.textContent = '';
      _pendingHighlight = data.term;
      tryHighlightMsg();
    }

    if (data.type === 'appendChunk') {
      appendHtml(data.messagesHtml);
      _hasMore     = !!data.hasMore;
      _loadingMore = false;
      updateLoadMoreButton();
      // Re-try pending highlight after new messages are in DOM
      if (_pendingHighlight) { tryHighlightMsg(); }
    }

    if (data.type === 'cwScroll') {
      // Double rAF: first frame lets the browser apply any pending layout from
      // appended chunks, second frame ensures paint is complete before measuring.
      requestAnimationFrame(function() {
        requestAnimationFrame(function() { cwDoScroll(data); });
      });
    }
  });

  // Signal ready \u2014 extension host will send the 'render' payload
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
  // ── Helpers ───────────────────────────────────────────────────────────────
  static async _saveSelection(text, sessionTitle) {
    const safe = sessionTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "session";
    const home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? "/";
    const defaultUri = vscode4.Uri.file(`${home}/${safe}-selection.md`);
    const uri = await vscode4.window.showSaveDialog({
      defaultUri,
      filters: { "Markdown": ["md"] },
      title: "Export Selection as Markdown"
    });
    if (!uri) {
      return;
    }
    const content = `# Selection from: ${sessionTitle}

${text}
`;
    await vscode4.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    await vscode4.window.showTextDocument(uri);
  }
};

// src/search/snippetExtractor.ts
function extractSnippet(content, matchOffset, matchLength, contextChars = 100) {
  const windowStart = Math.max(0, matchOffset - contextChars);
  const windowEnd = Math.min(content.length, matchOffset + matchLength + contextChars);
  const raw = content.slice(windowStart, windowEnd);
  const matchStart = matchOffset - windowStart;
  const matchEnd = matchStart + matchLength;
  const prependEllipsis = windowStart > 0;
  const appendEllipsis = windowEnd < content.length;
  const ellipsisOffset = prependEllipsis ? 1 : 0;
  const snippet = (prependEllipsis ? "\u2026" : "") + raw + (appendEllipsis ? "\u2026" : "");
  return { snippet, matchStart: matchStart + ellipsisOffset, matchEnd: matchEnd + ellipsisOffset };
}
function findFirstMatch(content, query) {
  if (typeof query === "string") {
    const idx = content.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) {
      return void 0;
    }
    return { offset: idx, length: query.length };
  } else {
    const match = query.exec(content);
    if (match === null) {
      return void 0;
    }
    return { offset: match.index, length: match[0].length };
  }
}

// src/search/fullTextEngine.ts
var MAX_RESULTS = 500;
var MAX_TOKEN_LENGTH = 50;
var MIN_DOC_FREQ = 2;
var MAX_REGEX_LEN = 200;
var REGEX_SEARCH_TIMEOUT_MS = 1e3;
var RE_REDOS_PATTERNS = /\([^()]*[+*{][^)]*\)\s*[+*?]|\([^)]*\|[^)]*\)\s*[+*?]/;
function isReDoS(pattern) {
  return pattern.length > MAX_REGEX_LEN || RE_REDOS_PATTERNS.test(pattern);
}
function tokenize(text) {
  return text.toLowerCase().split(/\W+/).filter((t) => t.length >= 2 && t.length <= MAX_TOKEN_LENGTH);
}
var FullTextSearchEngine = class {
  /** sessionId → Session */
  sessions = /* @__PURE__ */ new Map();
  /** token → Set of "sessionId:messageIndex" strings (docFreq ≥ MIN_DOC_FREQ) */
  invertedIndex = /* @__PURE__ */ new Map();
  /** sessionId → Set of tokens indexed for that session (reverse map for O(1) removal) */
  sessionTokens = /* @__PURE__ */ new Map();
  /** token → set of sessionIds containing it (document-frequency tracking) */
  tokenDocSessions = /* @__PURE__ */ new Map();
  /**
   * Single-session tokens not yet promoted to the main index (hapax legomena).
   * These are excluded from search results to keep the main index bounded.
   */
  hapaxStore = /* @__PURE__ */ new Map();
  get size() {
    return this.sessions.size;
  }
  /** Remove all indexed sessions and clear every internal map. */
  clear() {
    this.sessions.clear();
    this.invertedIndex.clear();
    this.sessionTokens.clear();
    this.tokenDocSessions.clear();
    this.hapaxStore.clear();
  }
  index(session) {
    if (this.sessions.has(session.id)) {
      this._removeFromInvertedIndex(session.id);
    }
    this.sessions.set(session.id, session);
    const tokenSet = /* @__PURE__ */ new Set();
    this.sessionTokens.set(session.id, tokenSet);
    for (let msgIdx = 0; msgIdx < session.messages.length; msgIdx++) {
      const message = session.messages[msgIdx];
      const tokens = tokenize(message.content);
      const entry = `${session.id}:${msgIdx}`;
      for (const token of tokens) {
        tokenSet.add(token);
        let docSessions = this.tokenDocSessions.get(token);
        if (docSessions === void 0) {
          docSessions = /* @__PURE__ */ new Set();
          this.tokenDocSessions.set(token, docSessions);
        }
        docSessions.add(session.id);
        if (docSessions.size < MIN_DOC_FREQ) {
          let hapax = this.hapaxStore.get(token);
          if (hapax === void 0) {
            hapax = { sessionId: session.id, postings: /* @__PURE__ */ new Set() };
            this.hapaxStore.set(token, hapax);
          }
          hapax.postings.add(entry);
        } else if (this.hapaxStore.has(token)) {
          const hapax = this.hapaxStore.get(token);
          const promoted = new Set(hapax.postings);
          promoted.add(entry);
          this.invertedIndex.set(token, promoted);
          this.hapaxStore.delete(token);
        } else {
          let postings = this.invertedIndex.get(token);
          if (postings === void 0) {
            postings = /* @__PURE__ */ new Set();
            this.invertedIndex.set(token, postings);
          }
          postings.add(entry);
        }
      }
    }
  }
  /** Returns statistics about the current state of the index. */
  indexStats() {
    let postingCount = 0;
    for (const postings of this.invertedIndex.values()) {
      postingCount += postings.size;
    }
    const indexedTokenCount = this.invertedIndex.size;
    const hapaxTokenCount = this.hapaxStore.size;
    const totalTokenCount = indexedTokenCount + hapaxTokenCount;
    const memoryEstimateKB = Math.round(
      (indexedTokenCount * 50 + postingCount * 40 + hapaxTokenCount * 90) / 1024
    );
    return { indexedTokenCount, hapaxTokenCount, totalTokenCount, postingCount, memoryEstimateKB };
  }
  remove(sessionId) {
    this._removeFromInvertedIndex(sessionId);
    this.sessions.delete(sessionId);
  }
  search(query) {
    if (query.text === "") {
      return { results: [], totalCount: 0 };
    }
    const filter = query.filter ?? {};
    const searchPrompts = filter.searchPrompts !== false;
    const searchResponses = filter.searchResponses !== false;
    const results = [];
    if (query.isRegex) {
      if (isReDoS(query.text)) {
        return { results: [], totalCount: 0 };
      }
      let regex;
      try {
        regex = new RegExp(query.text);
      } catch {
        return { results: [], totalCount: 0 };
      }
      const searchStartMs = Date.now();
      for (const session of this.sessions.values()) {
        if (Date.now() - searchStartMs > REGEX_SEARCH_TIMEOUT_MS) {
          break;
        }
        if (!this._sessionPassesFilter(session, filter)) {
          continue;
        }
        for (let msgIdx = 0; msgIdx < session.messages.length; msgIdx++) {
          const message = session.messages[msgIdx];
          if (!this._roleAllowed(message.role, searchPrompts, searchResponses)) {
            continue;
          }
          const match = findFirstMatch(message.content, regex);
          if (match === void 0) {
            continue;
          }
          const { snippet, matchStart, matchEnd } = extractSnippet(
            message.content,
            match.offset,
            match.length
          );
          results.push({
            sessionId: session.id,
            messageIndex: msgIdx,
            messageRole: message.role,
            snippet,
            matchStart,
            matchEnd,
            score: 1
          });
        }
      }
    } else {
      const queryTokens = tokenize(query.text);
      if (queryTokens.length === 0) {
        return { results: [], totalCount: 0 };
      }
      let candidateSet;
      for (const token of queryTokens) {
        const postings = this.invertedIndex.get(token);
        if (postings === void 0 || postings.size === 0) {
          return { results: [], totalCount: 0 };
        }
        if (candidateSet === void 0) {
          candidateSet = new Set(postings);
        } else {
          for (const entry of candidateSet) {
            if (!postings.has(entry)) {
              candidateSet.delete(entry);
            }
          }
        }
        if (candidateSet.size === 0) {
          return { results: [], totalCount: 0 };
        }
      }
      if (candidateSet === void 0 || candidateSet.size === 0) {
        return { results: [], totalCount: 0 };
      }
      for (const entry of candidateSet) {
        const colonIdx = entry.indexOf(":");
        const sessionId = entry.slice(0, colonIdx);
        const msgIdx = parseInt(entry.slice(colonIdx + 1), 10);
        const session = this.sessions.get(sessionId);
        if (session === void 0) {
          continue;
        }
        if (!this._sessionPassesFilter(session, filter)) {
          continue;
        }
        const message = session.messages[msgIdx];
        if (message === void 0) {
          continue;
        }
        if (!this._roleAllowed(message.role, searchPrompts, searchResponses)) {
          continue;
        }
        const match = findFirstMatch(message.content, query.text);
        if (match === void 0) {
          continue;
        }
        const { snippet, matchStart, matchEnd } = extractSnippet(
          message.content,
          match.offset,
          match.length
        );
        const messageTokenSet = new Set(tokenize(message.content));
        const score = queryTokens.filter((t) => messageTokenSet.has(t)).length;
        results.push({
          sessionId: session.id,
          messageIndex: msgIdx,
          messageRole: message.role,
          snippet,
          matchStart,
          matchEnd,
          score
        });
      }
    }
    const totalCount = results.length;
    const toSort = totalCount > MAX_RESULTS ? results.slice(0, MAX_RESULTS) : results;
    const updatedAtMap = /* @__PURE__ */ new Map();
    for (const r of toSort) {
      if (!updatedAtMap.has(r.sessionId)) {
        updatedAtMap.set(r.sessionId, this.sessions.get(r.sessionId)?.updatedAt ?? "");
      }
    }
    toSort.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const aUpdated = updatedAtMap.get(a.sessionId) ?? "";
      const bUpdated = updatedAtMap.get(b.sessionId) ?? "";
      return bUpdated < aUpdated ? -1 : bUpdated > aUpdated ? 1 : 0;
    });
    return { results: toSort, totalCount };
  }
  // ── Private helpers ──────────────────────────────────────────────────────
  _removeFromInvertedIndex(sessionId) {
    const prefix = `${sessionId}:`;
    const tokens = this.sessionTokens.get(sessionId);
    if (tokens !== void 0) {
      for (const token of tokens) {
        const docSessions = this.tokenDocSessions.get(token);
        if (docSessions !== void 0) {
          docSessions.delete(sessionId);
          if (docSessions.size === 0) {
            this.tokenDocSessions.delete(token);
          }
        }
        const hapax = this.hapaxStore.get(token);
        if (hapax !== void 0 && hapax.sessionId === sessionId) {
          this.hapaxStore.delete(token);
        } else {
          const postings = this.invertedIndex.get(token);
          if (postings !== void 0) {
            for (const entry of postings) {
              if (entry.startsWith(prefix)) {
                postings.delete(entry);
              }
            }
            if (postings.size === 0) {
              this.invertedIndex.delete(token);
            }
          }
        }
      }
      this.sessionTokens.delete(sessionId);
    } else {
      for (const [token, postings] of this.invertedIndex) {
        for (const entry of postings) {
          if (entry.startsWith(prefix)) {
            postings.delete(entry);
          }
        }
        if (postings.size === 0) {
          this.invertedIndex.delete(token);
        }
      }
    }
  }
  _sessionPassesFilter(session, filter) {
    if (filter.source !== void 0 && session.source !== filter.source) {
      return false;
    }
    if (filter.workspaceId !== void 0 && session.workspaceId !== filter.workspaceId) {
      return false;
    }
    if (filter.dateFrom !== void 0 && session.updatedAt < filter.dateFrom) {
      return false;
    }
    if (filter.dateTo !== void 0 && session.updatedAt > filter.dateTo) {
      return false;
    }
    return true;
  }
  _roleAllowed(role, searchPrompts, searchResponses) {
    if (role === "user" && !searchPrompts) {
      return false;
    }
    if (role === "assistant" && !searchResponses) {
      return false;
    }
    return true;
  }
};

// src/search/searchPanel.ts
var vscode5 = __toESM(require("vscode"));
function nextSourceState(current) {
  if (current === "all") {
    return "copilot";
  }
  if (current === "copilot") {
    return "claude";
  }
  return "all";
}
function sourceButtonIcon(state) {
  if (state === "copilot") {
    return new vscode5.ThemeIcon("github");
  }
  if (state === "claude") {
    return new vscode5.ThemeIcon("hubot");
  }
  return new vscode5.ThemeIcon("list-filter");
}
function sourceButtonTooltip(state) {
  if (state === "all") {
    return "Source: All \u2014 click for Copilot only";
  }
  if (state === "copilot") {
    return "Source: Copilot \u2014 click for Claude only";
  }
  return "Source: Claude \u2014 click for All";
}
function nextMsgTypeState(current) {
  if (current === "all") {
    return "prompts";
  }
  if (current === "prompts") {
    return "responses";
  }
  return "all";
}
function msgTypeIcon(state) {
  if (state === "prompts") {
    return new vscode5.ThemeIcon("person");
  }
  if (state === "responses") {
    return new vscode5.ThemeIcon("hubot");
  }
  return new vscode5.ThemeIcon("comment-discussion");
}
function msgTypeTooltip(state) {
  if (state === "all") {
    return "Messages: All \u2014 click for prompts only";
  }
  if (state === "prompts") {
    return "Messages: Prompts only \u2014 click for responses only";
  }
  return "Messages: Responses only \u2014 click for All";
}
var SearchPanel = class {
  static show(context, index, engine) {
    const summaryMap = /* @__PURE__ */ new Map();
    for (const summary of index.getAllSummaries()) {
      summaryMap.set(summary.id, summary);
    }
    let sourceFilter = "all";
    let msgTypeFilter = "all";
    const sourceButton = {
      iconPath: sourceButtonIcon(sourceFilter),
      tooltip: sourceButtonTooltip(sourceFilter)
    };
    const msgTypeButton = {
      iconPath: msgTypeIcon(msgTypeFilter),
      tooltip: msgTypeTooltip(msgTypeFilter)
    };
    const quickPick = vscode5.window.createQuickPick();
    quickPick.placeholder = "Search chat history\u2026 (prefix with / for regex)";
    quickPick.matchOnDescription = false;
    quickPick.matchOnDetail = true;
    quickPick.buttons = [sourceButton, msgTypeButton];
    let debounceTimer;
    function runSearch(value) {
      const isRegex = value.startsWith("/");
      const text = isRegex ? value.slice(1) : value;
      if (!text) {
        quickPick.items = [];
        return;
      }
      const filter = {};
      if (sourceFilter !== "all") {
        filter.source = sourceFilter;
      }
      filter.searchPrompts = msgTypeFilter !== "responses";
      filter.searchResponses = msgTypeFilter !== "prompts";
      let response;
      try {
        response = engine.search({ text, isRegex, filter });
      } catch {
        quickPick.items = [];
        return;
      }
      const items = [];
      if (response.totalCount > response.results.length) {
        items.push({
          label: `$(info) Showing top ${response.results.length} of ${response.totalCount} results \u2014 refine your query`,
          result: void 0,
          summary: void 0,
          alwaysShow: true
        });
      }
      for (const result of response.results) {
        const summary = summaryMap.get(result.sessionId);
        if (!summary) {
          continue;
        }
        const srcIcon = summary.source === "copilot" ? "$(github)" : "$(hubot)";
        const label = `${srcIcon}  ${summary.title}`;
        const workspace7 = summary.workspacePath ?? summary.workspaceId;
        const description = `${workspace7}  \xB7  ${summary.updatedAt.slice(0, 10)}`;
        const assistantName = summary.source === "copilot" ? "Copilot" : "Claude";
        const rolePrefix = result.messageRole === "user" ? "You" : assistantName;
        const detail = `${rolePrefix}:  ${result.snippet}`;
        const prefixLen = rolePrefix.length + 3;
        const item = { label, description, detail, result, summary };
        item.highlights = {
          detail: [[prefixLen + result.matchStart, prefixLen + result.matchEnd]]
        };
        items.push(item);
      }
      quickPick.items = items;
    }
    quickPick.onDidChangeValue((value) => {
      if (debounceTimer !== void 0) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = void 0;
        runSearch(value);
      }, 300);
    });
    quickPick.onDidTriggerButton((button) => {
      if (button === sourceButton) {
        sourceFilter = nextSourceState(sourceFilter);
        sourceButton.iconPath = sourceButtonIcon(sourceFilter);
        sourceButton.tooltip = sourceButtonTooltip(sourceFilter);
      } else if (button === msgTypeButton) {
        msgTypeFilter = nextMsgTypeState(msgTypeFilter);
        msgTypeButton.iconPath = msgTypeIcon(msgTypeFilter);
        msgTypeButton.tooltip = msgTypeTooltip(msgTypeFilter);
      }
      quickPick.buttons = [sourceButton, msgTypeButton];
      runSearch(quickPick.value);
    });
    quickPick.onDidAccept(() => {
      const active = quickPick.activeItems[0];
      if (active && active.result) {
        const raw = quickPick.value;
        const term = raw.startsWith("/") ? raw.slice(1) : raw;
        vscode5.commands.executeCommand("chatwizard.openSession", active.summary, term);
      }
    });
    quickPick.onDidHide(() => {
      if (debounceTimer !== void 0) {
        clearTimeout(debounceTimer);
      }
      quickPick.dispose();
    });
    quickPick.show();
  }
};

// src/export/exportCommands.ts
var vscode6 = __toESM(require("vscode"));
var path15 = __toESM(require("path"));

// src/export/markdownSerializer.ts
function truncate(text, maxLen) {
  return text.length <= maxLen ? text : text.slice(0, maxLen) + "\u2026";
}
var RE_SAFE_EXPORT_URL = /^https?:\/\/|^ftp:\/\/|^#|^\/[^/]|^\.\.?\//i;
var RE_MD_LINK = /\[([^\]]*)\]\(([^)]+)\)/g;
function sanitizeForExport(text) {
  return text.replace(RE_MD_LINK, (_match, linkText, url) => {
    return RE_SAFE_EXPORT_URL.test(url.trim()) ? `[${linkText}](${url})` : `[${linkText}]`;
  });
}
var EXPORT_HEADER = "<!-- Chat Wizard export \u2014 AI-generated content. Render in a trusted environment only. -->\n\n";
function serializeSession(session, sanitize = true) {
  const lines = [];
  lines.push(`# ${session.title || "Untitled Session"}`);
  lines.push("");
  lines.push(`- **Source:** ${session.source === "copilot" ? "GitHub Copilot" : "Claude Code"}`);
  if (session.model) {
    lines.push(`- **Model:** ${session.model}`);
  }
  lines.push(`- **Updated:** ${session.updatedAt.slice(0, 16).replace("T", " ")}`);
  lines.push("");
  const visible = session.messages.filter((m) => m.content.trim() !== "");
  let first = true;
  for (const msg of visible) {
    const content = sanitize ? sanitizeForExport(msg.content) : msg.content;
    if (msg.role === "user") {
      const firstLine = content.split("\n")[0].trim();
      const heading = truncate(firstLine || "Prompt", 120);
      lines.push("---");
      lines.push("");
      if (first) {
        first = false;
      }
      lines.push(`## ${heading}`);
      lines.push("");
      lines.push(content);
      lines.push("");
    } else {
      lines.push("### Response");
      lines.push("");
      lines.push(content);
      lines.push("");
    }
  }
  return lines.join("\n");
}
function serializeSessions(sessions, _mode, sanitize = true) {
  const parts = [];
  parts.push(EXPORT_HEADER);
  parts.push("# Chat Wizard Export");
  parts.push("");
  parts.push("## Table of Contents");
  parts.push("");
  for (let i = 0; i < sessions.length; i++) {
    const title = sessions[i].title || "Untitled Session";
    const anchor = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    parts.push(`${i + 1}. [${title}](#${anchor})`);
  }
  parts.push("");
  parts.push("---");
  parts.push("");
  for (const session of sessions) {
    parts.push(serializeSession(session, sanitize));
  }
  return parts.join("\n");
}

// src/export/exportCommands.ts
function safeFilename(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}
function defaultFolderUri() {
  const folders = vscode6.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri;
  }
  const home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? "/";
  return vscode6.Uri.file(home);
}
async function performExport(sessions) {
  if (sessions.length === 0) {
    vscode6.window.showInformationMessage("No sessions to export");
    return;
  }
  const modeItems = [
    { label: "$(file)  One file per session", description: "Creates a .md file for each session in a chosen folder", id: "separate" },
    { label: "$(files)  Single combined file", description: "All sessions in one .md file with a table of contents", id: "combined" }
  ];
  const modePick = await vscode6.window.showQuickPick(modeItems, {
    title: "Export Sessions",
    placeHolder: "Choose export format"
  });
  if (!modePick) {
    return;
  }
  if (modePick.id === "separate") {
    const folderUris = await vscode6.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: "Choose export folder",
      openLabel: "Export here"
    });
    if (!folderUris || folderUris.length === 0) {
      return;
    }
    const folder = folderUris[0];
    for (const session of sessions) {
      const fileUri = vscode6.Uri.joinPath(folder, `${safeFilename(session.title)}.md`);
      await vscode6.workspace.fs.writeFile(fileUri, Buffer.from(serializeSession(session), "utf8"));
    }
    vscode6.window.showInformationMessage(`Exported ${sessions.length} session(s) to ${folder.fsPath}`);
    return;
  }
  const saveUri = await vscode6.window.showSaveDialog({
    filters: { "Markdown": ["md"] },
    title: "Save combined export",
    defaultUri: vscode6.Uri.joinPath(defaultFolderUri(), "chatwizard-export.md")
  });
  if (!saveUri) {
    return;
  }
  await vscode6.workspace.fs.writeFile(saveUri, Buffer.from(serializeSessions(sessions, "combined"), "utf8"));
  await vscode6.window.showTextDocument(saveUri);
}
function registerExportCommands(context, index, getOrderedSummaries) {
  context.subscriptions.push(
    vscode6.commands.registerCommand("chatwizard.exportSession", async (item) => {
      const session = index.get(item.summary.id);
      if (!session) {
        vscode6.window.showErrorMessage(`Session not found: ${item.summary.id}`);
        return;
      }
      const filename = `${safeFilename(session.title)}.md`;
      const uri = await vscode6.window.showSaveDialog({
        defaultUri: vscode6.Uri.joinPath(defaultFolderUri(), filename),
        filters: { "Markdown": ["md"] },
        title: "Export Session as Markdown"
      });
      if (!uri) {
        return;
      }
      await vscode6.workspace.fs.writeFile(uri, Buffer.from(serializeSession(session), "utf8"));
      await vscode6.window.showTextDocument(uri);
    })
  );
  context.subscriptions.push(
    vscode6.commands.registerCommand("chatwizard.exportAll", async () => {
      const sessions = index.getAllSummaries().map((s) => index.get(s.id)).filter((s) => s != null);
      await performExport(sessions);
    })
  );
  context.subscriptions.push(
    vscode6.commands.registerCommand("chatwizard.exportSelected", async () => {
      const allSummaries = getOrderedSummaries ? getOrderedSummaries() : index.getAllSummaries();
      if (allSummaries.length === 0) {
        vscode6.window.showInformationMessage("No sessions to export");
        return;
      }
      const items = allSummaries.map((s) => ({
        label: s.title || "Untitled Session",
        description: `${path15.basename(s.workspacePath ?? s.workspaceId)} \xB7 ${s.updatedAt.slice(0, 10)}`,
        detail: `${s.source === "copilot" ? "Copilot" : "Claude"} \xB7 ${s.messageCount} messages`,
        id: s.id
      }));
      const qp = vscode6.window.createQuickPick();
      qp.items = items;
      qp.canSelectMany = true;
      qp.title = "Export Selected Sessions";
      qp.placeholder = "Type to filter \xB7 Space or click to select \xB7 Enter to export";
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;
      const picked = await new Promise((resolve) => {
        qp.onDidAccept(() => {
          resolve(qp.selectedItems);
          qp.hide();
        });
        qp.onDidHide(() => {
          resolve(void 0);
          qp.dispose();
        });
        qp.show();
      });
      if (!picked || picked.length === 0) {
        return;
      }
      const sessions = picked.map((p) => index.get(p.id)).filter((s) => s != null);
      await performExport(sessions);
    })
  );
  context.subscriptions.push(
    vscode6.commands.registerCommand("chatwizard.exportExcerpt", async (sessionId) => {
      const session = index.get(sessionId);
      if (!session) {
        vscode6.window.showErrorMessage(`Session not found: ${sessionId}`);
        return;
      }
      const visible = session.messages.filter((m) => m.content.trim() !== "");
      const assistantLabel = session.source === "copilot" ? "Copilot" : "Claude";
      const items = visible.map((msg, i) => ({
        label: msg.role === "user" ? "$(account) You" : `$(hubot) ${assistantLabel}`,
        description: msg.content.split("\n")[0].slice(0, 90),
        msgIndex: i
      }));
      const picked = await vscode6.window.showQuickPick(items, {
        canPickMany: true,
        title: `Export Excerpt \u2014 ${session.title}`,
        placeHolder: "Select messages to include (Space to toggle, Enter to confirm)"
      });
      if (!picked || picked.length === 0) {
        return;
      }
      const excerptSession = {
        ...session,
        title: `${session.title} (excerpt)`,
        messages: picked.map((p) => visible[p.msgIndex])
      };
      const filename = `${safeFilename(session.title)}-excerpt.md`;
      const uri = await vscode6.window.showSaveDialog({
        defaultUri: vscode6.Uri.joinPath(defaultFolderUri(), filename),
        filters: { "Markdown": ["md"] },
        title: "Export Excerpt as Markdown"
      });
      if (!uri) {
        return;
      }
      await vscode6.workspace.fs.writeFile(uri, Buffer.from(serializeSession(excerptSession), "utf8"));
      await vscode6.window.showTextDocument(uri);
    })
  );
}

// src/codeblocks/codeBlockSearchEngine.ts
var CodeBlockSearchEngine = class {
  blocks = [];
  /** Replace the entire code block index with a new set */
  index(blocks) {
    this.blocks = [...blocks];
  }
  /** All distinct language labels in the index, sorted alphabetically.
   *  Empty-string language is included (unlabeled blocks).
   *  Use this to populate the language filter dropdown in the UI. */
  getLanguages() {
    const seen = /* @__PURE__ */ new Set();
    for (const block of this.blocks) {
      seen.add(block.language);
    }
    return [...seen].sort();
  }
  /**
   * Search code blocks.
   * @param query - plain text substring to match against block content (case-insensitive).
   *                If empty, returns all blocks (subject to language filter).
   * @param language - if provided (non-empty string), only return blocks with this language (exact match, case-insensitive).
   * @returns matching IndexedCodeBlock[], preserving insertion order.
   */
  search(query, language) {
    let results = this.blocks;
    if (language && language.length > 0) {
      const langLower = language.toLowerCase();
      results = results.filter((b) => b.language.toLowerCase() === langLower);
    }
    if (query.length > 0) {
      const queryLower = query.toLowerCase();
      results = results.filter((b) => b.content.toLowerCase().includes(queryLower));
    }
    return results;
  }
  /** Total number of blocks currently in the index. */
  get size() {
    return this.blocks.length;
  }
  /**
   * Remove all blocks belonging to the given session.
   * No-op if the sessionId is not present in the index.
   */
  removeBySession(sessionId) {
    this.blocks = this.blocks.filter((b) => b.sessionId !== sessionId);
  }
  /**
   * Replace all blocks for `sessionId` with the supplied `blocks` array,
   * then append any blocks from other sessions that were already indexed.
   * If `blocks` is empty this behaves like `removeBySession`.
   */
  upsertBySession(sessionId, blocks) {
    this.removeBySession(sessionId);
    this.blocks = [...this.blocks, ...blocks];
  }
};

// src/codeblocks/codeBlocksPanel.ts
var vscode7 = __toESM(require("vscode"));
var CodeBlocksPanel = class _CodeBlocksPanel {
  static _panel;
  static show(context, index, engine) {
    const blocks = index.getAllCodeBlocks();
    engine.index(blocks);
    if (_CodeBlocksPanel._panel) {
      _CodeBlocksPanel._panel.reveal(vscode7.ViewColumn.One);
      void _CodeBlocksPanel._panel.webview.postMessage({
        type: "update",
        data: _CodeBlocksPanel.buildPayload(blocks, engine)
      });
      return;
    }
    const panel = vscode7.window.createWebviewPanel(
      "chatwizardCodeBlocks",
      "Code Blocks",
      vscode7.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    _CodeBlocksPanel._panel = panel;
    panel.webview.html = _CodeBlocksPanel.getShellHtml();
    panel.onDidDispose(() => {
      _CodeBlocksPanel._panel = void 0;
    }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage((message) => {
      if (message.command === "copy") {
        void vscode7.env.clipboard.writeText(message.text ?? "");
        void vscode7.window.showInformationMessage("Code block copied to clipboard.");
      } else if (message.command === "openSettings") {
        void vscode7.commands.executeCommand("workbench.action.openSettings", "chatwizard");
      } else if (message.command === "rescan") {
        void vscode7.commands.executeCommand("chatwizard.rescan");
      } else if (message.type === "ready") {
        void panel.webview.postMessage({
          type: "update",
          data: _CodeBlocksPanel.buildPayload(blocks, engine)
        });
      }
    }, void 0, context.subscriptions);
  }
  /** Call this when the index changes to refresh the open panel if visible */
  static refresh(index, engine) {
    if (!_CodeBlocksPanel._panel) {
      return;
    }
    const blocks = index.getAllCodeBlocks();
    engine.index(blocks);
    void _CodeBlocksPanel._panel.webview.postMessage({
      type: "update",
      data: _CodeBlocksPanel.buildPayload(blocks, engine)
    });
  }
  static buildPayload(blocks, engine) {
    return {
      blocks: blocks.map((b) => ({
        language: b.language || "",
        content: b.content,
        sessionTitle: b.sessionTitle,
        sessionSource: b.sessionSource,
        sessionUpdatedAt: b.sessionUpdatedAt ?? "",
        sessionWorkspacePath: b.sessionWorkspacePath,
        messageRole: b.messageRole
      })),
      languages: engine.getLanguages()
    };
  }
  static _escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  static getShellHtml() {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <style>
    ${cwThemeCss()}
    ${syntaxHighlighterCss()}
    * {
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 0;
      line-height: 1.5;
    }

    .toolbar {
      position: sticky;
      top: 0;
      background: var(--cw-surface);
      padding: 8px 16px;
      display: flex;
      gap: 8px;
      align-items: center;
      z-index: 10;
      border-bottom: 1px solid var(--cw-border);
    }

    .toolbar label {
      font-size: 0.85em;
      opacity: 0.75;
      white-space: nowrap;
    }

    #blockCount {
      font-size: 0.85em;
      opacity: 0.65;
      white-space: nowrap;
      margin-right: 4px;
    }

    #langFilter,
    #searchInput {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 3px;
      padding: 3px 6px;
      outline: none;
    }

    #langFilter:focus,
    #searchInput:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    #searchInput {
      flex: 1;
      min-width: 120px;
    }

    .blocks-list {
      padding: 12px 16px;
    }

    .block-card {
      margin-bottom: 12px;
      background: var(--cw-surface-raised);
      border: 1px solid var(--cw-border);
      border-radius: var(--cw-radius);
      box-shadow: var(--cw-shadow);
      overflow: hidden;
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      padding: 6px 10px;
      background: var(--cw-surface-subtle);
      border-bottom: 1px solid var(--cw-border);
      position: relative;
    }

    .badge {
      font-size: 0.78em;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 3px;
      white-space: nowrap;
    }

    .badge-lang {
      background: var(--cw-surface-subtle);
      color: var(--cw-accent);
      border: 1px solid var(--cw-border-strong);
      text-transform: lowercase;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .badge-lang[data-lang="javascript"], .badge-lang[data-lang="js"],
    .badge-lang[data-lang="typescript"], .badge-lang[data-lang="ts"],
    .badge-lang[data-lang="jsx"],        .badge-lang[data-lang="tsx"] {
      background: rgba(78,201,78,0.12); color: #4ec94e; border-color: rgba(78,201,78,0.3);
    }
    .badge-lang[data-lang="python"], .badge-lang[data-lang="py"] {
      background: rgba(91,155,213,0.12); color: #5b9bd5; border-color: rgba(91,155,213,0.3);
    }
    .badge-lang[data-lang="rust"] {
      background: rgba(240,136,62,0.12); color: #f0883e; border-color: rgba(240,136,62,0.3);
    }
    .badge-lang[data-lang="go"] {
      background: rgba(41,190,176,0.12); color: #29beb0; border-color: rgba(41,190,176,0.3);
    }
    .badge-lang[data-lang="shell"], .badge-lang[data-lang="bash"], .badge-lang[data-lang="sh"] {
      background: rgba(166,123,240,0.12); color: #a67bf0; border-color: rgba(166,123,240,0.3);
    }
    .badge-lang[data-lang="json"] {
      background: rgba(226,201,111,0.12); color: #e2c96f; border-color: rgba(226,201,111,0.3);
    }
    .badge-lang[data-lang="html"], .badge-lang[data-lang="css"] {
      background: rgba(244,112,103,0.12); color: #f47067; border-color: rgba(244,112,103,0.3);
    }

    .badge-role {
      background: var(--cw-surface-subtle);
      color: var(--cw-text-muted);
      border: 1px solid var(--cw-border-strong);
    }

    .source-label {
      font-size: 0.82em;
      opacity: 0.7;
      white-space: nowrap;
    }

    .session-title {
      font-size: 0.85em;
      font-weight: 500;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-date {
      font-size: 0.78em;
      opacity: 0.55;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    .session-workspace {
      font-size: 0.78em;
      opacity: 0.5;
      white-space: nowrap;
      font-style: italic;
    }

    .copy-btn {
      margin-left: auto;
      font-size: 0.78em;
      padding: 2px 10px;
      border: 1px solid var(--cw-border-strong);
      border-radius: var(--cw-radius-xs);
      cursor: pointer;
      background: var(--cw-surface-subtle);
      color: inherit;
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }

    .copy-btn:hover {
      background: var(--cw-accent);
      color: var(--cw-accent-text);
      border-color: var(--cw-accent);
    }

    pre {
      margin: 0;
      padding: 12px 14px;
      overflow-x: auto;
      white-space: pre;
    }

    code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
    }

    .empty-state {
      text-align: center;
      opacity: 0.5;
      font-style: italic;
      padding: 40px 16px;
    }
    :focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
    .empty-state-guided { text-align: center; padding: 40px 20px; }
    .empty-state-guided .empty-state-title { font-size: 1.05em; font-weight: 600; margin-bottom: 8px; }
    .empty-state-guided .empty-state-body { opacity: 0.6; margin-bottom: 16px; font-size: 0.92em; }
    .empty-state-guided .empty-state-actions { display: flex; gap: 8px; justify-content: center; }
  </style>
</head>
<body>
  <div class="toolbar">
    <span id="blockCount">Loading&#8230;</span>
    <label for="langFilter">Language:</label>
    <select id="langFilter">
      <option value="">All languages</option>
    </select>
    <input id="searchInput" type="text" placeholder="Filter by content&#8230;" />
  </div>
  <div class="blocks-list" id="blocks-list"></div>
  <script>
    const vscode = acquireVsCodeApi();

    function escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    const langSelect  = document.getElementById('langFilter');
    const searchInput = document.getElementById('searchInput');
    const countEl     = document.getElementById('blockCount');
    const listEl      = document.getElementById('blocks-list');

    function applyFilters() {
      const lang  = langSelect.value;
      const query = searchInput.value.toLowerCase();
      const cards = listEl.querySelectorAll('.block-card');
      let visible = 0;
      cards.forEach(function(card) {
        const cardLang    = card.dataset.lang    || '';
        const cardContent = card.dataset.content || '';
        const langMatch   = !lang  || cardLang === lang;
        const queryMatch  = !query || cardContent.includes(query);
        const show = langMatch && queryMatch;
        card.style.display = show ? '' : 'none';
        if (show) { visible++; }
      });
      countEl.textContent = visible + ' block' + (visible === 1 ? '' : 's');
    }

    langSelect.addEventListener('change', applyFilters);
    searchInput.addEventListener('input', applyFilters);

    // Copy via event delegation -- survives DOM rebuilds
    document.addEventListener('click', function(e) {
      const btn = e.target && e.target.closest ? e.target.closest('.copy-btn') : null;
      if (!btn) { return; }
      const content = btn.closest('.block-card') && btn.closest('.block-card').dataset.fullContent;
      if (content !== undefined) {
        vscode.postMessage({ command: 'copy', text: content });
        if (window.cwMorphCopy) { window.cwMorphCopy(btn, 'Copy'); }
      }
    });

    function renderData(payload) {
      const scrollTop = window.scrollY;

      // Save current filter selections
      const savedLang  = langSelect.value;
      const savedQuery = searchInput.value;

      // Rebuild language options
      const langs = payload.languages || [];
      let optHtml = '<option value="">All languages</option>';
      langs.forEach(function(lang) {
        optHtml += '<option value="' + escHtml(lang) + '">' + escHtml(lang) + '</option>';
      });
      langSelect.innerHTML = optHtml;

      // Restore saved lang if still available
      if (langs.includes(savedLang)) {
        langSelect.value = savedLang;
      } else {
        langSelect.value = '';
      }
      searchInput.value = savedQuery;

      const blocks = payload.blocks || [];

      if (blocks.length === 0) {
        listEl.innerHTML = '<div class="empty-state-guided">'
          + '<p class="empty-state-title">No code blocks indexed yet.</p>'
          + '<p class="empty-state-body">Chat Wizard indexes code blocks from your AI chat sessions. Configure your data paths and rescan to see results.</p>'
          + '<div class="empty-state-actions">'
          + '<button class="copy-btn" id="btn-open-settings">Configure Paths</button>'
          + '<button class="copy-btn" id="btn-rescan">Rescan</button>'
          + '</div></div>';
        var btnCfg = document.getElementById('btn-open-settings');
        var btnScan = document.getElementById('btn-rescan');
        if (btnCfg) { btnCfg.addEventListener('click', function() { vscode.postMessage({ command: 'openSettings' }); }); }
        if (btnScan) { btnScan.addEventListener('click', function() { vscode.postMessage({ command: 'rescan' }); }); }
        countEl.textContent = '0 blocks';
        return;
      }

      let cardsHtml = '';
      blocks.forEach(function(block, i) {
        const lang         = block.language || '';
        const langDisplay  = lang || 'plain';
        const langLower    = lang.toLowerCase();
        const roleLabel    = block.messageRole === 'user' ? 'User' : 'AI';
        const sourceLabel  = block.sessionSource === 'copilot' ? 'Copilot' : 'Claude';
        const sourceBadge  = block.sessionSource === 'copilot' ? 'cw-badge-copilot' : 'cw-badge-claude';
        const dateStr      = block.sessionUpdatedAt ? block.sessionUpdatedAt.slice(0, 10) : '';
        const wsPath       = block.sessionWorkspacePath || '';
        const wsName       = wsPath ? (wsPath.replace(/\\\\/g, '/').split('/').pop() || '') : '';
        const contentLower = block.content.toLowerCase();

        const fadeAttr = i < 15 ? ' style="--cw-i:' + i + '"' : '';
        const wsSpan   = wsName
          ? '\\n    <span class="session-workspace">' + escHtml(wsName) + '</span>'
          : '';

        cardsHtml +=
          '<div class="block-card cw-fade-item"' + fadeAttr
          + ' data-lang="' + escHtml(langLower) + '"'
          + ' data-content="' + escHtml(contentLower) + '"'
          + ' data-full-content="' + escHtml(block.content) + '">'
          + '\\n  <div class="card-header">'
          + '\\n    <span class="badge badge-lang" data-lang="' + escHtml(langLower) + '">' + escHtml(langDisplay) + '</span>'
          + '\\n    <span class="badge badge-role">' + escHtml(roleLabel) + '</span>'
          + '\\n    <span class="' + sourceBadge + '">' + escHtml(sourceLabel) + '</span>'
          + '\\n    <span class="session-title">' + escHtml(block.sessionTitle) + '</span>'
          + '\\n    <span class="session-date">' + escHtml(dateStr) + '</span>'
          + wsSpan
          + '\\n    <button class="copy-btn" title="Copy code block">Copy</button>'
          + '\\n  </div>'
          + '\\n  <pre><code' + (lang ? ' class="language-' + escHtml(lang) + '"' : '') + '>'
          + escHtml(block.content)
          + '</code></pre>'
          + '\\n</div>';
      });

      listEl.innerHTML = cardsHtml;

      // Re-run syntax highlighter on new DOM
      if (window._cwRunHighlighter) { window._cwRunHighlighter(); }

      // Apply current filters
      applyFilters();

      // Restore scroll position
      window.scrollTo(0, scrollTop);
    }

    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (msg && msg.type === 'update') {
        renderData(msg.data);
      }
    });

    // Signal ready
    vscode.postMessage({ type: 'ready' });
  </script>
  <script>
    // Expose tokenize globally so renderData can re-run after DOM rebuild
    (function() {
      var KEYWORDS = new Set([
        'abstract','as','async','await','break','case','catch','class','const',
        'continue','debugger','declare','default','delete','do','else','enum',
        'export','extends','false','finally','for','from','function','get','if',
        'implements','import','in','instanceof','interface','let','namespace',
        'new','null','of','package','private','protected','public','readonly',
        'return','set','static','super','switch','this','throw','true','try',
        'type','typeof','undefined','var','void','while','with','yield',
        'def','elif','except','exec','lambda','nonlocal','pass','print','raise',
        'and','not','or','is',
        'fn','mut','pub','use','mod','impl','struct','trait','where',
        'int','float','double','char','long','short','byte','unsigned','signed',
        'auto','register','extern','volatile','inline','None','True','False','self'
      ]);

      function escH(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      }
      function sp(cls, text) { return '<span class="' + cls + '">' + escH(text) + '</span>'; }
      function cwTokenize(code) {
        var out = ''; var i = 0; var len = code.length;
        while (i < len) {
          var ch = code[i];
          if (ch === '/' && code[i+1] === '*') { var ce = code.indexOf('*/', i+2); if (ce===-1){ce=len-2;} out+=sp('tok-comment',code.slice(i,ce+2)); i=ce+2; continue; }
          if (ch === '/' && code[i+1] === '/') { var nl = code.indexOf('\\n',i); if(nl===-1){nl=len;} out+=sp('tok-comment',code.slice(i,nl)); i=nl; continue; }
          if (ch === '#') { var nh = code.indexOf('\\n',i); if(nh===-1){nh=len;} out+=sp('tok-comment',code.slice(i,nh)); i=nh; continue; }
          if (ch==='"'||ch==="'") { var q=ch,j=i+1; while(j<len){if(code[j]==='\\\\'){j+=2;continue;}if(code[j]===q){j++;break;}j++;} out+=sp('tok-string',code.slice(i,j)); i=j; continue; }
          if (ch>='0'&&ch<='9') { var k=i; while(k<len){var c=code[k];if(!((c>='0'&&c<='9')||c==='.'||c==='_'||c==='x'||c==='X'||(c>='a'&&c<='f')||(c>='A'&&c<='F'))){break;}k++;} out+=sp('tok-number',code.slice(i,k)); i=k; continue; }
          if ((ch>='a'&&ch<='z')||(ch>='A'&&ch<='Z')||ch==='_') { var m=i; while(m<len){var mc=code[m];if(!((mc>='a'&&mc<='z')||(mc>='A'&&mc<='Z')||(mc>='0'&&mc<='9')||mc==='_')){break;}m++;} var word=code.slice(i,m),next=code[m]||''; if(KEYWORDS.has(word)){out+=sp('tok-keyword',word);}else if(next==='('){out+=sp('tok-function',word);}else if(word[0]>='A'&&word[0]<='Z'){out+=sp('tok-type',word);}else{out+=escH(word);} i=m; continue; }
          out+=escH(ch); i++;
        }
        return out;
      }
      window._cwRunHighlighter = function() {
        document.querySelectorAll('pre code').forEach(function(block) {
          block.innerHTML = cwTokenize(block.textContent || '');
        });
      };
      // Run once on initial load
      window._cwRunHighlighter();
    })();
  </script>
  <script>${cwInteractiveJs()}</script>
</body>
</html>`;
  }
};

// src/prompts/promptLibraryPanel.ts
var vscode8 = __toESM(require("vscode"));

// src/prompts/promptExtractor.ts
function normalizePromptText(text) {
  return text.trim().replace(/\s+/g, " ");
}
function buildPromptLibrary(index) {
  const raw = index.getAllPrompts();
  const map = /* @__PURE__ */ new Map();
  for (const prompt of raw) {
    const normalized = normalizePromptText(prompt.content);
    if (normalized.length === 0) {
      continue;
    }
    const session = index.get(prompt.sessionId);
    const workspacePath = session?.workspacePath;
    let entry = map.get(normalized);
    if (entry === void 0) {
      entry = {
        frequency: 0,
        sessionIds: /* @__PURE__ */ new Set(),
        projectIds: /* @__PURE__ */ new Set(),
        firstSeen: void 0,
        sessionMetaMap: /* @__PURE__ */ new Map()
      };
      map.set(normalized, entry);
    }
    entry.frequency += 1;
    entry.sessionIds.add(prompt.sessionId);
    if (workspacePath !== void 0) {
      entry.projectIds.add(workspacePath);
    }
    if (prompt.timestamp !== void 0) {
      if (entry.firstSeen === void 0 || prompt.timestamp < entry.firstSeen) {
        entry.firstSeen = prompt.timestamp;
      }
    }
    if (session !== void 0 && !entry.sessionMetaMap.has(prompt.sessionId)) {
      entry.sessionMetaMap.set(prompt.sessionId, {
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        source: session.source
      });
    }
  }
  const result = [];
  for (const [text, entry] of map) {
    result.push({
      text,
      frequency: entry.frequency,
      sessionIds: Array.from(entry.sessionIds),
      projectIds: Array.from(entry.projectIds),
      firstSeen: entry.firstSeen,
      sessionMeta: Array.from(entry.sessionMetaMap.values())
    });
  }
  result.sort((a, b) => {
    if (b.frequency !== a.frequency) {
      return b.frequency - a.frequency;
    }
    return a.text.localeCompare(b.text);
  });
  return result;
}

// src/prompts/similarityEngine.ts
var MAX_CLUSTER_ENTRIES = 5e3;
var ASYNC_CHUNK_SIZE = 100;
function buildTrigramSet(s) {
  const trigrams = /* @__PURE__ */ new Set();
  for (let i = 0; i <= s.length - 3; i++) {
    trigrams.add(s.slice(i, i + 3));
  }
  return trigrams;
}
var _cacheKey = "";
var _cachedResult = null;
function jaccardFromSets(setA, setB) {
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersectionSize = 0;
  for (const tg of setA) {
    if (setB.has(tg)) {
      intersectionSize++;
    }
  }
  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 1 : intersectionSize / unionSize;
}
function _processEntry(entry, entrySet, clusters, canonicalTrigramSets, buckets, threshold) {
  const candidateSet = /* @__PURE__ */ new Set();
  for (const tg of entrySet) {
    const bucket = buckets.get(tg);
    if (bucket) {
      for (const ci2 of bucket) {
        candidateSet.add(ci2);
      }
    }
  }
  if (threshold <= 0 && clusters.length > 0 && candidateSet.size === 0) {
    candidateSet.add(0);
  }
  for (const ci2 of candidateSet) {
    if (jaccardFromSets(canonicalTrigramSets[ci2], entrySet) >= threshold) {
      const cluster = clusters[ci2];
      cluster.variants.push(entry);
      cluster.totalFrequency += entry.frequency;
      for (const pid of entry.projectIds) {
        if (!cluster.allProjectIds.includes(pid)) {
          cluster.allProjectIds.push(pid);
        }
      }
      return;
    }
  }
  const ci = clusters.length;
  clusters.push({
    canonical: entry,
    variants: [],
    totalFrequency: entry.frequency,
    allProjectIds: [...entry.projectIds]
  });
  canonicalTrigramSets.push(entrySet);
  for (const tg of entrySet) {
    let bucket = buckets.get(tg);
    if (!bucket) {
      bucket = [];
      buckets.set(tg, bucket);
    }
    bucket.push(ci);
  }
}
function _sortAndFinalize(clusters, truncated) {
  for (const cluster of clusters) {
    cluster.variants.sort((a, b) => b.frequency - a.frequency);
  }
  clusters.sort((a, b) => b.totalFrequency - a.totalFrequency);
  return { clusters, truncated };
}
function _runClustering(entries, threshold) {
  const truncated = entries.length > MAX_CLUSTER_ENTRIES;
  const workEntries = truncated ? entries.slice(0, MAX_CLUSTER_ENTRIES) : entries;
  const trigramSets = workEntries.map((e) => buildTrigramSet(e.text));
  const clusters = [];
  const canonicalTrigramSets = [];
  const buckets = /* @__PURE__ */ new Map();
  for (let i = 0; i < workEntries.length; i++) {
    _processEntry(workEntries[i], trigramSets[i], clusters, canonicalTrigramSets, buckets, threshold);
  }
  return _sortAndFinalize(clusters, truncated);
}
function clusterPrompts(entries, threshold = 0.6) {
  return _runClustering(entries, threshold).clusters;
}
function clusterPromptsAsync(entries, threshold = 0.6, cacheKey) {
  if (cacheKey !== void 0) {
    const key = `${cacheKey}:${threshold}`;
    if (key === _cacheKey && _cachedResult !== null) {
      return Promise.resolve(_cachedResult);
    }
  }
  return new Promise((resolve) => {
    const truncated = entries.length > MAX_CLUSTER_ENTRIES;
    const workEntries = truncated ? entries.slice(0, MAX_CLUSTER_ENTRIES) : entries;
    const trigramSets = workEntries.map((e) => buildTrigramSet(e.text));
    const clusters = [];
    const canonicalTrigramSets = [];
    const buckets = /* @__PURE__ */ new Map();
    let i = 0;
    function processChunk() {
      const end = Math.min(i + ASYNC_CHUNK_SIZE, workEntries.length);
      while (i < end) {
        _processEntry(
          workEntries[i],
          trigramSets[i],
          clusters,
          canonicalTrigramSets,
          buckets,
          threshold
        );
        i++;
      }
      if (i < workEntries.length) {
        setImmediate(processChunk);
        return;
      }
      const result = _sortAndFinalize(clusters, truncated);
      if (cacheKey !== void 0) {
        _cacheKey = `${cacheKey}:${threshold}`;
        _cachedResult = result;
      }
      resolve(result);
    }
    setImmediate(processChunk);
  });
}

// src/prompts/promptLibraryPanel.ts
var PromptLibraryPanel = class _PromptLibraryPanel {
  static _panel;
  static _refreshTimer = null;
  static _lastIndexVersion = -1;
  static show(context, index) {
    const entries = buildPromptLibrary(index);
    const clusters = clusterPrompts(entries);
    if (_PromptLibraryPanel._panel) {
      _PromptLibraryPanel._panel.reveal(vscode8.ViewColumn.One);
      void _PromptLibraryPanel._panel.webview.postMessage({
        type: "update",
        data: { clusters, truncated: false }
      });
      return;
    }
    const panel = vscode8.window.createWebviewPanel(
      "chatwizardPromptLibrary",
      "Prompt Library",
      vscode8.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    _PromptLibraryPanel._panel = panel;
    panel.webview.html = _PromptLibraryPanel.getShellHtml();
    panel.onDidDispose(() => {
      _PromptLibraryPanel._panel = void 0;
    }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage((message) => {
      if (message.command === "copy") {
        void vscode8.env.clipboard.writeText(message.text ?? "");
        void vscode8.window.showInformationMessage("Prompt copied to clipboard.");
      } else if (message.command === "openSession" && message.sessionId) {
        void vscode8.commands.executeCommand("chatwizard.openSession", { id: message.sessionId }, message.searchTerm, message.highlightContainer);
      } else if (message.command === "openSettings") {
        void vscode8.commands.executeCommand("workbench.action.openSettings", "chatwizard");
      } else if (message.command === "rescan") {
        void vscode8.commands.executeCommand("chatwizard.rescan");
      } else if (message.type === "ready") {
        void panel.webview.postMessage({
          type: "update",
          data: { clusters, truncated: false }
        });
      }
    }, void 0, context.subscriptions);
  }
  static refresh(index) {
    if (!_PromptLibraryPanel._panel) {
      return;
    }
    if (_PromptLibraryPanel._refreshTimer) {
      clearTimeout(_PromptLibraryPanel._refreshTimer);
    }
    _PromptLibraryPanel._refreshTimer = setTimeout(() => {
      _PromptLibraryPanel._refreshTimer = null;
      if (!_PromptLibraryPanel._panel) {
        return;
      }
      if (index.version === _PromptLibraryPanel._lastIndexVersion) {
        return;
      }
      _PromptLibraryPanel._lastIndexVersion = index.version;
      const entries = buildPromptLibrary(index);
      const clusters = clusterPrompts(entries);
      void _PromptLibraryPanel._panel.webview.postMessage({
        type: "update",
        data: { clusters, truncated: false }
      });
    }, 2e3);
  }
  static _escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  static getShellHtml() {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <style>
    ${cwThemeCss()}
    * { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 0;
      line-height: 1.5;
    }

    .toolbar {
      position: sticky;
      top: 0;
      background: var(--cw-surface);
      padding: 8px 16px;
      display: flex;
      gap: 8px;
      align-items: center;
      z-index: 10;
      border-bottom: 1px solid var(--cw-border);
    }

    #promptCount {
      font-size: 0.85em;
      opacity: 0.65;
      white-space: nowrap;
    }

    #searchInput {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 3px;
      padding: 3px 6px;
      outline: none;
      flex: 1;
      min-width: 120px;
    }

    #searchInput:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    .prompts-list {
      padding: 12px 16px;
    }

    .prompt-card {
      margin-bottom: 10px;
      background: var(--cw-surface-raised);
      border: 1px solid var(--cw-border);
      border-radius: var(--cw-radius);
      box-shadow: var(--cw-shadow);
      overflow: hidden;
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: var(--cw-surface-subtle);
      border-bottom: 1px solid var(--cw-border);
    }

    .freq-badge {
      font-size: 0.78em;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--cw-accent-text, #fff);
      background: var(--cw-accent);
      padding: 2px 9px;
      border-radius: 10px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .stats-label {
      font-size: 0.82em;
      opacity: 0.7;
      flex: 1;
    }

    .copy-btn {
      font-size: 0.78em;
      padding: 2px 10px;
      border: 1px solid var(--cw-border-strong);
      border-radius: var(--cw-radius-xs);
      cursor: pointer;
      background: var(--cw-surface-subtle);
      color: inherit;
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }

    .copy-btn:hover {
      background: var(--cw-accent);
      color: var(--cw-accent-text);
      border-color: var(--cw-accent);
    }

    .copy-btn-sm {
      font-size: 0.72em;
      padding: 1px 6px;
    }

    .prompt-text {
      padding: 10px 12px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.95em;
      cursor: pointer;
    }

    .variants-details {
      border-top: 1px solid var(--cw-border);
    }

    .variants-summary {
      padding: 5px 12px;
      cursor: pointer;
      font-size: 0.82em;
      opacity: 0.7;
      user-select: none;
    }

    .variants-summary:hover {
      opacity: 1;
    }

    .variants-list {
      list-style: none;
      margin: 0;
      padding: 4px 12px 8px;
    }

    .variant-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 4px 0;
      border-top: 1px solid var(--cw-border);
      font-size: 0.88em;
    }
    .variant-item[data-sessions] { cursor: pointer; }
    .variant-item[data-sessions]:hover { background: var(--cw-surface-subtle); border-radius: 3px; }

    .variant-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .variant-text {
      white-space: pre-wrap;
      word-break: break-word;
      opacity: 0.85;
    }

    .variant-session {
      font-size: 0.8em;
      opacity: 0.55;
      font-style: italic;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .variant-freq {
      font-size: 0.82em;
      opacity: 0.55;
      font-family: var(--vscode-editor-font-family, monospace);
      white-space: nowrap;
    }

    .empty-state {
      text-align: center;
      opacity: 0.5;
      font-style: italic;
      padding: 40px 16px;
    }

    #truncatedBanner {
      display: none;
      padding: 6px 16px;
      font-size: 0.82em;
      opacity: 0.7;
      background: var(--cw-surface-subtle);
      border-bottom: 1px solid var(--cw-border);
      text-align: center;
    }
    :focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
    .variants-summary:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
    .empty-state-guided { text-align: center; padding: 40px 20px; }
    .empty-state-guided .empty-state-title { font-size: 1.05em; font-weight: 600; margin-bottom: 8px; }
    .empty-state-guided .empty-state-body { opacity: 0.6; margin-bottom: 16px; font-size: 0.92em; }
    .empty-state-guided .empty-state-actions { display: flex; gap: 8px; justify-content: center; }

    /* Session hover overlay \u2014 styled as a distinct floating popup */
    #sessionOverlay {
      display: none;
      position: fixed;
      z-index: 1000;
      /* Use quickInput palette: the same widget VS Code uses for command palette / quick open */
      background: var(--vscode-quickInput-background, #1e1e1e);
      color: var(--vscode-quickInput-foreground, #d4d4d4);
      border: 2px solid var(--cw-accent, #007acc);
      border-radius: 6px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.7), 0 0 0 1px rgba(0,0,0,0.4);
      min-width: 240px;
      max-width: 340px;
      max-height: 260px;
      overflow-y: auto;
      padding: 0;
      font-size: 0.88em;
      /* Slightly offset from the panel so it reads as a layer above */
      backdrop-filter: none;
    }
    #sessionOverlay.visible { display: block; }
    .overlay-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.7em;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--cw-accent, #007acc);
      padding: 7px 10px 5px;
      background: var(--vscode-quickInput-background, #1e1e1e);
      border-bottom: 1px solid var(--cw-accent, #007acc);
      position: sticky;
      top: 0;
    }
    .overlay-header::before {
      content: '\\25BA';
      font-size: 0.8em;
      opacity: 0.7;
    }
    .overlay-session-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: border-color 0.1s, background 0.1s;
    }
    .overlay-session-row:hover {
      background: var(--vscode-quickInputList-focusBackground, rgba(0,122,204,0.2));
      border-left-color: var(--cw-accent, #007acc);
    }
    .overlay-session-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }
    .overlay-session-title {
      font-size: 0.92em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .overlay-session-meta {
      font-size: 0.74em;
      opacity: 0.45;
      white-space: nowrap;
    }
    .overlay-session-icon {
      font-size: 0.8em;
      opacity: 0.4;
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span id="promptCount">Loading&#8230;</span>
    <input id="searchInput" type="text" placeholder="Filter by text&#8230;" />
  </div>
  <div id="truncatedBanner"></div>
  <div class="prompts-list" id="promptsList"></div>
  <div id="sessionOverlay"></div>
  <script>
    const vscode = acquireVsCodeApi();

    function escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    var MAX_PROMPT_DISPLAY = 300;
    function truncateDisplay(text, max) {
      if (text.length <= max) { return text; }
      return text.substring(0, max) + '\u2026';
    }

    const searchInput  = document.getElementById('searchInput');
    const countEl      = document.getElementById('promptCount');
    const listEl       = document.getElementById('promptsList');
    const bannerEl     = document.getElementById('truncatedBanner');

    function applyFilter() {
      const query = searchInput.value.toLowerCase();
      const cards = listEl.querySelectorAll('.prompt-card');
      let visible = 0;
      cards.forEach(function(card) {
        const text = card.dataset.text || '';
        const show = !query || text.includes(query);
        card.style.display = show ? '' : 'none';
        if (show) { visible++; }
      });
      countEl.textContent = visible + ' prompt' + (visible === 1 ? '' : 's');
    }

    searchInput.addEventListener('input', applyFilter);

    // Hash guard: skip DOM rebuild if cluster data hasn't changed
    var _lastClustersJson = '';

    // Copy via event delegation -- survives DOM rebuilds
    document.addEventListener('click', function(e) {
      const btn = e.target && e.target.closest ? e.target.closest('.copy-btn') : null;
      if (!btn) { return; }
      const text = btn.dataset.text || '';
      vscode.postMessage({ command: 'copy', text });
      if (window.cwMorphCopy) { window.cwMorphCopy(btn, btn.textContent); }
    });

    function renderClusters(clusters) {
      var newJson = JSON.stringify(clusters);
      if (newJson === _lastClustersJson) { return; }
      _lastClustersJson = newJson;

      const scrollTop = window.scrollY;
      const savedQuery = searchInput.value;

      if (clusters.length === 0) {
        listEl.innerHTML = '<div class="empty-state-guided">'
          + '<p class="empty-state-title">No prompts indexed yet.</p>'
          + '<p class="empty-state-body">Chat Wizard reads your Claude Code and GitHub Copilot chat history. Make sure the data paths are configured correctly.</p>'
          + '<div class="empty-state-actions">'
          + '<button class="copy-btn" id="btn-open-settings">Configure Paths</button>'
          + '<button class="copy-btn" id="btn-rescan">Rescan</button>'
          + '</div></div>';
        var btnCfg = document.getElementById('btn-open-settings');
        var btnScan = document.getElementById('btn-rescan');
        if (btnCfg) { btnCfg.addEventListener('click', function() { vscode.postMessage({ command: 'openSettings' }); }); }
        if (btnScan) { btnScan.addEventListener('click', function() { vscode.postMessage({ command: 'rescan' }); }); }
        countEl.textContent = '0 prompts';
        searchInput.value = savedQuery;
        return;
      }

      let totalEntries = 0;
      let cardsHtml = '';

      clusters.forEach(function(cluster, i) {
        const canonical      = cluster.canonical;
        const variants       = cluster.variants || [];
        const totalFrequency = cluster.totalFrequency;
        const allProjectIds  = cluster.allProjectIds || [];
        const projectCount   = allProjectIds.length;
        totalEntries += 1 + variants.length;

        const statsLabel = 'Asked ' + totalFrequency + ' time' + (totalFrequency === 1 ? '' : 's')
          + (projectCount > 0 ? ' across ' + projectCount + ' project' + (projectCount === 1 ? '' : 's') : '');

        const escapedText      = escHtml(canonical.text);
        const displayText      = escHtml(truncateDisplay(canonical.text, MAX_PROMPT_DISPLAY));
        const escapedTextLower = escHtml(canonical.text.toLowerCase());

        let variantsHtml = '';
        if (variants.length > 0) {
          const variantItems = variants.map(function(v) {
            const escapedV      = escHtml(v.text);
            const displayV      = escHtml(truncateDisplay(v.text, MAX_PROMPT_DISPLAY));
            const vMeta = v.sessionMeta || [];
            const vSessionsAttr = escHtml(JSON.stringify(vMeta));
            const vDirectAttr = vMeta.length === 1 ? (' data-direct="' + escHtml(vMeta[0].sessionId) + '"') : '';
            const vTitleAttr = vMeta.length === 1
              ? (' title="Click to open \u201C' + escHtml(vMeta[0].title) + '\u201D"')
              : (vMeta.length > 1 ? ' title="Hover or click to pick a session"' : '');
            const sessionInfoParts = vMeta.map(function(m) {
              const date = m.updatedAt ? m.updatedAt.substring(0, 10) : '';
              return escHtml(m.title + (date ? ' \xB7 ' + date : ''));
            });
            const sessionInfoHtml = sessionInfoParts.length > 0
              ? '<span class="variant-session">' + sessionInfoParts.join(', ') + '</span>'
              : '';
            return '<li class="variant-item" data-sessions="' + vSessionsAttr + '" data-prompt="' + escapedV + '"' + vDirectAttr + vTitleAttr + '>'
              + '<div class="variant-body">'
              + '<span class="variant-text">' + displayV + '</span>'
              + sessionInfoHtml
              + '</div>'
              + '<span class="variant-freq">' + v.frequency + '\xD7</span>'
              + '<button class="copy-btn copy-btn-sm" data-text="' + escapedV + '" title="Copy variant">Copy</button>'
              + '</li>';
          }).join('');
          variantsHtml = '<details class="variants-details">'
            + '<summary class="variants-summary">' + variants.length + ' similar variant' + (variants.length === 1 ? '' : 's') + '</summary>'
            + '<ul class="variants-list">' + variantItems + '</ul>'
            + '</details>';
        }

        const fadeAttr = i < 15 ? ' style="--cw-i:' + i + '"' : '';
        const sessionMeta = cluster.canonical.sessionMeta || [];
        const canonicalSessionsAttr = escHtml(JSON.stringify(sessionMeta));
        const canonicalDirectAttr = sessionMeta.length === 1 ? (' data-direct="' + escHtml(sessionMeta[0].sessionId) + '"') : '';
        const canonicalTitleAttr = sessionMeta.length === 1
          ? (' title="Click to open \u201C' + escHtml(sessionMeta[0].title) + '\u201D"')
          : (sessionMeta.length > 1 ? ' title="Hover or click to pick a session"' : '');
        const promptTextAttr = escapedText;
        cardsHtml +=
          '<div class="prompt-card cw-fade-item"' + fadeAttr + ' data-text="' + escapedTextLower + '">'
          + '\\n  <div class="card-header">'
          + '\\n    <span class="freq-badge">' + totalFrequency + '\\u00d7</span>'
          + '\\n    <span class="stats-label">' + escHtml(statsLabel) + '</span>'
          + '\\n    <button class="copy-btn" data-text="' + escapedText + '" title="Copy prompt">Copy</button>'
          + '\\n  </div>'
          + '\\n  <div class="prompt-text" data-sessions="' + canonicalSessionsAttr + '" data-prompt="' + promptTextAttr + '"' + canonicalDirectAttr + canonicalTitleAttr + '>' + displayText + '</div>'
          + variantsHtml
          + '\\n</div>';
      });

      listEl.innerHTML = cardsHtml;

      // Restore state
      searchInput.value = savedQuery;
      applyFilter();
      countEl.textContent = totalEntries + ' prompt' + (totalEntries === 1 ? '' : 's');

      window.scrollTo(0, scrollTop);
    }

    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (msg && msg.type === 'update') {
        renderClusters(msg.data.clusters || []);
        if (msg.data.truncated) {
          bannerEl.style.display = '';
          bannerEl.textContent = 'Results truncated \\u2014 showing top entries only.';
        } else {
          bannerEl.style.display = 'none';
        }
      }
    });

    // ---- Session hover overlay ----
    var overlay   = document.getElementById('sessionOverlay');
    var hideTimer = null;
    var showTimer = null;
    var activeEl  = null;

    // Returns the canonical .prompt-text element under the event target (for overlay),
    // or null if the target is a copy button, a variant-item, or unrelated element.
    // Variant items are intentionally excluded \u2014 they navigate directly on click.
    function getInteractable(target) {
      if (!target || !target.closest) { return null; }
      if (target.closest('.copy-btn')) { return null; }
      if (target.closest('.variants-list')) { return null; }
      return target.closest('.prompt-text[data-sessions]');
    }

    function positionOverlay(el) {
      var rect  = el.getBoundingClientRect();
      var ovW   = 340;
      var gap   = 12;
      var left  = rect.right + gap;
      if (left + ovW > window.innerWidth - 4) {
        left = rect.left - ovW - gap;
        if (left < 4) { left = 4; }
      }
      var top = rect.top;
      var ovH = Math.min(260, overlay.scrollHeight || 160);
      if (top + ovH > window.innerHeight - 4) { top = window.innerHeight - ovH - 4; }
      if (top < 4) { top = 4; }
      overlay.style.left = left + 'px';
      overlay.style.top  = top  + 'px';
    }

    function showOverlay(el) {
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      var raw = el.dataset.sessions;
      if (!raw) { return; }
      var sessions;
      try { sessions = JSON.parse(raw); } catch(e) { return; }
      if (!sessions || sessions.length === 0) { return; }
      var promptText = el.dataset.prompt || '';
      activeEl = el;

      var rows = sessions.map(function(m) {
        var date = m.updatedAt ? m.updatedAt.substring(0, 10) : '';
        var srcLabel = m.source === 'copilot' ? 'Copilot' : 'Claude';
        return '<div class="overlay-session-row" data-sid="' + escHtml(m.sessionId) + '" data-prompt="' + escHtml(promptText) + '">'
          + '<span class="overlay-session-icon">\\u27A4</span>'
          + '<div class="overlay-session-body">'
          + '<span class="overlay-session-title">' + escHtml(m.title || m.sessionId) + '</span>'
          + '<span class="overlay-session-meta">' + escHtml(srcLabel + (date ? ' \\u00b7 ' + date : '')) + '</span>'
          + '</div>'
          + '</div>';
      }).join('');

      overlay.innerHTML = '<div class="overlay-header">Open in session</div>' + rows;
      positionOverlay(el);
      overlay.classList.add('visible');
    }

    function hideOverlay() {
      overlay.classList.remove('visible');
      activeEl = null;
    }

    function scheduleHide() {
      hideTimer = setTimeout(hideOverlay, 200);
    }

    // Click on a variant item: always navigate directly (no overlay), first session if multi-session
    document.addEventListener('click', function(e) {
      if (e.target && e.target.closest && e.target.closest('.copy-btn')) { return; }
      var vi = e.target && e.target.closest ? e.target.closest('.variant-item[data-sessions]') : null;
      if (!vi) { return; }
      var sid = vi.dataset.direct;
      if (!sid) {
        try {
          var sess = JSON.parse(vi.dataset.sessions);
          if (sess && sess.length > 0) { sid = sess[0].sessionId; }
        } catch (_) {}
      }
      if (!sid) { return; }
      hideOverlay();
      vscode.postMessage({ command: 'openSession', sessionId: sid, searchTerm: vi.dataset.prompt || '', highlightContainer: true });
    });

    // Click on canonical prompt-text: direct navigation (single session) or toggle overlay (multiple sessions)
    document.addEventListener('click', function(e) {
      var el = getInteractable(e.target);
      if (!el) { return; }
      if (el.dataset.direct) {
        hideOverlay();
        vscode.postMessage({ command: 'openSession', sessionId: el.dataset.direct, searchTerm: el.dataset.prompt || '', highlightContainer: true });
        return;
      }
      if (el === activeEl) { hideOverlay(); } else { showOverlay(el); }
    });

    // Hover: show overlay only after a short dwell (tooltip-style) for multi-session elements
    document.addEventListener('mouseover', function(e) {
      var el = getInteractable(e.target);
      if (!el || el.dataset.direct) { return; }
      if (el !== activeEl) {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        showTimer = setTimeout(function() { showOverlay(el); }, 500);
      }
    });

    document.addEventListener('mouseout', function(e) {
      var el = getInteractable(e.target);
      if (!el) { return; }
      clearTimeout(showTimer);
      var toEl = e.relatedTarget;
      if (!(toEl && (toEl === overlay || overlay.contains(toEl)))) {
        scheduleHide();
      }
    });

    overlay.addEventListener('mouseenter', function() { clearTimeout(hideTimer); clearTimeout(showTimer); });
    overlay.addEventListener('mouseleave', scheduleHide);

    // Click on a session row in the overlay
    overlay.addEventListener('click', function(e) {
      var row = e.target && e.target.closest ? e.target.closest('.overlay-session-row') : null;
      if (!row) { return; }
      var sid    = row.dataset.sid || '';
      var prompt = row.dataset.prompt || '';
      hideOverlay();
      vscode.postMessage({ command: 'openSession', sessionId: sid, searchTerm: prompt, highlightContainer: true });
    });

    // Signal ready
    vscode.postMessage({ type: 'ready' });
  </script>
  <script>${cwInteractiveJs()}</script>
</body>
</html>`;
  }
  /** @deprecated Returns loading HTML shell. Use getShellHtml() + postMessage instead. */
  static getLoadingHtml() {
    return _PromptLibraryPanel.getShellHtml();
  }
  static getHtml(clusters, truncated = false) {
    const totalEntries = clusters.reduce((sum, c) => sum + 1 + c.variants.length, 0);
    const cardsHtml = clusters.map((cluster, i) => {
      const { canonical, variants, totalFrequency, allProjectIds } = cluster;
      const projectCount = allProjectIds.length;
      const statsLabel = `Asked ${totalFrequency} time${totalFrequency === 1 ? "" : "s"}` + (projectCount > 0 ? ` across ${projectCount} project${projectCount === 1 ? "" : "s"}` : "");
      const escapedText = _PromptLibraryPanel._escapeHtml(canonical.text);
      const escapedTextLower = _PromptLibraryPanel._escapeHtml(canonical.text.toLowerCase());
      let variantsHtml = "";
      if (variants.length > 0) {
        const variantItems = variants.map((v) => {
          const escapedV = _PromptLibraryPanel._escapeHtml(v.text);
          const sessionInfoParts = v.sessionMeta.map((m) => {
            const date = m.updatedAt ? m.updatedAt.substring(0, 10) : "";
            return _PromptLibraryPanel._escapeHtml(`${m.title}${date ? " &#183; " + date : ""}`);
          });
          const sessionInfoHtml = sessionInfoParts.length > 0 ? `<span class="variant-session">${sessionInfoParts.join(", ")}</span>` : "";
          return `<li class="variant-item">
          <div class="variant-body">
            <span class="variant-text">${escapedV}</span>
            ${sessionInfoHtml}
          </div>
          <span class="variant-freq">${v.frequency}&#215;</span>
          <button class="copy-btn copy-btn-sm" data-text="${_PromptLibraryPanel._escapeHtml(v.text)}" title="Copy variant">Copy</button>
        </li>`;
        }).join("\n");
        variantsHtml = `
        <details class="variants-details">
          <summary class="variants-summary">${variants.length} similar variant${variants.length === 1 ? "" : "s"}</summary>
          <ul class="variants-list">${variantItems}</ul>
        </details>`;
      }
      const fadeAttr = i < 15 ? ` style="--cw-i:${i}"` : "";
      return `<div class="prompt-card cw-fade-item"${fadeAttr} data-text="${escapedTextLower}">
  <div class="card-header">
    <span class="freq-badge">${totalFrequency}&#215;</span>
    <span class="stats-label">${_PromptLibraryPanel._escapeHtml(statsLabel)}</span>
    <button class="copy-btn" data-text="${escapedText}" title="Copy prompt">Copy</button>
  </div>
  <div class="prompt-text">${escapedText}</div>${variantsHtml}
</div>`;
    }).join("\n");
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <style>
    ${cwThemeCss()}
    * { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 0;
      line-height: 1.5;
    }

    .toolbar {
      position: sticky;
      top: 0;
      background: var(--cw-surface);
      padding: 8px 16px;
      display: flex;
      gap: 8px;
      align-items: center;
      z-index: 10;
      border-bottom: 1px solid var(--cw-border);
    }

    #promptCount {
      font-size: 0.85em;
      opacity: 0.65;
      white-space: nowrap;
    }

    #searchInput {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 3px;
      padding: 3px 6px;
      outline: none;
      flex: 1;
      min-width: 120px;
    }

    #searchInput:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    .prompts-list {
      padding: 12px 16px;
    }

    .prompt-card {
      margin-bottom: 10px;
      background: var(--cw-surface-raised);
      border: 1px solid var(--cw-border);
      border-radius: var(--cw-radius);
      box-shadow: var(--cw-shadow);
      overflow: hidden;
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: var(--cw-surface-subtle);
      border-bottom: 1px solid var(--cw-border);
    }

    .freq-badge {
      font-size: 0.78em;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--cw-accent-text, #fff);
      background: var(--cw-accent);
      padding: 2px 9px;
      border-radius: 10px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .stats-label {
      font-size: 0.82em;
      opacity: 0.7;
      flex: 1;
    }

    .copy-btn {
      font-size: 0.78em;
      padding: 2px 10px;
      border: 1px solid var(--cw-border-strong);
      border-radius: var(--cw-radius-xs);
      cursor: pointer;
      background: var(--cw-surface-subtle);
      color: inherit;
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }

    .copy-btn:hover {
      background: var(--cw-accent);
      color: var(--cw-accent-text);
      border-color: var(--cw-accent);
    }

    .copy-btn-sm {
      font-size: 0.72em;
      padding: 1px 6px;
    }

    .prompt-text {
      padding: 10px 12px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.95em;
      cursor: pointer;
    }

    .variants-details {
      border-top: 1px solid var(--cw-border);
    }

    .variants-summary {
      padding: 5px 12px;
      cursor: pointer;
      font-size: 0.82em;
      opacity: 0.7;
      user-select: none;
    }

    .variants-summary:hover {
      opacity: 1;
    }

    .variants-list {
      list-style: none;
      margin: 0;
      padding: 4px 12px 8px;
    }

    .variant-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 4px 0;
      border-top: 1px solid var(--cw-border);
      font-size: 0.88em;
    }

    .variant-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .variant-text {
      white-space: pre-wrap;
      word-break: break-word;
      opacity: 0.85;
    }

    .variant-session {
      font-size: 0.8em;
      opacity: 0.55;
      font-style: italic;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .variant-freq {
      font-size: 0.82em;
      opacity: 0.55;
      font-family: var(--vscode-editor-font-family, monospace);
      white-space: nowrap;
    }

    .empty-state {
      text-align: center;
      opacity: 0.5;
      font-style: italic;
      padding: 40px 16px;
    }
    .truncated-banner {
      background: var(--vscode-editorWarning-background, rgba(255,200,0,0.12));
      color: var(--vscode-editorWarning-foreground, #c8a800);
      border-bottom: 1px solid var(--vscode-editorWarning-border, rgba(200,168,0,0.3));
      font-size: 0.82em;
      padding: 5px 16px;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span id="promptCount">${totalEntries} prompt${totalEntries === 1 ? "" : "s"}</span>
    <input id="searchInput" type="text" placeholder="Filter by text\u2026" />
  </div>
  ${truncated ? `<div class="truncated-banner">Too many prompts to cluster \u2014 showing top ${MAX_CLUSTER_ENTRIES.toLocaleString()}</div>` : ""}
  <div class="prompts-list" id="promptsList">
    ${clusters.length === 0 ? '<p class="empty-state">No prompts found across all sessions.</p>' : cardsHtml}
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('searchInput');
    const cards = document.querySelectorAll('.prompt-card');
    const countEl = document.getElementById('promptCount');
    const totalCount = ${totalEntries};

    function applyFilter() {
      const query = searchInput.value.toLowerCase();
      let visible = 0;
      cards.forEach(card => {
        const text = card.dataset.text || '';
        const show = !query || text.includes(query);
        card.style.display = show ? '' : 'none';
        if (show) { visible++; }
      });
      countEl.textContent = visible + ' prompt' + (visible === 1 ? '' : 's');
    }

    searchInput.addEventListener('input', applyFilter);

    document.addEventListener('click', e => {
      const btn = e.target.closest('.copy-btn');
      if (!btn) { return; }
      const text = btn.dataset.text || '';
      vscode.postMessage({ command: 'copy', text });
      if (window.cwMorphCopy) { window.cwMorphCopy(btn, btn.textContent); }
    });
  </script>
  <script>${cwInteractiveJs()}</script>
</body>
</html>`;
  }
};

// src/prompts/promptLibraryViewProvider.ts
var vscode9 = __toESM(require("vscode"));
var PromptLibraryViewProvider = class {
  constructor(_index) {
    this._index = _index;
  }
  static viewType = "chatwizardPromptLibrary";
  _view;
  _lastIndexVersion = -1;
  _refreshTimer = null;
  resolveWebviewView(webviewView, _context, _token) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = PromptLibraryPanel.getShellHtml();
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this._sendData();
      }
    });
    webviewView.webview.onDidReceiveMessage((message) => {
      if (message.command === "copy") {
        void vscode9.env.clipboard.writeText(message.text ?? "");
        void vscode9.window.showInformationMessage("Prompt copied to clipboard.");
      } else if (message.command === "openSession" && message.sessionId) {
        void vscode9.commands.executeCommand("chatwizard.openSession", { id: message.sessionId }, message.searchTerm, message.highlightContainer);
      } else if (message.command === "openSettings") {
        void vscode9.commands.executeCommand("workbench.action.openSettings", "chatwizard");
      } else if (message.command === "rescan") {
        void vscode9.commands.executeCommand("chatwizard.rescan");
      } else if (message.type === "ready") {
        void this._sendData();
      }
    });
    void this._sendData();
  }
  /** Re-render the view when the session index changes. Debounced 2 s. No-op if not visible or index unchanged. */
  refresh() {
    if (!this._view?.visible) {
      return;
    }
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
    }
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      if (this._view?.visible && this._index.version !== this._lastIndexVersion) {
        void this._sendData();
      }
    }, 2e3);
  }
  async _sendData() {
    if (!this._view) {
      return;
    }
    this._lastIndexVersion = this._index.version;
    const entries = buildPromptLibrary(this._index);
    const result = await clusterPromptsAsync(entries, 0.6, String(this._lastIndexVersion));
    if (this._view) {
      void this._view.webview.postMessage({
        type: "update",
        data: { clusters: result.clusters, truncated: result.truncated }
      });
    }
  }
};

// src/analytics/analyticsPanel.ts
var vscode10 = __toESM(require("vscode"));

// src/analytics/analyticsEngine.ts
var STOP_WORDS = /* @__PURE__ */ new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "her",
  "was",
  "one",
  "our",
  "out",
  "had",
  "have",
  "has",
  "him",
  "his",
  "how",
  "its",
  "let",
  "may",
  "she",
  "who",
  "use",
  "that",
  "this",
  "with",
  "from",
  "they",
  "will",
  "been",
  "more",
  "also",
  "into",
  "than",
  "just",
  "your"
]);
function computeAnalytics(sessions, countTokens2) {
  const allMetrics = sessions.map((session) => {
    let userMessageCount = 0;
    let assistantMessageCount = 0;
    let userTokens = 0;
    let assistantTokens = 0;
    for (const msg of session.messages) {
      if (msg.role === "user") {
        userMessageCount++;
        userTokens += countTokens2(msg.content, session.source);
      } else {
        assistantMessageCount++;
        assistantTokens += countTokens2(msg.content, session.source);
      }
    }
    return {
      sessionId: session.id,
      sessionTitle: session.title,
      sessionSource: session.source,
      workspacePath: session.workspacePath,
      updatedAt: session.updatedAt,
      userMessageCount,
      assistantMessageCount,
      totalMessageCount: userMessageCount + assistantMessageCount,
      userTokens,
      assistantTokens,
      totalTokens: userTokens + assistantTokens
    };
  });
  let totalPrompts = 0;
  let totalResponses = 0;
  let totalUserTokens = 0;
  let totalAssistantTokens = 0;
  let copilotSessions = 0;
  let claudeSessions = 0;
  for (const m of allMetrics) {
    totalPrompts += m.userMessageCount;
    totalResponses += m.assistantMessageCount;
    totalUserTokens += m.userTokens;
    totalAssistantTokens += m.assistantTokens;
  }
  for (const s of sessions) {
    if (s.source === "copilot") {
      copilotSessions++;
    } else {
      claudeSessions++;
    }
  }
  const totalTokens = totalUserTokens + totalAssistantTokens;
  const dailyMap = /* @__PURE__ */ new Map();
  for (const m of allMetrics) {
    const date = m.updatedAt.slice(0, 10);
    let entry = dailyMap.get(date);
    if (!entry) {
      entry = { date, sessionCount: 0, promptCount: 0, tokenCount: 0 };
      dailyMap.set(date, entry);
    }
    entry.sessionCount++;
    entry.promptCount += m.userMessageCount;
    entry.tokenCount += m.totalTokens;
  }
  const dailyActivity = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const projectMap = /* @__PURE__ */ new Map();
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const m = allMetrics[i];
    const key = session.workspacePath ?? session.workspaceId;
    let entry = projectMap.get(key);
    if (!entry) {
      entry = { workspacePath: key, sessionCount: 0, promptCount: 0, tokenCount: 0 };
      projectMap.set(key, entry);
    }
    entry.sessionCount++;
    entry.promptCount += m.userMessageCount;
    entry.tokenCount += m.totalTokens;
  }
  const projectActivity = [...projectMap.values()].sort((a, b) => b.tokenCount - a.tokenCount);
  const termFreq = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    for (const msg of session.messages) {
      if (msg.role !== "user") {
        continue;
      }
      const words = msg.content.split(/\s+/).filter(Boolean);
      for (const raw of words) {
        const word = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (word.length < 3) {
          continue;
        }
        if (STOP_WORDS.has(word)) {
          continue;
        }
        termFreq.set(word, (termFreq.get(word) ?? 0) + 1);
      }
    }
  }
  const topTerms = [...termFreq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([term, count]) => ({ term, count }));
  const longestByMessages = [...allMetrics].sort((a, b) => b.totalMessageCount - a.totalMessageCount).slice(0, 10);
  const longestByTokens = [...allMetrics].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10);
  let oldestDate = "";
  let newestDate = "";
  let timeSpanDays = 0;
  if (dailyActivity.length > 0) {
    oldestDate = dailyActivity[0].date;
    newestDate = dailyActivity[dailyActivity.length - 1].date;
    const msPerDay = 864e5;
    timeSpanDays = Math.round(
      (new Date(newestDate).getTime() - new Date(oldestDate).getTime()) / msPerDay
    ) + 1;
  }
  return {
    totalSessions: sessions.length,
    totalPrompts,
    totalResponses,
    totalUserTokens,
    totalAssistantTokens,
    totalTokens,
    copilotSessions,
    claudeSessions,
    dailyActivity,
    projectActivity,
    topTerms,
    longestByMessages,
    longestByTokens,
    oldestDate,
    newestDate,
    timeSpanDays
  };
}

// src/analytics/tokenCounter.ts
function countTokens(text, source) {
  if (!text) {
    return 0;
  }
  if (source === "claude") {
    return Math.ceil(text.length / 4);
  }
  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
  return Math.ceil(wordCount * 1.3);
}

// src/analytics/analyticsPanel.ts
var AnalyticsPanel = class _AnalyticsPanel {
  static _panel;
  static show(context, index) {
    if (_AnalyticsPanel._panel) {
      _AnalyticsPanel._panel.reveal(vscode10.ViewColumn.One);
      void _AnalyticsPanel._panel.webview.postMessage({
        type: "update",
        data: _AnalyticsPanel.build(index)
      });
      return;
    }
    const panel = vscode10.window.createWebviewPanel(
      "chatwizardAnalytics",
      "Chat Analytics",
      vscode10.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );
    _AnalyticsPanel._panel = panel;
    panel.webview.html = _AnalyticsPanel.getShellHtml();
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "ready" && _AnalyticsPanel._panel) {
        setImmediate(() => {
          if (_AnalyticsPanel._panel) {
            void _AnalyticsPanel._panel.webview.postMessage({
              type: "update",
              data: _AnalyticsPanel.build(index)
            });
          }
        });
      } else if (msg.command === "openSession" && msg.sessionId) {
        void vscode10.commands.executeCommand("chatwizard.openSession", { id: msg.sessionId });
      } else if (msg.command === "openSettings") {
        void vscode10.commands.executeCommand("workbench.action.openSettings", "chatwizard");
      } else if (msg.command === "rescan") {
        void vscode10.commands.executeCommand("chatwizard.rescan");
      }
    }, void 0, context.subscriptions);
    panel.onDidDispose(() => {
      _AnalyticsPanel._panel = void 0;
    }, null, context.subscriptions);
  }
  static refresh(index) {
    if (!_AnalyticsPanel._panel) {
      return;
    }
    void _AnalyticsPanel._panel.webview.postMessage({
      type: "update",
      data: _AnalyticsPanel.build(index)
    });
  }
  static build(index) {
    const allSessions = index.getAllSummaries().map((s) => index.get(s.id)).filter((s) => s !== null);
    return computeAnalytics(allSessions, countTokens);
  }
  static _escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  static getShellHtml() {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline';">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    ${cwThemeCss()}
    * { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 0 0 40px 0;
      line-height: 1.5;
    }

    h2 {
      font-size: 1em;
      font-weight: 600;
      margin: 0 0 12px 0;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.35));
      opacity: 0.85;
    }

    .section {
      padding: 18px 20px;
      border-bottom: 1px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.2));
    }

    /* -- Summary cards -- */
    .summary-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }

    .summary-card {
      flex: 1 1 130px;
      min-width: 100px;
      background: var(--cw-surface-raised);
      border: 1px solid var(--cw-border);
      border-radius: var(--cw-radius);
      box-shadow: var(--cw-shadow);
      padding: 12px 14px;
      text-align: center;
    }

    .summary-value {
      font-size: 1.5em;
      font-weight: 700;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--cw-accent);
      line-height: 1.2;
    }

    .summary-label {
      font-size: 0.82em;
      opacity: 0.7;
      margin-top: 4px;
    }

    .summary-sub {
      font-size: 0.75em;
      opacity: 0.5;
      margin-top: 2px;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    /* -- Chart containers -- */
    .chart-container {
      position: relative;
      width: 100%;
    }

    /* -- Tables -- */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92em;
    }

    .data-table th {
      text-align: left;
      padding: 5px 10px;
      background: var(--cw-surface-subtle);
      border-bottom: 2px solid var(--cw-border-strong);
      font-weight: 600;
      white-space: nowrap;
      opacity: 0.85;
    }

    .data-table th.num,
    .data-table td.num {
      text-align: right;
    }

    .data-table td {
      padding: 5px 10px;
      border-bottom: 1px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.15));
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .data-table tr:last-child td {
      border-bottom: none;
    }

    .data-table tr:hover td {
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
    }

    .data-table tr[data-sid] {
      cursor: pointer;
    }

    .empty-state {
      text-align: center;
      opacity: 0.5;
      font-style: italic;
      padding: 20px 16px;
    }

    .empty-state-guided {
      text-align: center;
      padding: 40px 20px;
    }

    .empty-state-guided .empty-state-title {
      font-size: 1.05em;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .empty-state-guided .empty-state-body {
      opacity: 0.6;
      margin-bottom: 16px;
      font-size: 0.92em;
    }

    .empty-state-guided .empty-state-actions {
      display: flex;
      gap: 8px;
      justify-content: center;
    }

    .cw-action-btn {
      font-size: 0.85em;
      padding: 4px 14px;
      border: 1px solid var(--cw-border-strong);
      border-radius: var(--cw-radius-xs);
      cursor: pointer;
      background: var(--cw-surface-subtle);
      color: inherit;
      white-space: nowrap;
      transition: background 0.12s, color 0.12s;
    }

    .cw-action-btn:hover {
      background: var(--cw-accent);
      color: var(--cw-accent-text);
      border-color: var(--cw-accent);
    }

    .token-footnote {
      font-size: 0.78em;
      opacity: 0.5;
      padding: 12px 20px;
      margin: 0;
    }

    #freshness-bar {
      padding: 5px 20px;
      font-size: 0.78em;
      opacity: 0.55;
      border-bottom: 1px solid var(--cw-border);
      display: none;
    }

    #loading-msg {
      padding: 40px 20px;
      text-align: center;
      opacity: 0.6;
    }
  </style>
</head>
<body>

  <div id="freshness-bar"></div>

  <!-- Overview -->
  <div class="section">
    <h2>Overview</h2>
    <div class="summary-row" id="summary-row">
      <div class="summary-card sk cw-fade-item" style="--cw-i:0"><div class="cw-skeleton" style="width:28px;height:28px;border-radius:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:26px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:12px;width:72%"></div></div>
      <div class="summary-card sk cw-fade-item" style="--cw-i:1"><div class="cw-skeleton" style="width:28px;height:28px;border-radius:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:26px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:12px;width:72%"></div></div>
      <div class="summary-card sk cw-fade-item" style="--cw-i:2"><div class="cw-skeleton" style="width:28px;height:28px;border-radius:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:26px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:12px;width:72%"></div></div>
      <div class="summary-card sk cw-fade-item" style="--cw-i:3"><div class="cw-skeleton" style="width:28px;height:28px;border-radius:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:26px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:12px;width:72%"></div></div>
      <div class="summary-card sk cw-fade-item" style="--cw-i:4"><div class="cw-skeleton" style="width:28px;height:28px;border-radius:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:26px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:12px;width:72%"></div></div>
      <div class="summary-card sk cw-fade-item" style="--cw-i:5"><div class="cw-skeleton" style="width:28px;height:28px;border-radius:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:26px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:12px;width:72%"></div></div>
      <div class="summary-card sk cw-fade-item" style="--cw-i:6"><div class="cw-skeleton" style="width:28px;height:28px;border-radius:50%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:26px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:12px;width:72%"></div></div>
    </div>
  </div>

  <!-- Daily Activity -->
  <div class="section">
    <h2>Daily Activity</h2>
    <div id="activity-container"><div class="cw-skeleton" style="height:180px;width:100%;border-radius:var(--cw-radius-sm)"></div></div>
  </div>

  <!-- Top Projects -->
  <div class="section">
    <h2>Top Projects</h2>
    <table class="data-table">
      <thead>
        <tr>
          <th>Workspace</th>
          <th class="num">Sessions</th>
          <th class="num">Prompts</th>
          <th class="num">Est. Tokens *</th>
        </tr>
      </thead>
      <tbody id="projects-tbody">
        <tr><td colspan="4"><div class="cw-skeleton" style="height:14px;width:80%;margin:6px 0"></div></td></tr>
        <tr><td colspan="4"><div class="cw-skeleton" style="height:14px;width:65%;margin:6px 0"></div></td></tr>
        <tr><td colspan="4"><div class="cw-skeleton" style="height:14px;width:72%;margin:6px 0"></div></td></tr>
      </tbody>
    </table>
  </div>

  <!-- Top Terms -->
  <div class="section">
    <h2>Top Terms</h2>
    <div id="terms-container"><div class="cw-skeleton" style="height:140px;width:100%;border-radius:var(--cw-radius-sm)"></div></div>
  </div>

  <!-- Longest Sessions by Messages -->
  <div class="section">
    <h2>Longest Sessions (by Messages)</h2>
    <table class="data-table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Source</th>
          <th>Workspace</th>
          <th class="num">Messages</th>
          <th class="num">Est. Tokens *</th>
        </tr>
      </thead>
      <tbody id="by-msg-tbody">
        <tr><td colspan="5"><div class="cw-skeleton" style="height:14px;width:75%;margin:6px 0"></div></td></tr>
        <tr><td colspan="5"><div class="cw-skeleton" style="height:14px;width:60%;margin:6px 0"></div></td></tr>
        <tr><td colspan="5"><div class="cw-skeleton" style="height:14px;width:68%;margin:6px 0"></div></td></tr>
      </tbody>
    </table>
  </div>

  <!-- Longest Sessions by Tokens -->
  <div class="section">
    <h2>Longest Sessions (by Tokens)</h2>
    <table class="data-table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Source</th>
          <th>Workspace</th>
          <th class="num">Messages</th>
          <th class="num">Est. Tokens *</th>
        </tr>
      </thead>
      <tbody id="by-tok-tbody">
        <tr><td colspan="5"><div class="cw-skeleton" style="height:14px;width:80%;margin:6px 0"></div></td></tr>
        <tr><td colspan="5"><div class="cw-skeleton" style="height:14px;width:55%;margin:6px 0"></div></td></tr>
        <tr><td colspan="5"><div class="cw-skeleton" style="height:14px;width:70%;margin:6px 0"></div></td></tr>
      </tbody>
    </table>
  </div>
  <p class="token-footnote">* Token counts are estimates (Claude: characters\xF74, Copilot: words\xD71.3) and are not billing-accurate.</p>

  <script>
    ${cwInteractiveJs()}

    (function () {
      var activityChart = null;
      var termsChart = null;
      var _firstRender = true;

      function escHtml(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function getChartColors() {
        var style = getComputedStyle(document.body);
        return {
          fg:       style.getPropertyValue('--vscode-editor-foreground').trim()        || '#cccccc',
          border:   style.getPropertyValue('--vscode-textSeparator-foreground').trim() || 'rgba(128,128,128,0.3)',
          accent:   style.getPropertyValue('--cw-accent').trim()                       || '#5B8AF5',
          copilot:  style.getPropertyValue('--cw-copilot').trim()                      || '#f0883e',
        };
      }

      function renderSummary(data) {
        if (data.totalSessions === 0) {
          document.getElementById('summary-row').innerHTML =
            '<div class="empty-state-guided">'
            + '<p class="empty-state-title">No sessions indexed yet.</p>'
            + '<p class="empty-state-body">Chat Wizard reads your Claude Code and GitHub Copilot chat history. Make sure the data paths are configured correctly.</p>'
            + '<div class="empty-state-actions">'
            + '<button class="cw-action-btn" id="btn-cfg-paths">Configure Paths</button>'
            + '<button class="cw-action-btn" id="btn-rescan">Rescan</button>'
            + '</div></div>';
          document.getElementById('btn-cfg-paths').addEventListener('click', function() { vscode.postMessage({ command: 'openSettings' }); });
          document.getElementById('btn-rescan').addEventListener('click', function() { vscode.postMessage({ command: 'rescan' }); });
          return;
        }

        var timeSpanValue = data.timeSpanDays > 0
          ? data.timeSpanDays + ' day' + (data.timeSpanDays === 1 ? '' : 's')
          : '\\u2014';
        var timeSpanSub = (data.oldestDate && data.newestDate)
          ? '(' + escHtml(data.oldestDate) + ' \\u2013 ' + escHtml(data.newestDate) + ')'
          : '';

        var cards = [
          { label: 'Total Sessions',   value: data.totalSessions,   sub: '' },
          { label: 'Total Prompts',    value: data.totalPrompts,     sub: '' },
          { label: 'Total Responses',  value: data.totalResponses,   sub: '' },
          { label: 'Est. Tokens *',    value: data.totalTokens,      sub: '' },
          { label: 'Copilot Sessions', value: data.copilotSessions,  sub: '' },
          { label: 'Claude Sessions',  value: data.claudeSessions,   sub: '' },
          { label: 'Time Span',        value: timeSpanValue,         sub: timeSpanSub, noAnim: true },
        ];

        var html = cards.map(function(card, idx) {
          var valStr = typeof card.value === 'number' ? card.value.toLocaleString() : escHtml(String(card.value));
          var sub = card.sub ? '<div class="summary-sub">' + card.sub + '</div>' : '';
          return '<div class="summary-card cw-fade-item" style="--cw-i:' + idx + '">'
            + '<div class="summary-value">' + valStr + '</div>'
            + '<div class="summary-label">' + escHtml(card.label) + '</div>'
            + sub
            + '</div>';
        }).join('');

        document.getElementById('summary-row').innerHTML = html;

        // Count-up animation only on first render
        if (_firstRender) {
          document.querySelectorAll('.summary-value').forEach(function(el) {
            var raw = el.textContent.trim();
            if (!/^\\d[\\d,]*$/.test(raw)) { return; }
            var n = parseInt(raw.replace(/,/g, ''), 10);
            if (!n) { return; }
            var start = performance.now();
            (function tick(now) {
              var t    = Math.min((now - start) / 900, 1);
              var ease = 1 - Math.pow(1 - t, 4);
              el.textContent = Math.round(n * ease).toLocaleString();
              if (t < 1) { requestAnimationFrame(tick); }
              else { el.textContent = raw; }
            })(start);
          });
        }
      }

      function renderActivityChart(data) {
        var container = document.getElementById('activity-container');
        var colors = getChartColors();

        if (data.dailyActivity.length === 0) {
          if (activityChart) { activityChart.destroy(); activityChart = null; }
          container.innerHTML = '<p class="empty-state">No activity data yet.</p>';
          return;
        }

        var labels  = data.dailyActivity.map(function(d) { return d.date; });
        var tokens  = data.dailyActivity.map(function(d) { return d.tokenCount; });
        var prompts = data.dailyActivity.map(function(d) { return d.promptCount; });

        if (activityChart) {
          activityChart.data.labels = labels;
          activityChart.data.datasets[0].data = tokens;
          activityChart.data.datasets[1].data = prompts;
          activityChart.update('none');
        } else {
          container.innerHTML = '<div class="chart-container"><canvas id="activityChart"></canvas></div>';
          Chart.defaults.color       = colors.fg;
          Chart.defaults.borderColor = colors.border;
          var ctx = document.getElementById('activityChart').getContext('2d');
          activityChart = new Chart(ctx, {
            type: 'line',
            data: {
              labels: labels,
              datasets: [
                {
                  label: 'Tokens',
                  data: tokens,
                  borderColor: colors.accent,
                  backgroundColor: colors.accent.replace(')', ', 0.15)').replace('rgb', 'rgba'),
                  fill: true,
                  tension: 0.4,
                  pointRadius: 3,
                  pointHoverRadius: 5,
                  yAxisID: 'yTokens'
                },
                {
                  label: 'Prompts',
                  data: prompts,
                  borderColor: colors.copilot,
                  backgroundColor: colors.copilot.replace(')', ', 0.12)').replace('rgb', 'rgba'),
                  fill: true,
                  tension: 0.4,
                  pointRadius: 3,
                  pointHoverRadius: 5,
                  yAxisID: 'yPrompts'
                }
              ]
            },
            options: {
              responsive: true,
              maintainAspectRatio: true,
              animation: { duration: 1200, easing: 'easeOutQuart' },
              interaction: { mode: 'index', intersect: false },
              plugins: { legend: { position: 'top' } },
              scales: {
                x: { ticks: { maxTicksLimit: 12, maxRotation: 45 } },
                yTokens: {
                  type: 'linear', position: 'left', beginAtZero: true,
                  title: { display: true, text: 'Tokens' }
                },
                yPrompts: {
                  type: 'linear', position: 'right', beginAtZero: true,
                  title: { display: true, text: 'Prompts' },
                  grid: { drawOnChartArea: false }
                }
              }
            }
          });
        }
      }

      function renderProjectsTable(data) {
        var topProjects = data.projectActivity.slice().sort(function(a, b) {
          return b.tokenCount - a.tokenCount;
        }).slice(0, 10);

        var html;
        if (topProjects.length === 0) {
          html = '<tr><td colspan="4" class="empty-state">No project data.</td></tr>';
        } else {
          html = topProjects.map(function(p) {
            var wsName = p.workspacePath
              ? (p.workspacePath.replace(/\\\\/g, '/').split('/').pop() || p.workspacePath)
              : '(unknown)';
            return '<tr>'
              + '<td title="' + escHtml(p.workspacePath) + '">' + escHtml(wsName) + '</td>'
              + '<td class="num">' + p.sessionCount.toLocaleString() + '</td>'
              + '<td class="num">' + p.promptCount.toLocaleString() + '</td>'
              + '<td class="num">' + p.tokenCount.toLocaleString() + '</td>'
              + '</tr>';
          }).join('');
        }
        document.getElementById('projects-tbody').innerHTML = html;
      }

      function renderTermsChart(data) {
        var container = document.getElementById('terms-container');
        var topTerms = data.topTerms.slice(0, 20);
        var colors = getChartColors();

        if (topTerms.length === 0) {
          if (termsChart) { termsChart.destroy(); termsChart = null; }
          container.innerHTML = '<p class="empty-state">No term data yet.</p>';
          return;
        }

        var labels = topTerms.map(function(t) { return t.term; });
        var counts = topTerms.map(function(t) { return t.count; });
        var h = Math.max(180, topTerms.length * 24);

        if (termsChart) {
          termsChart.data.labels = labels;
          termsChart.data.datasets[0].data = counts;
          termsChart.update('none');
        } else {
          container.innerHTML = '<div class="chart-container" style="height:' + h + 'px"><canvas id="termsChart"></canvas></div>';
          var ctx = document.getElementById('termsChart').getContext('2d');
          termsChart = new Chart(ctx, {
            type: 'bar',
            data: {
              labels: labels,
              datasets: [{
                label: 'Count',
                data: counts,
                backgroundColor: colors.accent.replace(')', ', 0.65)').replace('rgb', 'rgba'),
                borderColor:     colors.accent,
                borderWidth: 1,
                borderRadius: 3
              }]
            },
            options: {
              indexAxis: 'y',
              responsive: true,
              maintainAspectRatio: false,
              animation: { duration: 900, easing: 'easeOutQuart' },
              plugins: { legend: { display: false } },
              scales: { x: { beginAtZero: true } }
            }
          });
        }
      }

      function renderSessionTable(tbodyId, sessions, colspan) {
        var rows;
        if (sessions.length === 0) {
          rows = '<tr><td colspan="' + colspan + '" class="empty-state">No sessions.</td></tr>';
        } else {
          rows = sessions.slice(0, 10).map(function(s) {
            var ws = s.workspacePath
              ? (s.workspacePath.replace(/\\\\/g, '/').split('/').pop() || '')
              : '';
            var srcBadge = s.sessionSource === 'copilot'
              ? '<span class="cw-badge-copilot">Copilot</span>'
              : '<span class="cw-badge-claude">Claude</span>';
            return '<tr data-sid="' + escHtml(s.sessionId) + '" title="Click to open session">'
              + '<td title="' + escHtml(s.sessionId) + '">' + escHtml(s.sessionTitle) + '</td>'
              + '<td>' + srcBadge + '</td>'
              + '<td title="' + escHtml(s.workspacePath || '') + '">' + escHtml(ws) + '</td>'
              + '<td class="num">' + s.totalMessageCount.toLocaleString() + '</td>'
              + '<td class="num">' + s.totalTokens.toLocaleString() + '</td>'
              + '</tr>';
          }).join('');
        }
        document.getElementById(tbodyId).innerHTML = rows;
      }

      function renderAll(data) {
        renderSummary(data);
        renderActivityChart(data);
        renderProjectsTable(data);
        renderTermsChart(data);
        renderSessionTable('by-msg-tbody', data.longestByMessages, 5);
        renderSessionTable('by-tok-tbody', data.longestByTokens, 5);
        _firstRender = false;

        // Freshness bar
        var fb = document.getElementById('freshness-bar');
        if (fb && data.totalSessions > 0) {
          fb.style.display = '';
          fb.textContent = data.totalSessions.toLocaleString() + ' session' + (data.totalSessions === 1 ? '' : 's') + ' indexed \xB7 Updated ' + new Date().toLocaleTimeString();
        }
      }

      // Chart.js ResizeObserver doesn't reliably fire when a VS Code panel expands
      // (the canvas itself sets the min-size, blocking the observer). Calling resize()
      // explicitly on window.resize fixes the expand-direction blind spot.
      var _resizeTimer = null;
      window.addEventListener('resize', function() {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(function() {
          if (activityChart) { activityChart.resize(); }
          if (termsChart) { termsChart.resize(); }
        }, 50);
      });

      var vscode = acquireVsCodeApi();

      // Session row click-through
      document.addEventListener('click', function(e) {
        var row = e.target && e.target.closest ? e.target.closest('tr[data-sid]') : null;
        if (row && row.dataset.sid) {
          vscode.postMessage({ command: 'openSession', sessionId: row.dataset.sid });
        }
      });

      window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg && msg.type === 'update') {
          renderAll(msg.data);
        }
      });

      // Signal ready to extension host
      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
  }
  /** @deprecated */
  static getHtml(_data) {
    return _AnalyticsPanel.getShellHtml();
  }
};

// src/analytics/analyticsViewProvider.ts
var vscode11 = __toESM(require("vscode"));
var AnalyticsViewProvider = class {
  constructor(_index) {
    this._index = _index;
  }
  static viewType = "chatwizardAnalytics";
  _view;
  _refreshTimer = null;
  resolveWebviewView(webviewView, _context, _token) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = AnalyticsPanel.getShellHtml();
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "ready") {
        this._sendData();
      } else if (msg.command === "openSession" && msg.sessionId) {
        void vscode11.commands.executeCommand("chatwizard.openSession", { id: msg.sessionId });
      }
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._sendData();
      }
    });
  }
  /** Re-render the view when the session index changes. Debounced 5 s. No-op if not visible. */
  refresh() {
    if (!this._view?.visible) {
      return;
    }
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
    }
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      if (this._view?.visible) {
        this._sendData();
      }
    }, 5e3);
  }
  _sendData() {
    if (!this._view) {
      return;
    }
    setImmediate(() => {
      if (this._view?.visible) {
        void this._view.webview.postMessage({
          type: "update",
          data: AnalyticsPanel.build(this._index)
        });
      }
    });
  }
};

// src/analytics/modelUsageEngine.ts
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function normalizeWsKey(raw) {
  return raw.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function computeModelUsage(summaries, from, to) {
  const fromStr = toDateStr(from);
  const toStr = toDateStr(to);
  const modelMap = /* @__PURE__ */ new Map();
  let totalSessions = 0;
  let totalUserRequests = 0;
  for (const s of summaries) {
    const dateStr = s.updatedAt.slice(0, 10);
    if (dateStr < fromStr || dateStr > toStr) {
      continue;
    }
    const model = friendlyModelName(s.model);
    let entry = modelMap.get(model);
    if (!entry) {
      entry = { sources: /* @__PURE__ */ new Set(), model, sessionCount: 0, userRequests: 0, wsMap: /* @__PURE__ */ new Map(), sessionMap: /* @__PURE__ */ new Map(), sourceMap: /* @__PURE__ */ new Map() };
      modelMap.set(model, entry);
    }
    entry.sources.add(s.source);
    entry.sessionCount++;
    entry.userRequests += s.userMessageCount;
    totalSessions++;
    totalUserRequests += s.userMessageCount;
    const rawWs = s.workspacePath ?? s.workspaceId;
    const wsKey = normalizeWsKey(rawWs);
    let wsEntry = entry.wsMap.get(wsKey);
    if (!wsEntry) {
      wsEntry = { displayPath: rawWs, total: 0, assistantMap: /* @__PURE__ */ new Map() };
      entry.wsMap.set(wsKey, wsEntry);
    }
    wsEntry.total += s.userMessageCount;
    wsEntry.assistantMap.set(s.source, (wsEntry.assistantMap.get(s.source) ?? 0) + s.userMessageCount);
    const prevSess = entry.sessionMap.get(s.id);
    if (prevSess) {
      prevSess.userRequests += s.userMessageCount;
    } else {
      entry.sessionMap.set(s.id, { title: s.title, userRequests: s.userMessageCount });
    }
    let srcEntry = entry.sourceMap.get(s.source);
    if (!srcEntry) {
      srcEntry = { sessionCount: 0, userRequests: 0, sessionMap: /* @__PURE__ */ new Map() };
      entry.sourceMap.set(s.source, srcEntry);
    }
    srcEntry.sessionCount++;
    srcEntry.userRequests += s.userMessageCount;
    const prevSrcSess = srcEntry.sessionMap.get(s.id);
    if (prevSrcSess) {
      prevSrcSess.userRequests += s.userMessageCount;
    } else {
      srcEntry.sessionMap.set(s.id, { title: s.title, userRequests: s.userMessageCount });
    }
  }
  const models = [...modelMap.values()].map((e) => {
    const workspaceBreakdown = [...e.wsMap.values()].map((ws) => {
      const assistantBreakdown = [...ws.assistantMap.entries()].map(([assistant, userRequests]) => ({ assistant, userRequests })).sort((a, b) => b.userRequests - a.userRequests);
      return { workspace: ws.displayPath, userRequests: ws.total, assistantBreakdown };
    }).sort((a, b) => b.userRequests - a.userRequests);
    const sessionBreakdown = [...e.sessionMap.entries()].map(([sessionId, v]) => ({ sessionId, sessionTitle: v.title, userRequests: v.userRequests })).sort((a, b) => b.userRequests - a.userRequests);
    const sourceBreakdown = [...e.sourceMap.entries()].map(([source, sv]) => ({
      source,
      sessionCount: sv.sessionCount,
      userRequests: sv.userRequests,
      percentage: totalUserRequests === 0 ? 0 : Math.round(sv.userRequests / totalUserRequests * 1e4) / 100,
      sessionBreakdown: [...sv.sessionMap.entries()].map(([sessionId, v]) => ({ sessionId, sessionTitle: v.title, userRequests: v.userRequests })).sort((a, b) => b.userRequests - a.userRequests)
    })).sort((a, b) => b.userRequests - a.userRequests);
    return {
      model: e.model,
      sources: [...e.sources],
      sessionCount: e.sessionCount,
      userRequests: e.userRequests,
      percentage: totalUserRequests === 0 ? 0 : Math.round(e.userRequests / totalUserRequests * 1e4) / 100,
      workspaceBreakdown,
      sessionBreakdown,
      sourceBreakdown
    };
  }).sort((a, b) => b.userRequests - a.userRequests);
  return { from: fromStr, to: toStr, totalSessions, totalUserRequests, models };
}

// src/analytics/modelUsageViewProvider.ts
function toIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function defaultDateRange() {
  const now = /* @__PURE__ */ new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { from, to };
}
var ModelUsageViewProvider = class {
  constructor(_context, _index) {
    this._context = _context;
    this._index = _index;
    const listener = _index.addTypedChangeListener(() => {
      this._scheduleRefresh();
    });
    _context.subscriptions.push(listener);
  }
  static viewType = "chatwizardModelUsage";
  _view;
  _dateRange = defaultDateRange();
  _refreshTimer = null;
  resolveWebviewView(webviewView, _context, _token) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getShellHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "ready") {
        this._sendUpdate(webviewView);
      } else if (msg.type === "setDateRange") {
        this._handleSetDateRange(msg.from, msg.to, webviewView);
      } else if (msg.type === "openSession" && msg.sessionId) {
        const session = this._index.get(msg.sessionId);
        if (session) {
          void SessionWebviewPanel.show(this._context, session);
        }
      }
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._sendUpdate(webviewView);
      }
    });
  }
  _handleSetDateRange(fromStr, toStr, view) {
    if (!fromStr || !toStr) {
      return;
    }
    const from = new Date(fromStr);
    const to = new Date(toStr);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return;
    }
    this._dateRange = from <= to ? { from, to } : { from: to, to: from };
    this._sendUpdate(view);
  }
  _scheduleRefresh() {
    if (!this._view?.visible) {
      return;
    }
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
    }
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      if (this._view?.visible) {
        this._sendUpdate(this._view);
      }
    }, 500);
  }
  _sendUpdate(view) {
    const summaries = this._index.getAllSummaries();
    const data = computeModelUsage(summaries, this._dateRange.from, this._dateRange.to);
    void view.webview.postMessage({
      type: "update",
      data,
      dateRange: { from: toIsoDate(this._dateRange.from), to: toIsoDate(this._dateRange.to) }
    });
  }
  getShellHtml(_webview) {
    const defaultRange = defaultDateRange();
    const fromStr = toIsoDate(defaultRange.from);
    const toStr = toIsoDate(defaultRange.to);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline';">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <title>Model Usage</title>
  <style>
    ${cwThemeCss()}
    * { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 0 0 32px 0;
      line-height: 1.5;
    }

    /* -- Date-range row ------------------------------------------ */
    .date-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--cw-border);
      background: var(--cw-surface);
    }

    .date-row label {
      font-size: 0.82em;
      opacity: 0.7;
      white-space: nowrap;
    }

    .date-row input[type="date"] {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 0.85em;
      background: var(--cw-surface-raised);
      color: var(--vscode-editor-foreground);
      border: 1px solid var(--cw-border-strong);
      border-radius: var(--cw-radius-xs);
      padding: 2px 6px;
      cursor: pointer;
    }

    .date-row input[type="date"]:focus {
      outline: 1px solid var(--cw-accent);
      border-color: var(--cw-accent);
    }

    .presets {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      margin-left: auto;
    }

    /* -- Content sections ----------------------------------------- */
    .section {
      padding: 14px 16px;
      border-bottom: 1px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.2));
    }

    h2 {
      font-size: 0.95em;
      font-weight: 600;
      margin: 0 0 10px 0;
      padding-bottom: 5px;
      border-bottom: 1px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.35));
      opacity: 0.85;
    }

    .chart-container {
      position: relative;
      width: 100%;
    }

    .empty-state {
      text-align: center;
      opacity: 0.5;
      font-style: italic;
      padding: 20px 8px;
    }

    /* -- Summary table -------------------------------------------- */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9em;
    }

    .data-table th {
      text-align: left;
      padding: 5px 8px;
      background: var(--cw-surface-subtle);
      border-bottom: 2px solid var(--cw-border-strong);
      font-weight: 600;
      white-space: nowrap;
      opacity: 0.85;
    }

    .data-table th.num,
    .data-table td.num { text-align: right; }

    .data-table td {
      padding: 5px 8px;
      border-bottom: 1px solid var(--vscode-textSeparator-foreground, rgba(128,128,128,0.15));
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 200px;
    }

    .data-table tr:last-child td { border-bottom: none; }

    .data-table tfoot td {
      font-weight: 700;
      border-top: 2px solid var(--cw-border-strong);
      background: var(--cw-surface-subtle);
    }

    .data-table tbody tr[data-sessions]:hover {
      background: var(--cw-surface-raised);
      cursor: default;
    }

    .data-table td.model-sub {
      opacity: 0.55;
      font-size: 0.9em;
    }

    /* -- Shared overlay base -------------------------------------- */
    #session-overlay,
    #chart-overlay {
      position: fixed;
      z-index: 9999;
      background: var(--vscode-menu-background, #252526);
      border: 1px solid var(--vscode-menu-border, #454545);
      border-radius: 5px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      display: none;
      max-width: 420px;
      max-height: calc(100vh - 80px);
      overflow-y: auto;
      font-size: 0.88em;
    }

    /* -- Session hover overlay ------------------------------------ */
    #session-overlay {
      padding: 8px 0;
      min-width: 280px;
    }

    /* -- Chart bar tooltip overlay -------------------------------- */
    #chart-overlay {
      padding: 0;
      min-width: 220px;
    }

    .co-header {
      padding: 7px 14px 6px 14px;
      font-weight: 600;
      border-bottom: 1px solid var(--vscode-menu-border, #454545);
    }

    .co-ws-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 5px 14px 2px 14px;
      font-weight: 600;
    }

    .co-ws-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .co-ws-count { flex-shrink: 0; }

    .co-asst-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 1px 14px 1px 26px;
      opacity: 0.8;
      font-size: 0.93em;
    }

    .co-asst-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .co-asst-count { flex-shrink: 0; }

    .co-asst-pct {
      opacity: 0.6;
      font-size: 0.9em;
    }

    .session-overlay-item {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 5px 14px;
      cursor: pointer;
      color: var(--vscode-menu-foreground, inherit);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .session-overlay-item:hover {
      background: var(--vscode-menu-selectionBackground, #094771);
      color: var(--vscode-menu-selectionForeground, #fff);
    }

    .session-overlay-item:hover .sess-link {
      color: var(--vscode-menu-selectionForeground, #fff);
    }

    .sess-idx {
      opacity: 0.5;
      font-size: 0.85em;
      min-width: 18px;
      text-align: right;
      flex-shrink: 0;
    }

    .sess-req {
      color: var(--cw-accent);
      font-weight: 600;
      flex-shrink: 0;
    }

    .sess-link {
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--vscode-editor-foreground);
      text-decoration: none;
      flex: 1;
    }

    /* -- Account section headings --------------------------------- */
    .account-section { display: none; } /* shown by JS when data exists */

    .account-heading {
      display: flex;
      align-items: center;
      gap: 7px;
    }

    .sel-total {
      display: none;
      margin-left: auto;
      font-size: 0.83em;
      font-weight: 600;
      color: var(--cw-accent);
      white-space: nowrap;
      letter-spacing: 0.01em;
    }

    /* -- Loading -------------------------------------------------- */
    /* -- Spinner -------------------------------------------------- */
    @keyframes cw-spin { to { transform: rotate(360deg); } }

    .cw-spinner {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid var(--cw-border-strong);
      border-top-color: var(--cw-accent, #5b8af5);
      border-radius: 50%;
      animation: cw-spin 0.7s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }

    #loading-msg {
      padding: 32px 16px;
      text-align: center;
      opacity: 0.75;
    }

    #main-content { display: none; }
  </style>
</head>
<body>

<div id="loading-msg"><span class="cw-spinner"></span>Loading\u2026</div>

<div id="main-content">
  <!-- Date range controls -->
  <div class="date-row">
    <label for="from-input">From</label>
    <input type="date" id="from-input" value="${fromStr}">
    <label for="to-input">To</label>
    <input type="date" id="to-input" value="${toStr}">
    <div class="presets">
      <button class="cw-btn" id="btn-this-month">This Month</button>
      <button class="cw-btn" id="btn-last-30">Last 30 Days</button>
      <button class="cw-btn" id="btn-last-3m">Last 3 Months</button>
      <button class="cw-btn" id="btn-all-time">All Time</button>
    </div>
  </div>

  <!-- Claude models section -->
  <div class="section account-section" id="section-claude">
    <h2 class="account-heading">
      <span class="cw-badge-claude">Claude</span> models
      <span class="sel-total" id="sel-total-claude"></span>
    </h2>
    <div id="chart-claude"></div>
  </div>

  <!-- Other models section -->
  <div class="section account-section" id="section-copilot">
    <h2 class="account-heading">
      <span class="cw-badge-copilot">Other</span> models
      <span class="sel-total" id="sel-total-copilot"></span>
    </h2>
    <div id="chart-copilot"></div>
  </div>

  <!-- Combined summary table -->
  <div class="section">
    <h2>Summary</h2>
    <table class="data-table">
      <thead>
        <tr>
          <th>Provider</th>
          <th>Model</th>
          <th>Coding Assistant</th>
          <th class="num">Sessions</th>
          <th class="num">Requests</th>
          <th class="num">% of Total</th>
        </tr>
      </thead>
      <tbody id="summary-tbody"></tbody>
      <tfoot id="summary-tfoot"></tfoot>
    </table>
  </div>
</div>

<!-- Session breakdown overlay -->
<div id="session-overlay"></div>

<!-- Chart bar tooltip overlay -->
<div id="chart-overlay"></div>

<script>
(function() {
  var vscode = acquireVsCodeApi();
  var charts = { claude: null, copilot: null };
  // Tooltip lookup maps \u2014 mutated in-place so existing Chart.js closures always read latest data
  var tooltipMaps = {
    claude:  { pct: {}, ws: {}, total: 0 },
    copilot: { pct: {}, ws: {}, total: 0 }
  };
  // Bar selection state \u2014 cleared on data update
  var selectedBars   = { claude: {}, copilot: {} }; // model \u2192 true
  var requestCounts  = { claude: {}, copilot: {} }; // model \u2192 userRequests (refreshed per update)

  // -- Helpers ---------------------------------------------------
  function toIsoDate(d) {
    return d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var ACCOUNT_LABEL = { claude: 'Claude', copilot: 'GitHub Copilot' };

  // Deterministic hue from string, shifted toward account base hue
  var ACCOUNT_BASE_HUE = { claude: 270, copilot: 30 }; // purple / orange
  function modelColor(name, source, alpha) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) {
      hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }
    var base = ACCOUNT_BASE_HUE[source] || 200;
    var hue = (base + (hash % 60) - 30 + 360) % 360; // \xB130\xB0 around account base
    return 'hsla(' + hue + ', 65%, 58%, ' + (alpha || 1) + ')';
  }

  function updateSelectionDisplay(source) {
    var sel = selectedBars[source];
    var keys = Object.keys(sel);
    var el = document.getElementById('sel-total-' + source);
    if (!el) { return; }
    if (keys.length === 0) { el.style.display = 'none'; return; }
    var total = 0;
    keys.forEach(function(m) { total += requestCounts[source][m] || 0; });
    el.style.display = 'inline';
    el.textContent = 'Total requests: ' + total.toLocaleString();
  }

  function getChartColors() {
    var style = getComputedStyle(document.body);
    return {
      fg:     style.getPropertyValue('--vscode-editor-foreground').trim() || '#cccccc',
      border: style.getPropertyValue('--vscode-textSeparator-foreground').trim() || 'rgba(128,128,128,0.3)',
    };
  }

  // -- Posting date range ----------------------------------------
  function sendDateRange() {
    var from = document.getElementById('from-input').value;
    var to   = document.getElementById('to-input').value;
    if (from && to) {
      vscode.postMessage({ type: 'setDateRange', from: from, to: to });
    }
  }

  document.getElementById('from-input').addEventListener('change', sendDateRange);
  document.getElementById('to-input').addEventListener('change', sendDateRange);

  // -- Preset buttons --------------------------------------------
  document.getElementById('btn-this-month').addEventListener('click', function() {
    var now = new Date();
    document.getElementById('from-input').value = toIsoDate(new Date(now.getFullYear(), now.getMonth(), 1));
    document.getElementById('to-input').value   = toIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    sendDateRange();
  });

  document.getElementById('btn-last-30').addEventListener('click', function() {
    var to = new Date();
    document.getElementById('from-input').value = toIsoDate(new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000));
    document.getElementById('to-input').value   = toIsoDate(to);
    sendDateRange();
  });

  document.getElementById('btn-last-3m').addEventListener('click', function() {
    var to = new Date();
    document.getElementById('from-input').value = toIsoDate(new Date(to.getFullYear(), to.getMonth() - 3, to.getDate()));
    document.getElementById('to-input').value   = toIsoDate(to);
    sendDateRange();
  });

  document.getElementById('btn-all-time').addEventListener('click', function() {
    document.getElementById('from-input').value = '2000-01-01';
    document.getElementById('to-input').value   = '2099-12-31';
    sendDateRange();
  });

  // -- Render one account chart ----------------------------------
  function renderAccountChart(source, models, totalUserRequests) {
    var containerId = 'chart-' + source;
    var sectionId   = 'section-' + source;
    var canvasId    = 'canvas-' + source;
    var container   = document.getElementById(containerId);
    var section     = document.getElementById(sectionId);

    if (models.length === 0) {
      if (charts[source]) { charts[source].destroy(); charts[source] = null; }
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    var labels   = models.map(function(m) { return m.model; });
    var counts   = models.map(function(m) { return m.userRequests; });
    var bgColors = models.map(function(m) { return modelColor(m.model, source, 0.65); });
    var bdColors = models.map(function(m) { return modelColor(m.model, source, 1); });
    var h = Math.max(80, models.length * 32);

    // Always refresh tooltip maps in-place so existing closures stay current
    var tm = tooltipMaps[source];
    for (var k in tm.pct) { delete tm.pct[k]; }
    for (var k in tm.ws)  { delete tm.ws[k]; }
    tm.total = totalUserRequests;
    models.forEach(function(m) {
      tm.pct[m.model] = m.percentage;
      tm.ws[m.model]  = m.workspaceBreakdown || [];
    });

    // Refresh request counts; reset selection (data changed, stale selection would mislead)
    requestCounts[source] = {};
    models.forEach(function(m) { requestCounts[source][m.model] = m.userRequests; });
    selectedBars[source] = {};
    updateSelectionDisplay(source);

    if (charts[source]) {
      charts[source].data.labels = labels;
      charts[source].data.datasets[0].data = counts;
      charts[source].data.datasets[0].backgroundColor = bgColors;
      charts[source].data.datasets[0].borderColor = bdColors;
      charts[source].update('none');
      // Resize container height if model count changed
      var wrap = container.querySelector('.chart-container');
      if (wrap) { wrap.style.height = h + 'px'; }
    } else {
      container.innerHTML = '<div class="chart-container" style="height:' + h + 'px"><canvas id="' + canvasId + '"></canvas></div>';
      var chartColors = getChartColors();
      Chart.defaults.color       = chartColors.fg;
      Chart.defaults.borderColor = chartColors.border;
      var ctx = document.getElementById(canvasId).getContext('2d');
      charts[source] = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: 'User Requests',
            data: counts,
            backgroundColor: bgColors,
            borderColor: bdColors,
            borderWidth: 1,
            borderRadius: 3
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 600, easing: 'easeOutQuart' },
          onClick: function(evt, elements) {
            if (!elements || !elements.length) { return; }
            var idx = elements[0].index;
            var modelName = charts[source].data.labels[idx];
            if (!modelName) { return; }
            var sel = selectedBars[source];
            if (sel[modelName]) { delete sel[modelName]; } else { sel[modelName] = true; }
            var anySelected = Object.keys(sel).length > 0;
            charts[source].data.datasets[0].backgroundColor = charts[source].data.labels.map(function(m) {
              if (!anySelected) { return modelColor(m, source, 0.65); }
              return sel[m] ? modelColor(m, source, 0.9) : modelColor(m, source, 0.2);
            });
            charts[source].update('none');
            updateSelectionDisplay(source);
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: false,
              external: function(context) {
                var tooltipModel = context.tooltip;
                if (tooltipModel.opacity === 0 || !tooltipModel.dataPoints || !tooltipModel.dataPoints.length) {
                  if (!isChartOverlayHovered) { scheduleHideChartOverlay(); }
                  return;
                }
                cancelHideChartOverlay();
                var modelName = tooltipModel.dataPoints[0].label;
                var tm = tooltipMaps[source];
                var count = tooltipModel.dataPoints[0].parsed.x;
                var pct = tm.pct[modelName] !== undefined ? tm.pct[modelName] : 0;
                var ws = tm.ws[modelName] || [];

                var html = '<div class="co-header">' + escHtml(modelName) + '<br>'
                  + count.toLocaleString() + ' requests (' + pct + '% of total)</div>';
                ws.forEach(function(w) {
                  var norm = w.workspace.split(String.fromCharCode(92)).join('/');
                  var parts = norm.split('/').filter(Boolean);
                  var display = parts.length > 0 ? parts[parts.length - 1] : w.workspace;
                  html += '<div class="co-ws-row"><span class="co-ws-name" title="' + escHtml(w.workspace) + '">'
                    + escHtml(display) + '</span><span class="co-ws-count">' + w.userRequests.toLocaleString() + '</span></div>';
                  if (w.assistantBreakdown && w.assistantBreakdown.length > 0) {
                    var grandTotal = tm.total || 1;
                    w.assistantBreakdown.forEach(function(a) {
                      var label = ASST_LABEL[a.assistant] || a.assistant;
                      var pctOfTotal = (a.userRequests / grandTotal * 100).toFixed(1);
                      html += '<div class="co-asst-row"><span class="co-asst-name">\u2514 ' + escHtml(label)
                        + '</span><span class="co-asst-count">' + a.userRequests.toLocaleString()
                        + ' <span class="co-asst-pct">(' + pctOfTotal + '%)</span></span></div>';
                    });
                  }
                });
                chartOverlay.innerHTML = html;

                var canvasRect = context.chart.canvas.getBoundingClientRect();
                var top  = canvasRect.top  + window.scrollY + tooltipModel.caretY;
                var left = canvasRect.left + window.scrollX + tooltipModel.caretX + 12;
                chartOverlay.style.display = 'block';
                chartOverlay.style.left = '0';
                chartOverlay.style.top  = '0';
                var ow = chartOverlay.offsetWidth;
                var oh = chartOverlay.offsetHeight;
                if (left + ow > window.innerWidth - 8) { left = Math.max(4, canvasRect.left + window.scrollX + tooltipModel.caretX - ow - 8); }
                if (top  + oh > window.innerHeight + window.scrollY - 8) { top = Math.max(0, window.innerHeight + window.scrollY - oh - 8); }
                chartOverlay.style.left = left + 'px';
                chartOverlay.style.top  = top  + 'px';
              }
            }
          },
          scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
        }
      });
    }
  }

  // -- Render combined table -------------------------------------
  function renderTable(data) {
    var tbody = document.getElementById('summary-tbody');
    var tfoot = document.getElementById('summary-tfoot');

    if (data.models.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No data for selected range.</td></tr>';
      tfoot.innerHTML = '';
      return;
    }

    // Group rows: Claude models first, then others; within each sorted by userRequests desc (already sorted)
    var claudeRows = data.models.filter(function(m) { return m.model.startsWith('Claude'); });
    var otherRows  = data.models.filter(function(m) { return !m.model.startsWith('Claude'); });

    function accountBadge(model) {
      return model.startsWith('Claude')
        ? '<span class="cw-badge-claude">Claude</span>'
        : '<span class="cw-badge-copilot">Other</span>';
    }

    function makeRows(rows) {
      return rows.map(function(m) {
        var badge = accountBadge(m.model);
        // One row per contributing assistant (sourceBreakdown), or fall back to single row
        var srcRows = (m.sourceBreakdown && m.sourceBreakdown.length > 0)
          ? m.sourceBreakdown
          : [{ source: (m.sources || [])[0] || '', sessionCount: m.sessionCount, userRequests: m.userRequests, percentage: m.percentage, sessionBreakdown: m.sessionBreakdown || [] }];

        return srcRows.map(function(sr, si) {
          var sessData = sr.sessionBreakdown && sr.sessionBreakdown.length > 0
            ? escHtml(JSON.stringify(sr.sessionBreakdown)) : '';
          var asstLabel = ASST_LABEL[sr.source] || sr.source;
          // Show provider badge and model name only on the first source row for this model
          var providerCell = si === 0 ? '<td>' + badge + '</td>' : '<td></td>';
          var modelCell    = si === 0
            ? '<td title="' + escHtml(m.model) + '">' + escHtml(m.model) + '</td>'
            : '<td class="model-sub" title="' + escHtml(m.model) + '">' + escHtml(m.model) + '</td>';
          return '<tr' + (sessData ? ' data-sessions="' + sessData + '"' : '') + '>'
            + providerCell
            + modelCell
            + '<td title="' + escHtml(asstLabel) + '">' + escHtml(asstLabel) + '</td>'
            + '<td class="num">' + sr.sessionCount.toLocaleString() + '</td>'
            + '<td class="num">' + sr.userRequests.toLocaleString() + '</td>'
            + '<td class="num">' + sr.percentage.toFixed(2) + '%</td>'
            + '</tr>';
        }).join('');
      }).join('');
    }

    tbody.innerHTML = makeRows(claudeRows) + makeRows(otherRows);

    tfoot.innerHTML = '<tr>'
      + '<td colspan="3"><strong>Total</strong></td>'
      + '<td class="num"><strong>' + data.totalSessions.toLocaleString() + '</strong></td>'
      + '<td class="num"><strong>' + data.totalUserRequests.toLocaleString() + '</strong></td>'
      + '<td class="num"><strong>100%</strong></td>'
      + '</tr>';
  }

  // -- Chart bar tooltip overlay ---------------------------------
  var chartOverlay = document.getElementById('chart-overlay');
  var chartOverlayHideTimer = null;
  var isChartOverlayHovered = false;

  function hideChartOverlay() {
    chartOverlay.style.display = 'none';
    chartOverlay.innerHTML = '';
  }

  function scheduleHideChartOverlay() {
    if (chartOverlayHideTimer) { clearTimeout(chartOverlayHideTimer); }
    chartOverlayHideTimer = setTimeout(hideChartOverlay, 400);
  }

  function cancelHideChartOverlay() {
    if (chartOverlayHideTimer) { clearTimeout(chartOverlayHideTimer); chartOverlayHideTimer = null; }
  }

  chartOverlay.addEventListener('mouseenter', function() {
    isChartOverlayHovered = true;
    cancelHideChartOverlay();
  });
  chartOverlay.addEventListener('mouseleave', function() {
    isChartOverlayHovered = false;
    scheduleHideChartOverlay();
  });

  // -- Session hover overlay -------------------------------------
  var overlay = document.getElementById('session-overlay');
  var overlayHideTimer = null;

  var ASST_LABEL = {
    claude: 'Claude Code', copilot: 'GitHub Copilot', cline: 'Cline',
    roocode: 'Roo Code', cursor: 'Cursor', windsurf: 'Windsurf', aider: 'Aider'
  };

  function showOverlay(sessions, anchorRect) {
    if (!sessions || sessions.length === 0) { return; }
    var html = '';
    sessions.forEach(function(s, i) {
      html += '<div class="session-overlay-item" data-session-id="' + escHtml(s.sessionId) + '">'
        + '<span class="sess-idx">' + (i + 1) + '.</span>'
        + '<span class="sess-req">Requests: ' + s.userRequests + '</span>'
        + '<span class="sess-link" title="' + escHtml(s.sessionTitle) + '">' + escHtml(s.sessionTitle) + '</span>'
        + '</div>';
    });
    overlay.innerHTML = html;

    // Position: prefer below-left of the row, flip if off-screen
    var top = anchorRect.bottom + window.scrollY + 2;
    var left = anchorRect.left + window.scrollX;
    overlay.style.display = 'block';
    overlay.style.left = '0';
    overlay.style.top = '0';

    var ow = overlay.offsetWidth;
    var oh = overlay.offsetHeight;
    if (left + ow > window.innerWidth) { left = Math.max(0, window.innerWidth - ow - 8); }
    if (top + oh > window.innerHeight + window.scrollY) { top = anchorRect.top + window.scrollY - oh - 2; }
    overlay.style.left = left + 'px';
    overlay.style.top  = top  + 'px';
  }

  function hideOverlay() {
    overlay.style.display = 'none';
    overlay.innerHTML = '';
  }

  function scheduleHide() {
    if (overlayHideTimer) { clearTimeout(overlayHideTimer); }
    overlayHideTimer = setTimeout(hideOverlay, 400);
  }

  function cancelHide() {
    if (overlayHideTimer) { clearTimeout(overlayHideTimer); overlayHideTimer = null; }
  }

  document.getElementById('summary-tbody').addEventListener('mouseover', function(e) {
    var tr = e.target.closest('tr[data-sessions]');
    if (!tr) { scheduleHide(); return; }
    cancelHide();
    try {
      var sessions = JSON.parse(tr.getAttribute('data-sessions'));
      showOverlay(sessions, tr.getBoundingClientRect());
    } catch (err) { /* ignore */ }
  });

  document.getElementById('summary-tbody').addEventListener('mouseleave', function() {
    scheduleHide();
  });

  overlay.addEventListener('mouseenter', cancelHide);
  overlay.addEventListener('mouseleave', scheduleHide);

  overlay.addEventListener('click', function(e) {
    var item = e.target.closest('.session-overlay-item');
    if (!item) { return; }
    var sid = item.getAttribute('data-session-id');
    if (sid) { vscode.postMessage({ type: 'openSession', sessionId: sid }); }
  });

  // -- Message handler -------------------------------------------
  window.addEventListener('message', function(e) {
    var msg = e.data;
    if (msg.type !== 'update') { return; }

    document.getElementById('loading-msg').style.display = 'none';
    document.getElementById('main-content').style.display = 'block';

    if (msg.dateRange) {
      document.getElementById('from-input').value = msg.dateRange.from;
      document.getElementById('to-input').value   = msg.dateRange.to;
    }

    var claudeModels = msg.data.models.filter(function(m) { return m.model.startsWith('Claude'); });
    var otherModels  = msg.data.models.filter(function(m) { return !m.model.startsWith('Claude'); });

    renderAccountChart('claude',  claudeModels, msg.data.totalUserRequests);
    renderAccountChart('copilot', otherModels,  msg.data.totalUserRequests);
    renderTable(msg.data);
  });

  // -- Ready signal ----------------------------------------------
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
};

// src/timeline/timelineViewProvider.ts
var vscode12 = __toESM(require("vscode"));

// src/timeline/timelineBuilder.ts
function extractWorkspaceName(workspacePath) {
  if (!workspacePath) {
    return "";
  }
  const normalized = workspacePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? "";
}
function extractMessageText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text") {
        const text = block.text;
        if (typeof text === "string") {
          return text;
        }
      }
    }
  }
  return "";
}
function buildTimeline(sessions, options) {
  const entries = [];
  for (const session of sessions) {
    if (session.messages.length === 0) {
      continue;
    }
    const timestamp = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
    const resolvedTimestamp = isNaN(timestamp) ? 0 : timestamp;
    let date;
    if (!session.updatedAt || isNaN(timestamp)) {
      date = "1970-01-01";
    } else {
      date = new Date(timestamp).toISOString().slice(0, 10);
    }
    if (date === "1970-01-01") {
      continue;
    }
    const workspacePath = session.workspacePath ?? "";
    const workspaceName = extractWorkspaceName(session.workspacePath);
    let firstPrompt = "";
    for (const msg of session.messages) {
      const role = msg.role;
      if (role === "user" || role === "human") {
        const raw = extractMessageText(msg.content).trim();
        firstPrompt = raw.length > 150 ? raw.slice(0, 150) + "\u2026" : raw;
        break;
      }
    }
    let promptCount = 0;
    for (const msg of session.messages) {
      const role = msg.role;
      if (role === "user" || role === "human") {
        promptCount++;
      }
    }
    entries.push({
      sessionId: session.id,
      sessionTitle: session.title,
      source: session.source,
      workspacePath,
      workspaceName,
      date,
      timestamp: resolvedTimestamp,
      firstPrompt,
      messageCount: session.messages.length,
      promptCount
    });
  }
  entries.sort((a, b) => b.timestamp - a.timestamp);
  const SWITCH_WINDOW_MS = 30 * 60 * 1e3;
  for (let i = 0; i < entries.length - 1; i++) {
    const newer = entries[i];
    const older = entries[i + 1];
    if (newer.source !== older.source && newer.timestamp - older.timestamp < SWITCH_WINDOW_MS) {
      newer.toolSwitchHighlight = true;
    }
  }
  let result = entries;
  if (options?.before !== void 0) {
    const cutoff = options.before.getTime();
    result = result.filter((e) => e.timestamp < cutoff);
  }
  if (options?.monthCount !== void 0) {
    const seenMonths = /* @__PURE__ */ new Set();
    const limited = [];
    for (const entry of result) {
      const ym = entry.date.slice(0, 7);
      seenMonths.add(ym);
      if (seenMonths.size > options.monthCount) {
        break;
      }
      limited.push(entry);
    }
    result = limited;
  }
  return result;
}

// src/timeline/timelineFeatures.ts
var STOP_WORDS2 = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "to",
  "of",
  "in",
  "and",
  "for",
  "is",
  "it",
  "that",
  "this",
  "with",
  "on",
  "i",
  "you",
  "we",
  "how",
  "do",
  "can",
  "my",
  "me",
  "what",
  "why",
  "get",
  "when",
  "are",
  "was",
  "be",
  "have",
  "as",
  "at",
  "by",
  "not",
  "but",
  "or",
  "if",
  "so",
  "up",
  "use",
  "let",
  "make",
  "add",
  "all",
  "into",
  "from",
  "more",
  "will",
  "your",
  "like",
  "just",
  "one",
  "its",
  "has",
  "their",
  "about",
  "than",
  "then",
  "there",
  "also",
  "any",
  "which",
  "who",
  "he",
  "she",
  "they",
  "him",
  "her",
  "our",
  "am",
  "im",
  "using",
  "used",
  "want",
  "need",
  "help",
  "try",
  "please",
  "sure",
  "okay",
  "yes",
  "no",
  "ok",
  "hi",
  "hey",
  "new",
  "now",
  "see",
  "work"
]);
function getISOWeekKey(ts) {
  const d = new Date(ts);
  const day = d.getUTCDay() || 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}
function buildHeatMap(entries, today = /* @__PURE__ */ new Date()) {
  if (entries.length === 0) {
    return [];
  }
  const countByDate = /* @__PURE__ */ new Map();
  for (const e of entries) {
    countByDate.set(e.date, (countByDate.get(e.date) ?? 0) + 1);
  }
  const todayStr = today.toISOString().slice(0, 10);
  let minDate = todayStr;
  for (const date of countByDate.keys()) {
    if (date < minDate) {
      minDate = date;
    }
  }
  const cells = [];
  const cursor = /* @__PURE__ */ new Date(minDate + "T00:00:00Z");
  const end = /* @__PURE__ */ new Date(todayStr + "T00:00:00Z");
  while (cursor <= end) {
    const dateStr = cursor.toISOString().slice(0, 10);
    cells.push({ date: dateStr, count: countByDate.get(dateStr) ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return cells;
}
var BURST_GAP_MS = 2 * 60 * 60 * 1e3;
function buildWorkBursts(entries) {
  if (entries.length === 0) {
    return [];
  }
  const oldestFirst = [...entries].reverse();
  const bursts = [];
  let burstEntries = [oldestFirst[0]];
  for (let i = 1; i < oldestFirst.length; i++) {
    const prev = burstEntries[burstEntries.length - 1];
    const curr = oldestFirst[i];
    if (curr.timestamp - prev.timestamp <= BURST_GAP_MS) {
      burstEntries.push(curr);
    } else {
      bursts.push(makeBurst(burstEntries));
      burstEntries = [curr];
    }
  }
  bursts.push(makeBurst(burstEntries));
  bursts.reverse();
  return bursts;
}
function makeBurst(entries) {
  const startTs = entries[0].timestamp;
  const endTs = entries[entries.length - 1].timestamp;
  const durationMinutes = Math.round((endTs - startTs) / 6e4);
  const sources = [...new Set(entries.map((e) => e.source))];
  const totalMessages = entries.reduce((s, e) => s + e.messageCount, 0);
  return {
    burstId: `burst-${startTs}`,
    date: entries[0].date,
    startTimestamp: startTs,
    endTimestamp: endTs,
    durationMinutes,
    sessionIds: entries.map((e) => e.sessionId),
    sources,
    totalMessages,
    sessionCount: entries.length
  };
}
function buildTopicDrift(entries) {
  if (entries.length === 0) {
    return [];
  }
  const weekMap = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const wk = getISOWeekKey(entry.timestamp);
    if (!weekMap.has(wk)) {
      weekMap.set(wk, /* @__PURE__ */ new Map());
    }
    const freqMap = weekMap.get(wk);
    const words = entry.firstPrompt.toLowerCase().split(/[\s\W]+/).filter((w) => w.length >= 3 && !STOP_WORDS2.has(w));
    for (const w of words) {
      freqMap.set(w, (freqMap.get(w) ?? 0) + 1);
    }
  }
  const result = [];
  for (const [weekKey, freqMap] of weekMap) {
    const sorted = [...freqMap.entries()].sort((a, b) => b[1] - a[1]);
    result.push({ weekKey, terms: sorted.slice(0, 3).map(([t]) => t) });
  }
  result.sort((a, b) => a.weekKey < b.weekKey ? -1 : a.weekKey > b.weekKey ? 1 : 0);
  return result;
}
function buildTimelineStats(entries, today = /* @__PURE__ */ new Date()) {
  const totalSessions = entries.length;
  const todayStr = today.toISOString().slice(0, 10);
  const occupiedDates = new Set(entries.map((e) => e.date));
  const dayOfWeek = today.getUTCDay() || 7;
  let activeDaysThisWeek = 0;
  for (let d = 0; d < 7; d++) {
    const offset = d - (dayOfWeek - 1);
    const candidate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
    const candidateStr = candidate.toISOString().slice(0, 10);
    if (candidateStr <= todayStr && occupiedDates.has(candidateStr)) {
      activeDaysThisWeek++;
    }
  }
  let currentStreak = 0;
  const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  while (true) {
    const dateStr = cursor.toISOString().slice(0, 10);
    if (!occupiedDates.has(dateStr)) {
      break;
    }
    currentStreak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  const sortedDates = [...occupiedDates].sort();
  let longestStreak = 0;
  let run = 0;
  for (let i = 0; i < sortedDates.length; i++) {
    if (i === 0) {
      run = 1;
    } else {
      const prev = /* @__PURE__ */ new Date(sortedDates[i - 1] + "T00:00:00Z");
      prev.setUTCDate(prev.getUTCDate() + 1);
      if (prev.toISOString().slice(0, 10) === sortedDates[i]) {
        run++;
      } else {
        run = 1;
      }
    }
    if (run > longestStreak) {
      longestStreak = run;
    }
  }
  const targetDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, today.getUTCDate()));
  const expectedMonth = today.getUTCMonth() === 0 ? 11 : today.getUTCMonth() - 1;
  let onThisDayLastMonth = [];
  if (targetDate.getUTCMonth() === expectedMonth) {
    const targetStr = targetDate.toISOString().slice(0, 10);
    onThisDayLastMonth = entries.filter((e) => e.date === targetStr);
  }
  return { activeDaysThisWeek, totalSessions, currentStreak, longestStreak, onThisDayLastMonth };
}
function findFirstMatchingEntry(entries, query) {
  if (!query) {
    return void 0;
  }
  const q = query.toLowerCase();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.sessionTitle.toLowerCase().includes(q) || e.firstPrompt.toLowerCase().includes(q)) {
      return e;
    }
  }
  return void 0;
}

// src/timeline/timelineViewProvider.ts
var INITIAL_MONTHS = 3;
var LOAD_MORE_MONTHS = 3;
var HEATMAP_MAX_DAYS = 364;
var TimelineViewProvider = class _TimelineViewProvider {
  constructor(_index, _context) {
    this._index = _index;
    this._context = _context;
  }
  static viewType = "chatwizardTimeline";
  _view;
  _filter = {};
  /** Full unfiltered timeline (for jump-to-month dropdown). */
  _allEntries = [];
  /** Filtered timeline (source of truth for pagination). */
  _allFilteredEntries = [];
  /** YYYY-MM keys of months whose entries have been sent to the webview. */
  _loadedMonthKeys = /* @__PURE__ */ new Set();
  // Feature caches
  _stats = null;
  _heatMap = [];
  _bursts = [];
  _topicDrift = [];
  _dayFilter = void 0;
  _searchQuery = "";
  _firstMatchId = void 0;
  resolveWebviewView(webviewView, _context, _token) {
    webviewView.webview.options = { enableScripts: true };
    this._view = webviewView;
    webviewView.webview.html = _TimelineViewProvider.getShellHtml();
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.command === "openSession") {
        void vscode12.commands.executeCommand("chatwizard.openSession", { id: msg.sessionId });
      } else if (msg.command === "setFilter") {
        this._filter = msg.filter ?? {};
        this._dayFilter = void 0;
        this._sendInitial();
      } else if (msg.command === "loadMore") {
        this._sendMore();
      } else if (msg.command === "jumpToMonth") {
        this._sendMore(msg.month);
      } else if (msg.command === "openSettings") {
        void vscode12.commands.executeCommand("workbench.action.openSettings", "chatwizard");
      } else if (msg.command === "filterByDay") {
        this._dayFilter = msg.date || void 0;
        this._sendInitial();
      } else if (msg.command === "clearDayFilter") {
        this._dayFilter = void 0;
        this._sendInitial();
      } else if (msg.command === "setSearchQuery") {
        this._searchQuery = (msg.query ?? "").toLowerCase().trim();
        if (this._searchQuery) {
          const match = findFirstMatchingEntry(this._allFilteredEntries, this._searchQuery);
          this._firstMatchId = match?.sessionId;
        } else {
          this._firstMatchId = void 0;
        }
        void this._view?.webview.postMessage({
          type: "searchResult",
          data: { firstMatchId: this._firstMatchId, query: this._searchQuery }
        });
      } else if (msg.command === "saveNote") {
        void this._setJournalNote(msg.date, msg.note ?? "");
      } else if (msg.type === "ready") {
        this._sendInitial();
      }
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._sendInitial();
      }
    });
  }
  /** Re-render the view when the session index changes. No-op if the view is not visible. */
  refresh() {
    if (this._view?.visible) {
      this._sendInitial();
    }
  }
  // ── Journal note helpers ─────────────────────────────────────────────────
  _getJournalNotes() {
    return this._context.globalState.get("cwJournalNotes", {});
  }
  async _setJournalNote(date, note) {
    const notes = this._getJournalNotes();
    if (note.trim() === "") {
      delete notes[date];
    } else {
      notes[date] = note.trim();
    }
    await this._context.globalState.update("cwJournalNotes", notes);
    void this._view?.webview.postMessage({ type: "noteUpdate", data: { date, note: note.trim() } });
  }
  // ── Pagination helpers ───────────────────────────────────────────────────
  _rebuildCache() {
    const sessions = this._index.getAllSummaries().map((s) => this._index.get(s.id)).filter(Boolean);
    this._allEntries = buildTimeline(sessions);
    const base = this._allEntries.filter((entry) => {
      if (this._filter.source !== void 0 && entry.source !== this._filter.source) {
        return false;
      }
      return true;
    });
    this._stats = buildTimelineStats(base);
    this._heatMap = buildHeatMap(base).slice(-HEATMAP_MAX_DAYS);
    this._bursts = buildWorkBursts(base);
    this._topicDrift = buildTopicDrift(base);
    if (this._dayFilter) {
      this._allFilteredEntries = base.filter((e) => e.date === this._dayFilter);
    } else {
      this._allFilteredEntries = base;
    }
    this._loadedMonthKeys = /* @__PURE__ */ new Set();
  }
  /**
   * Advance the loaded window by `monthCount` new months (or until `untilYm` inclusive).
   * Returns only the entries in the newly loaded months; mutates `_loadedMonthKeys`.
   */
  _sliceNextMonths(monthCount, untilYm) {
    const result = [];
    const newMonths = /* @__PURE__ */ new Set();
    for (const entry of this._allFilteredEntries) {
      const ym = entry.date.slice(0, 7);
      if (this._loadedMonthKeys.has(ym)) {
        continue;
      }
      if (untilYm === void 0 && !newMonths.has(ym) && newMonths.size >= monthCount) {
        break;
      }
      if (untilYm !== void 0 && ym < untilYm) {
        break;
      }
      newMonths.add(ym);
      result.push(entry);
    }
    for (const ym of newMonths) {
      this._loadedMonthKeys.add(ym);
    }
    return result;
  }
  _hasMore() {
    return this._allFilteredEntries.some((e) => !this._loadedMonthKeys.has(e.date.slice(0, 7)));
  }
  _burstsForEntries(entries) {
    const entryIds = new Set(entries.map((e) => e.sessionId));
    return this._bursts.filter((b) => b.sessionIds.some((sid) => entryIds.has(sid)));
  }
  // ── Send helpers ─────────────────────────────────────────────────────────
  /** Full reset + initial 3 months. */
  _sendInitial() {
    if (!this._view) {
      return;
    }
    this._rebuildCache();
    const entries = this._sliceNextMonths(INITIAL_MONTHS);
    const totalCount = this._index.getAllSummaries().length;
    void this._view.webview.postMessage({
      type: "update",
      data: {
        entries,
        filter: this._filter,
        allEntries: this._allEntries,
        hasMore: this._hasMore(),
        totalCount,
        stats: this._stats,
        heatMap: this._heatMap,
        topicDrift: this._topicDrift,
        bursts: this._burstsForEntries(entries),
        journalNotes: this._getJournalNotes(),
        dayFilter: this._dayFilter,
        firstMatchId: this._firstMatchId
      }
    });
  }
  /** Load the next batch (or up to `untilYm`) and send as `appendMonths`. */
  _sendMore(untilYm) {
    if (!this._view) {
      return;
    }
    const entries = this._sliceNextMonths(LOAD_MORE_MONTHS, untilYm);
    if (entries.length === 0) {
      return;
    }
    void this._view.webview.postMessage({
      type: "appendMonths",
      data: {
        entries,
        hasMore: this._hasMore(),
        scrollToMonth: untilYm,
        bursts: this._burstsForEntries(entries),
        journalNotes: this._getJournalNotes()
      }
    });
  }
  static getShellHtml() {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <style>
    ${cwThemeCss()}
    * { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
      padding: 0;
      line-height: 1.5;
    }

    :focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }

    .filter-bar {
      position: sticky;
      top: 0;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--cw-border);
      background: var(--cw-surface);
      z-index: 10;
    }

    .filter-bar select {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
      padding: 3px 6px;
      border-radius: 3px;
      font-size: 0.85em;
      font-family: inherit;
    }

    .filter-bar label {
      font-size: 0.82em;
      opacity: 0.7;
    }

    /* \u2500\u2500 Stats banner \u2500\u2500 */
    #stats-banner {
      display: none;
      flex-wrap: wrap;
      gap: 12px;
      padding: 7px 14px;
      border-bottom: 1px solid var(--cw-border);
      font-size: 0.8em;
    }
    .stat-chip { opacity: 0.65; }
    .stat-chip strong { opacity: 1; color: var(--cw-accent); }

    /* \u2500\u2500 On-this-day callout \u2500\u2500 */
    #on-this-day {
      display: none;
      padding: 6px 14px;
      border-left: 3px solid var(--cw-accent);
      margin: 6px 10px;
      font-size: 0.82em;
      background: var(--cw-surface-raised);
      border-radius: 0 var(--cw-radius-sm) var(--cw-radius-sm) 0;
    }

    /* \u2500\u2500 Topic drift ribbon \u2500\u2500 */
    #drift-ribbon {
      display: none;
      overflow-x: auto;
      padding: 4px 10px;
      border-bottom: 1px solid var(--cw-border);
      font-size: 0.73em;
      white-space: nowrap;
    }
    .drift-week {
      display: inline-block;
      padding: 2px 8px;
      border-right: 1px solid var(--cw-border);
      opacity: 0.6;
    }
    .drift-week:last-child { border-right: none; }
    .drift-week-label { font-weight: 700; color: var(--cw-accent); margin-right: 4px; }

    /* \u2500\u2500 Heat map \u2500\u2500 */
    #heatmap-section {
      display: none;
      padding: 8px 14px 4px;
      border-bottom: 1px solid var(--cw-border);
    }
    #heatmap-container {
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
      line-height: 0;
    }
    .hm-cell {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      cursor: pointer;
      background: var(--cw-border);
    }
    .hm-cell[data-intensity="1"] { background: color-mix(in srgb, var(--cw-accent) 25%, transparent); }
    .hm-cell[data-intensity="2"] { background: color-mix(in srgb, var(--cw-accent) 50%, transparent); }
    .hm-cell[data-intensity="3"] { background: color-mix(in srgb, var(--cw-accent) 75%, transparent); }
    .hm-cell[data-intensity="4"] { background: var(--cw-accent); }
    .hm-cell.hm-selected { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
    #day-filter-bar {
      display: none;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      font-size: 0.8em;
    }

    /* \u2500\u2500 Search bar \u2500\u2500 */
    #search-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-bottom: 1px solid var(--cw-border);
    }
    #tl-search {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
      padding: 3px 7px;
      border-radius: 3px;
      font-family: inherit;
      font-size: 0.85em;
    }
    #tl-search-status { font-size: 0.78em; opacity: 0.6; white-space: nowrap; }
    .entry.tl-first-match { outline: 2px solid var(--cw-accent); outline-offset: 2px; }

    /* \u2500\u2500 Freshness bar \u2500\u2500 */
    #freshness-bar {
      padding: 4px 14px;
      font-size: 0.78em;
      opacity: 0.55;
      border-bottom: 1px solid var(--cw-border);
      display: none;
    }

    /* \u2500\u2500 Month groups \u2500\u2500 */
    .month-group { margin: 0; }

    .month-header {
      font-size: 0.78em;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--cw-accent);
      padding: 10px 14px 4px;
      position: sticky;
      top: 41px;
      background: var(--vscode-editor-background);
      z-index: 5;
      border-bottom: 1px solid var(--cw-border);
    }

    /* \u2500\u2500 Work burst \u2500\u2500 */
    .burst-header {
      margin: 8px 10px 2px;
      padding: 5px 14px;
      background: var(--cw-surface);
      border: 1px solid var(--cw-border-strong);
      border-radius: var(--cw-radius-sm);
      font-size: 0.78em;
      font-weight: 600;
      opacity: 0.8;
    }

    /* \u2500\u2500 Entries \u2500\u2500 */
    .entry {
      margin: 5px 10px;
      padding: 9px 14px;
      border-radius: var(--cw-radius);
      border: 1px solid var(--cw-border);
      background: var(--cw-surface-raised);
      box-shadow: var(--cw-shadow);
      cursor: pointer;
      transition: box-shadow 0.14s, background 0.14s, transform 0.14s, border-color 0.14s;
    }

    .entry:hover {
      background:   var(--cw-surface-subtle);
      box-shadow:   var(--cw-shadow-hover);
      transform:    translateY(-2px);
      border-color: var(--cw-border-strong);
    }

    .entry.entry-in-burst { margin-left: 18px; }

    .entry.tool-switch-highlight {
      border-color: var(--cw-accent);
      background: color-mix(in srgb, var(--cw-accent) 6%, var(--cw-surface-raised));
    }

    .entry-title {
      font-weight: 600;
      font-size: 0.93em;
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .entry-meta {
      font-size: 0.78em;
      opacity: 0.55;
      margin-bottom: 3px;
    }

    .entry-prompt {
      font-size: 0.85em;
      opacity: 0.75;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }

    /* \u2500\u2500 Journal notes \u2500\u2500 */
    .journal-note-area {
      font-size: 0.79em;
      padding: 2px 14px 4px;
      color: var(--cw-accent);
      font-style: italic;
      cursor: pointer;
      opacity: 0.75;
    }
    .journal-note-area:empty::before { content: '+ Add note'; opacity: 0.35; font-style: italic; }
    .journal-edit-row {
      display: flex;
      gap: 6px;
      padding: 4px 10px;
      align-items: flex-start;
    }
    .journal-edit-row textarea {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
      border-radius: 3px;
      padding: 4px 6px;
      font-family: inherit;
      font-size: 0.82em;
      resize: vertical;
      min-height: 44px;
    }

    /* \u2500\u2500 Empty / loading states \u2500\u2500 */
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      opacity: 0.5;
      font-style: italic;
    }

    .empty-state-guided { text-align: center; padding: 40px 20px; }
    .empty-state-guided .empty-state-title { font-size: 1.05em; font-weight: 600; margin-bottom: 8px; }
    .empty-state-guided .empty-state-body { opacity: 0.6; margin-bottom: 16px; font-size: 0.92em; }
    .empty-state-guided .empty-state-actions { display: flex; gap: 8px; justify-content: center; }

    .cw-btn {
      font-size: 0.85em;
      padding: 4px 14px;
      border: 1px solid var(--cw-border-strong);
      border-radius: var(--cw-radius-xs);
      cursor: pointer;
      background: var(--cw-surface-subtle);
      color: inherit;
      white-space: nowrap;
    }
    .cw-btn:hover { background: var(--cw-accent); color: var(--cw-accent-text); border-color: var(--cw-accent); }

    .load-more-btn {
      display: block;
      width: calc(100% - 20px);
      margin: 10px;
      padding: 8px;
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.12));
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
      border: 1px solid var(--cw-border);
      border-radius: var(--cw-radius);
      cursor: pointer;
      font-family: inherit;
      font-size: 0.85em;
      text-align: center;
    }

    .load-more-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.22));
    }
  </style>
</head>
<body>
  <div class="filter-bar" id="filter-bar">
    <label>Source</label>
    <select id="srcFilter" onchange="applyFilter()" aria-label="Filter by source">
      <option value="">All</option>
      <option value="copilot">Copilot</option>
      <option value="claude">Claude</option>
    </select>
    <label>Jump to</label>
    <select id="jumpDate" onchange="jumpToMonth(this.value)" aria-label="Jump to month">
      <option value="">Month&hellip;</option>
    </select>
  </div>

  <!-- Stats / streak banner -->
  <div id="stats-banner" aria-live="polite"></div>

  <!-- On-this-day callout -->
  <div id="on-this-day"></div>

  <!-- Topic drift ribbon -->
  <div id="drift-ribbon" aria-label="Topic drift by week"></div>

  <!-- Heat map -->
  <div id="heatmap-section">
    <div id="heatmap-container" role="grid" aria-label="Activity calendar"></div>
    <div id="day-filter-bar">
      Showing: <span id="day-filter-label"></span>
      <button id="clear-day-filter" class="cw-btn" style="padding:2px 8px;font-size:0.78em">Clear</button>
    </div>
  </div>

  <!-- First-occurrence search -->
  <div id="search-bar">
    <input id="tl-search" type="text" placeholder="Jump to first occurrence\u2026" aria-label="Timeline search">
    <button id="tl-search-btn" class="cw-btn">Find</button>
    <span id="tl-search-status"></span>
  </div>

  <div id="freshness-bar" aria-live="polite"></div>
  <div id="timeline-content">
    <div id="cw-tl-skeleton">
      <div style="height:10px;width:38%;margin:10px 14px 6px" class="cw-skeleton"></div>
      <div style="margin:5px 10px;padding:9px 14px;border-radius:var(--cw-radius);border:1px solid var(--cw-border);background:var(--cw-surface-raised);box-shadow:var(--cw-shadow)"><div class="cw-skeleton" style="height:13px;width:68%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:11px;width:42%;margin-bottom:5px"></div><div class="cw-skeleton" style="height:12px;width:88%"></div></div>
      <div style="margin:5px 10px;padding:9px 14px;border-radius:var(--cw-radius);border:1px solid var(--cw-border);background:var(--cw-surface-raised);box-shadow:var(--cw-shadow)"><div class="cw-skeleton" style="height:13px;width:55%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:11px;width:38%;margin-bottom:5px"></div><div class="cw-skeleton" style="height:12px;width:92%"></div></div>
      <div style="margin:5px 10px;padding:9px 14px;border-radius:var(--cw-radius);border:1px solid var(--cw-border);background:var(--cw-surface-raised);box-shadow:var(--cw-shadow)"><div class="cw-skeleton" style="height:13px;width:74%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:11px;width:44%;margin-bottom:5px"></div><div class="cw-skeleton" style="height:12px;width:78%"></div></div>
      <div style="height:10px;width:32%;margin:14px 14px 6px" class="cw-skeleton"></div>
      <div style="margin:5px 10px;padding:9px 14px;border-radius:var(--cw-radius);border:1px solid var(--cw-border);background:var(--cw-surface-raised);box-shadow:var(--cw-shadow)"><div class="cw-skeleton" style="height:13px;width:62%;margin-bottom:6px"></div><div class="cw-skeleton" style="height:11px;width:35%;margin-bottom:5px"></div><div class="cw-skeleton" style="height:12px;width:82%"></div></div>
    </div>
  </div>
  <div id="load-more-container"></div>
<script>
  ${cwInteractiveJs()}
  const vscode = acquireVsCodeApi();

  // Global burst map (updated incrementally on appendMonths)
  var globalAllSidToBurst = new Map();
  // Global journal notes (full map, refreshed on each update/appendMonths)
  var globalJournalNotes = {};

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function applyFilter() {
    const src = document.getElementById('srcFilter').value;
    vscode.postMessage({ command: 'setFilter', filter: { source: src || undefined } });
  }

  function jumpToMonth(val) {
    if (!val) { return; }
    const existing = document.querySelector('[data-month="' + val + '"]');
    if (existing) {
      const header = existing.querySelector('.month-header');
      if (header) {
        const top = header.getBoundingClientRect().top + window.scrollY - 90;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
      return;
    }
    const headers = Array.from(document.querySelectorAll('[data-month]'));
    const oldest = headers.length > 0 ? headers[headers.length - 1].dataset.month : null;
    if (oldest && val < oldest) {
      vscode.postMessage({ command: 'jumpToMonth', month: val });
      return;
    }
    const target = headers.find(function(el) { return el.dataset.month <= val; });
    if (target) {
      const header = target.querySelector('.month-header');
      if (header) {
        const top = header.getBoundingClientRect().top + window.scrollY - 90;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
  }

  function monthLabel(ym) {
    return new Date(ym + '-15').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  // \u2500\u2500 Heat map \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function hmIntensity(count, max) {
    if (count === 0 || max === 0) { return 0; }
    const pct = count / max;
    if (pct < 0.25) { return 1; }
    if (pct < 0.5)  { return 2; }
    if (pct < 0.75) { return 3; }
    return 4;
  }

  function renderHeatMap(heatMap, dayFilter) {
    const section = document.getElementById('heatmap-section');
    if (!heatMap || heatMap.length === 0) { section.style.display = 'none'; return; }
    section.style.display = '';
    const max = Math.max.apply(null, heatMap.map(function(c) { return c.count; }));
    var cells = '';
    heatMap.forEach(function(cell) {
      const intensity = hmIntensity(cell.count, max);
      const selected  = dayFilter === cell.date ? ' hm-selected' : '';
      cells += '<div class="hm-cell' + selected + '" data-date="' + escHtml(cell.date)
             + '" data-count="' + cell.count + '" data-intensity="' + intensity
             + '" role="gridcell" tabindex="0" title="' + escHtml(cell.date) + ': ' + cell.count + ' sessions"></div>';
    });
    document.getElementById('heatmap-container').innerHTML = cells;
    const filterBar = document.getElementById('day-filter-bar');
    if (dayFilter) {
      filterBar.style.display = 'flex';
      document.getElementById('day-filter-label').textContent = dayFilter;
    } else {
      filterBar.style.display = 'none';
    }
  }

  // \u2500\u2500 Stats banner \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function renderStatsBanner(stats) {
    var el = document.getElementById('stats-banner');
    if (!stats) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.innerHTML =
      '<span class="stat-chip">This week: <strong>' + stats.activeDaysThisWeek + ' day' + (stats.activeDaysThisWeek === 1 ? '' : 's') + '</strong></span>'
      + '<span class="stat-chip">Sessions: <strong>' + stats.totalSessions + '</strong></span>'
      + '<span class="stat-chip">Streak: <strong>' + stats.currentStreak + 'd</strong></span>'
      + '<span class="stat-chip">Best: <strong>' + stats.longestStreak + 'd</strong></span>';
  }

  // \u2500\u2500 On-this-day callout \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function renderOnThisDay(onThisDay) {
    var el = document.getElementById('on-this-day');
    if (!onThisDay || onThisDay.length === 0) { el.style.display = 'none'; return; }
    el.style.display = '';
    var label = onThisDay.length === 1
      ? escHtml(onThisDay[0].sessionTitle)
      : onThisDay.length + ' sessions';
    el.innerHTML = '&#128197; On this day last month: ' + label;
  }

  // \u2500\u2500 Topic drift ribbon \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function renderDriftRibbon(drift) {
    var el = document.getElementById('drift-ribbon');
    if (!drift || drift.length === 0) { el.style.display = 'none'; return; }
    el.style.display = '';
    var html = '';
    drift.forEach(function(w) {
      html += '<span class="drift-week"><span class="drift-week-label">' + escHtml(w.weekKey) + '</span>'
           + escHtml(w.terms.join(', ')) + '</span>';
    });
    el.innerHTML = html;
  }

  // \u2500\u2500 Burst map helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function updateGlobalBurstMap(bursts) {
    (bursts || []).forEach(function(b) {
      b.sessionIds.forEach(function(sid) { globalAllSidToBurst.set(sid, b); });
    });
  }

  function renderBurstHeaderHtml(burst) {
    const durText = burst.durationMinutes < 60
      ? burst.durationMinutes + 'm'
      : (burst.durationMinutes / 60).toFixed(1) + 'h';
    const srcText = burst.sources.join(' + ');
    return '<div class="burst-header">'
      + '&#9889; Work burst \xB7 ' + burst.sessionCount + ' sessions \xB7 ' + escHtml(durText)
      + ' \xB7 ' + escHtml(srcText) + '</div>';
  }

  // \u2500\u2500 Entry rendering \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function renderEntryHtml(entry, fadeIdx) {
    const fadeAttr     = fadeIdx < 25 ? ' style="--cw-i:' + fadeIdx + '"' : '';
    const sourceLabel  = entry.source === 'copilot' ? 'Copilot' : 'Claude';
    const badgeClass   = entry.source === 'copilot' ? 'cw-badge-copilot' : 'cw-badge-claude';
    const wsMeta       = entry.workspaceName || '(unknown workspace)';
    const promptText   = entry.firstPrompt   || '(no prompt)';
    const ariaLabel    = escHtml(entry.sessionTitle) + ', ' + sourceLabel + ', ' + escHtml(entry.date);
    const inBurst      = globalAllSidToBurst.has(entry.sessionId) ? ' entry-in-burst' : '';
    const switchClass  = entry.toolSwitchHighlight ? ' tool-switch-highlight' : '';
    const switchTip    = entry.toolSwitchHighlight ? ' title="Tool switch: you switched AI tools within the last 30 minutes"' : '';
    return '<div class="entry cw-fade-item' + inBurst + switchClass + '"' + fadeAttr
      + ' data-sid="' + escHtml(entry.sessionId) + '"'
      + ' role="button" tabindex="0" aria-label="' + ariaLabel + '"' + switchTip + '>'
      + '<div class="entry-title">' + escHtml(entry.sessionTitle) + '<span class="' + badgeClass + '">' + escHtml(sourceLabel) + '</span>'
      + (entry.toolSwitchHighlight ? '<span style="font-size:0.75em;opacity:0.6" title="Tool switch">&#8646;</span>' : '')
      + '</div>'
      + '<div class="entry-meta">' + escHtml(wsMeta) + ' \xB7 ' + entry.messageCount + ' messages \xB7 ' + entry.promptCount + ' prompts \xB7 ' + escHtml(entry.date) + '</div>'
      + '<div class="entry-prompt">' + escHtml(promptText) + '</div>'
      + '</div>';
  }

  // \u2500\u2500 Month group rendering \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function buildMonthGroupsHtml(entries, startFadeIdx) {
    // Group by month
    const monthMap = new Map();
    entries.forEach(function(entry) {
      const ym = entry.date.slice(0, 7);
      if (!monthMap.has(ym)) { monthMap.set(ym, new Map()); }
      const dayMap = monthMap.get(ym);
      if (!dayMap.has(entry.date)) { dayMap.set(entry.date, []); }
      dayMap.get(entry.date).push(entry);
    });

    let fadeIdx = startFadeIdx || 0;
    let html = '';

    monthMap.forEach(function(dayMap, ym) {
      let monthHtml = '<div class="month-header" id="month-' + escHtml(ym) + '">' + escHtml(monthLabel(ym)) + '</div>';

      const seenBursts = new Set();
      dayMap.forEach(function(dayEntries, date) {
        dayEntries.forEach(function(entry) {
          const burst = globalAllSidToBurst.get(entry.sessionId);
          if (burst && !seenBursts.has(burst.burstId)) {
            seenBursts.add(burst.burstId);
            monthHtml += renderBurstHeaderHtml(burst);
          }
          monthHtml += renderEntryHtml(entry, fadeIdx++);
        });
        // Journal note area for this day
        const note = (globalJournalNotes && globalJournalNotes[date]) || '';
        monthHtml += '<div class="journal-note-area" data-note-date="' + escHtml(date) + '">' + escHtml(note) + '</div>';
      });

      html += '<div class="month-group" data-month="' + escHtml(ym) + '">' + monthHtml + '</div>';
    });

    return html;
  }

  // \u2500\u2500 Load more button \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function setLoadMoreBtn(hasMore) {
    const container = document.getElementById('load-more-container');
    container.innerHTML = hasMore
      ? '<button class="load-more-btn" id="load-more-btn">Load earlier months</button>'
      : '';
    if (hasMore) {
      document.getElementById('load-more-btn').addEventListener('click', function() {
        vscode.postMessage({ command: 'loadMore' });
      });
    }
  }

  // \u2500\u2500 Workspace / jump dropdowns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function populateJumpDropdown(allEntries, currentFilter) {
    const seenYm = new Set();
    const months = [];
    allEntries.forEach(function(e) {
      const ym = e.date.slice(0, 7);
      if (currentFilter && currentFilter.source && e.source !== currentFilter.source) { return; }
      if (!seenYm.has(ym)) { seenYm.add(ym); months.push(ym); }
    });
    const sel = document.getElementById('jumpDate');
    const saved = sel.value;
    let opts = '<option value="">Month\u2026</option>';
    months.forEach(function(ym) {
      opts += '<option value="' + escHtml(ym) + '">' + escHtml(monthLabel(ym)) + '</option>';
    });
    sel.innerHTML = opts;
    if (saved && seenYm.has(saved)) { sel.value = saved; }
  }

  // \u2500\u2500 Main render functions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function renderTimeline(data) {
    const entries    = data.entries    || [];
    const filter     = data.filter     || {};
    const allEntries = data.allEntries || [];
    const scrollTop  = window.scrollY;

    // Update globals
    globalAllSidToBurst = new Map();
    updateGlobalBurstMap(data.bursts);
    globalJournalNotes = data.journalNotes || {};

    document.getElementById('srcFilter').value = filter.source || '';
    populateJumpDropdown(allEntries, filter);

    // Render new features
    renderStatsBanner(data.stats);
    renderOnThisDay(data.stats ? data.stats.onThisDayLastMonth : []);
    renderDriftRibbon(data.topicDrift);
    renderHeatMap(data.heatMap, data.dayFilter);

    // Render main feed
    const container = document.getElementById('timeline-content');
    if (entries.length === 0) {
      if (!data.totalCount) {
        container.innerHTML =
          '<div class="empty-state-guided">'
          + '<p class="empty-state-title">No sessions indexed yet.</p>'
          + '<p class="empty-state-body">Chat Wizard reads your Claude Code and GitHub Copilot chat history. Make sure the data paths are configured correctly.</p>'
          + '<div class="empty-state-actions">'
          + '<button class="cw-btn" id="btn-cfg">Configure Paths</button>'
          + '</div></div>';
        document.getElementById('btn-cfg').addEventListener('click', function() { vscode.postMessage({ command: 'openSettings' }); });
      } else {
        container.innerHTML = '<div class="empty-state">No sessions match this filter.</div>';
      }
    } else {
      container.innerHTML = buildMonthGroupsHtml(entries, 0);
    }

    setLoadMoreBtn(!!data.hasMore);
    window.scrollTo(0, scrollTop);

    // Highlight first match if present
    if (data.firstMatchId) {
      var t = document.querySelector('[data-sid="' + data.firstMatchId + '"]');
      if (t) { t.classList.add('tl-first-match'); }
    }

    if (data.totalCount) {
      var fb = document.getElementById('freshness-bar');
      fb.style.display = '';
      fb.textContent = data.totalCount.toLocaleString() + ' session' + (data.totalCount === 1 ? '' : 's') + ' indexed'
        + (data.dayFilter ? ' \xB7 Filtered to ' + data.dayFilter : '');
    }
  }

  function appendMonths(data) {
    const entries = data.entries || [];
    if (entries.length === 0) { return; }

    // Merge new burst data
    updateGlobalBurstMap(data.bursts);
    if (data.journalNotes) { globalJournalNotes = data.journalNotes; }

    const existingCount = document.querySelectorAll('.entry').length;
    const html = buildMonthGroupsHtml(entries, existingCount);

    const container = document.getElementById('timeline-content');
    container.insertAdjacentHTML('beforeend', html);

    setLoadMoreBtn(!!data.hasMore);

    if (data.scrollToMonth) {
      const target = document.getElementById('month-' + data.scrollToMonth);
      if (target) {
        const top = target.getBoundingClientRect().top + window.scrollY - 90;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
  }

  // \u2500\u2500 Search \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  function applyTimelineSearch() {
    var q = document.getElementById('tl-search').value.trim();
    vscode.postMessage({ command: 'setSearchQuery', query: q });
  }

  document.getElementById('tl-search-btn').addEventListener('click', applyTimelineSearch);
  document.getElementById('tl-search').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { applyTimelineSearch(); }
  });

  // \u2500\u2500 Click / keyboard handlers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  document.addEventListener('click', function(e) {
    // Heat map cell
    var hmCell = e.target && e.target.closest ? e.target.closest('.hm-cell') : null;
    if (hmCell) {
      vscode.postMessage({ command: 'filterByDay', date: hmCell.dataset.date });
      return;
    }

    // Clear day filter
    var clearBtn = e.target && e.target.closest ? e.target.closest('#clear-day-filter') : null;
    if (clearBtn) {
      vscode.postMessage({ command: 'clearDayFilter' });
      return;
    }

    // Journal note area \u2014 toggle edit row
    var noteArea = e.target && e.target.closest ? e.target.closest('.journal-note-area') : null;
    if (noteArea && !(noteArea.nextElementSibling && noteArea.nextElementSibling.classList.contains('journal-edit-row'))) {
      var date = noteArea.dataset.noteDate;
      var existing = noteArea.textContent;
      var editRow = document.createElement('div');
      editRow.className = 'journal-edit-row';
      var ta = document.createElement('textarea');
      ta.value = existing;
      var saveBtn = document.createElement('button');
      saveBtn.className = 'cw-btn cw-btn-save-note';
      saveBtn.textContent = 'Save';
      saveBtn.dataset.date = date;
      editRow.appendChild(ta);
      editRow.appendChild(saveBtn);
      noteArea.insertAdjacentElement('afterend', editRow);
      ta.focus();
      return;
    }

    // Save note button
    var saveNoteBtn = e.target && e.target.closest ? e.target.closest('.cw-btn-save-note') : null;
    if (saveNoteBtn) {
      var date2 = saveNoteBtn.dataset.date;
      var note = saveNoteBtn.previousElementSibling.value;
      vscode.postMessage({ command: 'saveNote', date: date2, note: note });
      saveNoteBtn.closest('.journal-edit-row').remove();
      return;
    }

    // Session entry
    var entry = e.target && e.target.closest ? e.target.closest('.entry') : null;
    if (entry && entry.dataset.sid) {
      vscode.postMessage({ command: 'openSession', sessionId: entry.dataset.sid });
    }
  });

  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter' && e.key !== ' ') { return; }
    var entry = e.target && e.target.closest ? e.target.closest('.entry') : null;
    if (entry && entry.dataset.sid) {
      e.preventDefault();
      vscode.postMessage({ command: 'openSession', sessionId: entry.dataset.sid });
    }
  });

  // \u2500\u2500 Message handler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (msg && msg.type === 'update') {
      renderTimeline(msg.data);
    } else if (msg && msg.type === 'appendMonths') {
      appendMonths(msg.data);
    } else if (msg && msg.type === 'searchResult') {
      // Remove previous highlight
      var prev = document.querySelector('.tl-first-match');
      if (prev) { prev.classList.remove('tl-first-match'); }
      var status = document.getElementById('tl-search-status');
      if (!msg.data.firstMatchId) {
        status.textContent = msg.data.query ? 'No match found' : '';
        return;
      }
      var target = document.querySelector('[data-sid="' + msg.data.firstMatchId + '"]');
      if (target) {
        target.classList.add('tl-first-match');
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        status.textContent = 'Earliest match';
      } else {
        status.textContent = '(match in unloaded months \u2014 load more)';
      }
    } else if (msg && msg.type === 'noteUpdate') {
      var noteEl = document.querySelector('[data-note-date="' + msg.data.date + '"]');
      if (noteEl) { noteEl.textContent = msg.data.note; }
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
};

// src/telemetry/telemetryRecorder.ts
var fs13 = __toESM(require("fs"));
var path16 = __toESM(require("path"));
var MAX_LOG_BYTES = 1e6;
var MAX_LOG_AGE_MS = 30 * 24 * 60 * 60 * 1e3;
var TelemetryRecorder = class {
  filePath;
  _enabled = false;
  /**
   * @param storagePath  The directory where the telemetry JSONL file will be written.
   *                     Typically `context.globalStoragePath` from the VS Code extension context.
   */
  constructor(storagePath) {
    this.filePath = path16.join(storagePath, "telemetry.jsonl");
  }
  /** Whether telemetry recording is currently enabled. */
  get enabled() {
    return this._enabled;
  }
  /** Enable or disable telemetry recording. Rotation runs when enabling. */
  setEnabled(enabled) {
    this._enabled = enabled;
    if (enabled) {
      this.rotate();
    }
  }
  /**
   * Record a telemetry event.
   * Does nothing if telemetry is disabled.
   * Swallows any filesystem errors silently.
   *
   * @param event       Event name (e.g. 'extension.activated', 'session.opened').
   * @param properties  Optional key/value properties to attach.
   */
  record(event, properties) {
    if (!this._enabled) {
      return;
    }
    const entry = {
      event,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      ...properties !== void 0 ? { properties } : {}
    };
    try {
      fs13.mkdirSync(path16.dirname(this.filePath), { recursive: true });
      fs13.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    } catch {
    }
  }
  /**
   * Read all previously recorded events from the local JSONL file.
   * Returns an empty array if the file does not exist or cannot be read.
   * Lines that fail to parse as JSON are silently skipped.
   */
  getEvents() {
    try {
      const content = fs13.readFileSync(this.filePath, "utf8");
      return content.split("\n").filter((line) => line.trim().length > 0).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }
  /**
   * Rotate the telemetry log.
   * Reads all events, discards any older than MAX_LOG_AGE_DAYS, and rewrites the file
   * when either the age limit was exceeded or the file is larger than MAX_LOG_BYTES.
   * Swallows all errors — telemetry must never crash the extension.
   *
   * SEC-8: prevents unbounded log growth and retains no data older than 30 days.
   */
  rotate() {
    try {
      let stat;
      try {
        stat = fs13.statSync(this.filePath);
      } catch {
        return;
      }
      const needsRotation = stat.size > MAX_LOG_BYTES;
      const cutoff = Date.now() - MAX_LOG_AGE_MS;
      const content = fs13.readFileSync(this.filePath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      let hadOld = false;
      const surviving = lines.filter((line) => {
        try {
          const entry = JSON.parse(line);
          if (Date.parse(entry.timestamp) < cutoff) {
            hadOld = true;
            return false;
          }
          return true;
        } catch {
          return false;
        }
      });
      if (needsRotation || hadOld || surviving.length < lines.length) {
        fs13.writeFileSync(this.filePath, surviving.map((l) => l.trim()).join("\n") + (surviving.length > 0 ? "\n" : ""), "utf8");
      }
    } catch {
    }
  }
  /**
   * Delete the telemetry file, clearing all recorded events.
   * Silently ignores errors (e.g. file not found).
   */
  clear() {
    try {
      fs13.unlinkSync(this.filePath);
    } catch {
    }
  }
  /** The full path to the telemetry JSONL file. Exposed for testing. */
  get logFilePath() {
    return this.filePath;
  }
};

// src/commands/manageWorkspaces.ts
var vscode13 = __toESM(require("vscode"));
var path17 = __toESM(require("path"));
function registerManageWorkspacesCommand(context, scopeManager, getWatcher, channel, index) {
  context.subscriptions.push(
    vscode13.commands.registerCommand("chatwizard.manageWatchedWorkspaces", async () => {
      const [copilotWs, claudeWs] = await Promise.all([
        discoverCopilotWorkspacesAsync().then(
          (list) => list.map((ws) => ({
            id: ws.workspaceId,
            source: "copilot",
            workspacePath: ws.workspacePath,
            storageDir: ws.storageDir
          }))
        ).catch(() => []),
        discoverClaudeWorkspacesAsync().catch(() => [])
      ]);
      const allAvailable = [...copilotWs, ...claudeWs];
      if (allAvailable.length === 0) {
        void vscode13.window.showInformationMessage(
          "Chat Wizard: No Copilot or Claude workspaces found to manage."
        );
        return;
      }
      const [byteCounts, diskCounts] = await Promise.all([
        Promise.all(allAvailable.map((ws) => calcWorkspaceSizeBytes(ws.storageDir, ws.source))),
        Promise.all(allAvailable.map((ws) => countWorkspaceSessions(ws.storageDir, ws.source)))
      ]);
      const byteMap = /* @__PURE__ */ new Map();
      const diskCountMap = /* @__PURE__ */ new Map();
      allAvailable.forEach((ws, i) => {
        byteMap.set(ws.id, byteCounts[i]);
        diskCountMap.set(ws.id, diskCounts[i]);
      });
      function formatSize(bytes) {
        if (bytes === 0) {
          return "0 KB";
        }
        if (bytes < 1024 * 1024) {
          return `${(bytes / 1024).toFixed(2)} KB`;
        }
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
      }
      const allSummaries = index.getAllSummaries();
      function indexCountForIds(ids) {
        const dirs = ids.map((id) => {
          const ws = allAvailable.find((w) => w.id === id);
          return path17.normalize(ws.storageDir);
        });
        return allSummaries.filter(
          (s) => dirs.some((dir) => path17.normalize(s.filePath).startsWith(dir + path17.sep))
        ).length;
      }
      const countCache = context.globalState.get("cwSessionCountCache", {});
      const updatedCache = { ...countCache };
      const pathGroups = /* @__PURE__ */ new Map();
      for (const ws of allAvailable) {
        const key = path17.normalize(ws.workspacePath).toLowerCase();
        const group = pathGroups.get(key) ?? [];
        group.push(ws);
        pathGroups.set(key, group);
      }
      const allKeys = [...pathGroups.keys()];
      for (const key of allKeys) {
        const prefix = key.endsWith(path17.sep) ? key : key + path17.sep;
        if (allKeys.some((other) => other !== key && other.startsWith(prefix))) {
          pathGroups.delete(key);
        }
      }
      const currentSelectedIds = scopeManager.getSelectedIds();
      const workspaceItems = [];
      for (const group of pathGroups.values()) {
        const representative = group[0];
        const allIds = group.map((ws) => ws.id);
        const groupBytes = allIds.reduce((sum, id) => sum + (byteMap.get(id) ?? 0), 0);
        const cacheKey = path17.normalize(representative.workspacePath).toLowerCase();
        const isSelected = allIds.some((id) => currentSelectedIds.includes(id));
        const indexCount = indexCountForIds(allIds);
        let sessionCount;
        let approx;
        if (indexCount > 0) {
          sessionCount = indexCount;
          approx = false;
          updatedCache[cacheKey] = indexCount;
        } else {
          const cached = countCache[cacheKey];
          if (cached !== void 0 && cached > 0) {
            sessionCount = cached;
            approx = false;
          } else {
            sessionCount = allIds.reduce((sum, id) => sum + (diskCountMap.get(id) ?? 0), 0);
            approx = true;
          }
        }
        const countLabel = approx ? `~${sessionCount.toLocaleString()} session${sessionCount !== 1 ? "s" : ""}` : `${sessionCount.toLocaleString()} session${sessionCount !== 1 ? "s" : ""}`;
        workspaceItems.push({
          wsIds: allIds,
          workspacePath: representative.workspacePath,
          totalBytes: groupBytes,
          sessionCount,
          sessionCountApprox: approx,
          label: path17.basename(representative.workspacePath),
          description: representative.workspacePath,
          detail: `${formatSize(groupBytes)}  \u2014  ${countLabel}`,
          picked: isSelected
        });
      }
      void context.globalState.update("cwSessionCountCache", updatedCache);
      const TITLE_BASE = "Chat Wizard: Manage Watched Workspaces";
      function makeTitle(selectedItems) {
        const bytes = selectedItems.reduce((sum, item) => sum + item.totalBytes, 0);
        const sessions = selectedItems.reduce((sum, item) => sum + item.sessionCount, 0);
        return `${TITLE_BASE}  \u2014  ${formatSize(bytes)}  /  ${sessions.toLocaleString()} session${sessions !== 1 ? "s" : ""} selected`;
      }
      const picked = await new Promise((resolve) => {
        let accepted = false;
        const initialReal = workspaceItems.filter((i) => i.picked);
        const qp = vscode13.window.createQuickPick();
        qp.canSelectMany = true;
        qp.keepScrollPosition = true;
        qp.items = workspaceItems;
        qp.selectedItems = initialReal;
        qp.title = makeTitle(initialReal);
        qp.placeholder = "Select workspaces to index";
        const openPaths = new Set(
          (vscode13.workspace.workspaceFolders ?? []).map((f) => path17.normalize(f.uri.fsPath).toLowerCase())
        );
        const currentWsItems = workspaceItems.filter(
          (item) => openPaths.has(path17.normalize(item.workspacePath).toLowerCase())
        );
        qp.onDidChangeSelection((selected) => {
          if (selected.length === 0) {
            const restore = currentWsItems.length > 0 ? currentWsItems : workspaceItems;
            setImmediate(() => {
              qp.selectedItems = restore;
              qp.title = makeTitle(restore);
            });
            return;
          }
          qp.title = makeTitle(selected);
        });
        qp.onDidAccept(() => {
          const result = [...qp.selectedItems];
          if (result.length === 0) {
            if (currentWsItems.length > 0) {
              qp.selectedItems = currentWsItems;
              qp.title = makeTitle(currentWsItems);
            } else {
              qp.title = "\u26A0 Select at least one workspace";
            }
            return;
          }
          accepted = true;
          resolve(result);
          qp.hide();
        });
        qp.onDidHide(() => {
          channel.appendLine(`[ManageWs] onDidHide accepted=${accepted}`);
          if (!accepted) {
            resolve(void 0);
          }
          qp.dispose();
        });
        qp.show();
      });
      if (picked === void 0) {
        return;
      }
      const newIds = picked.flatMap((item) => item.wsIds);
      const sortedNew = [...newIds].sort();
      const sortedCurrent = [...currentSelectedIds].sort();
      const unchanged = sortedNew.length === sortedCurrent.length && sortedNew.every((id, i) => id === sortedCurrent[i]);
      if (unchanged) {
        return;
      }
      scopeManager.setSelectedIds(newIds);
      channel.appendLine(
        `[Chat Wizard] Workspace scope updated \u2014 ${newIds.length} workspace(s) selected: ${newIds.join(", ")}`
      );
      const watcher2 = getWatcher();
      if (watcher2) {
        await watcher2.restart();
        channel.appendLine("[Chat Wizard] Watcher restarted after scope change.");
      } else {
        channel.appendLine("[Chat Wizard] Scope persisted \u2014 watcher not yet started, will use new scope on next start.");
      }
    })
  );
}

// src/extension.ts
var watcher;
async function activate(context) {
  const channel = vscode14.window.createOutputChannel("Chat Wizard");
  context.subscriptions.push(channel);
  const telemetry = new TelemetryRecorder(context.globalStorageUri.fsPath);
  const telemetryCfg = vscode14.workspace.getConfiguration("chatwizard");
  telemetry.setEnabled(telemetryCfg.get("enableTelemetry") ?? false);
  const index = new SessionIndex();
  const promptLibraryViewProvider = new PromptLibraryViewProvider(index);
  context.subscriptions.push(
    vscode14.window.registerWebviewViewProvider(PromptLibraryViewProvider.viewType, promptLibraryViewProvider)
  );
  const analyticsViewProvider = new AnalyticsViewProvider(index);
  context.subscriptions.push(
    vscode14.window.registerWebviewViewProvider(AnalyticsViewProvider.viewType, analyticsViewProvider)
  );
  const modelUsageViewProvider = new ModelUsageViewProvider(context, index);
  context.subscriptions.push(
    vscode14.window.registerWebviewViewProvider(ModelUsageViewProvider.viewType, modelUsageViewProvider)
  );
  const timelineViewProvider = new TimelineViewProvider(index, context);
  context.subscriptions.push(
    vscode14.window.registerWebviewViewProvider(TimelineViewProvider.viewType, timelineViewProvider)
  );
  context.subscriptions.push(
    vscode14.window.registerFileDecorationProvider(new SessionParseWarningDecorationProvider())
  );
  const engine = new FullTextSearchEngine();
  const searchIndexListener = index.addTypedChangeListener((event) => {
    if (event.type === "upsert") {
      engine.index(event.session);
    } else if (event.type === "remove") {
      engine.remove(event.sessionId);
    } else if (event.type === "batch") {
      for (const session of event.sessions) {
        engine.index(session);
      }
      const stats = engine.indexStats();
      channel.appendLine(
        `[Chat Wizard] Search index ready \u2014 indexed tokens: ${stats.indexedTokenCount.toLocaleString()}, hapax (single-session): ${stats.hapaxTokenCount.toLocaleString()}, postings: ${stats.postingCount.toLocaleString()}, ~${stats.memoryEstimateKB} KB`
      );
    } else if (event.type === "clear") {
      engine.clear();
    }
  });
  context.subscriptions.push(searchIndexListener);
  const codeBlockEngine = new CodeBlockSearchEngine();
  context.subscriptions.push(
    vscode14.window.registerWebviewPanelSerializer("chatwizardAnalytics", {
      async deserializeWebviewPanel(webviewPanel) {
        webviewPanel.webview.options = { enableScripts: true };
        webviewPanel.webview.html = AnalyticsPanel.getShellHtml();
        webviewPanel.onDidDispose(() => {
        }, null, context.subscriptions);
        webviewPanel.webview.onDidReceiveMessage((msg) => {
          if (msg.type === "ready") {
            void webviewPanel.webview.postMessage({ type: "update", data: AnalyticsPanel.build(index) });
          }
        }, void 0, context.subscriptions);
        void webviewPanel.webview.postMessage({ type: "update", data: AnalyticsPanel.build(index) });
      }
    })
  );
  context.subscriptions.push(
    vscode14.window.registerWebviewPanelSerializer("chatwizardCodeBlocks", {
      async deserializeWebviewPanel(webviewPanel) {
        webviewPanel.webview.options = { enableScripts: true };
        webviewPanel.webview.html = CodeBlocksPanel.getShellHtml();
        webviewPanel.onDidDispose(() => {
        }, null, context.subscriptions);
        const blocks = index.getAllCodeBlocks();
        webviewPanel.webview.onDidReceiveMessage((msg) => {
          if (msg.command === "copy") {
            void vscode14.env.clipboard.writeText(msg.text ?? "");
          } else if (msg.type === "ready") {
            void webviewPanel.webview.postMessage({ type: "update", data: CodeBlocksPanel.buildPayload(blocks, codeBlockEngine) });
          }
        }, void 0, context.subscriptions);
        void webviewPanel.webview.postMessage({ type: "update", data: CodeBlocksPanel.buildPayload(blocks, codeBlockEngine) });
      }
    })
  );
  context.subscriptions.push(
    vscode14.window.registerWebviewPanelSerializer("chatwizardPromptLibrary", {
      async deserializeWebviewPanel(webviewPanel) {
        webviewPanel.dispose();
      }
    })
  );
  context.subscriptions.push(
    vscode14.window.registerWebviewPanelSerializer("chatwizardSession3", {
      async deserializeWebviewPanel(webviewPanel) {
        webviewPanel.dispose();
      }
    })
  );
  const codeBlockProvider = new CodeBlockTreeProvider(index, codeBlockEngine);
  function makeEmptyStateMsg(noun) {
    return `No ${noun} indexed yet.

Chat Wizard reads your Claude Code and GitHub Copilot chat history. Make sure the data paths are configured correctly.`;
  }
  const codeBlockListener = index.addChangeListener(() => {
    codeBlockEngine.index(index.getAllCodeBlocks());
    CodeBlocksPanel.refresh(index, codeBlockEngine);
    codeBlockTreeView.description = codeBlockProvider.getDescription();
    codeBlockTreeView.message = index.getAllCodeBlocks().length === 0 ? makeEmptyStateMsg("code blocks") : void 0;
  });
  context.subscriptions.push(codeBlockListener);
  const promptLibraryListener = index.addChangeListener(() => {
    PromptLibraryPanel.refresh(index);
    promptLibraryViewProvider.refresh();
  });
  context.subscriptions.push(promptLibraryListener);
  const analyticsListener = index.addChangeListener(() => {
    AnalyticsPanel.refresh(index);
    analyticsViewProvider.refresh();
  });
  context.subscriptions.push(analyticsListener);
  const timelineListener = index.addChangeListener(() => {
    timelineViewProvider.refresh();
  });
  context.subscriptions.push(timelineListener);
  const provider = new SessionTreeProvider(index, context.extensionUri);
  const savedStackJson = context.globalState.get("sortStack");
  if (savedStackJson) {
    try {
      const saved = JSON.parse(savedStackJson);
      provider.restoreStack(saved);
    } catch {
    }
  }
  const savedPinnedJson = context.globalState.get("pinnedIds");
  if (savedPinnedJson) {
    try {
      provider.setPinnedIds(JSON.parse(savedPinnedJson));
    } catch {
    }
  }
  const savedManualOrderJson = context.globalState.get("manualOrder");
  if (savedManualOrderJson) {
    try {
      provider.setManualOrder(JSON.parse(savedManualOrderJson));
    } catch {
    }
  }
  function syncContext() {
    const primary = provider.getPrimary();
    void vscode14.commands.executeCommand("setContext", "chatwizard.sortKey", primary.key);
    void vscode14.commands.executeCommand("setContext", "chatwizard.sortDir", primary.direction);
    void vscode14.commands.executeCommand("setContext", "chatwizard.hasFilter", provider.hasActiveFilter());
  }
  syncContext();
  function savePins() {
    void context.globalState.update("pinnedIds", JSON.stringify(provider.getPinnedIds()));
    void context.globalState.update("manualOrder", JSON.stringify(provider.getManualOrder()));
  }
  const dragDropController = {
    dragMimeTypes: ["application/vnd.chatwizard.session"],
    dropMimeTypes: ["application/vnd.chatwizard.session"],
    handleDrag(items, dataTransfer) {
      dataTransfer.set(
        "application/vnd.chatwizard.session",
        new vscode14.DataTransferItem(items.map((i) => i.summary.id))
      );
    },
    async handleDrop(target, dataTransfer) {
      const dragged = dataTransfer.get("application/vnd.chatwizard.session");
      if (!dragged) {
        return;
      }
      const ids = dragged.value;
      provider.reorder(ids, target?.summary.id);
      treeView.description = provider.getDescription();
      provider.refresh();
      savePins();
    }
  };
  const treeView = vscode14.window.createTreeView("chatwizardSessions", {
    treeDataProvider: provider,
    dragAndDropController: dragDropController,
    canSelectMany: true
  });
  treeView.description = provider.getDescription();
  context.subscriptions.push(treeView);
  const sessionDescListener = index.addChangeListener(() => {
    treeView.description = provider.getDescription();
    treeView.message = index.size === 0 ? makeEmptyStateMsg("sessions") : void 0;
  });
  context.subscriptions.push(sessionDescListener);
  const codeBlockTreeView = vscode14.window.createTreeView("chatwizardCodeBlocks", {
    treeDataProvider: codeBlockProvider,
    canSelectMany: false
  });
  codeBlockTreeView.description = codeBlockProvider.getDescription();
  codeBlockTreeView.message = makeEmptyStateMsg("code blocks");
  context.subscriptions.push(codeBlockTreeView);
  function applySort(mode) {
    provider.setSortMode(mode);
    treeView.description = provider.getDescription();
    provider.refresh();
    syncContext();
    void context.globalState.update("sortStack", JSON.stringify(provider.getSortStack()));
  }
  function applyStack(stack) {
    provider.setSortStack(stack);
    treeView.description = provider.getDescription();
    provider.refresh();
    syncContext();
    void context.globalState.update("sortStack", JSON.stringify(provider.getSortStack()));
  }
  function syncCbContext() {
    void vscode14.commands.executeCommand("setContext", "chatwizard.cbSortKey", codeBlockProvider.getSortMode());
    void vscode14.commands.executeCommand("setContext", "chatwizard.cbSortDir", codeBlockProvider.getSortDir());
  }
  syncCbContext();
  function applyCbSort(mode) {
    codeBlockProvider.setSortMode(mode);
    codeBlockTreeView.description = codeBlockProvider.getDescription();
    codeBlockProvider.refresh();
    syncCbContext();
  }
  const sortModes = ["date", "workspace", "length", "title", "model"];
  for (const mode of sortModes) {
    context.subscriptions.push(
      vscode14.commands.registerCommand(`chatwizard.sortBy${capitalise(mode)}`, () => applySort(mode))
    );
    context.subscriptions.push(
      vscode14.commands.registerCommand(`chatwizard.sortBy${capitalise(mode)}.asc`, () => applySort(mode))
    );
    context.subscriptions.push(
      vscode14.commands.registerCommand(`chatwizard.sortBy${capitalise(mode)}.desc`, () => applySort(mode))
    );
  }
  const cbSortModes = ["date", "workspace", "length", "title", "language"];
  for (const mode of cbSortModes) {
    context.subscriptions.push(
      vscode14.commands.registerCommand(`chatwizard.cbSortBy${capitalise(mode)}`, () => applyCbSort(mode))
    );
    context.subscriptions.push(
      vscode14.commands.registerCommand(`chatwizard.cbSortBy${capitalise(mode)}.asc`, () => applyCbSort(mode))
    );
    context.subscriptions.push(
      vscode14.commands.registerCommand(`chatwizard.cbSortBy${capitalise(mode)}.desc`, () => applyCbSort(mode))
    );
  }
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.configureSortOrder", async () => {
      const allKeys = ["date", "workspace", "length", "title", "model", "source"];
      const newStack = [];
      for (let round = 0; round < 3; round++) {
        const remaining = allKeys.filter((k) => !newStack.some((c) => c.key === k));
        const ordinal = ["1st (primary)", "2nd", "3rd"][round];
        const items = remaining.map((k) => ({
          label: SORT_KEY_LABELS[k],
          key: k
        }));
        if (round > 0) {
          items.push({ label: "$(check)  Done \u2014 apply current sort", key: "_done", alwaysShow: true });
        }
        const keyPick = await vscode14.window.showQuickPick(items, {
          title: `Sort order \u2014 ${ordinal} criterion`,
          placeHolder: round === 0 ? "Pick the primary sort key" : "Pick an additional key, or Done to finish"
        });
        if (!keyPick || keyPick.key === "_done") {
          break;
        }
        const dirItems = [
          { label: "$(arrow-down)  Descending", description: "Newest \xB7 Largest \xB7 Z\u2192A", dir: "desc" },
          { label: "$(arrow-up)  Ascending", description: "Oldest \xB7 Smallest \xB7 A\u2192Z", dir: "asc" }
        ];
        const dirPick = await vscode14.window.showQuickPick(dirItems, {
          title: `Direction for "${SORT_KEY_LABELS[keyPick.key]}"`
        });
        if (!dirPick) {
          break;
        }
        newStack.push({ key: keyPick.key, direction: dirPick.dir });
      }
      if (newStack.length > 0) {
        applyStack(newStack);
      }
    })
  );
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.filterSessions", async () => {
      const current = provider.getFilter();
      const items = [
        {
          id: "title",
          label: "$(symbol-text)  Title contains\u2026",
          description: current.title ? `current: "${current.title}"` : void 0
        },
        {
          id: "dateFrom",
          label: "$(calendar)  Updated from\u2026 (YYYY-MM-DD)",
          description: current.dateFrom ? `current: ${current.dateFrom}` : void 0
        },
        {
          id: "dateTo",
          label: "$(calendar)  Updated until\u2026 (YYYY-MM-DD)",
          description: current.dateTo ? `current: ${current.dateTo}` : void 0
        },
        {
          id: "model",
          label: "$(symbol-event)  Model contains\u2026",
          description: current.model ? `current: "${current.model}"` : void 0
        },
        {
          id: "minMessages",
          label: "$(list-ordered)  Minimum messages",
          description: current.minMessages !== void 0 ? `current: ${current.minMessages}` : void 0
        },
        {
          id: "maxMessages",
          label: "$(list-ordered)  Maximum messages",
          description: current.maxMessages !== void 0 ? `current: ${current.maxMessages}` : void 0
        },
        {
          id: "hideInterrupted",
          label: current.hideInterrupted ? "$(eye)  Show interrupted sessions" : "$(eye-closed)  Hide interrupted sessions",
          description: current.hideInterrupted ? "currently hidden" : void 0
        },
        {
          id: "onlyWithWarnings",
          label: current.onlyWithWarnings ? "$(warning)  Show all sessions" : "$(warning)  Show only sessions with warnings",
          description: current.onlyWithWarnings ? "currently active" : void 0
        },
        {
          id: "_clear",
          label: "$(close)  Clear all filters",
          alwaysShow: true
        }
      ];
      const pick = await vscode14.window.showQuickPick(items, {
        title: "Filter Sessions",
        placeHolder: "Choose a filter criterion to set (or clear all)"
      });
      if (!pick) {
        return;
      }
      if (pick.id === "_clear") {
        provider.clearFilter();
        treeView.description = provider.getDescription();
        provider.refresh();
        void vscode14.commands.executeCommand("setContext", "chatwizard.hasFilter", false);
        return;
      }
      const newFilter = { ...current };
      if (pick.id === "title") {
        const val = await vscode14.window.showInputBox({
          title: "Filter by title (case-insensitive substring)",
          value: current.title ?? "",
          placeHolder: "Leave blank to remove this filter"
        });
        if (val === void 0) {
          return;
        }
        newFilter.title = val.trim() || void 0;
      } else if (pick.id === "dateFrom") {
        const val = await vscode14.window.showInputBox({
          title: "Updated from (YYYY-MM-DD, inclusive)",
          value: current.dateFrom ?? "",
          placeHolder: "e.g. 2024-01-01  \u2014  blank to remove",
          validateInput: (v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v) ? void 0 : "Use YYYY-MM-DD format"
        });
        if (val === void 0) {
          return;
        }
        newFilter.dateFrom = val.trim() || void 0;
      } else if (pick.id === "dateTo") {
        const val = await vscode14.window.showInputBox({
          title: "Updated until (YYYY-MM-DD, inclusive)",
          value: current.dateTo ?? "",
          placeHolder: "e.g. 2024-12-31  \u2014  blank to remove",
          validateInput: (v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v) ? void 0 : "Use YYYY-MM-DD format"
        });
        if (val === void 0) {
          return;
        }
        newFilter.dateTo = val.trim() || void 0;
      } else if (pick.id === "model") {
        const val = await vscode14.window.showInputBox({
          title: "Filter by model (case-insensitive substring)",
          value: current.model ?? "",
          placeHolder: "e.g. gpt-4  \u2014  blank to remove"
        });
        if (val === void 0) {
          return;
        }
        newFilter.model = val.trim() || void 0;
      } else if (pick.id === "minMessages") {
        const val = await vscode14.window.showInputBox({
          title: "Minimum message count (inclusive)",
          value: current.minMessages !== void 0 ? String(current.minMessages) : "",
          placeHolder: "e.g. 10  \u2014  blank to remove",
          validateInput: (v) => !v || /^\d+$/.test(v) ? void 0 : "Enter a whole number"
        });
        if (val === void 0) {
          return;
        }
        newFilter.minMessages = val.trim() ? parseInt(val.trim(), 10) : void 0;
      } else if (pick.id === "maxMessages") {
        const val = await vscode14.window.showInputBox({
          title: "Maximum message count (inclusive)",
          value: current.maxMessages !== void 0 ? String(current.maxMessages) : "",
          placeHolder: "e.g. 100  \u2014  blank to remove",
          validateInput: (v) => !v || /^\d+$/.test(v) ? void 0 : "Enter a whole number"
        });
        if (val === void 0) {
          return;
        }
        newFilter.maxMessages = val.trim() ? parseInt(val.trim(), 10) : void 0;
      } else if (pick.id === "hideInterrupted") {
        newFilter.hideInterrupted = !current.hideInterrupted || void 0;
      } else if (pick.id === "onlyWithWarnings") {
        newFilter.onlyWithWarnings = !current.onlyWithWarnings || void 0;
      }
      provider.setFilter(newFilter);
      treeView.description = provider.getDescription();
      provider.refresh();
      void vscode14.commands.executeCommand("setContext", "chatwizard.hasFilter", provider.hasActiveFilter());
    })
  );
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.filterCodeBlocks", async () => {
      const current = codeBlockProvider.getFilter();
      const items = [
        {
          id: "language",
          label: "$(symbol-event)  Language contains\u2026",
          description: current.language ? `current: "${current.language}"` : void 0
        },
        {
          id: "content",
          label: "$(symbol-text)  Content contains\u2026",
          description: current.content ? `current: content:"${current.content}"` : void 0
        },
        {
          id: "sessionSource",
          label: "$(github)  Source (Copilot/Claude)",
          description: current.sessionSource ? `current: ${current.sessionSource}` : void 0
        },
        {
          id: "messageRole",
          label: "$(person)  Role (User/AI)",
          description: current.messageRole ? `current: ${current.messageRole}` : void 0
        },
        {
          id: "_clear",
          label: "$(close)  Clear all filters",
          alwaysShow: true
        }
      ];
      const pick = await vscode14.window.showQuickPick(items, {
        title: "Filter Code Blocks",
        placeHolder: "Choose a filter criterion to set (or clear all)"
      });
      if (!pick) {
        return;
      }
      if (pick.id === "_clear") {
        codeBlockProvider.clearFilter();
        codeBlockTreeView.description = codeBlockProvider.getDescription();
        codeBlockProvider.refresh();
        return;
      }
      const newFilter = { ...current };
      if (pick.id === "language") {
        const val = await vscode14.window.showInputBox({
          title: "Filter by language (case-insensitive substring)",
          value: current.language ?? "",
          placeHolder: "e.g. typescript, python, javascript"
        });
        if (val === void 0) {
          return;
        }
        newFilter.language = val.trim() || void 0;
      } else if (pick.id === "content") {
        const val = await vscode14.window.showInputBox({
          title: "Filter by content (case-insensitive substring)",
          value: current.content ?? "",
          placeHolder: "Search within code block content"
        });
        if (val === void 0) {
          return;
        }
        newFilter.content = val.trim() || void 0;
      } else if (pick.id === "sessionSource") {
        const sourceItems = [
          { label: "$(github)  GitHub Copilot", source: "copilot" },
          { label: "$(hubot)  Claude Code", source: "claude" },
          { label: "$(close)  Clear filter", source: void 0 }
        ];
        const sourcePick = await vscode14.window.showQuickPick(sourceItems, {
          title: "Filter by source"
        });
        if (!sourcePick) {
          return;
        }
        newFilter.sessionSource = sourcePick.source;
      } else if (pick.id === "messageRole") {
        const roleItems = [
          { label: "$(person)  User", role: "user" },
          { label: "$(hubot)  AI Assistant", role: "assistant" },
          { label: "$(close)  Clear filter", role: void 0 }
        ];
        const rolePick = await vscode14.window.showQuickPick(roleItems, {
          title: "Filter by message role"
        });
        if (!rolePick) {
          return;
        }
        newFilter.messageRole = rolePick.role;
      }
      codeBlockProvider.setFilter(newFilter);
      codeBlockTreeView.description = codeBlockProvider.getDescription();
      codeBlockProvider.refresh();
    })
  );
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.pinSession", (item) => {
      provider.pin(item.summary.id);
      provider.refresh();
      savePins();
    })
  );
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.unpinSession", (item) => {
      provider.unpin(item.summary.id);
      provider.refresh();
      savePins();
    })
  );
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.loadMoreSessions", () => provider.loadMore())
  );
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.loadMoreCodeBlocks", () => codeBlockProvider.loadMore())
  );
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.openSession", (summary, searchTerm, highlightContainer) => {
      const session = index.get(summary.id);
      if (!session) {
        vscode14.window.showErrorMessage(`Session not found: ${summary.id}`);
        return;
      }
      telemetry.record("session.opened", { source: session.source });
      SessionWebviewPanel.show(context, session, searchTerm, false, void 0, void 0, void 0, highlightContainer);
    })
  );
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.openSessionFromCodeBlock", (ref) => {
      const session = index.get(ref.sessionId);
      if (!session) {
        vscode14.window.showErrorMessage(`Session not found: ${ref.sessionId}`);
        return;
      }
      const isLeaf = ref.blocks.length === 1;
      const targetMsgIdx = isLeaf ? ref.blocks[0].messageIndex : void 0;
      const targetBlockIdx = isLeaf ? ref.blocks[0].blockIndexInMessage ?? 0 : void 0;
      SessionWebviewPanel.show(context, session, void 0, isLeaf, targetMsgIdx, void 0, targetBlockIdx);
    })
  );
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.search", () => {
      telemetry.record("search.opened");
      SearchPanel.show(context, index, engine);
    })
  );
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.showCodeBlocks", () => {
      CodeBlocksPanel.show(context, index, codeBlockEngine);
    })
  );
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.showPromptLibrary", () => {
      PromptLibraryPanel.show(context, index);
    })
  );
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.showAnalytics", () => {
      AnalyticsPanel.show(context, index);
    })
  );
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.showTimeline", () => {
      void vscode14.commands.executeCommand("chatwizardTimeline.focus");
    })
  );
  context.subscriptions.push(
    vscode14.commands.registerCommand("chatwizard.rescan", () => {
      void vscode14.window.showInformationMessage(
        "Chat Wizard indexes sessions automatically via file system events. If sessions are missing, reload the window to trigger a fresh scan.",
        "Reload Window"
      ).then((action) => {
        if (action === "Reload Window") {
          void vscode14.commands.executeCommand("workbench.action.reloadWindow");
        }
      });
    })
  );
  context.subscriptions.push(
    vscode14.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("chatwizard.enableTelemetry")) {
        const cfg = vscode14.workspace.getConfiguration("chatwizard");
        telemetry.setEnabled(cfg.get("enableTelemetry") ?? false);
      }
      if (e.affectsConfiguration("chatwizard.claudeProjectsPath") || e.affectsConfiguration("chatwizard.copilotStoragePath")) {
        channel.appendLine("[Chat Wizard] Data path setting changed \u2014 re-discovering workspaces and restarting index...");
        void (async () => {
          const [copilotWs, claudeWs] = await Promise.all([
            discoverCopilotWorkspacesAsync().then(
              (list) => list.map((ws) => ({
                id: ws.workspaceId,
                source: "copilot",
                workspacePath: ws.workspacePath,
                storageDir: ws.storageDir
              }))
            ).catch(() => []),
            discoverClaudeWorkspacesAsync().catch(() => [])
          ]);
          const allAvailable = [...copilotWs, ...claudeWs];
          scopeManager.resetToDefault();
          await scopeManager.initDefault(allAvailable);
          const selectedIds = scopeManager.getSelectedIds();
          channel.appendLine(
            `[Chat Wizard] Scope reset after path change \u2014 ${selectedIds.length} workspace(s): ${selectedIds.join(", ")}`
          );
          if (watcher) {
            await watcher.restart();
            channel.appendLine("[Chat Wizard] Watcher restarted after path change.");
          }
        })().catch((err) => channel.appendLine(`[error] Path-change restart failed: ${err}`));
      }
      if (e.affectsConfiguration("chatwizard.oldestSessionDate") || e.affectsConfiguration("chatwizard.maxSessions")) {
        channel.appendLine("[Chat Wizard] Session filter setting changed \u2014 restarting index...");
        void watcher?.restart().then(() => channel.appendLine("[Chat Wizard] Watcher restarted after filter change.")).catch((err) => channel.appendLine(`[error] Filter-change restart failed: ${err}`));
      }
    })
  );
  registerExportCommands(context, index, () => provider.getSortedSummaries());
  context.subscriptions.push(
    vscode14.commands.registerCommand(
      "chatwizard.exportFromTreeSelection",
      async (item, allSelected) => {
        const items = allSelected && allSelected.length > 0 ? allSelected : item ? [item] : [];
        const sessions = items.map((i) => index.get(i.summary.id)).filter((s) => s != null);
        await performExport(sessions);
      }
    )
  );
  const scopeManager = new WorkspaceScopeManager(context);
  registerManageWorkspacesCommand(context, scopeManager, () => watcher, channel, index);
  await new Promise((resolve) => setTimeout(resolve, 200));
  void (async () => {
    const [copilotWs, claudeWs] = await Promise.all([
      discoverCopilotWorkspacesAsync().then(
        (list) => list.map((ws) => ({
          id: ws.workspaceId,
          source: "copilot",
          workspacePath: ws.workspacePath,
          storageDir: ws.storageDir
        }))
      ).catch(() => []),
      discoverClaudeWorkspacesAsync().catch(() => [])
    ]);
    const allAvailable = [...copilotWs, ...claudeWs];
    channel.appendLine(
      `[Chat Wizard] Discovered ${allAvailable.length} workspace(s) for scope detection: ` + allAvailable.map((ws) => `${ws.source}:${ws.id} (${ws.workspacePath})`).join(", ")
    );
    await scopeManager.initDefault(allAvailable);
    const selectedIds = scopeManager.getSelectedIds();
    channel.appendLine(
      `[Chat Wizard] Workspace scope initialised \u2014 ${selectedIds.length} workspace(s) selected: ${selectedIds.join(", ")}`
    );
    const w = await startWatcher(index, channel, scopeManager);
    watcher = w;
    context.subscriptions.push(w);
    const copilotCount = index.getSummariesBySource("copilot").length;
    const claudeCount = index.getSummariesBySource("claude").length;
    channel.appendLine(
      `Chat Wizard activated \u2014 ${index.size} sessions indexed (${copilotCount} Copilot, ${claudeCount} Claude)`
    );
    telemetry.record("extension.activated", { sessionCount: index.size });
  })().catch((err) => channel.appendLine(`[error] Watcher init failed: ${err}`));
}
function deactivate() {
  watcher?.dispose();
  watcher = void 0;
}
function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
