# ProjectChat

ProjectChat is a WhatsApp-style project workspace. Projects are containers; each subproject is a focused chat with tasks, mentions, status updates, and full or read-only access.

The workspace has one global administrator. New open signups remain pending until the administrator approves them and assigns a project. Only the administrator can create or delete projects/chats and invite or approve members.

The Admin workspace includes a global member directory for direct project/subproject assignment, role changes, and access removal without deleting accounts. Individual task deletion is permanent and admin-only.

## Production stack

- Express.js application and API
- PostgreSQL database through `DATABASE_URL` (Neon is recommended for Vercel)
- Database-backed, expiring sessions
- Vercel Function entry point in `api/index.js`

## Commands

```bash
npm install
npm run db:migrate
npm test
npm start
```

Copy `.env.example` to `.env.local` and provide a PostgreSQL `DATABASE_URL` before migrating or starting the app. There is no demo seed data or demo login.

The complete deployment and team operating guide is in `outputs/PROJECTCHAT_INSTRUCTION_MANUAL.md`.
