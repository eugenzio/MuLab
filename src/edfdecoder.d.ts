/**
 * Minimal ambient declaration for the untyped `edfdecoder` package.
 * Only the surface we use is declared; the decoder output is treated structurally
 * via the EdfOutput interface in parsers/edf.ts.
 */
declare module 'edfdecoder' {
  export class EdfDecoder {
    setInput(buffer: ArrayBuffer): void;
    decode(): void;
    getOutput(): unknown;
  }
}
