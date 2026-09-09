# 开发文档（DEVELOPMENT）

> 给下一次继续更新用的备忘。包含架构、Obsidian 1.13 的坑、调试方法、部署流程和 TODO。

## 项目结构

```
obsidian-editor-breadcrumbs/
├── main.ts               # 插件入口：BreadcrumbsPlugin（bars 生命周期、事件注册、CM 扩展）
├── src/
│   ├── bar.ts            # BreadcrumbBar：每个 Markdown leaf 一条面包屑栏（渲染、菜单、跳转）
│   ├── trail.ts          # 面包屑链计算（编辑模式 / 阅读模式）、stripMarkdown、阅读模式跳转
│   ├── settings.ts       # EBSettings + 默认值
│   └── settingsTab.ts    # 设置页（注意：不要定义 update() 方法！见下文坑 1）
├── styles.css            # .eb-bar 样式 + 让编辑器高度减去面包屑高度
├── esbuild.config.mjs    # esbuild 打包（obsidian / @codemirror/* 外部化）
├── manifest.json         # id: editor-breadcrumbs
└── README.md
```

## 工作原理

### 1. 面包屑栏的挂载

- `syncBars()` 遍历所有 leaf，为每个 `MarkdownView` 在 `view.contentEl`（即 `.view-content`）
  **prepend** 一条 `.eb-bar`（普通文档流，不盖在内容上）。
- `.view-content` 加 `.eb-active` 类，`styles.css` 里把 `.markdown-source-view` /
  `.markdown-reading-view` 高度改为 `calc(100% - 27px)`，给面包屑腾出空间。
- 事件刷新时机：`layout-change`（重建/同步 bars）、`active-leaf-change`、
  `metadataCache changed/resolve`（标题变化；`changed` 在输入时更快触发，两者都按文件
  定向 `renderForFile`，只刷显示该文件的栏）、leaf 内滚动（capture 阶段监听 contentEl），
  以及 **1s 轮询兜底**（`checkRefresh()`：比对 模式|文件|scrollTop|scrollHeight|光标|设置
  的快照指纹，变化才重渲染）。轮询覆盖没有可靠事件的场景：启动恢复滚动、程序化滚动、
  模式切换等边界（**隐藏时不要暂停轮询**，见 P5 评估结论）。

### 2. 面包屑链（trail）计算

- **编辑模式**：光标行 → `metadataCache.headings` 里所有 `start.line <= cursorLine` 的标题，
  按层级维护一个栈（遇到同级/更高级弹出）→ 得到唯一当前链。
- **阅读模式**：⚠️ Obsidian 1.13 的阅读模式是**虚拟化渲染**（DOM 里只有视口附近几个标题，
  metadata 里有 74 个），所以不能直接用 DOM。**现行做法（2026-09-07 重写，零 DOM 查询）**：
  1. `renderer.getScroll()` 直接返回**视口顶对应的分数源码行**（renderer 用实测 section
     height + 列表项 `data-line` 精修换算而来）；返回 null（section 未测完）时退回
     `view.scroll`（Obsidian 每次 scroll 经 syncScroll 维护的同语义行号）；
  2. 当前链 = `headingChainFromCache(headings, 行号 + PREVIEW_LINE_EPSILON(0.75 行))`，
     与大纲面板判定"当前标题"同一套行号语义；
  3. 行号完全不可用时（刚打开、一行都没有），回退到旧的 DOM 窗口**连续子序列匹配**算法
     （`computePreviewHeadingTrailDom`，文本严格→宽松两级匹配）。
- 标题文本展示前用 `stripMarkdown()` 去掉行内标记（加粗、链接、行内公式等）。

### 3. 光标跟随

- `registerEditorExtension()` 注册一个 CM6 ViewPlugin，`selectionSet` 或 `docChanged` 时
  rAF 节流后调用 `renderActive()`（只刷新当前活动 leaf 的栏）。

### 4. 跳转

