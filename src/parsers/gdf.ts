/**
 * GDF 2.0 parser — Phase 1 investigation and honest verdict.
 *
 * Status (NEEDS VERIFICATION, recorded in ASSUMPTIONS.md):
 *  - As of this spike, no production-grade, well-maintained pure-JS GDF 2.0
 *    parser was found on npm that reliably decodes signals AND the event table
 *    with correct scaling. (Most "EDF/GDF" JS libraries handle EDF only; GDF's
 *    variable header, mixed channel rates, and binary event table are not
 *    covered.)
 *  - We can reliably SNIFF the GDF fixed header (version, channel count, record
 *    geometry) in the browser — proven below. Full signal/event decode is NOT
 *    claimed to work in-browser.
 *
 * Chosen strategy: a **data-adapter fallback**. GDF files are pre-converted in
 * Python (`mne.io.read_raw_gdf`) to a cleaned `.npz`/JSON that the tool loads.
 * `parseGdf` therefore sniffs the header for diagnostics and then throws
 * {@link GdfUnsupportedError} directing the caller to the adapter path, so the
 * limitation can never be silently assumed away. README documents that the raw
 * GDF format cannot be read directly in-browser (yet).
 */

/** Best-effort fields read from the 256-byte GDF fixed header. */
export interface GdfHeaderSniff {
  /** Raw 8-byte version magic, e.g. "GDF 2.20". */
  version: string;
  /** True if the magic begins with "GDF". */
  isGdf: boolean;
  /** Number of signals/channels (uint16 @ offset 252) — best effort. */
  numChannels: number;
  /** Number of data records (int64 @ offset 236) — best effort. */
  numRecords: number;
  /** Record duration in seconds (uint32 pair @ offset 244) — best effort. */
  recordDurationSec: number;
}

export class GdfUnsupportedError extends Error {
  readonly adapterRequired = true;
  constructor(
    message: string,
    readonly sniff: GdfHeaderSniff | null,
  ) {
    super(message);
    this.name = 'GdfUnsupportedError';
  }
}

const GDF_FIXED_HEADER_BYTES = 256;

/**
 * Read diagnostic fields from the GDF fixed header. Does NOT decode signals.
 * Offsets follow the GDF 2.x specification; values are best-effort and marked
 * "needs verification" until checked against MNE for a real file.
 */
export function sniffGdfHeader(buffer: ArrayBuffer): GdfHeaderSniff {
  if (buffer.byteLength < GDF_FIXED_HEADER_BYTES) {
    return { version: '', isGdf: false, numChannels: 0, numRecords: 0, recordDurationSec: 0 };
  }
  const dv = new DataView(buffer);
  const bytes = new Uint8Array(buffer, 0, 8);
  let version = '';
  for (let i = 0; i < 8; i++) version += String.fromCharCode(bytes[i]!);

  const isGdf = version.startsWith('GDF');

  // GDF 2.x fixed-header offsets:
  //   236: NRec  (int64 LE, number of data records)
  //   244: record duration as uint32 numerator / uint32 denominator
  //   252: NS    (uint16 LE, number of signals)
  const numRecords = Number(dv.getBigInt64(236, true));
  const durNum = dv.getUint32(244, true);
  const durDen = dv.getUint32(248, true);
  const recordDurationSec = durDen !== 0 ? durNum / durDen : 0;
  const numChannels = dv.getUint16(252, true);

  return { version: version.trim(), isGdf, numChannels, numRecords, recordDurationSec };
}

/**
 * Attempt to parse a GDF buffer. Per the Phase 1 verdict this always routes to
 * the adapter fallback: it sniffs the header (for a useful diagnostic message)
 * and throws {@link GdfUnsupportedError}.
 */
export function parseGdf(buffer: ArrayBuffer): never {
  const sniff = sniffGdfHeader(buffer);
  if (!sniff.isGdf) {
    throw new GdfUnsupportedError(
      'Not a GDF file (missing "GDF" magic). If this is BCI Competition IV 2a, ' +
        'pre-convert it with the Python adapter (mne.io.read_raw_gdf -> .npz/JSON).',
      sniff,
    );
  }
  throw new GdfUnsupportedError(
    `GDF ${sniff.version} detected (channels≈${sniff.numChannels}, records≈${sniff.numRecords}, ` +
      `recordDur≈${sniff.recordDurationSec}s). Direct in-browser GDF 2.0 decoding is not ` +
      'supported in Phase 1. Use the Python pre-convert adapter (mne.io.read_raw_gdf -> .npz/JSON) ' +
      'and load the cleaned format instead. [NEEDS VERIFICATION: header offsets vs MNE]',
    sniff,
  );
}
