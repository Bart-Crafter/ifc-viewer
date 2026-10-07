// The access register: an Excel workbook ("Project Access.xlsx") kept in each project's Submissions folder.
// It is the single source of truth for who has which role on the project and which folders they can open, so staff
// can maintain it either on the website or by opening the file in SharePoint/OneDrive.
//
//   sheet "Access":  Email | Name | Role | 01 – PDF | 02 – DWG | 03 – IFC | 04 – CALCS | 05 – OTHER   (one row per person)
//   sheet "Folders": Folder | Anyone with the link/QR can view                                         (one row per folder)
//   sheet "How to use": plain-language instructions
//
// Reading is forgiving (any dash style in headers, Yes/Y/True/1/X for yes) and strict about security: a row with an
// unrecognised role gives no access, and a missing/unreadable file gives nobody access.

export const REGISTER_NAME = "Project Access.xlsx";
export const ROLES = ["viewer", "client", "designer", "admin"];

export const FOLDERS = [
  { key: "pdf", label: "01 – PDF", publicDefault: true },
  { key: "dwg", label: "02 – DWG", publicDefault: false },
  { key: "ifc", label: "03 – IFC", publicDefault: true },
  { key: "calcs", label: "04 – CALCS", publicDefault: false },
  { key: "other", label: "05 – OTHER", publicDefault: false },
];
export const FOLDER_KEYS = FOLDERS.map((f) => f.key);

const YES = new Set(["yes", "y", "true", "1", "x", "✓", "✔"]);
const isYes = (text) => YES.has(String(text ?? "").trim().toLowerCase());
const norm = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const ROLE_LIST = `"${ROLES.join(",")}"`;
const MAX_ROWS = 300; // dropdowns are pre-filled this far down the sheet

// Which folder does a column header / row label refer to? ("01 – PDF", "01-pdf", "PDF" all work.)
function folderKeyOf(text) {
  const t = norm(text);
  return FOLDER_KEYS.find((k) => t.endsWith(k) || t === k) ?? null;
}

const cellText = (cell) => {
  const v = cell?.value;
  if (v && typeof v === "object" && "result" in v) return String(v.result ?? "").trim();
  return String(cell?.text ?? "").trim();
};

async function excel() {
  const mod = await import("exceljs");
  return mod.default ?? mod;
}

function columnsOf(sheet) {
  const cols = { folders: {} };
  sheet.getRow(1).eachCell((cell, n) => {
    const t = norm(cellText(cell));
    if (!t) return;
    if (t.includes("email")) cols.email ??= n;
    else if (t === "name" || t === "fullname") cols.name ??= n;
    else if (t === "role" || t === "accesslevel") cols.role ??= n;
    else {
      const key = folderKeyOf(t);
      if (key) cols.folders[key] ??= n;
    }
  });
  return cols;
}

const accessSheet = (wb) => wb.getWorksheet("Access") ?? wb.worksheets[0];
const foldersSheet = (wb) => wb.getWorksheet("Folders");

export async function parseRegister(buffer) {
  const ExcelJS = await excel();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const warnings = [];
  const people = [];

  const sheet = accessSheet(wb);
  const cols = sheet ? columnsOf(sheet) : {};
  if (!sheet || !cols.email || !cols.role) {
    throw new Error('The register needs an "Access" sheet with "Email" and "Role" columns.');
  }
  const seen = new Set();
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const email = cellText(row.getCell(cols.email)).toLowerCase();
    if (!email) return;
    const role = cellText(row.getCell(cols.role)).toLowerCase();
    if (!role) return; // no role = no access
    if (!ROLES.includes(role)) {
      warnings.push(`Row ${n}: "${role}" is not a valid role (use ${ROLES.join(", ")}), so ${email} has no access.`);
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      warnings.push(`Row ${n}: "${email}" is not a valid email address.`);
      return;
    }
    if (seen.has(email)) {
      warnings.push(`Row ${n}: ${email} is listed more than once; only the first row is used.`);
      return;
    }
    seen.add(email);
    const folders = {};
    for (const key of FOLDER_KEYS) folders[key] = cols.folders[key] ? isYes(cellText(row.getCell(cols.folders[key]))) : false;
    people.push({ email, name: cols.name ? cellText(row.getCell(cols.name)) : "", role, folders });
  });

  const publicFolders = Object.fromEntries(FOLDERS.map((f) => [f.key, f.publicDefault]));
  const fSheet = foldersSheet(wb);
  if (fSheet) {
    fSheet.eachRow((row, n) => {
      if (n === 1) return;
      const key = folderKeyOf(cellText(row.getCell(1)));
      if (key) publicFolders[key] = isYes(cellText(row.getCell(2)));
    });
  }
  return { people, publicFolders, warnings };
}

