# 湘舍动公益文件系统 — 使用指南

**版本**: 2.2 | **最后更新**: 2026年4月

---

## 快速开始

### 登录
所有用户使用Google OAuth登录。首次登录后，管理员会将用户添加到Users表中进行授权。

### 用户操作
1. **上传照片**: 仪表板 → Upload Photos → 选择赛事 → 选择文件 → 4步流程
2. **查看照片**: 仪表板 → Browse Drive 查看Google Drive中的有组织文件
3. **分享相册**: 联系管理员获取Google Photos相册链接(每个赛事自动创建)

### 管理员操作
1. **创建赛事**: Events → New Event (自动生成YYYY-MM-DD_EventName文件夹)
2. **管理用户**: Users → 添加/编辑/停用用户并分配角色
3. **管理跑团**: Clubs → 添加/编辑/停用跑团
4. **查看报告**: Summary → 按赛事/跑团的上传统计、违规、导出CSV

---

## 系统架构

### 三层级文件夹结构 (Google Drive)

```
📁 湘舍动公益文件系统
├── 📁 YYYY-MM-DD_EventName          (第1层: 赛事, 管理员创建)
│   ├── 📁 ClubName                  (第2层: 跑团, 首次上传时自动创建)
│   │   └── 📁 YYYYMMDD-HHMMSS_user  (第3层: 批次, 每个会话自动生成)
│   │       ├── photo1.jpg
│   │       └── photo2.jpg
│   └── 📁 AnotherClub
│       └── ...
└── 📁 2025-10-30_Another_Event
    └── ...
```

### 文件夹命名规则

| 层级 | 模式 | 示例 | 验证 |
|------|------|------|------|
| 赛事 (L1) | `YYYY-MM-DD_Title_Case_Name` | `2025-11-03_NYC_Marathon` | ✅ 严格 |
| 跑团 (L2) | 必须与Clubs表中批准的跑团匹配 | `New_Bee` | ✅ 严格 |
| 批次 (L3) | `YYYYMMDD-HHMMSS_username` | `20251103-093500_cathylin` | 自动生成 |
| 文件 (L4+) | 保留原始文件名 | `DSC_0042.jpg` | 仅类型检查 |

---

## 用户角色和权限

| 角色 | 权限 |
|------|------|
| **admin** | 完全访问: 管理用户/跑团/赛事、查看报告、核算上传 |
| **user** | 上传照片、浏览赛事、查看跑团文件夹 |
| **api_client** | 编程式REST API访问(无web UI) |

---

## 照片上传 (4步流程)

### 步骤1: 选择赛事
从卡片网格中选择赛事。如需要，使用日期过滤器缩小列表。

### 步骤2: 查看跑团文件夹
查看您的跑团在此赛事的现有批次文件夹(只读)。点击**Continue**继续。

### 步骤3: 选择文件
- **支持的格式**: JPEG、PNG、HEIC
- **文件限制**: 单个文件≤50 MB，批次≤200 MB
- **重复检测**: 系统按文件名+大小检测;选择跳过或覆盖

### 步骤4: 结果摘要
```
✅ 已上传: N张照片, X MB
⏭️ 跳过重复: N
🚫 跳过非照片: N
```

照片自动同步到Google Photos相册(赛事相册和跑团相册)。

---

## 管理员任务

### 赛事管理

**创建赛事:**
1. Events → New Event
2. 输入名称(例如"Boston Marathon")
3. 选择日期
4. 系统生成文件夹名称`YYYY-MM-DD_Event_Name`并创建Drive文件夹 + Google Photos相册

**编辑赛事:**
- 点击编辑图标 → 更新名称或日期(文件夹名称不可变)

**检查违规:**
- Events页面扫描第1-2层的命名违规
- 如发现违规,显示橙色横幅;点击**View Details**查看和修复

### 用户管理

**添加用户:**
1. Users → Add User
2. 输入电子邮件、选择跑团、选择角色(admin/user/api_client)
3. 用户可立即登录

**编辑用户:** 点击编辑图标 → 更新跑团或角色

**停用用户:** 点击停用图标 → 用户无法登录(历史记录保留)

**批量导入:** 粘贴行到Users表,列顺序: email, running_club, role, status, added_date, added_by

### 跑团管理

**添加跑团:**
1. Clubs → Add Club
2. Display Name: 人类可读名称(例如"New Bee Runners")
3. Normalized Name: 文件夹名称(例如"New_Bee") — 必须匹配`[A-Za-z][A-Za-z0-9]*(_[A-Za-z][A-Za-z0-9]*)*`

**编辑跑团:** 点击编辑图标 → 更新名称(现有Drive文件夹不变)

**停用跑团:** 点击停用图标 → 跑团从上传/用户注册下拉列表中移除(文件夹保留)

### 核算和报告

**Summary仪表板:**
1. Summary → 选择日期范围
2. 查看表格: 按赛事/跑团的上传、零上传的赛事、命名违规
3. **导出CSV**: 下载完整报告
4. **Exception Email**: 发送违规报告到管理员邮箱

---

## 数据模型 (Google Sheets)

### Users表 (用户表)
| email | running_club | role | status | added_date | added_by |
|-------|-------------|------|--------|------------|---------|

### Events表 (赛事表)
| event_id | event_name | event_date | folder_name | drive_folder_id | created_by | created_at |
|----------|-----------|-----------|------------|-----------------|-----------|----------|

### Upload_Log表 (上传日志表)
| log_id | event_id | club_name | uploaded_by | batch_folder_name | batch_folder_id | file_count | total_size_mb | skipped_duplicates | skipped_non_photo | upload_timestamp | source |
|--------|----------|----------|------------|------------------|-----------------|-----------|---------------|-------------------|------------------|------------------|--------|

