# AGENTS.md

> 面向 AI Agent 的项目开发指南。最后更新：2026-09-14 · 适用分支：`main`
> 维护约定：架构 / 接口 / 约定变更后必须同步更新本文件对应小节，否则它会快速腐化。
> 文中行号是写作时快照，改动后会漂移——请优先按**符号名（函数名 / 组件名）搜索**定位。

## 0. 快速上手（30 秒版）

- **项目一句话**：本地自托管的视频处理工具箱——Flask + 本机 ffmpeg 做后端，SolidJS 单页应用做界面，提供 11 个视频处理功能，全程本机处理、不上传。
- **技术栈**：Python 3.10+ / Flask `>=3.0,<4.0` · ffmpeg（系统或 `imageio-ffmpeg>=0.4.9` 静态二进制）· SolidJS `^1.8.22` + Vite `^5.4.8` + TypeScript（`strict`）· OpenCV（inpaint 模式）
- **装依赖 / 起服务**：
  - `./start.sh` 快速启动｜`./start.sh --build` 装依赖并重建前端｜`./start.sh -d` 后台启动（日志 `/tmp/clipbench.log`）
  - 手动：`.venv/bin/python app.py`（Python 环境在 `.venv`，系统 python3 未装 Flask）
- **跑测试**：`.venv/bin/python -m pytest -q`（39 个用例；缺 ffmpeg 时 E2E 自动 skip）
- **构建前端**：`pnpm build`（输出 `dist/`，由 Flask 托管；**改了前端不 build，页面上看不到效果**）
- **改代码前必读**：§3 AI Agent 开发指导（尤其 §3.2 禁止修改、§3.3 联动表、§3.4 踩坑清单）

---

## 1. 项目全局认知

### 1.1 项目目标与定位

把一个"可视化 ffmpeg 操作台"做成本地一键可用的 Web 应用：用户上传视频 → 浏览器里点选参数 → 后端排队执行 ffmpeg → 产物落在 `outputs/`。定位是**隐私友好、零上传、开箱即用**（未装 ffmpeg 时用 imageio-ffmpeg 静态二进制兜底）。

11 个功能：去字幕、拆分、截图、格式转换、压缩、裁剪、合并、旋转、水印、调速、音频提取。

### 1.2 整体架构与目录地图

```
浏览器 (localhost:8080)
   │
   │  REST /api/*          SSE /api/tasks/stream
   ▼                          ▲
Flask app.py ──► TASKS(dict) ──► save_tasks() ──► _notify_tasks_changed() ──► _sse_pump()
   │                                                 │
   │ new_task() ─► start_task() ─► 线程 + 并发闸门 ──► _run_ffmpeg_locked() ─► ffmpeg 子进程
   ▼
uploads/ (源文件)          outputs/ (产物，命名走 _build_output_name)
```

