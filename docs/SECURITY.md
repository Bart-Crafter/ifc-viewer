# Security: how the portal protects the files, and what to switch on

There are **three ways in**, and each needs its own protection. Think of the files in SharePoint as behind three doors:

1. **A portal account** (staff, clients, consultants) signing in on the website.
2. **The project QR code / link and quick-send links**, which need no account.
3. **The portal's own keys**: the Microsoft secret that lets the site read SharePoint, and the accounts that run the site (Render, Neon, GitHub).

If any one door is left weak, the others don't help. This page lists what the code already does and what has to be done by a person (mostly IT).

## 1. Built into the portal

| Protection | Detail |
| --- | --- |
| **Two-step sign-in for all staff** | Required for site admins and anyone who is a Designer or Admin on any project (clients and viewers sign in with a password only, and are limited to viewing/downloading). Password **and** a 6-digit code from an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…). Set up at first sign-in; ten one-time recovery codes are shown once. Each code works only once. Authenticator secrets are encrypted in the database with `APP_SECRET`. A site admin can **Reset 2-step** for a lost phone. Switch off only for local testing with `MFA_REQUIRED=0`. |
| Passwords | Hashed with scrypt, 10+ characters, temporary passwords must be changed, 5 wrong tries per account and 30 per address per 15 minutes then a lock-out. Wrong-code guessing is locked out separately (8 tries). |
| Sessions | Random tokens stored only as hashes, HttpOnly cookie, `Secure` over HTTPS, 7-day sliding expiry, all other sessions ended when a password changes or an account is disabled. |
| Access rules | Decided by the project's `Project Access.xlsx` (read live, fails closed): per person, per folder. A viewer can't download; clients can't upload; only designers/admins can change files. |
| **Download cap** | One account (or one address, for QR-link users) can fetch at most **400 files per hour** (`DOWNLOAD_LIMIT_PER_HOUR`). Normal use is far below it; it stops a stolen account or link being used to copy a whole project quickly. Hitting it is written to the activity log. |
| Quick-send links | Expire after 3 days, can be cancelled, give access to the chosen files only, stored only as hashes. |
| Browser protections | Content-Security-Policy, no framing, HSTS, no sniffing, cross-site request protection on every change. |
| Audit log | Sign-ins (good and bad), 2-step events, uploads, replacements, deletions, link resets, access changes, rate-limit hits. |
| Files | Never public on the internet: every byte goes through an access check. Deleted files go to the SharePoint recycle bin; replaced files keep their old version. |
| Updates | Known-vulnerable packages are patched (`npm audit` shows only 2 moderate findings in `exceljs → uuid`, which only matters for a feature the site doesn't use). Enable GitHub **Dependabot** so this stays true. |

## 2. Microsoft 365: for IT to set up

Do these in order of importance.

1. **Only ever grant access folder by folder** (`Files.SelectedOperations.Selected` and `Grant-ProjectFolder.ps1`). Never give the app tenant-wide permissions such as `Files.ReadWrite.All` or `Sites.ReadWrite.All`: if the portal were compromised, that would expose everything.
2. **Limit who can edit each "4 – Submissions" folder.** The `Project Access.xlsx` file inside it *is* the list of who can see the project online, so anyone who can edit that folder can grant themselves access. Keep edit rights to a small, trusted group.
3. **Make the client secret short-lived and watched.**
   - Use a **6 or 12 month** expiry (not 24) and put the renewal in two calendars.
   - Name at most **two owners** of the app registration (Entra → App registrations → Owners).
   - Create an alert for changes to the app's credentials (Entra → Monitoring → Audit logs: *Update application – Certificates and secrets management*), so a new secret being added by someone else is noticed.
4. **Restrict where the app can sign in from** (Entra *Conditional Access for workload identities*, needs the Workload ID Premium licence). Allow the app only from the hosting provider's outbound addresses. Render's free plan shares addresses; a paid plan gives a fixed set you can allow-list. Worth doing once the site is in real use.
5. **Switch on monitoring.** In Microsoft Purview → Audit, search for the app's activity (`FileDownloaded`, `FileDeleted`, `FileModified`) and create an alert policy for *unusual volume of file downloads/deletions*. Entra → Enterprise applications → Sign-in logs → *Service principal sign-ins* shows every time the app signs in.
6. **Make deletion recoverable.** Keep SharePoint versioning on, and set a **retention (preservation) policy** on the project library so nothing can be permanently removed for, say, 12 months even by an authorised app. Consider Microsoft 365 Backup or a third-party backup of the library.
7. **Tenant basics.** Multi-factor authentication for all staff; legacy authentication blocked; "Anyone" sharing links disabled for the library; run the grant script from an admin account that isn't used for everyday work.
8. **Decide what may be shared.** Only the Submissions folder is visible to the portal, but anything placed there can be seen by the people with access. Keep third-party and confidential material in 04/05, and out of the public folders.

## 3. The accounts that run the site

- **Turn on two-step sign-in for every account** on Render, Neon and GitHub, for every person who has one. Whoever controls these can read the portal's secrets.
- Keep the number of people with Render dashboard access to two or three: its environment page shows the Microsoft client secret in plain text.
- On GitHub: require a pull request and two-step sign-in for changes to `main`, switch on *secret scanning* and *Dependabot*. Never paste secrets into the repository.
- Set `APP_SECRET` (a long random value, Render can generate it) so the authenticator secrets are not stored next to their key. `render.yaml` already asks for it.
- When someone leaves: remove them from Render, GitHub, Neon and the project access lists, and rotate the client secret.

## 4. The QR code is a "key" that gets printed

Anyone who photographs the QR code can **view** the public folders (default 01 – PDF and 03 – IFC) without signing in. The QR is on drawings that travel to subcontractors and beyond, so treat the public folders as **visible to anyone who ever receives a drawing**.

- Mark a folder public only if that is acceptable (Who can see what → *Anyone with the link or QR code*). For a sensitive project, turn the public folders off; the QR then shows no files.
- **Reset the link** (Link / QR → Reset) if a drawing has gone where it shouldn't. The old QR stops working at once, **including the codes already printed on drawings**.
- The download cap and view-only mode slow copying but can't stop someone photographing the screen.

## 5. If you think something has gone wrong

In this order (each step takes under a minute):

1. **Entra → the app registration → Certificates & secrets → delete the client secret.** The portal loses access to SharePoint immediately.
2. Render → **Suspend** the service.
3. Check *Entra service principal sign-ins* and the Purview audit search for anything unexpected.
4. Restore changed or deleted files from the SharePoint recycle bin or version history.
5. Create a new secret, reset the project links, reset passwords and 2-step for the accounts involved, then resume.

## Settings reference

| Setting | Default | Meaning |
| --- | --- | --- |
| `MFA_REQUIRED` | staff | Unset: required for site admins and project Designers/Admins. `all`: required for every account. `0`: off (local testing only). |
| `APP_SECRET` | generated and stored in the database if missing | Key that encrypts the authenticator secrets. Set it on the host. |
| `DOWNLOAD_LIMIT_PER_HOUR` | 400 | Files one account or address can fetch per hour. |
| `SHARE_DAYS` | 3 | Fixed at 3 in production. |
