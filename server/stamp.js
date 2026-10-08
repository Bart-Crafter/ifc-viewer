import { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix, rgb } from "pdf-lib";
import QRCode from "qrcode";

// Puts a QR code onto a PDF drawing as vector shapes (sharp at any print size, no picture), exactly where the
// designer placed it in the viewer. The position is given as fractions of the page as it looks on screen, so it is
// right whichever way the page is rotated. The code sits on a white box so it scans over linework.

export const MIN_WIDTH = 0.02; // of the page width
export const MAX_WIDTH = 0.6;

// x, y: top-left corner of the box as a fraction of the visible page (0..1, y measured down from the top).
// w: box width as a fraction of the visible page width (the box is square, quiet zone included).
export function cleanPlacement(input = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  const page = Math.round(num(input.page ?? 1));
  const x = num(input.x);
  const y = num(input.y);
  const w = num(input.w);
  if (![page, x, y, w].every(Number.isFinite) || page < 1) throw new Error("The QR position isn't valid.");
  if (w < MIN_WIDTH || w > MAX_WIDTH) throw new Error("The QR code size isn't valid.");
  return { page, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), w, allPages: input.allPages === true };
}

// Map "visual" coordinates (as the page looks on screen, origin bottom-left) onto the page's own coordinate system.
function pageMatrix(rotation, w, h, x0, y0) {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [0, 1, -1, 0, x0 + w, y0];
    case 180:
      return [-1, 0, 0, -1, x0 + w, y0 + h];
    case 270:
      return [0, -1, 1, 0, x0, y0 + h];
    default:
      return [1, 0, 0, 1, x0, y0];
  }
}

export async function stampQr(bytes, url, placement) {
  const p = cleanPlacement(placement);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = pdf.getPages();
  if (!pages.length) throw new Error("The PDF has no pages.");
  if (p.page > pages.length) throw new Error("That page doesn't exist in the PDF.");

  const qr = QRCode.create(url, { errorCorrectionLevel: "L" });
  const n = qr.modules.size;
  const total = n + 4; // two modules of white margin each side
  const black = rgb(0, 0, 0);

  // dark squares as horizontal runs, to keep the drawing instructions few
  const runs = [];
  for (let row = 0; row < n; row++) {
    let col = 0;
    while (col < n) {
      if (!qr.modules.get(row, col)) {
        col++;
        continue;
      }
      let end = col;
      while (end + 1 < n && qr.modules.get(row, end + 1)) end++;
      runs.push([col, row, end - col + 1]);
      col = end + 1;
    }
  }

  const targets = p.allPages ? pages.slice(0, 300) : [pages[p.page - 1]];
  for (const page of targets) {
    const crop = page.getCropBox();
    const rotation = page.getRotation().angle;
    const visualW = rotation % 180 === 0 ? crop.width : crop.height;
    const visualH = rotation % 180 === 0 ? crop.height : crop.width;
    const box = p.w * visualW; // square
    // keep the whole box on the sheet
    const left = Math.min(Math.max(0, p.x * visualW), Math.max(0, visualW - box));
    const bottom = Math.min(Math.max(0, visualH - p.y * visualH - box), Math.max(0, visualH - box));
    const module = box / total;

    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...pageMatrix(rotation, crop.width, crop.height, crop.x, crop.y)));
    page.drawRectangle({ x: left, y: bottom, width: box, height: box, color: rgb(1, 1, 1) });
    const top = bottom + box - module * 2; // top of the symbol, below the white margin
    for (const [col, row, length] of runs) {
      page.drawRectangle({ x: left + module * 2 + col * module, y: top - (row + 1) * module, width: length * module, height: module, color: black });
    }
    page.pushOperators(popGraphicsState());
  }
  return Buffer.from(await pdf.save());
}