```
clipbench/
├── app.py                  # ★ 唯一后端文件（2216 行）：全部 API + 任务队列 + ffmpeg 执行 + SSE
├── desub_inpaint.py        # 内容感知修复算法（cv2.inpaint，含时序/光流两种实现）
├── detect_subtitle.py      # 字幕区域自动检测
├── start.sh                # 一键启动（venv + 依赖 + 可选前端构建 + 启动）
├── package.json            # 前端依赖与脚本（dev / build / preview / start）
├── vite.config.js          # root=src，outDir=dist，sourcemap=true，dev 代理 → 127.0.0.1:8080
├── tsconfig.json           # strict，jsx: preserve，jsxImportSource: solid-js
├── requirements.txt        # Flask>=3.0,<4.0 / imageio-ffmpeg>=0.4.9
├── requirements-dev.txt    # -r requirements.txt + pytest>=7.4
├── README.md / README_EN.md / llms.txt / LICENSE
├── screenshots/            # 界面截图（被中英 README 引用）
├── docs/
│   ├── CHANGELOG.md        # ★ 改动日志：先写「待提交改动」，提交后归档到「已提交记录」
│   ├── UI-DESIGN.md        # ★ UI 布局体系、设计 Token、三种布局模板、DOM 顺序约束
│   └── todo.md             # 功能建议与状态（部分条目已过时，见 §5.5）
├── src/                    # 前端（Vite root）
│   ├── index.html / index.tsx   # 挂载入口
│   ├── App.tsx             # 顶层布局：顶栏 + Sidebar + 主区（Tab 切换）+ Tasks + 弹框/Toast
│   ├── store.ts            # ★ 全局状态：TABS / files / tasks / toasts / modal / persistSignal
│   ├── api.ts              # ★ 后端 API 薄封装：jsonFetch / withTemplate / Task 与 StoredFile 类型
│   ├── sse.ts              # SSE 订阅 → upsertTask（断线降级为 500ms 轮询）
│   ├── addedOutputs.ts     # 「已添加产物」集合（localStorage，键 cb_added_outputs）
│   ├── filenameTemplate.ts # 全局输出文件名模板（localStorage，键 cb_filename_template）
│   ├── styles.css          # ★ 全部样式（暗色主题，设计 Token 在 :root）
│   └── components/
│       ├── Sidebar.tsx     # 媒体文件列表 + 搜索 + 批量删除 + 上传 dropzone + 模板设置
│       ├── Tasks.tsx       # 任务列表：进度 / 压缩对比 / 产物信息 / 日志弹窗 / 「添加」按钮
│       ├── Workbench.tsx   # 去字幕工作台（视频 + 选区 + 时间轴）
│       ├── TimePickerModal.tsx  # 取帧打点弹窗（拆分/截图复用）
│       └── panels/         # 11 个功能面板 + index.ts 统一导出
├── tests/
│   ├── conftest.py         # CLIPBENCH_TEST=1 + monkeypatch 隔离临时目录
│   ├── test_app.py         # 39 个用例：纯函数单测 + API 测试 + E2E
│   └── manual-test.md      # 浏览器端 UI 手工回归清单
├── uploads/                # 运行时：上传源文件（.gitignore）
├── outputs/                # 运行时：处理产物（.gitignore）
└── tasks.json              # 运行时：任务持久化（.gitignore）
```

### 1.3 技术栈说明（版本来自 package.json / requirements）

| 层 | 技术 | 版本 | 备注 |
| --- | --- | --- | --- |
| 后端 | Python | 3.10+ | 代码里用了 `str \| None` 等新语法 |
| 后端 | Flask | `>=3.0,<4.0` | 单文件应用，无蓝图 |
| 媒体 | ffmpeg / ffprobe | 系统优先 | 兜底 `imageio-ffmpeg>=0.4.9` 静态二进制 |
| 媒体 | OpenCV | 可选 | 仅去字幕 `inpaint` 模式需要；缺失时该模式返回友好报错 |
| 前端 | SolidJS | `^1.8.22` | 细粒度响应式，`createStore` / `createSignal` |
| 前端 | Vite | `^5.4.8` + `vite-plugin-solid ^2.10.2` | build 开 `sourcemap: true` |
| 前端 | TypeScript | `strict: true` | `jsx: preserve` + `jsxImportSource: solid-js` |
| 测试 | pytest | `>=7.4` | Flask test client，无浏览器依赖 |

**无路由、无 UI 库、无状态管理库**——单页应用靠 `activeTab` signal 切面板，样式全在 `styles.css`。

### 1.4 核心模块职责

