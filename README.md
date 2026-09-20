# Scentinova API

Node + Express + MongoDB backend for the Scentinova storefront.

## Setup

```bash
npm install
cp .env.example .env
# MONGODB_URI=mongodb://127.0.0.1:27017/scentinova
npm run seed
npm run seed:admin
npm run dev
```

API: `http://localhost:5000/api`  
Health: `GET /api/health`

## Scripts

- `npm run dev` — nodemon
- `npm start` — production
- `npm run seed` — upsert 4 house signatures
- `npm run seed:admin` — create admin from env
