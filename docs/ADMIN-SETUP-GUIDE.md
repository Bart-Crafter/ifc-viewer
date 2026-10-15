---
title: "Crafter Project Portal: Microsoft 365 setup guide"
subtitle: "Step-by-step for the Microsoft 365 administrator"
---

# What this is

The Crafter Project Portal is a website where clients and consultants see project drawings (PDF, DWG, IFC) without being given access to our Microsoft 365. The files **stay in our SharePoint**. The website reads and writes only the specific folders you give it, and it also emails a sign-in code to staff.

You are being asked to do **three things** that need an administrator account:

| Part | What | Time |
| --- | --- | --- |
| **A** | Register the website as an app in Microsoft Entra and give it limited SharePoint access | about 15 minutes, once |
| **B** | Allow the app into each project's "4 – Submissions" folder | about 1 minute per folder |
| **C** | Set up one mailbox the website sends sign-in codes from | about 15 minutes, once |

Then you send Bartosz five pieces of information (listed in Part D). Nothing is installed on our computers and nothing needs a licence except what you already have.

**You will need:** an account that is a **Global Administrator** (or Application Administrator plus Privileged Role Administrator), access to **Exchange admin**, and to be an **owner of the SharePoint site** that holds the projects.

**Where the files live.** The folders should be in a **SharePoint site** document library. If any are in one person's personal OneDrive, move them to SharePoint first, because access to a personal OneDrive ends when that person leaves.

**Safety rules for this guide**
- The website is given access folder by folder. **Never** give it tenant-wide permissions such as `Files.ReadWrite.All` or `Sites.ReadWrite.All`.
- The client secret you create in A5 is like a password. **Do not email it.** Share it by a password manager, or read it out and have it typed in.

---

# Part A: Register the app (once)

1. Go to **https://entra.microsoft.com** and sign in as the administrator.
2. Open **Entra ID → App registrations → New registration**.
   - **Name:** `Crafter Project Portal`
   - **Supported account types:** *Accounts in this organizational directory only*
   - **Redirect URI:** leave empty
   - Click **Register**.
3. On the app's **Overview** page, copy these two values into a note:
   - **Application (client) ID**
   - **Directory (tenant) ID**
4. Open **API permissions → Add a permission → Microsoft Graph → Application permissions**. Search for **`Files.SelectedOperations.Selected`**, tick it and click **Add permissions**.
   - Add **nothing else**. On its own this permission gives access to **no** files until Part B.
   - Click **Grant admin consent for Crafter Engineering** and confirm. The Status column should show a green tick.
5. Open **Certificates & secrets → Client secrets → New client secret**.
   - Description: `Portal`. Expires: **12 months** (the shorter the safer).
   - Click **Add**, then **copy the Value immediately**. It is only shown once. (Copy the *Value*, not the *Secret ID*.)
   - Put a reminder in the calendar for **one month before it expires**. When it expires the site stops reaching SharePoint until a new secret is created and given to Bartosz.
6. Open **Owners → Add owners** and make sure only **two named people** are owners.

---

# Part B: Allow the app into a project folder (per project)

Each project has a folder called **"4 – Submissions"**. The website only ever sees folders you grant here, and nothing else in the project.

**Start with one test folder.** Create a dummy project folder, for example `ZZ Portal Test`, with a sub-folder `4 – Submissions`, and do the steps below for just that. The real projects can follow once the test works.

1. On a Windows PC open **PowerShell** and, the first time only, run:

   ```
   Install-Module Microsoft.Graph.Authentication -Scope CurrentUser
   ```
2. Bartosz will send you a file called **`Grant-ProjectFolder.ps1`**. Save it somewhere simple, such as the Desktop.
3. In SharePoint (in your web browser) open the project's **4 – Submissions** folder and **copy the address from the browser's address bar**.
4. In PowerShell, go to the folder holding the script and run it (put your own Application (client) ID from A3 and the folder address inside the quotes):

   ```
   .\Grant-ProjectFolder.ps1 -ClientId <Application (client) ID> -FolderUrl "<address of the 4 – Submissions folder>"
   ```
5. A Microsoft sign-in window opens. **Sign in as an owner of the SharePoint site** (an administrator is fine). If it asks you to approve "Microsoft Graph Command Line Tools", approve it.
6. The script prints a line saying access was granted, then a **Project code** that looks like `b!abc…|01XYZ…`. **Copy the whole Project code** and send it to Bartosz with the project's name. He pastes it into the website's *New project* box.
7. If the script cannot delete files later and reports `accessDenied`, run it again with `-Role owner` on the end.

**Several folders at once:** pass a comma-separated list of addresses to `-FolderUrl`. Because there are 500+ projects, **do not grant them all up front**: grant a project when it is put on the website. Bartosz can supply a script that finds every Submissions folder automatically when you want to do them in bulk.