### Clubs表 (跑团表)
| display_name | normalized_name | status | created_date |
|-------------|-----------------|--------|--------------|

### Photos_Albums表 (v1.x) (相册表)
| albumId | albumType | eventId | clubName | albumTitle | albumUrl | shareableUrl | createdAt | lastSyncAt | syncedFileCount |
|---------|-----------|---------|----------|-----------|----------|-------------|-----------|-----------|-----------------|

---

## Google Photos相册

**每个赛事自动创建:**
- **赛事相册**: 包含该赛事所有跑团的照片(赛事创建时创建)
- **跑团相册**: 包含一个跑团对该赛事的照片(该跑团首次上传时创建)

**同步时机:**
- 赛事创建 → 赛事相册创建
- 首次跑团上传 → 跑团相册创建
- 每次上传完成 → 照片推送到两个相册

**分享相册:**
- 联系管理员获取可分享链接
- 或在GAS编辑器中运行`serverGetEventAlbums({ eventId: "<eventId>" })`

**手动同步(管理员):**
- `serverSyncAlbum({ eventId: "<eventId>" })` — 同步一个赛事
- `serverBackfillAlbums({})` — 同步所有赛事(幂等;可安全重新运行)

---

## REST API (合作组织)

### 先决条件
- 注册为`api_client`用户
- 接收: Web应用URL + API密钥(您的注册电子邮件)

### 身份验证
将API密钥作为查询参数传递: `?api_key=your.email@partnerorg.com`

### 速率限制
每个API密钥每小时60个请求

### 端点

**检查文件夹** (GET):
```
GET {BASE_URL}?action=api_check_folder&event_folder_name=2025-11-03_NYC_Marathon&api_key=...
```
响应: `{ status, code, data: { folderId, exists } }`

**列出文件** (GET):
```
GET {BASE_URL}?action=api_list_files&folder_id=DRIVE_FOLDER_ID&api_key=...
```
响应: `{ status, code, data: [ { name, size, mimeType, modifiedTime }, ... ] }`

**上传文件** (POST):
```
POST {BASE_URL}?action=api_upload_file&api_key=...
Body: { eventId, clubName, fileName, mimeType, base64Data }
```
响应: `{ status, code, data: { fileId, batchFolderName } }`

### 错误代码
| 代码 | 含义 |
|------|------|
| 200 | 成功 |
| 400 | 错误的请求 |
| 403 | 禁止(无效API密钥) |
| 404 | 未找到 |
| 409 | 重复文件 |
| 415 | 不支持的文件类型 |
| 429 | 超出速率限制 |
| 500 | 服务器错误 |

**示例客户端**: 见仓库中的`example/partner-client.gs`

---

## 故障排除

### 登录问题
| 错误 | 解决方案 |
|------|--------|
| "您的账户未注册" | 联系管理员将您的电子邮件添加到Users表 |
| "您的账户已被停用" | 联系管理员重新激活 |
| "部署后需要授权" | 重新打开应用;Google会提示新的OAuth范围;点击Allow |

### 上传问题
| 错误 | 解决方案 |
|------|--------|
| "不支持的文件类型" | 仅使用JPEG、PNG或HEIC |
| "文件太大" | 文件必须≤50 MB;批次≤200 MB |
| "检测到重复" | 选择跳过或覆盖;或检查跑团文件夹历史 |
| 上传中途失败 | 重试;部分文件可能已上传 |

### 赛事/文件夹问题
| 错误 | 解决方案 |
|------|--------|
| 选择器中看不到赛事 | 管理员必须先创建赛事 |
| 命名违规横幅 | 在Drive中手动重命名或删除违规文件夹;刷新 |
| 赛事创建但相册未创建 | 在GAS编辑器中运行`serverSyncAlbum({ eventId })` |
| 照片已上传但不在相册中 | 运行`serverSyncAlbum({ eventId })`重试同步 |

### API问题
| 错误 | 解决方案 |
|------|--------|
| "无效的API密钥" (403) | 验证密钥是您的注册电子邮件 |
| "超出速率限制" (429) | 等待1小时供计数器重置 |
| `api_check_folder`返回`exists: false` | 先通过管理员UI创建赛事 |

---

## 维护和支持

### 管理员事项
- **部署**: 见`gas-app/SETUP.md`
- **用户入职**: 添加到Users表(电子邮件、跑团、角色)
- **赛事设置**: 用户上传前创建赛事
- **监控**: 定期查看Summary仪表板以了解违规和活动

### GAS函数(管理员)
```javascript
// 同步特定赛事到Google Photos
serverSyncAlbum({ eventId: "<eventId>" })

// 同步所有赛事(幂等)
serverBackfillAlbums({})

// 获取赛事的相册链接
serverGetEventAlbums({ eventId: "<eventId>" })
```

### 报告
- 上传统计: Summary → 选择日期范围 → 查看/导出
- 违规: Summary → "Naming violations"部分 → 点击"Send Exception Email"
- CSV导出: Summary → "Export CSV"

---

## 联系方式

**系统管理员**: cathy.lin@mmrunners.org  
**电子邮件**: admin@mmrunners.org

---

## 版本历史

| 版本 | 日期 | 更改 |
|------|------|------|
| 2.2 | 2026年4月 | 第6阶段: Google Photos相册;统一文档 |
| 2.1 | 2026年3月 | REST API、速率限制、跨组织访问 |
| 2.0 | 2026年2月 | 管理员摘要、核算、违规扫描 |
| 1.0 | 2026年1月 | 核心: 上传、用户管理、跑团管理 |