- **编辑模式**：`editor.setCursor(line)` + `scrollIntoView(..., true)` + `focus`。
- **阅读模式** `scrollToPreviewHeading()`：走**官方内部路径**（与大纲面板点击标题完全同款）：
  `view.setEphemeralState({ line })` → `renderer.applyScrollDelayed(line, {highlight:true})`。
  `applyScroll` 用**实测** section 高度把行号换算成像素偏移一次落地（未测完会挂到
  onRendered 后重试），并自动展开折叠标题、闪烁高亮目标。
- **250ms 后一次修正（`JUMP_CORRECT_MS`）**：远跳会让渲染窗口重新挂载，邻接 margin 折叠
  变化导致重测高度、内容整体位移（实测漂过 127px ≈ 3 行）。等重测稳定后重新
  `applyScroll(line)` 即精确（实测误差 0.02 行）。修正前若用户已滚走
  （`|getScroll − line| > 10 行`）则放弃，不与用户抢滚动条。
- 跳转后目标标题必须出现在面包屑里：**着陆 = 目标行精确落在视口顶（偏移 0 行），链判定
  余量 `PREVIEW_LINE_EPSILON = 0.75 行`**。该值必须 < 1 行（≥1 行时紧邻的下一标题会在精确
  着陆时侵入链）；修正逻辑不能删（127px 级漂移会让目标行掉出余量窗口）。
- 内部 API 缺失/抛异常时回退到旧的"比例跳转 + 观测窗口 + 迭代收敛"
  （`scrollToPreviewHeadingLegacy`，最多 7 轮 × 220ms）。

### 5. 左键菜单 / 右键跳转（VS Code 行为）

- 标题段左键：`showSiblingMenu()` —— 找到该标题在 metadata 中的下标，向上找最近的
  更低层级父标题；在父标题跨度内用**层级栈**只列**真兄弟**（同层级且直属于同一父标题，
  **不含各兄弟的子级**，也不含别的父标题下的同层级标题），`Menu.showAtPosition` 显示在
  段下方，当前项 `setChecked(true)`（API 有存在性检查）。无父标题（H1）时列出全部顶层
  H1。
- 标题段右键：`contextmenu` 事件 `preventDefault + stopPropagation`（阻止 Obsidian 自己的
  菜单）后直接 `jumpToHeading`。
- 文件/文件夹段：左/右键都是 `revealInFolder`（走 `internalPlugins.getPluginById('file-explorer')`，
  该 API 不在公开 typings 里，已用类型断言处理）。

## Obsidian 1.13 的坑（重要！）

1. **`SettingTab.update()` 方法名冲突**：1.13.0 起基类新增 `update(): void`，并且
   `addSettingTab()` 会调用它。任何插件设置页如果自定义了 `update(data)`，会被 Obsidian
   以**无参数**调用，极易把 `plugin.settings = undefined`。本仓库的设置页**没有**任何
   `update()` 类方法（各设置项在 onChange 回调里直接 `saveSettings()`，天然避开）。
   sticky headings 原版/无闪烁 fork 就是栽在这里（已修复并验证）。
2. **阅读模式虚拟化**：DOM 只有窗口片段（本例 74 个标题只剩 7 个），不能按 DOM 计算全链，
   见上文 trail 算法。`renderer.sections`（575 节，含 `lines` 起始行、`height`）仍在，
   可作为备用信息源。
3. **阅读模式标题标签层级会 +1**：metadata 里 H1 在 DOM 中渲染成 `<h2>`。所以匹配逻辑
   **不要比较层级**，只按文本匹配。
4. **程序化 `scrollTop` "不派发 scroll 事件"的真相（已查明）**：赋值只有在该值真的变化时
   才会派发 scroll 事件。之前观察到的"无事件"其实是 progressive render 未完成时
   `sizerEl.minHeight` 低估 → scrollHeight 偏小 → 赋值被钳制或值不变 → 无事件。
   另外**合成 WheelEvent（isTrusted=false）不触发原生滚动**，早先"有时能动"的观察不可靠；
   程序化滚动请一律用 `renderer.applyScroll(行号)`（值真变化时会正常派发 scroll 事件，
   本插件 bar 的 capture 监听收得到）。
