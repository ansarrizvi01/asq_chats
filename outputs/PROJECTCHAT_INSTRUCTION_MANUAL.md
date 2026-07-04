# ProjectChat Deployment and Team Instruction Manual

Version: 1.0  
Deployment target: Vercel  
Database: Neon PostgreSQL

## 1. What You Are Deploying

ProjectChat is a chat-first project workspace:

- A **project** is a container, such as `Website Launch` or `Client ABC`.
- A **subproject** is a working chat inside that project, such as `Landing Page`, `Content`, or `Client Approval`.
- Messages can be posted as updates, tasks, or alerts.
- Tasks have an assignee, status, notes, and status updates.
- Full-access members can write, create tasks, change task status, and invite people.
- Read-only members can follow the work without changing it.

The application contains no demo users, demo projects, demo messages, or default passwords. The first real user creates an account after deployment.

## 2. Production Architecture

```text
Team browser
    |
    v
Vercel HTTPS deployment
    |
    +-- Express API and static frontend
    |
    v
Neon PostgreSQL
    +-- users and password hashes
    +-- expiring login sessions
    +-- projects and project memberships
    +-- subprojects and room memberships
    +-- messages and mentions
    +-- tasks and task updates
    +-- invitations and access roles
```

PostgreSQL is required for production. Do not replace `DATABASE_URL` with a local SQLite file: Vercel Functions do not provide a durable application filesystem. Vercel recommends Marketplace Postgres providers and serverless-friendly connection pooling.

## 3. Accounts You Need

Create these accounts before deployment:

1. A GitHub account for the source repository.
2. A Vercel account for hosting and deployments.
3. A Neon account is optional in advance; Vercel can create and connect one through its Marketplace.

Install Node.js 20 or newer and Git on the deployment computer.

## 4. Put the Project on GitHub

Open PowerShell in the ProjectChat folder and run:

```powershell
git init
git add .
git commit -m "Prepare ProjectChat for production"
git branch -M main
```

Create an empty repository in GitHub. Do not add a README or `.gitignore` there because this project already contains both. Then connect and push it:

```powershell
git remote add origin https://github.com/YOUR-NAME/YOUR-REPOSITORY.git
git push -u origin main
```

The `.gitignore` excludes database credentials, local Vercel metadata, dependencies, and the deleted local SQLite data directory.

## 5. Create the Vercel Project

