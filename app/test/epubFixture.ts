import JSZip from 'jszip';

const sentence = 'The traveller walked slowly along the old road. ';

export const chapterOne = (paragraphs = 6) =>
  `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><title>One</title><link rel="stylesheet" href="style.css" type="text/css"/></head>
<body class="chapter">
<h1 id="c1">Chapter One</h1>
${Array.from({ length: paragraphs }, (_, i) => `<p class="body">Paragraph ${i}. <em>${sentence}</em>${sentence.repeat(2)}<a href="ch2.xhtml#s2" epub:type="noteref">note</a></p>`).join('\n')}
<p><img src="images/pic.png" alt="A picture"/></p>
</body>
</html>`;

export const chapterTwo = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>Two</title></head>
<body>
<h2 id="s2">Second Part</h2>
<p>It was a <span class="x">dark</span> night. Fish &amp; chips &lt;3.</p>
<p>3</p>
</body>
</html>`;

export const coverPage = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head>
<body><div><img src="images/pic.png" alt=""/></div></body></html>`;

export interface EpubOptions {
  chapters?: Record<string, string>;
  /** Extra spine entries that point at files missing from the archive. */
  missingSpineFile?: boolean;
  paragraphs?: number;
}

export async function buildEpub(options: EpubOptions = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:uuid:1234</dc:identifier>
<dc:title>Test Book</dc:title>
<dc:language>en</dc:language>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="ch2" href="Chapter%202.xhtml" media-type="application/xhtml+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="pic" href="images/pic.png" media-type="image/png"/>
</manifest>
<spine toc="ncx">
<itemref idref="cover"/>
<itemref idref="ch1"/>
<itemref idref="ch2"/>
${options.missingSpineFile ? '<itemref idref="ghost"/>' : ''}
</spine>
</package>`.replace(
      '<item id="pic"',
      options.missingSpineFile ? '<item id="ghost" href="ghost.xhtml" media-type="application/xhtml+xml"/>\n<item id="pic"' : '<item id="pic"',
    ),
  );
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<navMap>
<navPoint id="n1"><navLabel><text>Chapter One</text></navLabel><content src="ch1.xhtml"/></navPoint>
<navPoint id="n2"><navLabel><text>Second Part</text></navLabel><content src="Chapter%202.xhtml#s2"/></navPoint>
</navMap></ncx>`,
  );
  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>Nav</title></head>
<body>
<nav epub:type="toc"><ol>
<li><a href="ch1.xhtml">Chapter One</a></li>
<li><a href="Chapter%202.xhtml#s2">Second Part</a></li>
</ol></nav>
<nav epub:type="landmarks"><ol><li><a href="ch1.xhtml">Start</a></li></ol></nav>
</body></html>`,
  );
  zip.file('OEBPS/cover.xhtml', coverPage);
  zip.file('OEBPS/ch1.xhtml', options.chapters?.['ch1.xhtml'] ?? chapterOne(options.paragraphs));
  zip.file('OEBPS/Chapter 2.xhtml', options.chapters?.['Chapter 2.xhtml'] ?? chapterTwo);
  zip.file('OEBPS/style.css', 'body { margin: 1em; }');
  zip.file('OEBPS/images/pic.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  return zip.generateAsync({ type: 'uint8array' });
}

export async function readEpub(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const text = async (path: string) => (await zip.file(path)!.async('string'));
  return { zip, text, names: Object.keys(zip.files) };
}

export const parseXmlDoc = (xml: string, type: DOMParserSupportedType = 'application/xhtml+xml') =>
  new DOMParser().parseFromString(xml, type);