5. **API 变动**：`MarkdownView.getFile()` / `previewMode.renderer` 已不在 1.13 typings 里
   （运行时仍在），代码里用 `view.file ?? view.previewMode.file` 和类型断言兜底。
   `tsconfig.json` 需要开 `skipLibCheck`（1.13.1 的 d.ts 与 @codemirror 类型有内部冲突）。

## 构建与部署

```bash
# 开发
pnpm install            # 需要 pnpm-workspace.yaml 里 allowBuilds: esbuild: false
pnpm build              # = node esbuild.config.mjs production
npx tsc --noEmit        # 类型检查

# 部署（把 <vault> 换成你的库路径；本机开发库为 C:\Users\Dumortierite\MarkdownProject）
cp main.js manifest.json styles.css \
  <vault>/.obsidian/plugins/editor-breadcrumbs/

# 重启验证
obsidian restart
```

## 调试（Obsidian CLI）

- `obsidian dev:errors` —— 看未捕获异常（最常用）
- `obsidian dev:console limit=100` —— console 输出（注意 dev:console 有时抓不到，可用
  `window.__XXX` 全局数组存日志再 `obsidian eval` 读取）
- `obsidian eval 'code=JSON.stringify(...)'` —— 在应用内执行 JS 检查 DOM/插件状态
  （注意：返回 Promise 的 eval 有时拿不到结果，尽量写成同步或用 window 变量中转；
  **不要对没有缓存条目的文件手动 `metadataCache.trigger('changed', file)`**——会打崩
  Obsidian 内部 `onCacheChanged`（读 `undefined.frontmatter`），要测事件就用当前打开的
  已解析文件）
- `obsidian plugin id=editor-breadcrumbs` —— 插件启用状态
- CLI 的 `plugin:enable` 子命令当前返回 127 不可用，启用/禁用改 `community-plugins.json`
  后 `obsidian restart`。

## 设计取舍记录

- **长标题**：面包屑栏按 `maxSegmentLength`（默认 20）截断加 `…`；同级标题菜单里
  **不截断**（用户明确要求：菜单里看全称）。VS Code 的"整条栏横向滚动"方案评估过、
  未采纳。
- **只显示当前链**：面包屑每级只显示当前标题（用户要求），不做 sticky headings 那种
  "显示所有已读过的同级标题"的堆叠行为。

## 附：阅读视图虚拟化 renderer 内幕（逆向 app.js 1.13.7 的结论）

> P1 排查时从 `C:\Program Files\Obsidian\resources\obsidian.asar` 解出 app.js 逆向所得，
> 换大版本时按此复核。类名已混淆，行为按方法名定位。

- `previewMode.renderer.previewEl`（`.markdown-preview-view`）**本身就是滚动容器**，
  挂 passive scroll 监听。虚拟化 = `sizerEl.style.minHeight`（合成总高）+
  `pusherEl.style.marginBottom`（窗口前空白）+ 只挂载 `[R,N]` 窗口内的 section
  （视口 ± `max(clientHeight×renderExtra, 500px)`）。
- section 字段：`html`（该节源码渲染出的 HTML 串，标题节以 `<h1..h6` 开头）、`height`、
  `computed`（是否实测过）、`lines`（**行数**，不是起始行！）、`start.line`（起始行）、
  `shown`（**折叠语义**，与虚拟化无关）、`level`、`el`。
- **所有 section 的 height 最终都会被实测**：onRender 时临时挂载 → `measureSection`
  （offsetTop 差）→ `updateVirtualDisplay` 再把窗口外的卸掉。所以行号↔像素换算是精确的，
  sticky-headings 参考插件预计算偏移吃的就是这个红利。
- `applyScroll(行号, {highlight, center})`：参数是**行号**（分数可行），要求全部 section
  `computed` 否则返回 false 什么都不做；`applyScrollDelayed` 会挂 onRendered 重试。
  `getScroll()` 返回**分数行号**，任一 section 未 computed 返回 null。