1. Sign in to [Vercel](https://vercel.com/).
2. Select **Add New > Project**.
3. Import the GitHub repository created above.
4. Leave the root directory as the repository root.
5. Vercel should recognize the Express configuration from `vercel.json`.
6. Create the project. The first deployment may not become healthy until the database is connected and migrated; that is expected.

The repository includes `api/index.js` as the Vercel Function entry point and routes incoming requests through the Express application.

## 6. Create and Connect Neon PostgreSQL

Dashboard method:

1. Open the ProjectChat project in Vercel.
2. Open **Storage** or the **Marketplace**.
3. Select **Neon** and choose **Install**.
4. Create a new Neon database on the free or paid plan appropriate for the team.
5. Connect it to the ProjectChat Vercel project.
6. Enable it for **Production** and **Development**. Enable **Preview** too if preview deployments should have database access.
7. Confirm that Vercel added a `DATABASE_URL` environment variable.

CLI alternative after running `vercel link`:

```powershell
vercel install neon
```

Choose a database region close to the Vercel Function region. For a Pakistan-based team, compare Singapore and nearby available regions, then keep the function and database in the same or nearest practical region. This reduces chat and task latency.

Important: use the pooled Neon connection string for `DATABASE_URL`. The application also limits each warm Function instance to a small connection pool.

## 7. Pull Credentials and Create the Database Schema

Install and connect the Vercel CLI:

```powershell
npm install -g vercel
vercel login
vercel link
vercel env pull .env.local
```

Install dependencies and create the empty production schema:

```powershell
npm install
npm run db:migrate
```

The migration creates all tables, foreign keys, role constraints, and performance indexes. It does not create any users or dummy content. It is safe to run the current migration again because it uses `CREATE ... IF NOT EXISTS`.

If Vercel did not provide `DATABASE_URL`, open **Project Settings > Environment Variables** and add it manually for Production, Preview, and Development as appropriate. Never commit the connection string to Git.

## 8. Test Before Going Live

Run the automated clean-database test:

```powershell
npm test
```

This test uses a temporary in-memory PostgreSQL-compatible database. It verifies:

- Registration and secure login sessions
- Project and subproject creation
- Message persistence
- Task creation and retrieval
- Project-wide invitation acceptance
- Read-only permission enforcement

Test the real connected database locally:

```powershell
npm start
```

Open `http://localhost:3000/api/health`. A healthy response is:

```json
{"ok":true,"database":"connected"}
```

Then open `http://localhost:3000`, create the owner account, create one test project and subproject, and send one update. Delete the test project directly from the database only if absolutely necessary; normally it is better to rename it and use it as the team onboarding project.

## 9. Deploy Production

Deploy from the CLI:

```powershell
vercel --prod
```

Or push to the GitHub `main` branch and let Vercel deploy automatically:

```powershell
git add .
git commit -m "Deploy ProjectChat"
git push
```

After deployment:

1. Open `https://YOUR-DOMAIN/api/health` and confirm the database is connected.
2. Open the main site and create the first owner account.
3. In Vercel, set `APP_URL` to the final production URL, such as `https://projects.yourcompany.com`.
4. Redeploy after adding or changing environment variables; Vercel environment changes only apply to new deployments.

`APP_URL` ensures generated invitation links use the permanent domain. If it is omitted, the application uses the current request domain.

## 10. Optional Custom Domain

1. Open the Vercel project.
2. Go to **Settings > Domains**.
3. Add a domain such as `projects.yourcompany.com`.
4. Follow Vercel's DNS instructions.
5. Change `APP_URL` to the custom HTTPS URL.
6. Redeploy and create a fresh invitation link to verify the domain.

## 11. Create the Team Workspace

Recommended first setup:

1. The team owner creates an account using their real work email.
2. Select the `+` control and create a project container.
3. Open workspace actions and create the project's first subproject.
4. Use one subproject per distinct stream of work.

Example structure:

```text
Website Launch
  Landing Page
  Content and SEO
  Analytics
  Launch Checklist

Client ABC
  Requirements
  Design Review
  Delivery
```

Avoid creating one giant subproject for the whole company. A subproject should have one clear outcome, a recognizable owner group, and a manageable task list.

## 12. Invite Team Members

The application uses private invitation links. It does not send email automatically, so the inviter shares the generated link through the company's trusted email or messaging system.

To invite someone:

1. Open **Workspace actions** from the compact sidebar controls.
2. Under **Invite member**, choose the project.
3. Choose **Entire project** or one specific subproject.
4. Enter the teammate's exact work email.
5. Select **Full access** or **Read only**.
6. Select **Send invite**.
7. Copy the private invitation link shown by ProjectChat.
8. Send that link only to the intended teammate.

Invitation links expire after seven days. Create a fresh invite if a teammate does not accept within that period.

The teammate then:

1. Opens the invitation link.
2. Signs in, or creates an account using the exact invited email address.
3. ProjectChat automatically accepts the invitation after authentication.
4. The project and permitted subprojects appear in the sidebar.

Invitation behavior:

- **Entire project + Full access:** access to all current subprojects, permission to create future subprojects, invite members, post updates, and manage tasks.
- **Entire project + Read only:** view access to all current subprojects and future subprojects, without write actions.
- **Specific subproject + Full access:** the project container is visible, but full write access is granted only to that subproject.
- **Specific subproject + Read only:** only that subproject can be viewed.

Do not post invitation links in public channels. The server also checks that the signed-in email matches the invited email.

## 13. Daily Team Workflow

Use the chat as the chronological record and Tasks as the actionable record.

### Start of day

1. Open each active subproject.
2. Review the latest updates and alerts.
3. Open **Tasks** and identify open assignments.
4. Post a short update only when it changes what the team needs to know.

### During work

1. Use **Update** for progress, decisions, and handoffs.
2. Use **Task** messages when discussing actionable work.
3. Use **Alert** for blockers, deadlines, and urgent decisions.
4. Mention one relevant person when attention is specifically required.
5. Create a formal task when work needs an owner and completion state.
6. Add a status update to the task instead of repeatedly asking for progress in chat.

### End of day

1. Assignees add a short task status: completed work, remaining work, and blocker.
2. Mark completed tasks done.
3. Re-open a task only when additional work is genuinely required.
4. Post one concise handoff update if another person must continue the work.

## 14. Recommended Communication Rules

Adopt these rules during onboarding:

1. Every task has one assignee, even when several people contribute.
2. Every blocker is posted as an alert and names the person who can unblock it.
3. Decisions are summarized in the relevant subproject chat.
4. Task status belongs on the task; broader context belongs in chat.
5. Read-only access is the default for observers, clients, and leadership viewers.
6. Completed work is marked done immediately, not at the end of the week.
7. Create a new subproject when a workstream gains a separate outcome or team.

## 15. Permissions and Security

ProjectChat includes:

- Password hashing with bcrypt at a production work factor
- Random server-side session tokens
- Sessions stored in PostgreSQL with a 14-day expiration
- `HttpOnly`, `SameSite=Lax`, and production `Secure` cookies
- Same-origin checks for write requests
- API and authentication rate limiting
- Security headers through Helmet
- Server-side membership and role checks on every protected action
- Foreign keys and constrained role/status values in PostgreSQL

Operational responsibilities:

1. Use HTTPS only in production; Vercel provides it automatically.
2. Keep `DATABASE_URL` only in Vercel/Neon environment settings.
3. Require strong unique passwords through company policy or a password manager.
4. Remove access in the database if an employee leaves; a dedicated member-removal screen is not included yet.
5. The current release does not include password-reset email. An administrator should treat forgotten-password recovery as a support task until an email provider and reset flow are added.

## 16. Database Operations and Backups

Open **Vercel Project > Storage > Neon** to inspect tables, run queries, and view the schema. Vercel's supported Postgres integrations provide browser, data, query, and schema views from the dashboard.

Recommended operations:

1. Enable the backup or point-in-time recovery level appropriate to the chosen Neon plan.
2. Check Neon storage and compute usage monthly.
3. Keep the database region aligned with the Vercel Function region.
4. Before a destructive schema change, create a Neon branch or backup.
5. Run `npm run db:migrate` before deploying code that depends on a new schema.
6. Never edit password hashes, session tokens, membership relationships, or foreign keys casually in the data editor.

The important relationships are protected by foreign keys. Deleting a project cascades into its subprojects, messages, tasks, and memberships, so direct production deletion should be deliberate and backed up first.

## 17. Updating the Application

For each future release:

```powershell
git pull
npm install
npm test
npm run db:migrate
git add .
git commit -m "Describe the release"
git push
```

Use a Vercel Preview deployment for UI or workflow changes. For database schema changes, use a separate Neon preview branch where possible so testing cannot contaminate production data.

## 18. Troubleshooting

### `DATABASE_URL is required`

Run `vercel env pull .env.local`, or add `DATABASE_URL` to `.env.local` for local development. Confirm the Neon integration is connected to the correct Vercel project and environment.

### `/api/health` returns an error

Confirm the database exists, the connection string is current, the schema migration succeeded, and the Vercel deployment was created after the environment variable was added.

### A teammate cannot accept an invitation

Confirm they registered with the exact invited email, including the same spelling. Create a new invitation if the old invitation was already accepted. The app prevents duplicate pending invitations to the same project/subproject.

### A teammate sees the project but no subproject

They may have been invited only to a different subproject, or they may have project-container membership without room membership from an older/manual database edit. Send a new invitation for the required subproject or the entire project.

### A read-only member cannot post or change tasks

That is expected. Create a new full-access invitation for the relevant scope if their responsibilities changed.

### Environment changes do not appear

Redeploy. Vercel applies environment-variable changes only to new deployments.

## 19. Go-Live Checklist

- [ ] Repository is private unless open source is intentional.
- [ ] Neon is connected and `DATABASE_URL` exists in Production.
- [ ] `npm run db:migrate` completed successfully.
- [ ] `npm test` passes.
- [ ] Production `/api/health` reports database connected.
- [ ] Owner account uses a real company email and strong password.
- [ ] `APP_URL` matches the final HTTPS domain.
- [ ] A test invitation was accepted with a second real email.
- [ ] Read-only access was tested.
- [ ] The team agrees on project/subproject naming and daily update rules.
- [ ] Neon backup and retention settings were reviewed.

## 20. Official Deployment References

- [Using Express.js with Vercel](https://vercel.com/kb/guide/using-express-with-vercel)
- [Vercel Marketplace storage](https://vercel.com/docs/marketplace-storage)
- [Postgres on Vercel](https://vercel.com/docs/postgres)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Vercel project configuration](https://vercel.com/docs/project-configuration/vercel-json)
- [Neon on the Vercel Marketplace](https://vercel.com/marketplace/neon)
- [Connect Vercel and Neon manually](https://neon.com/docs/guides/vercel-manual)
