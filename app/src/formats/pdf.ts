// PDF input: translated as the plain text of its text layer, delivered as a .txt file.

import { TxtAdapter } from './txt';

export class PdfAdapter extends TxtAdapter {
  override readonly formatName = 'pdf';

  protected override async loadText(): Promise<string> {
    // pdf.js is large and only needed for PDFs.
    const { extractPdfText } = await import('../documents/pdf');
    const text = await extractPdfText(this.input);
    if (!text.trim()) {
      this.config.log?.('pdf_no_text', 'The PDF has no text layer');
      throw new Error('pdf has no text');
    }
    return text;
  }
}
