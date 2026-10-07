<#
.SYNOPSIS
  Gives the "Crafter Project Portal" app access to ONE SharePoint folder (a project's "4 - Submissions" folder),
  or takes that access away again.

.DESCRIPTION
  The portal's Entra app only has the Microsoft Graph permission Files.SelectedOperations.Selected, which on its own
  gives access to nothing. This script is the second half: it grants the app a role on a single folder, using the
  "create permission on a driveItem" Graph call. The app then sees that folder and everything inside it, and nothing else.
  Note: granting breaks permission inheritance on that folder (normal for this feature). Existing staff access is unchanged.

  Run it as a SharePoint site owner / IT administrator. It signs you in interactively (delegated, your own account).
  Requires the Microsoft.Graph.Authentication module:  Install-Module Microsoft.Graph.Authentication -Scope CurrentUser

.PARAMETER ClientId
  Application (client) ID of the Entra app registration (NOT the secret, NOT the tenant id).

.PARAMETER FolderUrl
  Web address of the folder. In SharePoint: open the folder, then copy the address from the browser, or use "Copy link".
  Several addresses can be passed at once.

.PARAMETER Role
  read, write (default), owner or fullcontrol. "write" lets the portal list, read, upload, replace, rename and delete.
  If deleting fails with "accessDenied" after granting, re-run with -Role owner.

.PARAMETER Remove
  Remove the app's access from the folder(s) instead of granting it.

.EXAMPLE
  .\Grant-ProjectFolder.ps1 -ClientId 11111111-2222-3333-4444-555555555555 `
     -FolderUrl "https://crafterengineering.sharepoint.com/sites/CrafterEngineering/P%20%20Project%20System/Series%20100100/100111%20-%20Birnbeck%20Pier/TW100%20-%20Temporary%20Staircase/4%20%E2%80%93%20Submissions"

  Prints a "Project code" for each folder. Paste that code into the portal's "New project" box.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $ClientId,
  [Parameter(Mandatory)] [string[]] $FolderUrl,
  [ValidateSet("read", "write", "owner", "fullcontrol")] [string] $Role = "write",
  [switch] $Remove
)

$ErrorActionPreference = "Stop"

if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
  throw "Install the Graph module first:  Install-Module Microsoft.Graph.Authentication -Scope CurrentUser"
}
Import-Module Microsoft.Graph.Authentication

# Delegated sign-in as the administrator running this script. Sites.FullControl.All lets them manage permissions
# on folders they already own; the app itself is NOT given this scope.
Connect-MgGraph -Scopes "Sites.FullControl.All" -NoWelcome

function ConvertTo-ShareId([string] $url) {
  "u!" + ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($url))).TrimEnd("=").Replace("/", "_").Replace("+", "-")
}

foreach ($url in $FolderUrl) {
  Write-Host ""
  Write-Host "Folder: $url"
  try {
    $item = Invoke-MgGraphRequest -Method GET -Uri ("https://graph.microsoft.com/v1.0/shares/{0}/driveItem?`$select=id,name,folder,parentReference" -f (ConvertTo-ShareId $url))
  } catch {
    Write-Warning "Could not open that folder: $($_.Exception.Message). Check the address and that your account can open it."
    continue
  }
  if (-not $item.folder) { Write-Warning "That address is a file, not a folder. Skipping."; continue }

  $driveId = $item.parentReference.driveId
  $itemId = $item.id
  $base = "https://graph.microsoft.com/v1.0/drives/$driveId/items/$itemId/permissions"

  if ($Remove) {
    $existing = (Invoke-MgGraphRequest -Method GET -Uri $base).value | Where-Object {
      $_.grantedToV2.application.id -eq $ClientId -or $_.grantedTo.application.id -eq $ClientId
    }
    if (-not $existing) { Write-Host "  The app has no access to '$($item.name)'. Nothing to remove."; continue }
    foreach ($p in $existing) { Invoke-MgGraphRequest -Method DELETE -Uri "$base/$($p.id)" | Out-Null }
    Write-Host "  Removed the app's access to '$($item.name)'." -ForegroundColor Yellow
    continue
  }

  $body = @{ roles = @($Role); grantedToV2 = @{ application = @{ id = $ClientId } } } | ConvertTo-Json -Depth 5
  try {
    Invoke-MgGraphRequest -Method POST -Uri $base -Body $body -ContentType "application/json" | Out-Null
  } catch {
    Write-Warning "Grant failed: $($_.Exception.Message)"
    continue
  }
  Write-Host "  Granted '$Role' on '$($item.name)' to the portal app." -ForegroundColor Green
  Write-Host "  Project code (paste into the portal's New project box):"
  Write-Host "      $driveId|$itemId" -ForegroundColor Cyan
}

Disconnect-MgGraph | Out-Null
