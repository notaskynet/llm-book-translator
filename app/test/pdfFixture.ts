/** A minimal text PDF: one Helvetica line per entry, `gap` points between lines. */
export interface PdfLine {
  text: string;
  /** Extra vertical space before this line, in points. */
  extra?: number;
}

export function buildPdf(pages: PdfLine[][]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) && objects.length;

  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];

  for (const lines of pages) {
    let y = 750;
    const ops = lines.map((l, i) => {
      y -= (i === 0 ? 0 : 16) + (l.extra ?? 0);
      const escaped = l.text.replace(/[\\()]/g, '\\$&');
      return `BT /F1 12 Tf 50 ${y} Td (${escaped}) Tj ET`;
    }).join('\n');
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}
