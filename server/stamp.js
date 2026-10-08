import { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix } from "pdf-lib";
import QRCode from "qrcode";

// Puts a QR code onto a PDF drawing as vector shapes (sharp at any print size, no picture). The code is placed in a
// corner of the visible sheet, whatever way the page is rotated, on a white box so it scans over linework.
const MM = 72 / 25.4; // PDF points per millimetre

export const STAMP_DEFAULTS = { pos: "br", mm: 22, margin: 8, pages: "first", caption: true };

export function cleanStampOptions(input = {}) {
  const num = (v, fallback, min, max) => Math.min(max, Math.max(min, Number(v) || fallback));
  return {
    pos: ["br", "bl", "tr", "tl"].includes(input.pos) ? input.pos : STAMP_DEFAULTS.pos,
    mm: num(input.mm, STAMP_DEFAULTS.mm, 12, 80),
    margin: num(input.margin, STAMP_DEFAULTS.margin, 0, 60),
    pages: input.pages === "all" ? "all" : "first",
    caption: input.caption === undefined ? STAMP_DEFAULTS.caption : input.caption === true || input.caption === "1" || input.caption === 1,
  };
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

export async function stampQr(bytes, url, options = {}) {
  const o = cleanStampOptions(options);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = pdf.getPages();
  if (!pages.length) throw new Error("The PDF has no pages.");
  const font = o.caption ? await pdf.embedFont(StandardFonts.Helvetica) : null;

  const qr = QRCode.create(url, { errorCorrectionLevel: "L" });
  const n = qr.modules.size;
  const symbol = o.mm * MM;
  const module = symbol / n;
  const quiet = module * 2;
  const captionSize = Math.max(3.5, module * 5);
  const captionText = "Scan: latest revision";
  const captionHeight = font ? captionSize + 3 : 0;
  const boxW = symbol + quiet * 2;
  const boxH = boxW + captionHeight;
  const margin = o.margin * MM;
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

  const targets = o.pages === "all" ? pages.slice(0, 300) : [pages[0]];
  for (const page of targets) {
    const crop = page.getCropBox();
    const rotation = page.getRotation().angle;
    const visualW = rotation % 180 === 0 ? crop.width : crop.height;
    const visualH = rotation % 180 === 0 ? crop.height : crop.width;
    if (boxW + margin > visualW || boxH + margin > visualH) throw new Error("The QR code is too big for this page size. Choose a smaller size.");
    const x = o.pos.endsWith("l") ? margin : visualW - margin - boxW;
    const y = o.pos.startsWith("b") ? margin : visualH - margin - boxH;

    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...pageMatrix(rotation, crop.width, crop.height, crop.x, crop.y)));
    page.drawRectangle({ x, y, width: boxW, height: boxH, color: rgb(1, 1, 1) });
    const top = y + boxH - quiet; // top of the symbol, below the white margin
    for (const [col, row, length] of runs) {
      page.drawRectangle({ x: x + quiet + col * module, y: top - (row + 1) * module, width: length * module, height: module, color: black });
    }
    if (font) {
      const textWidth = font.widthOfTextAtSize(captionText, captionSize);
      page.drawText(captionText, { x: x + (boxW - textWidth) / 2, y: y + 2, size: captionSize, font, color: black });
    }
    page.pushOperators(popGraphicsState());
  }
  return Buffer.from(await pdf.save());
}
