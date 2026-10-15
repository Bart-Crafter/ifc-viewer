# Email setup: the sign-in codes (for IT)

Staff (site admins, and anyone who is a **Designer or Admin** on a project) sign in with their password **and** a 6-digit code that the site emails to them. Clients and viewers use a password only. The site needs one mailbox to send those emails from.

Until email is set up:
- **While the site is only being tried out** (no SharePoint connected, files in the temporary local folder) staff can sign in with a password alone, and the log says so.
- **Once SharePoint is connected**, staff **cannot sign in** until email works. Set it up first, or temporarily set `MFA_REQUIRED=0` on the host to get in, and remove it again straight afterwards.

Pick **one** of the two options. Option A keeps everything inside Microsoft 365.

## Option A: send through Microsoft 365 (recommended)

About 15 minutes. Uses the same app registration as the SharePoint access (`Crafter Project Portal`).

1. **Create a mailbox to send from**, for example `noreply@crafterengineering.co.uk`. A **shared mailbox** needs no licence. People don't need to read it; replies can go nowhere.
2. **Entra admin centre → App registrations → Crafter Project Portal → API permissions → Add a permission → Microsoft Graph → Application permissions → `Mail.Send`**, then **Grant admin consent**.
3. **Restrict that permission to the one mailbox. This step matters.** On its own `Mail.Send` lets the app send as *anyone in the company*. In Exchange Online PowerShell, limit it to the sending mailbox (use Microsoft's current "RBAC for Applications"; the older *Application Access Policy* does the same job):

   ```powershell
   Connect-ExchangeOnline
   # register the app in Exchange (ObjectId = the *Enterprise application's* object id, from Entra)
   New-ServicePrincipal -AppId <Application (client) ID> -ObjectId <enterprise app object id> -DisplayName "Crafter Project Portal"
   # a scope containing only the sending mailbox
   New-ManagementScope -Name "Portal sender mailbox" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'noreply@crafterengineering.co.uk'"
   # allow the app to send mail, but only from inside that scope
   New-ManagementRoleAssignment -App <enterprise app object id> -Role "Application Mail.Send" -CustomResourceScope "Portal sender mailbox"
   ```

   Then remove the broad Graph `Mail.Send` consent from step 2 if Microsoft's docs for your tenant say to (the role assignment above replaces it). Check afterwards that the app **can** send as `noreply@…` and **cannot** send as another person.
4. On the hosting service set `MAIL_FROM` to the mailbox address (e.g. `noreply@crafterengineering.co.uk`). The existing `AZURE_*` settings are reused; there is nothing else to add.

## Option B: send through Resend (resend.com)

Simple and separate from Microsoft, with a free tier (about 100 emails a day).

1. Create an account, **add and verify your domain** (adding the SPF and DKIM records it shows you to your DNS).
2. Create an **API key with "Sending access" only**.
3. Set `RESEND_API_KEY` to the key and `MAIL_FROM` to an address on the verified domain (for example `Crafter Engineering <noreply@crafterengineering.co.uk>`).

If both are set, Resend is used.

## Check it works

1. Sign in on the site as a Designer or admin. An email titled *Your Crafter Engineering sign-in code* should arrive within seconds (check Junk the first time; add `noreply@…` to safe senders).
2. A wrong code is refused; **Send a new code** sends a fresh one and cancels the old.
3. The server log shows `Two-step sign-in: codes are sent by Microsoft 365 email` at start-up. If it says no email service is set up, a setting is missing.

## Good to know

- The code works **once**, expires after **10 minutes**, and five wrong tries cancel it. Each person can request at most 5 codes every 15 minutes.
- The email says when and from which address the password was entered, so an unexpected one is a warning that the password is known.
- **Protect the staff mailboxes themselves.** Anyone who can read a person's mailbox gets their codes, so Microsoft 365 multi-factor authentication must be on for every staff mailbox. This is the main reason an authenticator app is stronger; email is simpler for people but depends on the mailbox being safe.
- Codes are never written to the production log. (In development only, with no email service set, the code is printed to the log so the site can be tried.)
