# 定格动画逐帧拍摄台账（gbstopmotion）

面向定格动画的动画师与摄影助理，把镜头拆分、逐帧位移量、拍摄参数与**逐帧拍摄台账**记录成可执行的拍摄清单：新建镜头后按帧率与时长自动排帧区间，在帧序条带上插入、移除、移动格子并重算时长；**每格按自己的张数登记已拍与废片，废片自动重算进待拍，该格、镜头、总览进度即时联动；张数下调或格子移出条带时，已拍超量不会消失，自动留进补拍清单**；格子拥有永久 uid，切换镜头或关掉页面再回来，台账仍按原格对应，历史每日实拍记录照常使用。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21830>

停止（镜像保留）：

```bash
docker compose down
```

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + TypeScript） |
| 构建 | Vite 5 + `vue-tsc -b`（类型检查零错误） |
| 状态 | Pinia（`shotStore` / `frameStore` / `ledgerStore` / `uiStore`） |
| 路由 | Vue Router 4（HTML5 History，nginx `try_files` 兜底） |
| UI | Element Plus + 自研轻量组件 |
| 本地存储 | IndexedDB（Dexie，库名 `gbstopmotion-db`）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（多阶段构建，gzip + 前端路由回落） |

## 目录结构

```
sologsb-1130/
├── docker-compose.yml        # 顶层 name: gbstopmotion，端口 ${FRONTEND_PORT:-21830}
├── .env / .env.example       # COMPOSE_PROJECT_NAME=gbstopmotion
└── frontend/
    ├── Dockerfile            # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf            # try_files $uri $uri/ /index.html + gzip
    ├── public/favicon.svg
    └── src/
        ├── types/{shot,frame,prop,take}.ts        # 4 个数据模型（take 含补拍清单）
        ├── stores/{shotStore,frameStore,ledgerStore,uiStore}.ts
        ├── components/common/{FrameStrip,RegisterTakeForm,ExposureForm,ShotProgress,StatusTag,EmptyState}.vue
        ├── hooks/{useFrameSequence,useLocalDraft}.ts
        ├── pages/{Overview,ShotNew,ShotDetail,FrameBoard,PropTrack,TakeLog}.vue
        ├── router/index.ts
        ├── utils/{frameMath,ledger,exposure,format}.ts
        └── db/{index,api}.ts                      # Dexie 实例（v1→v4 升级迁移）与读写层
```

## 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 进度总览 | 各镜头格子数/计划张数、逐格完成度、待拍与补拍清单条数，累计全片张数 |
| `/shots/new` | 新建镜头 | 填写镜号、场景名、帧率与时长，保存后生成帧区间与首位格子 |
| `/shots/:id` | 镜头详情 | 镜头参数、带台账状态的帧序条带、逐帧台账表格、逐格登记、实拍流水、补拍清单、道具轨迹 |
| `/frames` | 帧序编排台 | 移动/插入/移除格子、批量套用曝光，改动后重排序号与总时长（格子 uid 不变） |
| `/props` | 道具位移轨迹 | 按镜头与帧区间登记 X/Y/Z 与旋转角度，曲线预览累计位移 |
| `/progress` | 实拍·补拍台账 | 逐格登记实拍/废片；每日按镜头汇总的实拍台账（含旧整天记录）；超量好张补拍清单与归档 |

## 逐帧台账规则

- **每格按自己的张数记账**：条带上每格显示 `已拍 / 废片 / 待拍`。好张 = 已拍 − 废片；待拍 = max(0, 该格张数 − 好张)。
- **废片重算待拍**：登记废片后好张不增加，待拍自动把废片张数加回（拍 2 废 1 → 还需补拍 1）。
- **三档进度联动**：一次登记同时重算该格、所属镜头与全片总览（完成度按好张/计划张数）。
- **超量不消失（补拍清单）**：
  - 该格张数下调、或登记张数超过计划 → 超量好张进入补拍清单，并随该格计划**实时重算**（再调回张数或删除多拍登记即自动核销归档）；
  - 格子从条带移除 → 软删除（`active=false`），已拍好张按**固定快照**留在补拍清单，条带位次重排、格子 uid 不变；
  - 核销只做人工归档，历史记录始终保留。
- **格子身份永久稳定**：每格有 `uid`，插入/移动只新增或改 `frameNo`，不再整表删除重建；实拍记录引用 uid，切镜头、关页面再回来仍对回原格。
- **历史数据兼容**：v3 及以前「按整天登记」的实拍记录以 `frameUid=null` 保留，每日台账照常汇总显示，只是不对格冲抵待拍。

## 数据存储

- **IndexedDB（Dexie，`gbstopmotion-db`）**：镜头、格子（帧条目）、道具状态、实拍记录、补拍清单五张表。
  版本迁移：`v1` 建 `shots` / `frames`；`v2` 增加 `props` 表与 `shotId` 索引；`v3` 增加 `takes` 表并按实拍张数回填进度；`v4` 逐帧台账——格子补 `uid/label/active` 永久身份，实拍记录补 `frameUid/frameLabel/frameNo/note`（旧整天记录 `frameUid=null` 原样保留），新增 `pickups` 补拍清单表。
- **localStorage**：新建镜头表单与批量曝光参数草稿，键前缀 `gbstopmotion:draft:`。
- 全部数据存在浏览器本地，容器无状态、不使用数据库服务、不挂载命名卷，无任何后端接口调用。
