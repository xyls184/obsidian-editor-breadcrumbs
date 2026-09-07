# Editor Breadcrumbs

VS Code style breadcrumbs for the Obsidian editor:

```
Folder › Subfolder › Note name › Heading 1 › Heading 2 › Heading 3 › …
```

A breadcrumb bar sits at the top of the editor pane, following the cursor (edit mode) or the scroll position (reading mode), and shows the **current heading chain only** — one crumb per heading level.

> Requires Obsidian **1.13.0+**, desktop.

## Features

- Real-time trail: follows the cursor in edit mode, follows scrolling in reading mode — including long, virtualized documents.
- Left-click a heading crumb → the **sibling heading menu** (headings of the same level under the same parent, current one checked). Arrow-key navigation is built in.
- Right-click a heading crumb → jump to it immediately.
- Jumps land precisely in both modes; reading-mode jumps use Obsidian's own internal heading-scroll path.
- Click a file/folder crumb → reveal the file in the file explorer.
- Long names are truncated with an ellipsis in the bar; the sibling menu always shows full titles.

## Usage

| Action | Effect |
| --- | --- |
| Left-click a heading crumb | Sibling heading menu — pick one to jump |
| Right-click a heading crumb | Jump to that heading immediately |
| Left/right-click a file or folder crumb | Reveal the file in the file explorer |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Show folder path | on | Show the `Folder › Subfolder` chain before the file name |
| Show file name | on | Show the file name crumb |
| Max characters per crumb | 20 | Truncation length for the bar (menu entries are never truncated) |
| Show in reading mode | on | Also show the bar in reading mode, following the scroll position |
| Hide when there are no headings | off | Hide the bar entirely for notes without headings |

## Installation

### Option A — Download the pre-built files (no build needed)

Download these **three files**: `main.js`, `manifest.json`, `styles.css` (from the repository root or the Releases page), and copy them into:

```
<vault>/.obsidian/plugins/editor-breadcrumbs/
```

Create the folder if it does not exist. Then in Obsidian: **Settings → Community plugins → enable "Editor Breadcrumbs"** (turn off Restricted mode first if prompted).

### Option B — Install via BRAT

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then add this repository as a BRAT plugin.

### Option C — Build from source

Requires [Node.js](https://nodejs.org/) and [pnpm](https://pnpm.io/).

```bash
git clone <this repository>
cd obsidian-editor-breadcrumbs
pnpm install
pnpm build        # produces main.js
npx tsc --noEmit  # optional: type check
```

Then copy the three files (`main.js`, `manifest.json`, `styles.css`) into `<vault>/.obsidian/plugins/editor-breadcrumbs/` as in Option A.

---

# Editor Breadcrumbs（中文说明）

VS Code 风格的 Obsidian 编辑器面包屑导航：

```
文件夹 › 子文件夹 › 笔记名 › 一级标题 › 二级标题 › 三级标题 › …
```

编辑区顶部常驻一条面包屑栏，编辑模式**跟随光标**、阅读模式**跟随滚动**，只显示**当前标题链**（每级只出现当前所在的那个标题）。

> 需要 Obsidian **1.13.0+**，桌面版。

## 功能

- 路径实时更新；阅读模式同样支持（含超长虚拟化文档）。
- 左键标题段 → 弹出**同级标题菜单**（同一父标题下同层级的兄弟标题，当前项勾选），方向键导航原生支持。
- 右键标题段 → 直接跳转到该标题。
- 两种模式均精确落地；阅读模式走 Obsidian 官方内部跳转路径。
- 左键/右键文件、文件夹段 → 在文件列表中定位该文件。
- 面包屑栏里长标题截断显示 `…`；同级菜单里始终显示完整标题。

## 使用

| 操作 | 效果 |
| --- | --- |
| 左键点击标题段 | 弹出同级标题菜单，选择后跳转 |
| 右键点击标题段 | 直接跳转到该标题 |
| 左/右键点击文件、文件夹段 | 在文件列表中定位该文件 |

## 设置项

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| Show folder path | 开 | 是否显示 `文件夹 › 子文件夹` 段 |
| Show file name | 开 | 是否显示文件名段 |
| Max characters per crumb | 20 | 面包屑栏每段最大字符数（菜单内不截断） |
| Show in reading mode | 开 | 阅读模式是否也显示面包屑（跟随滚动） |
| Hide when there are no headings | 关 | 无标题的笔记是否隐藏整条面包屑 |

## 安装

### 方式 A —— 下载预编译文件（无需编译）

下载这三个文件：`main.js`、`manifest.json`、`styles.css`（在本仓库根目录或 Releases 页面），复制到：

```
<库路径>/.obsidian/plugins/editor-breadcrumbs/
```

文件夹不存在就手动创建。然后在 Obsidian 中：**设置 → 第三方插件 → 启用 "Editor Breadcrumbs"**（如提示受限模式请先关闭）。

### 方式 B —— 通过 BRAT 安装

安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat)，将本仓库添加为 BRAT 插件即可。

### 方式 C —— 从源码编译

需要 [Node.js](https://nodejs.org/) 和 [pnpm](https://pnpm.io/)。

```bash
git clone <本仓库>
cd obsidian-editor-breadcrumbs
pnpm install
pnpm build        # 生成 main.js
npx tsc --noEmit  # 可选：类型检查
```

编译后按方式 A 把三个文件（`main.js`、`manifest.json`、`styles.css`）复制到 `<库路径>/.obsidian/plugins/editor-breadcrumbs/`。

---

License: MIT · Architecture & development notes: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)（中文）