- **大纲面板点击标题 = `view.setEphemeralState({ line: heading.position.start.line })`**
  （阅读模式经 `$W.setEphemeralState` → `applyScrollDelayed(line, {highlight:true}, syncScroll)`）。
- workspace `markdown-scroll` 事件由 `view.syncScroll()` 触发（滚动时、带回调的跳转完成后），
  阅读模式有 `lastRender < 100ms` 的抑制；启动恢复滚动不带回调、不触发。本插件未监听它
  （bar 的 contentEl capture scroll 监听已覆盖两模式，含 applyScroll 的程序滚动）。
- **远跳漂移**：跳转后新窗口重挂载 → 邻接 margin 折叠变化 → 重测高度 → 内容位移
  （实测 127px）。这是 Obsidian 自身行为（大纲跳转同样漂），靠延时一次修正解决。

## TODO

- [ ] **面包屑冻结/吸顶**（用户提出，暂存想法）：像 VS Code 那样，滚动时把当前面包屑路径
      冻结在窗口上方。由于本插件面包屑常驻在编辑区顶部（normal flow），此需求更像
      "阅读模式长滚动时把当前链吸顶显示"。可参考 sticky headings 的绝对定位做法
      （`.sticky-headings-root` position absolute top:0），或为阅读模式加一个吸顶变体。
- [ ] 同级标题菜单支持**输入过滤/搜索**（方向键导航 Obsidian Menu 原生已支持，缺的只是
      搜索定位；超长列表场景才需要，可能要自绘）。
- [ ] 文件段左键目前是 reveal，可考虑 VS Code 式"同级文件列表"菜单。

## 待优化清单（交接记录；P1/P2/P3 已于 2026-09-07 完成）

> 按优先级排列。**当前基线（2026-09-07 第二轮验证，Obsidian 1.13.7）**：功能全部可用——
> 编辑模式光标跟随 ✓、阅读模式滚动跟随 ✓（行号语义，5/5 位置校验）、阅读模式跳转 ✓
> （官方路径 + 一次修正，7/7 精确落地、目标必现在面包屑）、左键同级菜单 ✓、右键跳转 ✓、
> 截断 ✓、设置页 ✓、`obsidian dev:errors` 无报错 ✓。
> 性能（对照 sticky-headings-no-flicker 基准，74 标题/575 section/43000px 文档）：
> 滚动无链变化帧 **0.033ms**（纯数组比较，零 DOM），跨标题边界偶发全重建 ~11.5ms 一次性，
> 与参考插件同量级；旧实现每帧 DOM 探测 + 子序列匹配 + 全重建 ≈ 12ms/帧。

### P1 · 虚拟化阅读视图的程序化滚动语义 —— ✅ 已解决

- 结论见上文「附：renderer 内幕」。核心：`applyScroll` 参数是行号非比例（旧观察
  `applyScroll(0.12)→scrollTop≈11` 即跳到第 0.12 行）；`getScroll()` 返回行号、未测完
  返回 null；直接赋 scrollTop 在 progressive render 未完成时被钳制（"无 scroll 事件"
  的真相）；官方跳转 = `view.setEphemeralState({line})`；远跳后 margin 折叠漂移需一次
  250ms 修正。已全部落入 `src/trail.ts`（`scrollToPreviewHeading` + `JUMP_CORRECT_MS`）。

### P2 · 子序列窗口匹配的健壮性与复杂度 —— ✅ 已解决（主路径弃用匹配）

- 新主路径完全不碰 DOM、不做文本匹配：`renderer.getScroll()` 行号 → metadata 层级栈。
  旧的 `computePreviewHeadingTrailDom` 仅作行号不可用时的回退保留。重复标题错位风险
  随主路径一并消失；`stripMarkdown` 精度问题（P4）对主路径也只剩显示用途。

### P3 · 编辑模式 trail 的实时性 —— ✅ 已解决

- `main.ts` 改为 `metadataCache.on('changed', file)`（该文件的缓存条目一更新就触发，
  输入新标题基本即时出现）+ `resolve` 兜底，且两者都走**按文件定向**的
  `renderForFile(file)`（只重渲染显示该文件的 bar），不再是全量 `renderAll()`。