| 模块 | 路径 | 负责 | **不负责** |
| --- | --- | --- | --- |
| 后端 API 层 | `app.py` 的 `api_*` | 参数校验、建任务、返回 `task_id` | 不执行实际转码（丢给线程）、不生成前端文案 |
| 任务执行核心 | `app.py` `_run_ffmpeg_locked` | 跑 ffmpeg、解析 `-progress` 写进度、判定成功/失败、记录产物信息 | 不建任务、不做参数校验 |
| 任务状态 | `app.py` `TASKS` / `save_tasks` | 内存态 + `tasks.json` 持久化 + 触发 SSE 通知 | 不持有 ffmpeg 参数细节（由 `args` 数组承载） |
| 并发控制 | `ffmpeg_acquire` / `inpaint_acquire` | 闸门限流，排队时把状态置 `queued` | 不改变任务语义 |
| SSE 推送 | `_notify_tasks_changed` / `_sse_pump` | 节流后把整个 `TASKS` 推给所有订阅者 | 不做增量 diff |
| 前端状态 | `src/store.ts` | 文件/任务/Tab/Toast/Modal 全局状态与持久化工具 | 不发请求（除 `upsertTask` 内的刷新外） |
| 前端 API 封装 | `src/api.ts` | 所有 HTTP 调用 + 类型定义（`Task` / `StoredFile`） | 不直接操作 DOM、不弹 Toast |
| 任务呈现 | `src/components/Tasks.tsx` | 进度、对比信息、产物大小、日志、删除/取消/添加 | 不修改后端数据模型 |
| 文件侧栏 | `src/components/Sidebar.tsx` | 上传、搜索、选择、批量删除、产物添加后的展示 | 不决定产物是否回流（由 `addedOutputs` 决定） |

### 1.5 关键数据流

**任务生命周期（前端视角）**

```
面板提交 → api.ts(withTemplate 注入 filename_template) → POST /api/xxx
  → new_task() 建记录(status=running) → start_task() 起线程
  → SSE 推送 → sse.ts onmessage → upsertTask() → store.tasks 更新 → Tasks.tsx 重渲染
  → 完成: status=finished + out_size/out_codec/out_resolution 落盘 → 卡片显示产物信息
```

**ffmpeg 执行（后端视角）**

```
run_ffmpeg / run_ffmpeg_list → ffmpeg_acquire(闸门, 排队时 queued)
  → _run_ffmpeg_locked → Popen(cwd=workdir, -progress pipe:1)
  → 逐行解析 out_time_ms → task["progress"] 均摊 → save_tasks()（每次落盘即触发 SSE）
  → proc.wait() == 0 ? status=finished : status=failed + error 尾部日志
  → compress → _record_compress_result（含源/输出对比 saving）
    其余全部 → _record_split_result（大小/编码/分辨率/时长/文件数）
  → task["log"] = 尾部 600 行 ffmpeg 输出 → save_tasks()
```

**产物回流（2026-08-27 起）**

```
任务完成 ≠ 产物自动进侧栏。
用户点任务卡片「添加」→ addedOutputs.addOutput(name) → refreshFiles()
  → Sidebar.refreshFiles() 拉 /api/files?outputs=1 → 只保留 uploads + 已添加的产物
```

### 1.6 关键设计原则（可验证的项目真实约束）

1. **后端驱动智能，前端只渲染**：压缩建议 / CRF 推断由 `suggest_compress()`（`/api/compress_suggest`）计算，前端不得写死阈值。
2. **输出命名唯一入口**：所有任务产物名必须经 `_build_output_name(data.get("filename_template"), src, ext)`，禁止硬编码文件名。
3. **任务列表是产物信息的唯一载体**：产物大小/编码等由后端写进 task 记录，不存在独立的「输出产物」面板。
4. **产物默认不回流**：产物需用户显式「添加」才进入媒体列表（保留可二次处理能力，同时不污染列表）。
5. **SSE 优先、轮询兜底**：正常走 SSE；断线才降级 500ms 轮询。
6. **UI 复用统一布局语言**：所有面板共用 `.seg / .field / .form-card / .panel-aside / .actions`，双栏面板 DOM 顺序固定（见 §3.3）。

---

## 2. 开发规则

### 2.1 代码组织规范

