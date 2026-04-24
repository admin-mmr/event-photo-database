# 湘舍动公益文件系统 / MM Runners Photo Archive

A Google-native event photo management system for running clubs. Built on Google Apps Script, Google Drive, and Google Sheets — no external server required.

---

## What It Does

Running clubs upload race photos through a web interface. The system automatically organizes everything into a three-level Google Drive folder hierarchy, enforces consistent naming, checks for duplicates, and logs every upload. Administrators manage users, events, and club registrations through the same interface. Partner organizations can also upload programmatically via a REST-style API.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend + Backend | Google Apps Script (GAS) Web App (HTML Service) |
| Storage | Google Drive |
| Database | Google Sheets (Users, Events, Upload_Log, Rate_Limit, Clubs) |
| Auth | Google OAuth (single sign-on) |
| Hosting | GAS Web App deployment |
| Local Dev | TypeScript + esbuild + clasp + Jest |

## Folder Structure (Google Drive)

```
📁 [ROOT] 湘舍动公益文件系统
│
├── 📁 YYYY-MM-DD_EventName        ← Layer 1: Event folder (admin creates)
│   │                                  e.g. 2025-11-03_NYC_Marathon
│   │
│   ├── 📁 ClubName                ← Layer 2: Club folder (auto-created on first upload)
│   │   │                              e.g. New_Bee | Misty_Mountain | Nankai
│   │   │
│   │   └── 📁 YYYYMMDD-HHMMSS_user  ← Layer 3: Upload batch (auto-created per session)
│   │       ├── photo1.jpg
│   │       └── photo2.jpg
│   │
│   └── 📁 AnotherClub
│       └── ...
│
└── 📁 2025-10-30_Another_Event
    └── ...
```

All three layers are validated by the system. Naming violations are detected automatically and flagged to administrators.

## User Roles

| Role | Access |
|------|--------|
| `user` | Sign in, browse events, upload photos for their club |
| `admin` | All user permissions + manage users, events, clubs, view summary reports |
| `api_client` | Programmatic REST API access for partner organizations |

## Key Features (v1.0 — All Phases Complete)

- **Authentication**: Google OAuth single sign-on; no separate registration
- **User management**: Add, edit, deactivate, and reactivate users via Admin UI
- **Club management**: Clubs managed via a live Clubs sheet; admin-editable through the UI
- **Event management**: Create and update events with automatic Drive folder creation
- **Photo upload**: 4-step guided flow with type filtering (JPEG, PNG, HEIC), duplicate detection, and per-file progress
- **Upload logging**: Every upload session is recorded to the Upload_Log sheet with full metadata
- **Admin summary dashboard**: Upload stats by event and club, events with no activity, CSV export, exception email alerts
- **Folder naming enforcement**: Layer 1–2 violations are detected on every scan and reported to admins
- **Cross-org REST API**: Partner GAS scripts can query folders, list files, and upload photos via HTTP
- **Rate limiting**: 60 requests/hour per API key enforced via the Rate_Limit sheet

## Documentation

| Document | Description |
|----------|-------------|
| [`USER_GUIDE.md`](USER_GUIDE.md) | Complete system guide: all features, workflows, troubleshooting (English) |
| [`USER_GUIDE.docx`](USER_GUIDE.docx) | Complete system guide (English, Word format) |
| [`使用指南.md`](使用指南.md) | 完整系统指南：所有功能、工作流程、故障排除 (中文) |
| [`使用指南.docx`](使用指南.docx) | 完整系统指南 (中文, Word格式) |
| [`gas-app/SETUP.md`](gas-app/SETUP.md) | Step-by-step deployment and development setup |

## Local Development

```bash
cd gas-app
npm install
npm test                  # Run all tests with coverage
npm run typecheck         # TypeScript type check
npm run push              # Push to Google Apps Script (requires clasp login)
```

Test coverage targets: ≥85% statements, ≥80% branches, ≥85% functions, ≥85% lines.

See [`gas-app/SETUP.md`](gas-app/SETUP.md) for the full deployment walkthrough.

## Future Plans (v2)

A planned migration to Node.js + Firebase will retain all naming conventions and folder structure while gaining better scalability, background job support, and Firestore-based queries. See the Features & Roadmap documents for a detailed wishlist.
