// Shared cache + probe for open-in-editor. shared() survives overlay copies;
// localStorage does not (each popup is a new copy).
import { exec, setShared, shared, spaces, panes } from "herdr";

export const STORE = "open-in-editor";
export const EDITORS_TTL_MS = 30 * 60 * 1000;

export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function machineKey(machine) {
  return machine || "local";
}

export function store() {
  const value = shared(STORE);
  return value && typeof value === "object"
    ? value
    : { last: {}, editors: {}, folders: {} };
}

export function saveStore(next) {
  setShared(STORE, next);
}

export function editorCatalog() {
  return [
    {
      id: "cursor",
      name: "Cursor",
      icon: "icons/cursor.svg",
      tint: false,
      commands: ["cursor"],
      paths: [
        "$HOME/.local/bin/cursor",
        "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      ],
      app: "Cursor",
    },
    {
      id: "code",
      name: "VS Code",
      icon: "icons/command-code.svg",
      tint: true,
      commands: ["code"],
      paths: [
        "/usr/local/bin/code",
        "/opt/homebrew/bin/code",
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      ],
      app: "Visual Studio Code",
    },
    {
      id: "zed",
      name: "Zed",
      icon: "icons/command-code.svg",
      tint: true,
      commands: ["zed"],
      paths: ["$HOME/.local/bin/zed", "/Applications/Zed.app/Contents/MacOS/cli"],
      app: "Zed",
    },
    {
      id: "antigravity",
      name: "Antigravity",
      icon: "icons/antigravity.svg",
      tint: false,
      commands: [],
      paths: [],
      app: "Antigravity",
    },
    {
      id: "vscode-insiders",
      name: "VS Code Insiders",
      icon: "icons/command-code.svg",
      tint: true,
      commands: ["code-insiders"],
      paths: [
        "/usr/local/bin/code-insiders",
        "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
      ],
      app: "Visual Studio Code - Insiders",
    },
    {
      id: "windsurf",
      name: "Windsurf",
      icon: "icons/command-code.svg",
      tint: true,
      commands: ["windsurf"],
      paths: [
        "$HOME/.local/bin/windsurf",
        "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf",
      ],
      app: "Windsurf",
    },
  ];
}

export function sortEditors(list, last) {
  return [...list].sort(
    (a, b) => Number(b.id === last) - Number(a.id === last) || a.name.localeCompare(b.name),
  );
}

function onOpts(machine, opts = {}) {
  return machine ? { ...opts, on: machine } : opts;
}

function spacePanes(space) {
  if (!space) return [];
  const tabIds = new Set((space.tabs ?? []).map((t) => t.id));
  return panes().filter((p) => tabIds.has(p.tab));
}

export function quickFolder(space) {
  if (!space) return null;
  const mine = spacePanes(space);
  return (
    mine.find((p) => p.focused)?.cwd ||
    mine.find((p) => p.cwd)?.cwd ||
    (space.folder && space.folder !== "/" ? space.folder : null)
  );
}

async function resolveBin(editor, machine) {
  for (const cmd of editor.commands) {
    const result = await exec(
      "sh",
      ["-lc", `command -v ${shQuote(cmd)} || true`],
      onOpts(machine),
    ).catch(() => null);
    const found = String(result?.stdout || "").trim().split("\n").find(Boolean);
    if (found) return found;
  }
  for (const path of editor.paths) {
    const script = path.startsWith("$HOME/")
      ? `f="$HOME"/${shQuote(path.slice("$HOME/".length))}; test -x "$f" && printf '%s' "$f"`
      : `test -x ${shQuote(path)} && printf '%s' ${shQuote(path)}`;
    const result = await exec("sh", ["-lc", script], onOpts(machine)).catch(() => null);
    const found = String(result?.stdout || "").trim();
    if (found) return found;
  }
  return null;
}

async function appExists(app, machine) {
  const result = await exec(
    "sh",
    ["-lc", `test -d /Applications/${shQuote(app)}.app && printf ok`],
    onOpts(machine),
  ).catch(() => null);
  return String(result?.stdout || "").trim() === "ok";
}

export async function probeEditors(machine) {
  const results = await Promise.all(
    editorCatalog().map(async (editor) => {
      const bin = await resolveBin(editor, machine);
      const ok = editor.app ? await appExists(editor.app, machine) : false;
      if (!bin && !ok) return null;
      return {
        id: editor.id,
        name: editor.name,
        icon: editor.icon,
        tint: editor.tint,
        bin,
        app: editor.app,
        appOk: ok,
      };
    }),
  );
  return results.filter(Boolean);
}

export async function resolveFolder(space, machine) {
  const cwd = quickFolder(space);
  if (!cwd) return null;
  const top = await exec("git", ["rev-parse", "--show-toplevel"], onOpts(machine, { cwd })).catch(
    () => null,
  );
  if (top && top.code === 0) {
    const root = String(top.stdout || "").trim();
    if (root) return root;
  }
  return cwd;
}

export function cacheFresh(machine) {
  const cached = store().editors?.[machineKey(machine)];
  return Boolean(
    cached?.list?.length && Date.now() - (cached.at || 0) < EDITORS_TTL_MS,
  );
}

/** Warm the shared cache for the active space's machine. Safe to call often. */
export async function warmActiveSpace() {
  const space = spaces().find((s) => s.active);
  const machine = space?.machine || null;
  const mk = machineKey(machine);
  if (cacheFresh(machine)) return store().editors[mk];

  const folder = await resolveFolder(space, machine);
  const list = await probeEditors(machine);
  const next = store();
  next.editors = {
    ...(next.editors || {}),
    [mk]: { at: Date.now(), list },
  };
  if (space && folder) {
    next.folders = {
      ...(next.folders || {}),
      [space.id]: { folder, at: Date.now() },
    };
  }
  saveStore(next);
  return next.editors[mk];
}