- **后端只有一个文件**：`app.py`。新增功能 = 在该文件加 `@app.route` 处理函数；算法复杂时抽独立模块（参照 `desub_inpaint.py` / `detect_subtitle.py`）。
- **app.py 内部顺序约定**（改动时插到对应区段，别打乱）：全局常量 → 闸门/任务生命周期 → SSE → ffmpeg 解析与媒体元信息 → 任务执行核心与记录函数 → 模板/文件工具 → 任务工具函数 → API 路由分组（按功能，用 `# ---------------- 功能名 ----------------` 分隔）→ `/api/tasks*` → 下载/删除 → `if __name__ == "__main__"`（末尾含 `backfill_task_sizes()` 调用）。
- **前端**：状态进 `store.ts`；HTTP 进 `api.ts`；持久化小模块单独成文件（`addedOutputs.ts` / `filenameTemplate.ts`）以避免循环依赖。
- **功能面板**：一个 Tab 一个文件，放 `src/components/panels/`，并在 `panels/index.ts` 统一具名导出。

### 2.2 命名规范

| 对象 | 约定 | 例 |
| --- | --- | --- |
| Python 私有函数 / 常量 | `_` 前缀 / 全大写 | `_build_output_name`、`UPLOAD_DIR` |
| Python 路由函数 | `api_<动作>` | `api_compress`、`api_task_delete` |
| 任务类型标记 | `extra={"kind": "<类型>"}`，小写单词 | `compress` / `split` / `merge` |
| Solid 信号 | `[value, setValue]` | `[files, setFiles]` |
| 面板组件 | `<功能>Panel` | `CompressPanel`、`AudioExtractPanel` |
| localStorage 键 | `cb_<snake_case>` | `cb_filename_template`、`cb_added_outputs`、`cb_faststart` |
| CSS 类 | kebab-case，语义化块 | `.compress-compare`、`.form-card`、`.panel-aside` |

### 2.3 文件结构约定（面板组件）

参照 `docs/UI-DESIGN.md` 模板 B，双栏面板的 DOM 顺序**必须**是：

```
.tab-panel.two-col
├── h2 + p.muted          (grid-column: 1/-1)
├── .form-card            (左列 1/2)
├── aside.panel-aside     (右列，与 form-card 同排等高)
└── .actions              (grid-column: 1/-1，必须在 aside 之后！)
```

`.actions` 若插在 `form-card` 与 `aside` 之间，会把 `aside` 挤到按钮下方，破坏并排布局。

### 2.4 模块拆分原则

- 新算法 > 80 行或需独立依赖（cv2 等）→ 拆独立 `.py` 模块。
- 跨面板复用的交互组件（如 `TimePickerModal`）→ 放 `src/components/` 顶层，不塞进 `panels/`。
- 面板参数记忆统一用 `store.ts` 的 `persistSignal(key, fallback)`，不要自己写 localStorage 读写。

### 2.5 API / 数据模型规范

- 所有请求走 `api.ts` 的 `jsonFetch`（自动处理 Content-Type、`{}` 空体、解析后端 `{error}` 中文报错）。
- 所有**创建任务**的请求体用 `withTemplate(payload)` 包裹，自动注入 `filename_template`。
- 前端类型是前后端契约：后端 task 新增字段 → 必须同步 `src/api.ts` 的 `Task` 接口。
- 上传类接口返回 `{task_id}`；查询类返回对象或 `{files: [...]}` / `{tasks: [...]}`。

### 2.6 错误处理

- **后端**：参数错误返回 `jsonify({"error": "中文说明"}), 4xx`；任务失败写 `task["error"]`（取 ffmpeg 输出尾部 30 行）并置 `status="failed"`。
- **前端**：`jsonFetch` 解析后端 error 字段抛出；调用方用 `pushToast(msg, "error")` 提示，禁止裸 `alert`。取消等易失败动作要 try/catch。

### 2.7 日志规范

