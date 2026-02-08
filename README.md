# Slash Restore 🛠️🔍

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron-30-9839da?style=for-the-badge&logo=electron)](https://electronjs.org/)
[![React](https://img.shields.io/badge/React-18-blue?style=for-the-badge&logo=react)](https://reactjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=for-the-badge&logo=typescript)](https://typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5-orange?style=for-the-badge&logo=vite)](https://vitejs.dev/)

Slash Restore is a **cross-platform data recovery application** designed for recovering files from damaged or formatted storage devices. Using advanced file carving techniques and filesystem parsers, it helps retrieve lost data effortlessly.

## ✨ Features

- **🗂️ File Carving**: Signature-based recovery for JPEG, PNG, PDF, MP4, AVI, HEIC, RAW, ZIP, and more.
- **💾 Filesystem Support**: NTFS, EXT4, FAT32, exFAT, HFS+ parsers with automatic detection.
- **🌐 Cross-Platform**: Native support for **Linux**, **macOS**, and **Windows**.
- **👁️ Preview Mode**: Safe preview of carved files before recovery.
- **🔒 Privilege Handling**: Secure raw block device access with elevated privileges.
- **⚡ Modern Stack**: Electron + Vite + React + Tailwind CSS + Radix UI + Lucide Icons + Zustand.
- **🧪 Workers**: Dedicated carving and metadata processing in Web Workers for performance.

## 🚀 Quick Start

### Prerequisites
- Node.js ≥ 20
- [Bun](https://bun.sh/) (recommended for faster installs)

### Development
`bash
git clone https://github.com/slashbinslashnoname/slash-restore.git
cd slash-restore
bun install
bun run dev
`

### Production Build
`bash
bun run build
`

### Platform Packages
`bash
bun run pack:linux    # Linux AppImage/DEB/RPM
bun run pack:mac      # macOS DMG
bun run pack:win      # Windows EXE/NSIS
`

## 🧪 Testing
`bash
bun run test          # Run tests
bun run test:watch    # Watch mode
bun run typecheck     # TypeScript check
`

## 📦 Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start dev server |
| `bun run build` | Build production bundles |
| `bun run preview` | Preview built app |
| `bun run pack:linux/mac/win` | Build platform installers |

## 📂 Project Structure

`
src/
├── core/           # Core recovery logic (carving, FS parsers, IO)
├── main/           # Electron main process (IPC, device enum)
├── preload/        # Preload scripts
├── renderer/       # React app (UI)
└── shared/         # Shared types/utils
`

## 🔧 Tech Stack

- **Frontend**: React 18, Tailwind CSS, Radix UI Primitives, Lucide React Icons, Zustand
- **Backend**: Electron 30, TypeScript 5.4, Vite 5
- **Build**: Electron Vite, Electron Builder
- **Testing**: Vitest

## 📱 Icon & Branding

- **App Icon**: Add high-res icons to `public/` (512x512 PNG recommended).
- **Repo Icon**: Upload `slash-restore-logo.png` to repo root for GitHub display.
- **Favicon**: Configure in `src/renderer/index.html`.

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'feat: add amazing feature'`)
4. Push (`git push origin feature/AmazingFeature`)
5. Open PR

## 📄 License

This project is [MIT](LICENSE) licensed.

---

⭐ **Star us on GitHub** if this helps your data recovery needs!  
💬 [Issues](https://github.com/slashbinslashnoname/slash-restore/issues) & [Discussions](https://github.com/slashbinslashnoname/slash-restore/discussions) welcome.