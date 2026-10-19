import JSZip from 'jszip';

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const sentence = 'The traveller walked slowly along the old road. ';

export const run = (text: string, rPr = '') =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;

export const documentXml = (paragraphs = 3) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run('Chapter One')}</w:p>
${Array.from({ length: paragraphs }, (_, i) =>
  `<w:p><w:pPr><w:jc w:val="both"/></w:pPr>${run(`Paragraph ${i}. `, '<w:rFonts w:ascii="Georgia"/>')}${run(sentence, '<w:rFonts w:ascii="Georgia"/>')}${run('Important words. ', '<w:b/>')}<w:r><w:tab/></w:r>${run(sentence.repeat(2))}</w:p>`).join('\n')}
<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"/></w:drawing></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p>${run('Cell text in a table.')}</w:p></w:tc></w:tr></w:tbl>
<w:p>${run('Fish &amp; chips &lt;3.')}</w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
</w:body></w:document>`;

export const footnotesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes ${NS}><w:footnote w:id="1"><w:p>${run('A footnote about the road.')}</w:p></w:footnote></w:footnotes>`;

export async function buildDocx(options: { paragraphs?: number; footnotes?: boolean } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml', documentXml(options.paragraphs));
  if (options.footnotes) zip.file('word/footnotes.xml', footnotesXml);
  zip.file('word/media/image1.png', new Uint8Array([137, 80, 78, 71]));
  return zip.generateAsync({ type: 'uint8array' });
}

export async function readDocx(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  return {
    names: Object.keys(zip.files),
    text: async (path: string) => (await zip.file(path)!.async('string')),
    bytes: async (path: string) => zip.file(path)!.async('uint8array'),
  };
}