- 后端用 `print(..., flush=True)` 并加 `[模块]` 前缀（如 `[compress]`、`[upload]`、`[split]`），便于 `grep`。
- ffmpeg 原始输出不直接 print，而是收进 `task["log"]`（尾部 600 行）供前端「日志」弹窗查看。
- 前端仅保留 `console.error`（如 `refreshFiles` 失败），不写调试日志。

### 2.8 测试要求

- 框架 pytest；新增后端接口/校验**必须**补 `tests/test_app.py` 用例。
- 纯函数测试放文件上部，API 测试用 `client` fixture，E2E 用 `sample_video` fixture（缺 ffmpeg 自动 skip）。
- 交付前必跑：`.venv/bin/python -m pytest -q`（应 39 passed）+ `pnpm build`（应 0 error）。
- UI/交互改动需按 `tests/manual-test.md` 自查对应条目。

---

## 3. AI Agent 开发指导 ★最高优先级★

### 3.1 改动前必须了解的内容

1. 后端任务状态是 `finished` / `failed` / `cancelled` / `queued` / `running`——**没有** `done`。
2. 任务产物的全部信息（大小/编码/分辨率/时长/文件数）由 `_record_split_result` 或 `_record_compress_result` 在**执行完成时**写入 task 记录。
3. 前端产物列表 = `uploads/` 全部 + `outputs/` 中**已加入 `addedOutputs`** 的部分。
4. 改了 `src/` 必须 `pnpm build`，Flask 托管的是 `dist/`。
5. 项目用 `.venv/bin/python`（系统 python3 无 Flask）。
6. 提交纪律：先更新 `docs/CHANGELOG.md`，提交后把条目归档到「已提交记录」（见 §5.6）。

### 3.2 禁止随意修改的文件（含原因）

| 文件 / 目录 | 原因 |
| --- | --- |
| `tasks.json` | 运行时任务状态，含本机绝对路径；手工改会与内存 `TASKS` 不一致（已 gitignore） |
| `outputs/`、`uploads/` | 运行时数据与用户文件；`outputs/merge_list_*.txt` 等是中间产物（已 gitignore） |
| `dist/` | Vite 构建产物，改动会被下次 build 覆盖，应改 `src/` 源文件（已 gitignore） |
| `pnpm-lock.yaml` | 锁文件；除显式增删依赖外不要动，改依赖请用 `pnpm add/remove` |
| `.venv/` | 本地虚拟环境 |
| `llms.txt` | 面向 AI 爬虫的对外摘要；改动需与 README 描述保持一致 |

### 3.3 强依赖关系（改动联动表）

| 改这里 | 必须同步改 |
| --- | --- |
| 新增功能 Tab | `store.ts` 的 `TabKey` 联合类型 **+** `TABS` 数组（含 SVG path）→ 新建 `panels/XxxPanel.tsx` → `panels/index.ts` 导出 → `App.tsx` import 与 `<Show when={activeTab() === "xxx"}>` → `api.ts` 加请求函数（含 `withTemplate`）|
| 新增后端任务类型 | `app.py` 新 `api_xxx`：`new_task(..., extra={"kind": "xxx"})` → 用 `_build_output_name` 生成产物名 → 完成记录（非 compress 自动走 `_record_split_result`，无需额外代码）→ 前端 `Task` 接口补字段 |
| 改任务字段名/新增字段 | `app.py` 写入点 **+** `src/api.ts` 的 `Task` 接口 **+** `Tasks.tsx` 渲染（前后端契约，缺一即失效） |
| 改输出文件名规则 | 只需改 `_build_output_name` / `_sanitize_template`；**不要**在单个 API 里拼文件名 |
| 改产物「添加」逻辑 | `src/addedOutputs.ts` **+** `Sidebar.refreshFiles` 的过滤条件 **+** `Tasks.tsx` 的 `isVideoOutput` 判定 |
| 改 UI 布局/间距 | `docs/UI-DESIGN.md`（规范文档）+ `src/styles.css`；保持 `.actions` 在 `aside` 之后 |
| 改面板表单字段 | 该面板组件 **+** `api.ts` 请求参数类型 **+** 后端对应 `api_*` 的 `data.get` 键名（snake_case）|
| 改并发/闸门 | `ffmpeg_acquire/release`、`inpaint_acquire/release`、`_default_ffmpeg_slots`；注意排队态要置 `queued` |
| 改 README 接口表 | 必须与 `app.py` 实际 `data.get(...)` 参数一致（历史上多次脱节） |

