# SharePoint setup for the Crafter project portal (for IT)

**What this is.** A website where clients sign in and see project files (PDF/DWG/IFC). The files stay in our SharePoint. The site reads and writes them through Microsoft Graph using **one app registration that can only see the specific folders you grant it**, never the whole tenant. Clients never get SharePoint access.

**Time needed:** about 15 minutes once, then 1 minute per project folder.

## One-time setup

1. **Entra admin centre → App registrations → New registration**
   - Name: `Crafter Project Portal`
   - Supported account types: *Accounts in this organizational directory only*
   - Redirect URI: leave empty. Click **Register**.
2. **API permissions → Add a permission → Microsoft Graph → Application permissions** → tick **`Files.SelectedOperations.Selected`** → *Add*. Then **Grant admin consent for Crafter Engineering**.
   - Add nothing else. On its own this permission gives access to **no** files until step "Per project" below.
3. **Certificates & secrets → New client secret** (24 months). Copy the **Value** immediately.
4. Send the project owner these three values by a secure route (not plain email):
   - Directory (tenant) ID
   - Application (client) ID
   - Client secret value

   They go into the hosting service as `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`. Put a reminder in the calendar to renew the secret before it expires.

## Per project (each "4 – Submissions" folder)

Run as a SharePoint site owner / admin (it asks you to sign in; nothing is stored):

```powershell
Install-Module Microsoft.Graph.Authentication -Scope CurrentUser    # first time only
.\scripts\Grant-ProjectFolder.ps1 -ClientId <Application (client) ID> `
   -FolderUrl "<address of the 4 – Submissions folder>"
```

- Several folders at once: pass a comma-separated list to `-FolderUrl`.
- It prints a **Project code** (looks like `b!abc…|01XYZ…`). Send that to whoever creates the project on the portal; they paste it into *New project*.
- The app gets the **write** role (list, read, upload, replace, rename, delete) on that folder and its contents only. If deleting from the portal later fails with "accessDenied", re-run with `-Role owner`.
- Granting breaks permission inheritance on that one folder (how Microsoft's *Selected* permissions work). Staff access to it does not change.

## What the portal does in each granted folder

- Lists the PDF / DWG / IFC files in the folder (not subfolders).
- Uploads, replaces, renames, deletes on behalf of signed-in portal users who have the Designer/Admin role. Deleted files go to the normal SharePoint recycle bin; replaced files keep SharePoint's version history.
- Creates one subfolder, `_viewer-cache`, holding converted copies of IFC models so they open quickly. It is safe to delete; it is rebuilt automatically.

## Taking access away

- One project: `.\scripts\Grant-ProjectFolder.ps1 -ClientId <id> -FolderUrl "<folder address>" -Remove`
- Everything at once: delete the client secret, or remove the admin consent, in Entra. The portal stops reading SharePoint immediately.

## Things worth knowing / checking

- Sign-in logs for the app (`Crafter Project Portal`) appear under *Entra → Enterprise applications → Sign-in logs → Service principal sign-ins*.
- Two points were designed from Microsoft's documentation and should be confirmed on the first real folder: that the **write** role is enough to delete, and that the portal can open a folder from its pasted address (if not, the *Project code* always works).
- Reference: <https://learn.microsoft.com/graph/permissions-selected-overview> and <https://learn.microsoft.com/graph/api/driveitem-post-permissions>
