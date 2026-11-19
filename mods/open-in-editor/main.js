// Popup: open the current project in an editor on the space's machine.
// Cache lives in shared() (survives overlay close). Last-used editor sorts first.
// Floating copy with props.warm prefetches so the first click is instant.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  checking,
  closeOverlay,
  exec,
  notify,
  props,
  spaces,
  theme,
} from "herdr";
import {
  cacheFresh,
  machineKey,
  probeEditors,
  quickFolder,
  resolveFolder,
  saveStore,
  sortEditors,
  store,
  warmActiveSpace,
} from "./cache.js";

export default class OpenInEditor extends View {
  init(_props, cx) {
    this.editors = [];
    this.folder = null;
    this.machine = null;
    this.where = "This Mac";
    this.error = null;
    this.last = "";
    this.warm = Boolean(_props?.warm ?? props()?.warm);
    this.handle = cx.focus_handle();
    if (!this.warm) this.handle.focus();
    if (checking()) return;

    if (this.warm) {
      this.prefetch(cx);
      cx.timer.every(60_000, (cx) => this.prefetch(cx));
      return;
    }

    const space = spaces().find((s) => s.active);
    const warm = this.hydrate(space);
    if (warm) return;

    cx.spawn(async (cx) => {
      try {
        await this.refresh(space);
      } catch (error) {
        if (this.editors.length === 0) this.error = String(error);
      }
      cx.notify();
    });
  }

  prefetch(cx) {
    const space = spaces().find((s) => s.active);
    if (cacheFresh(space?.machine || null)) return;
    cx.spawn(async () => {
      try {
        await warmActiveSpace();
      } catch {}
    });
  }

  hydrate(space) {
    const data = store();
    this.machine = space?.machine || null;
    this.where = this.machine || "This Mac";
    const mk = machineKey(this.machine);
    this.last = data.last?.[mk] || "";

    const cachedEditors = data.editors?.[mk];
    const cachedFolder = space ? data.folders?.[space.id] : null;
    this.folder = cachedFolder?.folder || quickFolder(space);

    if (cacheFresh(this.machine) && cachedEditors?.list?.length) {
      this.editors = sortEditors(cachedEditors.list, this.last);
      this.error = null;
      return Boolean(this.folder);
    }

    if (cachedEditors?.list?.length) {
      this.editors = sortEditors(cachedEditors.list, this.last);
      this.error = null;
    }
    return false;
  }

  on(opts = {}) {
    return this.machine ? { ...opts, on: this.machine } : opts;
  }

  async refresh(space) {
    this.machine = space?.machine || null;
    this.where = this.machine || "This Mac";
    const mk = machineKey(this.machine);
    const data = store();
    this.last = data.last?.[mk] || "";

    this.folder = await resolveFolder(space, this.machine);
    if (!this.folder) {
      this.error = "No folder for this space yet.";
      if (this.editors.length === 0) this.editors = [];
      return;
    }

    const found = await probeEditors(this.machine);
    this.editors = sortEditors(found, this.last);
    this.error =
      found.length === 0
        ? `No supported editors on ${this.where}. Install Cursor, VS Code, or Zed there.`
        : null;

    const next = store();
    next.last = { ...(next.last || {}), [mk]: this.last };
    next.editors = {
      ...(next.editors || {}),
      [mk]: { at: Date.now(), list: found },
    };
    if (space) {
      next.folders = {
        ...(next.folders || {}),
        [space.id]: { folder: this.folder, at: Date.now() },
      };
    }
    saveStore(next);
  }

  async openEditor(editor) {
    const folder = this.folder;
    if (!folder) return;
    closeOverlay(props().overlay);

    const mk = machineKey(this.machine);
    const next = store();
    next.last = { ...(next.last || {}), [mk]: editor.id };
    if (next.editors?.[mk]?.list?.length) {
      next.editors = {
        ...next.editors,
        [mk]: {
          ...next.editors[mk],
          list: sortEditors(next.editors[mk].list, editor.id),
        },
      };
    }
    saveStore(next);

    try {
      let result = null;
      if (editor.bin) {
        result = await exec(editor.bin, [folder], this.on());
      }
      if ((!result || result.code) && editor.app) {
        result = await exec("open", ["-a", editor.app, folder], this.on());
      }
      if (result?.code && result.code !== 0) {
        notify({
          title: "Open in editor",
          body: (result.stderr || result.stdout || `Failed on ${this.where}`).trim().slice(0, 180),
          level: "error",
        });
        return;
      }
      notify({
        title: editor.name,
        body: `${this.where}: ${folder}`,
        level: "success",
      });
    } catch (error) {
      notify({ title: "Open in editor", body: String(error), level: "error" });
    }
  }

  row(editor) {
    const t = theme();
    const icon = editor.tint
      ? svg(editor.icon).size(14).text_color(t.foreground)
      : image(editor.icon).size(14);
    return h_flex()
      .id(`editor-${editor.id}`)
      .h(31)
      .px(9)
      .gap(10)
      .rounded(7)
      .items_center()
      .flex_none()
      .text_color(t.foreground)
      .cursor_pointer()
      .hover((s) => s.bg(t.selected))
      .on_click(() => this.openEditor(editor))
      .child(icon)
      .child(div().flex_1().child(editor.name))
      .when(editor.id === this.last, (el) =>
        el.child(div().text_size(11).text_color(t.dim).child("recent")));
  }

  render() {
    if (this.warm) return div();
    const t = theme();
    const rows = Math.max(1, this.editors.length);
    const height = Math.min(340, 96 + rows * 31 + (this.error ? 36 : 0));
    const headline = this.folder
      ? `${this.where} · ${this.folder}`
      : `Resolving on ${this.where}…`;
    return v_flex()
      .w_full()
      .h(height)
      .bg(t.popover)
      .p(5)
      .text_size(12.8)
      .id("open-in-editor")
      .track_focus(this.handle)
      .child(div().px(9).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(headline))
      .when(Boolean(this.error) && this.editors.length === 0, (el) =>
        el.child(div().px(9).py(8).text_color(t.dim).child(this.error)))
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .children(this.editors.map((editor) => this.row(editor))),
      )
      .when(Boolean(this.error) && this.editors.length > 0, (el) =>
        el.child(div().px(9).pt(4).text_size(11).text_color(t.dim).child(this.error)));
  }
}
