// pdf.js ships no types for its worker bundle; tests run it in-process.
declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