### 3.4 常见错误模式（真实踩坑，含现象 → 根因 → 正确做法）

| 现象 | 根因 | 正确做法 |
| --- | --- | --- |
| `X is not a function`，组件挂载即崩 | `createStore` 返回 **Proxy 对象**，被当成函数调用（曾写 `tasks()`、`files()`） | 直接写 `tasks` / `files`，取长度用 `tasks.length` |
| 接口数据到了但 UI 停在 0% / 不更新 | `setTasks(idx, fn)` 返回了**同一对象引用**，Solid 认为值未变、不通知订阅者 | 返回新对象：`setTasks(idx, (cur) => ({ ...cur, ...t }))` |
| 任务完成后列表/产物不自动刷新 | 前端判断 `status === "done"`，后端实际是 `"finished"` | 统一用 `"finished"`（见 §3.1） |
| `Set.prototype.size` 报 incompatible receiver | 用 `createStore` 包裹原生 `Set`（Proxy 破坏 getter） | 用 `createSignal<Set<string>>` |
| 产物文件名里的中文消失 | 用了 `secure_filename` 清洗输出名 | 输出命名只用 `_build_output_name`（仅剥离路径穿越与不可见字符） |
| 浏览器报错定位不到源码 | sourcemap 未开 | 已在 `vite.config.js` 设 `sourcemap: true`；报错可直接映射到 `.tsx` 行号 |
| 前端改了但页面没变 | 未 `pnpm build`，Flask 仍托管旧 `dist/` | `pnpm build` 后硬刷新（Cmd+Shift+R） |
| 起服务报 `No module named 'flask'` | 用了系统 python3 | 用 `.venv/bin/python app.py` 或 `./start.sh` |
| 访问根路径 403 | 端口落在 macOS AirPlay 占用的 5000 | 保持 8080（或 `PORT` 指定其他端口） |
| 任务列表大小「有的显示有的没显示」 | 只有部分 kind 记录了产物信息 | 完成记录必须覆盖所有任务类型（非 compress 统一走 `_record_split_result`） |
| 测试污染真实数据 | 未走测试隔离 | `tests/conftest.py` 已设 `CLIPBENCH_TEST=1` + monkeypatch 临时目录；**不要在测试里 import 后直接跑真实路径** |

### 3.5 推荐开发流程

1. **改前**：读 `docs/CHANGELOG.md` 待提交改动（了解近期上下文）+ 涉及 UI 时读 `docs/UI-DESIGN.md`；用符号名搜索定位（别依赖行号）。
2. **改中**：对照 §3.3 联动表把关联文件一次改全；后端新接口同时补测试。
3. **改后**：`.venv/bin/python -m pytest -q` → `pnpm build` → 浏览器实测关键路径（上传 → 处理 → 任务卡片产物信息 → 「添加」→ 列表出现）。
4. **提交前**：更新 `docs/CHANGELOG.md`「待提交改动」；commit message 用 `feat:` / `fix:` / `docs:` / `refactor:`（可选 scope，如 `feat(split):`）+ 中文描述。
5. **提交后**：把 CHANGELOG 条目从「待提交改动」移到「已提交记录」并标注提交哈希。

### 3.6 Debug 排查顺序

