# ProjectChat

ProjectChat is a WhatsApp-style project workspace. Projects are containers; each subproject is a focused chat with tasks, mentions, status updates, and full or read-only access.

The workspace supports multiple global administrators with identical management privileges. `ADMIN_EMAIL` remains the protected primary owner. New open signups remain pending until an admin approves them and assigns a project.

The Admin workspace includes a global member directory for direct project/subproject assignment, role changes, and access removal without deleting accounts. Individual task deletion is permanent and admin-only.

Chats include unread badges, sender-side read receipts, sender edit/delete controls, and lightweight inline tasks that grey out when completed. Inline chat tasks stay in the conversation and do not appear in the formal Tasks tab. The notification center tracks mentions, task assignments, task updates, and access changes. Formal tasks can have optional deadlines with live countdowns.

The workspace uses a responsive WhatsApp-style two-pane layout. Projects and subproject chats automatically reorder by their latest activity, while unread badges identify unseen messages from teammates. Messages and formal task conversations are grouped by day; on phones, the project list and selected conversation become separate full-screen views with a native back-to-projects flow.

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
