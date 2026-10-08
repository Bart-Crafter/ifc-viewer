import QRCode from "qrcode";

// A QR code as a DXF drawing, so it can be put into a DWG as real vector geometry (it stays sharp at any size) instead
// of a picture: in AutoCAD, INSERT > Browse > pick the .dxf, or open it and copy/paste.
//
// The code is drawn as filled SOLIDs (one per run of dark squares) on layer "QR", with its bottom-left corner at 0,0.
// Size: `mm` is how big the code should be on the printed sheet, `scale` the drawing scale (1:scale), so in a
// model-space drawing at 1:50 a 25 mm code is 1250 units wide. Drawing units are taken to be millimetres.
export function qrToDxf(text, { mm = 25, scale = 1, layer = "QR" } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "L" });
  const n = qr.modules.size;
  const unit = (mm * scale) / n;
  const num = (v) => Number(v.toFixed(5)).toString();
  const lines = [];
  const add = (code, value) => lines.push(String(code), String(value));

  // header + the tables an R12 file needs so the layer and its line type are defined
  add(0, "SECTION"); add(2, "HEADER"); add(9, "$ACADVER"); add(1, "AC1009"); add(0, "ENDSEC");
  add(0, "SECTION"); add(2, "TABLES");
  add(0, "TABLE"); add(2, "LTYPE"); add(70, 1);
  add(0, "LTYPE"); add(2, "CONTINUOUS"); add(70, 0); add(3, "Solid line"); add(72, 65); add(73, 0); add(40, 0);
  add(0, "ENDTAB");
  add(0, "TABLE"); add(2, "LAYER"); add(70, 1);
  add(0, "LAYER"); add(2, layer); add(70, 0); add(62, 7); add(6, "CONTINUOUS");
  add(0, "ENDTAB");
  add(0, "ENDSEC");

  add(0, "SECTION"); add(2, "ENTITIES");
  for (let row = 0; row < n; row++) {
    const y0 = (n - 1 - row) * unit; // row 0 is the top of the code
    const y1 = y0 + unit;
    let col = 0;
    while (col < n) {
      if (!qr.modules.get(row, col)) {
        col++;
        continue;
      }
      let end = col;
      while (end + 1 < n && qr.modules.get(row, end + 1)) end++;
      const x0 = col * unit;
      const x1 = (end + 1) * unit;
      // SOLID corners are given in "Z" order: bottom-left, bottom-right, top-left, top-right
      add(0, "SOLID"); add(8, layer);
      add(10, num(x0)); add(20, num(y0)); add(30, 0);
      add(11, num(x1)); add(21, num(y0)); add(31, 0);
      add(12, num(x0)); add(22, num(y1)); add(32, 0);
      add(13, num(x1)); add(23, num(y1)); add(33, 0);
      col = end + 1;
    }
  }
  add(0, "ENDSEC");
  add(0, "EOF");
  return lines.join("\r\n") + "\r\n";
}