| 症状 | 排查顺序 |
| --- | --- |
| 页面白屏 / 崩溃 | 浏览器 Console（sourcemap 已开）→ 是否 `createStore` 当函数调用 / 新引入的 undefined 导入 |
| 任务卡在 0% | `_run_ffmpeg_locked` 是否解析到 `out_time_ms`（`duration` 为 0 时进度为 `None`）→ 是否每次解析后 `save_tasks()` |
| 任务一直 `queued` | 正常排队（闸门限流）：查 `_FFMPEG_SLOTS` / `CLIPBENCH_FFMPEG_SLOTS`；inpaint 恒为 1 个并发 |
| 任务失败 | 前端任务卡片「日志」按钮看 `task["log"]`（ffmpeg 完整输出）→ 服务端 `/tmp/clipbench.log` |
| 产物文件不存在 | 查 `OUTPUT_DIR` 与 `task["output_name"]`；是否被「清空」或 `api_task_delete` 连带删除 |
| 产物没出现在侧栏 | 确认已点「添加」（`addedOutputs`）→ 查 `/api/files?outputs=1` 返回 → `refreshFiles` 的过滤条件 |
| 缩略图 404 | `_find_media` 会同时查 uploads 与 outputs；`IMAGE_EXTS` / `_is_ignored_file` 是否误排除 |
| 服务起不来 | 端口占用（`lsof -ti:8080`）→ `.venv` 依赖 → `/tmp/clipbench.log` |

### 3.7 如何避免破坏已有功能（回归清单）

- [ ] `.venv/bin/python -m pytest -q` → **39 passed**
- [ ] `pnpm build` → 无报错（新 hash 产物）
- [ ] 上传文件 → 媒体信息卡片有编码标签
- [ ] 跑一个压缩任务 → 进度平滑增长 → 完成后卡片显示 源/输出 对比与大小
- [ ] 跑一个非压缩任务（如截图）→ 卡片显示「输出 xx KB」
- [ ] 点任务卡片「添加」→ 产物出现在侧栏（带「产物」徽标，可二次处理）
- [ ] 删除任务 / 取消运行中任务 / 清空列表均正常
- [ ] 侧栏「输出文件名模板」设置后，新任务产物名符合模板

---

## 4. 文档索引

| 文档 | 路径 | 用途 | 重要度 | 何时查看 |
| --- | --- | --- | --- | --- |
| AGENTS.md | `./AGENTS.md` | 本文件：Agent 开发指南与索引 | 🔴必读 | 每次开始改动前 |
| CHANGELOG | `docs/CHANGELOG.md` | 改动日志 + 「待提交改动」区；项目要求的提交前置动作 | 🔴必读 | 改动前了解上下文、提交前写入 |
| UI 设计文档 | `docs/UI-DESIGN.md` | 布局体系、设计 Token、三种布局模板、DOM 顺序约束 | 🔴必读（UI 改动） | 改样式 / 加面板 / 调布局时 |
| README | `README.md` | 对外功能说明 + 28 个 API 概览 + 环境变量 | 🟡常用 | 确认接口语义、同步文档时 |
| README_EN | `README_EN.md` | 英文版（国际用户 / 搜索优化） | 🟢参考 | 改中文 README 时考虑同步 |
| 功能建议 | `docs/todo.md` | 历史建议与状态（**部分已过时**，见 §5.5） | 🟢参考 | 规划新功能时 |
| 手工测试清单 | `tests/manual-test.md` | 浏览器端 UI 回归项 | 🟡常用 | UI/交互改动后自查 |
| 自动化测试 | `tests/test_app.py` | 39 个用例，含 API 契约与端到端流程 | 🔴必读（改后端） | 改接口 / 加校验时 |
| AI 摘要 | `llms.txt` | 面向 AI 爬虫的对外项目摘要 | 🟢参考 | 改对外描述时 |

**快捷路由（问题 → 文档）**