// ---------- writing ----------
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };

function styleHeader(sheet) {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = HEADER_FILL;
  row.alignment = { vertical: "middle", horizontal: "left" };
  row.height = 22;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function addDropdowns(sheet, cols, row) {
  if (cols.role) sheet.getCell(row, cols.role).dataValidation = { type: "list", allowBlank: true, formulae: [ROLE_LIST] };
  for (const n of Object.values(cols.folders)) {
    sheet.getCell(row, n).dataValidation = { type: "list", allowBlank: true, formulae: ['"Yes,No"'] };
  }
}

async function newWorkbook(seed) {
  const ExcelJS = await excel();
  const wb = new ExcelJS.Workbook();
  wb.creator = "Crafter Engineering project portal";

  const access = wb.addWorksheet("Access");
  access.columns = [
    { header: "Email", width: 34 },
    { header: "Name", width: 26 },
    { header: "Role", width: 14 },
    ...FOLDERS.map((f) => ({ header: f.label, width: 12 })),
  ];
  styleHeader(access);
  const cols = columnsOf(access);
  for (let r = 2; r <= MAX_ROWS; r++) addDropdowns(access, cols, r);

  const folders = wb.addWorksheet("Folders");
  folders.columns = [
    { header: "Folder", width: 18 },
    { header: "Anyone with the link/QR can view", width: 36 },
  ];
  styleHeader(folders);
  FOLDERS.forEach((f, i) => {
    folders.getCell(i + 2, 1).value = f.label;
    folders.getCell(i + 2, 2).value = f.publicDefault ? "Yes" : "No";
    folders.getCell(i + 2, 2).dataValidation = { type: "list", allowBlank: false, formulae: ['"Yes,No"'] };
  });

  const help = wb.addWorksheet("How to use");
  help.getColumn(1).width = 110;
  [
    "PROJECT ACCESS REGISTER",
    "",
    'This file controls who can open this project on the project website. Edit it here, or on the website (both change the same file). Changes made here can take about 15 seconds to apply.',
    "",
    'Sheet "Access": one row per person.',
    "  • Email: the address they sign in with. They need an account on the website first (an administrator creates it).",
    "  • Role: viewer = view only, client = view and download, designer = also upload/replace/rename/delete and decide who sees which folder, admin = also manage who is on the project. Leave Role empty to remove someone's access.",
    "  • Folder columns: Yes/No for each folder. Designers and admins always see every folder.",
    "",
    'Sheet "Folders": whether anyone holding the project link or QR code (no sign-in) can view the files in that folder. They can only view, never download.',
    "",
    "Please don't rename the sheets or the column headings.",
  ].forEach((line, i) => {
    help.getCell(i + 1, 1).value = line;
    help.getCell(i + 1, 1).alignment = { wrapText: true, vertical: "top" };
  });
  help.getCell(1, 1).font = { bold: true, size: 14 };

  const worksheet = access;
  let r = 2;
  for (const person of seed?.people ?? []) writePerson(worksheet, cols, r++, person);
  return { wb, cols };
}

function writePerson(sheet, cols, rowNumber, person) {
  const everything = person.role === "designer" || person.role === "admin";
  sheet.getCell(rowNumber, cols.email).value = person.email;
  if (cols.name && person.name !== undefined) sheet.getCell(rowNumber, cols.name).value = person.name;
  if (cols.role && person.role !== undefined) sheet.getCell(rowNumber, cols.role).value = person.role;
  for (const key of FOLDER_KEYS) {
    if (!cols.folders[key]) continue;
    const on = everything || !!person.folders?.[key];
    sheet.getCell(rowNumber, cols.folders[key]).value = on ? "Yes" : "No";
  }
  addDropdowns(sheet, cols, rowNumber);
}

/** A fresh register, optionally seeded with people: [{ email, name, role, folders }]. */
export async function createRegister(people = []) {
  const { wb } = await newWorkbook({ people });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * Apply one change to a register file and return the new bytes. The existing workbook is edited in place, so any extra
 * columns, notes or formatting that staff added by hand survive.
 * ops: { type: "setPerson", email, name?, role?, folders? } | { type: "removePerson", email } | { type: "setPublic", folders }
 */
export async function editRegister(buffer, op) {
  const ExcelJS = await excel();
  let wb;
  if (buffer) {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
  } else {
    wb = (await newWorkbook()).wb;
  }
  const sheet = accessSheet(wb);
  const cols = columnsOf(sheet);
  if (!cols.email || !cols.role) throw new Error('The register needs an "Access" sheet with "Email" and "Role" columns.');

  const findRow = (email) => {
    let found = 0;
    sheet.eachRow((row, n) => {
      if (n > 1 && !found && cellText(row.getCell(cols.email)).toLowerCase() === email) found = n;
    });
    return found;
  };

  if (op.type === "setPerson") {
    const email = op.email.toLowerCase();
    let n = findRow(email);
    const isNew = !n;
    if (isNew) {
      n = 2;
      while (cellText(sheet.getCell(n, cols.email))) n++; // first empty row
    }
    const current = isNew
      ? { email, name: "", role: "viewer", folders: {} }
      : {
          email,
          name: cols.name ? cellText(sheet.getCell(n, cols.name)) : "",
          role: cellText(sheet.getCell(n, cols.role)).toLowerCase(),
          folders: Object.fromEntries(FOLDER_KEYS.map((k) => [k, cols.folders[k] ? isYes(cellText(sheet.getCell(n, cols.folders[k]))) : false])),
        };
    writePerson(sheet, cols, n, {
      email,
      name: op.name ?? current.name,
      role: op.role ?? current.role,
      folders: { ...current.folders, ...(op.folders ?? {}) },
    });
  } else if (op.type === "removePerson") {
    const n = findRow(op.email.toLowerCase());
    if (n) {
      // Clear (rather than delete) the row, so formatting and the rows below are undisturbed.
      for (const col of [cols.email, cols.name, cols.role, ...Object.values(cols.folders)]) if (col) sheet.getCell(n, col).value = null;
    }
  } else if (op.type === "setPublic") {
    let fSheet = foldersSheet(wb);
    if (!fSheet) {
      fSheet = wb.addWorksheet("Folders");
      fSheet.columns = [
        { header: "Folder", width: 18 },
        { header: "Anyone with the link/QR can view", width: 36 },
      ];
      styleHeader(fSheet);
    }
    for (const f of FOLDERS) {
      if (!(f.key in op.folders)) continue;
      let n = 0;
      fSheet.eachRow((row, i) => {
        if (i > 1 && !n && folderKeyOf(cellText(row.getCell(1))) === f.key) n = i;
      });
      if (!n) {
        n = Math.max(fSheet.rowCount, 1) + 1;
        fSheet.getCell(n, 1).value = f.label;
      }
      fSheet.getCell(n, 2).value = op.folders[f.key] ? "Yes" : "No";
      fSheet.getCell(n, 2).dataValidation = { type: "list", allowBlank: false, formulae: ['"Yes,No"'] };
    }
  } else {
    throw new Error(`Unknown register change: ${op.type}`);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
