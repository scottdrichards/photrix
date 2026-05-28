# Getting Started

Development and deployment setup for Photrix.

## 1) Prerequisites

- Reverse proxy is configured in front of server (for production deployment)

## 2) Install

```bash
npm --prefix server install
npm --prefix client install
npm --prefix server run face:python:install
```

## 3) Configure environment

Copy the template and edit values for your deployment:

```powershell
Copy-Item server/.env.example server/.env
```

Use `server/.env.example` as the source of truth for required settings.

## 4) Start services

```bash
npm --prefix server run start
npm --prefix client run dev
```

## 5) Local development

Just start both services:

```powershell
npm --prefix server run start
npm --prefix client run dev
```

Open `http://localhost:5173`.