**What the script does.** It gives the app permission on that one folder and everything inside it, and nothing else. It breaks permission inheritance on that one folder (this is how Microsoft's feature works); staff access to the folder does not change.

**Important: who can edit the Submissions folder.** Inside it the website keeps one Excel file, `Project Access.xlsx`, which lists who can see the project and which folders they can open. **Anyone who can edit that folder can change who has access on the website**, so keep edit rights to a small, trusted group.

**Taking access away from a project:** run the same command with `-Remove` on the end.

---

# Part C: The sign-in code mailbox (once)

Staff sign in with their password and a 6-digit code emailed to them. The website needs one mailbox to send those from.

1. Go to **https://admin.exchange.microsoft.com → Recipients → Mailboxes → Add a shared mailbox**.
   - Name: `Crafter Portal`. Email address: for example `noreply@crafter-engineering.co.uk` (any address you prefer).
   - A shared mailbox does not need a licence. Nobody needs to read it.
2. Open PowerShell and run these commands one at a time. They let the app **send only from this one mailbox**, never as anyone else in the company. Replace the placeholders; the **Enterprise application Object ID** is found in Entra under **Enterprise applications → Crafter Project Portal → Overview → Object ID** (it is not the same as the App registration's Object ID).

   ```
   Install-Module ExchangeOnlineManagement -Scope CurrentUser
   Connect-ExchangeOnline

   New-ServicePrincipal -AppId <Application (client) ID> -ObjectId <Enterprise application Object ID> -DisplayName "Crafter Project Portal"

   New-ManagementScope -Name "Portal sender mailbox" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'noreply@crafter-engineering.co.uk'"

   New-ManagementRoleAssignment -App <Enterprise application Object ID> -Role "Application Mail.Send" -CustomResourceScope "Portal sender mailbox"
   ```
3. Check it, with the same placeholders. It should say the app **is** authorised for the portal mailbox, and a test against any other mailbox should say it is **not**:

   ```
   Test-ServicePrincipalAuthorization -Identity <Enterprise application Object ID> -Resource noreply@crafter-engineering.co.uk
   Test-ServicePrincipalAuthorization -Identity <Enterprise application Object ID> -Resource <any other person's email>
   ```

Microsoft updates these commands from time to time. If one of them gives an error, the current steps are on Microsoft's page **"Role Based Access Control for Applications in Exchange Online"**.

**If the first test email fails with "403":** use the older method instead. In Entra add the Graph **application** permission `Mail.Send` to the app and grant admin consent. Then restrict it to the one mailbox with an *Application Access Policy* (`New-ApplicationAccessPolicy -AppId <client ID> -PolicyScopeGroupId <mail-enabled security group containing only the portal mailbox> -AccessRight RestrictAccess`). **Do not leave `Mail.Send` unrestricted**, because it would allow the app to send as anyone in the company.

---

# Part D: What to send back to Bartosz

Send these by a secure route (a password manager's shared item, or phone):

| # | Item | Where it came from |
| --- | --- | --- |
| 1 | **Directory (tenant) ID** | A3 |
| 2 | **Application (client) ID** | A3 |
| 3 | **Client secret Value** (the secret) | A5 |
| 4 | **The sender mailbox address** | Part C |
| 5 | **A Project code for each folder**, with the project's name | B6 |

Bartosz puts items 1 to 4 into the website's hosting settings and the Project codes into the *New project* box. **The website's staff sign-in will not work until item 4 is in place**, so please do Part C before the website goes live.

---

# Part E: Make it as safe as possible (strongly recommended)

Do these once; they take little time and matter most if something ever goes wrong.

1. **Multi-factor authentication on every staff Microsoft 365 account.** The website emails staff a sign-in code, so anyone who can read a staff mailbox can get that code. MFA on the mailboxes is what makes it safe.
2. **Limit who can edit each "4 – Submissions" folder** (see Part B).
3. **Make deleting files recoverable.** Keep SharePoint **versioning** on, and set a **retention policy** on the project library in Microsoft Purview so nothing can be permanently deleted for, say, 12 months. Consider a backup of the library.
4. **Turn on monitoring.** In **Microsoft Purview → Audit**, search for the app's activity (`FileDownloaded`, `FileDeleted`, `FileModified`) and create an alert for unusual volumes of downloads or deletions. In Entra, **Enterprise applications → Crafter Project Portal → Sign-in logs → Service principal sign-ins** shows every time the app signs in. Also create an alert for changes to the app's credentials (Entra → Monitoring → Audit logs, *Update application – Certificates and secrets management*).
5. **Block "Anyone" sharing links** for the project library, and run the folder script from an administrator account that is not used for everyday work.
6. **Later, when the site is in real use:** restrict the app so it can only sign in from the hosting provider's addresses (Entra *Conditional Access for workload identities*, needs the Workload ID Premium licence).

---

# If something looks wrong

In this order, each step takes under a minute:

1. **Entra → App registrations → Crafter Project Portal → Certificates & secrets → delete the client secret.** The website immediately loses access to SharePoint.
2. Tell Bartosz so the website can be paused.
3. Check **Entra sign-in logs** and **Purview audit search** for anything unexpected.
4. Restore any changed or deleted files from the SharePoint recycle bin or version history.
5. Create a new secret and give it to Bartosz when everything is safe again.

---

# Checklist

- [ ] A1–A6: app registered, `Files.SelectedOperations.Selected` consented, secret created and copied, two owners
- [ ] B: test folder granted, Project code sent to Bartosz
- [ ] C1–C3: shared mailbox created, app limited to that mailbox, test shows other mailboxes blocked
- [ ] D: tenant ID, client ID, secret, mailbox address, Project code(s) sent securely
- [ ] E1–E5: MFA on staff accounts, edit rights limited, retention and alerts on
- [ ] Calendar reminder one month before the secret expires