- 布局 / 间距 / 面板结构 → `docs/UI-DESIGN.md`
- API 参数 / 环境变量 → `README.md`「API 概览」+ `app.py` 对应 `api_*`
- 测试怎么写 / 隔离机制 → `tests/conftest.py` + `tests/test_app.py`
- 最近改了什么 / 为什么 → `docs/CHANGELOG.md`
- 该不该做 / 做到哪了 → `docs/todo.md`（注意时效性）

---

## 5. 当前项目状态

### 5.1 已完成模块

- 11 个功能全部可用：去字幕（4 模式，含 OpenCV inpaint）、拆分（按时长/片段，GIF）、截图（jpg/png/webp/avif）、格式转换、压缩（x264/x265 自适应 + 智能建议）、裁剪、合并（h264/hevc/copy + 一致性校验）、旋转/翻转、水印（文字/图片）、调速（0.5–4x + 倒放）、音频提取（mp3/m4a/wav/flac）。
- 任务闭环：SSE 实时进度、失败日志弹窗（可复制）、运行中取消、删除任务并清理输出、孤儿任务巡检、启动时回填历史任务产物大小。
- 产物管理：文件名模板（`{name}{ext}{ts}{date}{time}`）、任务卡片产物大小/编码/分辨率、「添加」按钮回流到媒体列表。
- 质量保障：39 个 pytest 用例、手工测试清单、UI 设计文档、CHANGELOG 流程。
- 开源配套：MIT 许可证、中英双语 README、badges、`llms.txt`。

### 5.2 开发中的模块

无（工作区干净，无进行中的半成品）。

### 5.3 未完成计划（摘自 `docs/todo.md`）

- P1 批量操作：选中多个文件后「应用到全部选中」（除合并外当前均为单文件）。
- P2 Tab 快捷键（1-9 切换、空格暂停预览）。
- P2 桌面化打包（Tauri / Electron）。
- P2 任务重试（失败任务一键带原参数重跑）。
- P3 亮色主题切换。
- P3 任务完成浏览器系统通知（Notification API）。

### 5.4 技术债务

| 位置 | 问题 | 影响 |
| --- | --- | --- |
| `app.py`（2216 行单文件） | 全部路由 + 任务队列 + ffmpeg 逻辑混在一个文件 | 定位需靠符号搜索；建议后续按域拆分（routes / tasks / ffmpeg）|
| `docs/todo.md` | 多个条目状态过时（见 §5.5） | 可能误导规划判断 |
| `README.md` 曾与代码脱节 | API 参数表落后于实现（已于 2026-09-02 修正） | 需在改接口时同步 |
| 产物「添加」仅支持单文件视频 | 多文件产物（拆分目录、截图目录）无法添加 | 已知限制，非 bug |
| `_record_split_result` 命名 | 实际已服务所有任务类型，名称仍带 `split` | 语义误导（改动时注意它不只服务拆分）|

### 5.5 已知问题

- `docs/todo.md` 中「输出目录管理」标为未完成，实际该方案已实施后**又被移除**（改为任务列表「添加」按钮）；「输出文件名模板」标为未完成，实际已实现（2026-08-27）。阅读该文件时需与 CHANGELOG 交叉验证。
- 产物文件若被删除，历史任务卡片的产物大小显示为 `—`（文件不存在无法探测，属预期行为）。
- 前端单文件视频产物才出现「添加」按钮（`VIDEO_EXTS` 判定），图片/音频/多文件产物不支持。

### 5.6 后续规划 / 路线图

1. 按 §5.3 推进 todo 中 P1–P2 项（批量操作优先级最高）。
2. 视体量拆分 `app.py`，降低 Agent 与人的定位成本。
3. 保持 CHANGELOG 流程：改动 → 记「待提交改动」→ 提交 → 归档「已提交记录」。

---

## 6. 变更记录（本文件）

- 2026-09-14：首次创建。基于当时的代码与文档实测取证（`app.py` 2216 行、39 个测试用例、无既有 AGENTS.md/CLAUDE.md）。