### P4 · stripMarkdown 是近似实现

- 现状：正则剥掉行内标记， `$...$`/`$$`、脚注、多行公式可能残留符号；现在只影响
  **显示文本**与回退路径的窗口匹配（主路径不做文本匹配）。
- 方向：用 `MarkdownRenderer.render` 渲染一次做精确映射有性能成本；更实际的是把宽松匹配
  做得更鲁棒（去所有空白+标点）。发布优先级低。

### P5 · 小项

- [x] bar 隐藏时是否暂停轮询：**评估后保留轮询**——编辑↔阅读模式切换等场景没有可靠
      事件可依赖，暂停有"卡死在隐藏态"的风险（如 showInReadingMode=false 时切回编辑模式
      可能无人触发重渲染）；轮询本身每秒仅约 10 次属性读 + 指纹比较，收益可忽略（2026-09-07）；
- [x] `render()` 与 `checkRefresh()` 双渲染已合并：两者共用 `scheduleRender()` 的 rAF 闸；
      `render()` 另有 `lastRenderKey` 记忆化，链未变化的帧直接跳过 DOM 重建（2026-09-07）；
- [x] 阅读模式标题标签层级 +1 的坑对主路径已无意义（不再做 DOM 文本匹配），
      仅回退路径仍受影响（已按文本匹配绕过）；
- [ ] 菜单超长列表（几百同级标题）无虚拟化，Obsidian Menu 原生可滚动但无搜索定位
      （方向键导航原生支持）；
- [x] 同一文件在多个 leaf 打开时每个 leaf 各一条 bar：确认为预期行为，README 已注明；
- [x] `maxSegmentLength` 容错：设置页输入校验（非法值不保存，已有）+ `loadSettings`
      加载兜底（NaN/负数回落默认 20，2026-09-07）。

## 发布（GitHub）

- 2026-09-07 初始化 git 仓库并做首个提交。发布资产三件套：`main.js` / `manifest.json` /
  `styles.css`（社区插件提交要求附在 GitHub Release 上）；`main.js` 也直接提交在分支里，
  BRAT 可免 Release 装分支版。
- `minAppVersion: 1.13.0`：阅读模式行号链与官方跳转路径依赖 1.13 虚拟化 renderer 内部
  （`renderer.getScroll/applyScroll`），更低版本未验证、不承诺。
- `isDesktopOnly: true`：只在桌面版验证过；移动端理论上同代码路径但未测，测过想放开再改。
- **提交 Obsidian 社区插件目录（2026-09-09 按官方文档核对，旧说法已过时）**：入口是
  <https://community.obsidian.md>（Obsidian 账号登录 → 关联 GitHub → Add plugin），
  **不再**往 obsidian-releases 仓库提 PR。仓库根目录需有 `README.md`、`LICENSE`、
  `manifest.json`、`versions.json`；Release 的 tag 必须与 manifest 的 `version` 完全一致
  （本插件即 `1.0.0`），并附 `main.js` / `manifest.json` / `styles.css` 三件套
  （Obsidian 安装插件时从该 Release 拉取这三个文件）。提交后自动审查给出整改意见，
  按意见改代码 → 升 `version` → 发新 Release 即可。manifest `description` 要求
  ≤250 字符、句号结尾、避免 emoji/特殊字符；README 截图不是硬性要求（列表页只展示
  README 摘要），但建议补（录屏可用 Obsidian 自带或 ShareX）。
- 2026-09-09：推送 GitHub（远端原有网页端生成的 README/LICENSE 脚手架，由本地历史覆盖）；
  许可证三处统一为 CC0-1.0（`LICENSE` / `package.json` / README）。
- 本文档（DEVELOPMENT.md）含内部 API 逆向笔记，随仓库公开有助于后人，无敏感信息
  （本机路径已泛化）。

## 相关项目

- `C:\Users\Dumortierite\typeScriptProject\obsidian-sticky-headings-no-flicker`
  —— sticky headings 兼容修复，见其 `FIX-obsidian-1.13.md`。
