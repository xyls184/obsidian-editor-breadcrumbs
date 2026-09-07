# Editor Breadcrumbs

A VS Code style breadcrumb bar for [Obsidian](https://obsidian.md), pinned to the top of the editor pane:

```
Folder › Subfolder › Note name › Heading 1 › Heading 2 › Heading 3 › …
```

The trail follows the cursor (editing mode) or the scroll position (reading mode) and shows the **current heading chain only** — one crumb per heading level, no history stacking.

## Features

- Real-time trail updates: follows the cursor in edit mode, follows scrolling in reading mode (including Obsidian's virtualized reading view).
- Long names are truncated with an ellipsis in the bar (configurable, default 20 characters); the sibling menu always shows **full titles**.
- Left-click a heading crumb to open the **sibling heading menu** (same level under the same parent, current one checked) — same behavior as VS Code's breadcrumb dropdown. Obsidian's menu supports arrow-key navigation natively.
- Right-click a heading crumb to jump straight to it.
- Works in both edit (Live Preview / Source) and reading mode. Reading-mode jumps use Obsidian's own internal heading-scroll path, so they land precisely even in long, virtualized documents.
- Click a file/folder crumb to reveal the file in the file explorer.

## Interaction

| Action | Effect |
| --- | --- |
| Left-click heading crumb | Sibling heading menu (same parent, current item checked); pick one to jump |
| Right-click heading crumb | Jump to that heading immediately |
| Left/right-click file or folder crumb | Reveal the file in the file explorer |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Show folder path | on | Show the `Folder › Subfolder` chain before the file name |
| Show file name | on | Show the file name crumb |
| Max characters per crumb | 20 | Truncation length for the bar (menu entries are never truncated); `0` disables truncation on load |
| Show in reading mode | on | Also show the bar in reading mode, following the scroll position |
| Hide when there are no headings | off | Hide the bar entirely for notes without headings |

## Installation

**From this repository (BRAT)** — install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, then add this repository as a BRAT plugin (`main.js` is committed to the branch).

**Manual** — download `main.js`, `manifest.json`, `styles.css` and copy them into `<vault>/.obsidian/plugins/editor-breadcrumbs/`, then enable the plugin in Settings → Community plugins.

**Community plugins** — submission pending.

Build from source:

```bash
pnpm install
pnpm build          # produces main.js
npx tsc --noEmit    # type check
```

## Known limitations

- Requires Obsidian **1.13.0+** (relies on the 1.13 virtualized reading-view renderer internals); desktop only for now.
- The sibling menu is not virtualized: notes with hundreds of same-level headings get a long (scrollable) menu.
- If the same note is open in several panes, each pane gets its own bar (by design).
- More notes and design decisions: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## 中文说明

VS Code 风格的编辑器面包屑导航插件。在编辑区顶部显示一条常驻面包屑栏，**只显示当前层级链**（每级只出现当前所在的那一个标题）：

- 路径**跟随光标 / 滚动位置**实时更新（编辑模式跟随光标，阅读模式跟随滚动）
- **长标题**：面包屑栏按字符数截断（默认 20，可设置），左键同级菜单里**显示完整标题、不截断**
- **左键**标题段 → 弹出同级标题菜单（同一父标题下的真兄弟，当前项勾选），选择后跳转
- **右键**标题段 → 直接跳转到该标题
- **左键/右键**文件、文件夹段 → 在文件列表中显示（reveal）该文件
- 跳转在两种模式下都可用；阅读模式走 Obsidian 官方内部跳转路径（针对 1.13 虚拟化渲染做了精确落地）

设置项：是否显示文件夹链 / 文件名 / 阅读模式显示 / 无标题时隐藏 / 每段最大字符数。

已知限制与设计取舍详见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。
