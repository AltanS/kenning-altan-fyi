/**
 * sqlite-table-reader.ts, a read-only reader for ONE table of a SQLite file.
 *
 * WHY THIS EXISTS AT ALL. A WikDict pair file is a SQLite database, and the
 * reader of this app imports it in the browser. The obvious answer is a WASM
 * SQLite build, and it is the wrong one here: it is a dependency of several
 * hundred kilobytes that the product loads for ONE job, once, on one settings
 * screen, to run ONE query (`select * from simple_translation`). The file
 * format for that job is small and frozen, so this module reads it directly.
 * The milestone forbids a new package, and this is what replaces it.
 *
 * WHAT IT IS, AND IS NOT. It scans a table front to back, rowid order, and
 * yields each row as a plain array of values. It has no query planner, no index
 * support, no row lookup by key and no schema beyond "find this table's root
 * page". It reads rollback-journal databases in the UTF-8 encoding. It refuses
 * everything else with a reason (WAL mode, UTF-16, an index b-tree where a table
 * was expected) instead of guessing, because a wrong guess here would import a
 * garbled dictionary and report success.
 *
 * THE FILE FORMAT, IN THE PARTS THIS USES
 *   - The file is a run of equal pages. Page numbers start at 1. Page 1 begins
 *     with a 100-byte database header, and its b-tree header therefore starts at
 *     byte 100 of that page; every other page's b-tree header starts at byte 0.
 *   - A table is a b-tree keyed by rowid. An INTERIOR page (type 0x05) holds
 *     child pointers, a LEAF page (type 0x0d) holds the rows. A full scan visits
 *     every leaf in key order: for an interior page, the children of its cells
 *     from the first to the last, then its right-most pointer.
 *   - A row is a "record": a header of serial types, then the column bodies. A
 *     row too big for its page spills the rest into a chain of overflow pages.
 *   - Cell offsets are measured from the start of the PAGE, also on page 1.
 *
 * THE INVARIANTS THAT MAKE IT SAFE TO POINT AT A FILE A STRANGER MADE
 *   - Every read is bounds checked against the page it belongs to, and a cell
 *     that claims to leave its page is an error, not a clamp.
 *   - The walk visits at most `pageCount` pages and holds at most `pageCount`
 *     pending references. A valid b-tree visits each page once, so a cycle, or a
 *     page that lists itself as a child, trips the cap and throws instead of
 *     spinning.
 *   - A record bigger than the whole file is refused BEFORE the buffer for it is
 *     allocated, so a lying size varint cannot ask for gigabytes. The reader
 *     therefore never holds more than the file it was handed plus one record.
 *   - Every failure is a `SqliteFormatError`. A `RangeError` or a `TypeError`
 *     escaping from here would mean a path nobody checked.
 *
 * CLIENT-ONLY BY CONVENTION. Nothing here touches the DOM, but this directory
 * is the device dictionary and no server module imports it (see
 * `tests/unit/local-dictionary-store.test.ts`, which says so in executable form).
 */

/** One column of one row. SQLite has exactly these storage classes. */
export type SqliteValue = string | number | Uint8Array | null;

/**
 * The file is not a SQLite database this reader can read.
 *
 * A single class, so a caller can tell "the reader's own refusal" (show the
 * reader of the app a sentence about their file) from a defect (let it throw).
 */
export class SqliteFormatError extends Error {
  /** @param reason What was wrong with the file, in plain words. */
  constructor(reason: string) {
    super(reason);
    this.name = 'SqliteFormatError';
  }
}

/** The 16 bytes every SQLite 3 file starts with: `SQLite format 3` and a NUL. */
const MAGIC_HEADER = Uint8Array.from('SQLite format 3\0', (character) => character.codePointAt(0) ?? 0);

/** The database header is the first 100 bytes of page 1. */
const DATABASE_HEADER_SIZE = 100;

/** The only text encoding accepted. 2 and 3 are UTF-16, 0 is an empty database. */
const ENCODING_UTF8 = 1;

/** The file format version byte that marks a write-ahead-log database. */
const FORMAT_VERSION_WAL = 2;

/** The smallest usable page size SQLite allows (page size minus reserved bytes). */
const MIN_USABLE_SIZE = 480;

/** The stored page size value that means 65536, which does not fit in a u16. */
const PAGE_SIZE_SENTINEL = 1;

/** Largest page size SQLite allows. */
const MAX_PAGE_SIZE = 65_536;

/** Smallest page size SQLite allows. */
const MIN_PAGE_SIZE = 512;

/** B-tree page type of a table interior page. */
const PAGE_TYPE_TABLE_INTERIOR = 0x05;

/** B-tree page type of a table leaf page. */
const PAGE_TYPE_TABLE_LEAF = 0x0d;

/** Bytes in a leaf page's b-tree header. */
const LEAF_HEADER_SIZE = 8;

/** Bytes in an interior page's b-tree header, which adds the right-most pointer. */
const INTERIOR_HEADER_SIZE = 12;

/** Bytes in one entry of a page's cell pointer array. */
const CELL_POINTER_SIZE = 2;

/** Bytes in a page number, in a child pointer and in an overflow link. */
const PAGE_NUMBER_SIZE = 4;

/** Overhead SQLite subtracts from the usable size to get the largest local payload. */
const MAX_LOCAL_OVERHEAD = 35;

/** The fixed part of the minimum-local formula: `floor((U - 12) * 32 / 255) - 23`. */
const MIN_LOCAL_BASE_OFFSET = 12;

/** The multiplier in the minimum-local formula. */
const MIN_LOCAL_NUMERATOR = 32;

/** The divisor in the minimum-local formula. */
const MIN_LOCAL_DENOMINATOR = 255;

/** The constant subtracted at the end of the minimum-local formula. */
const MIN_LOCAL_TAIL = 23;

/** Byte offsets inside the 100-byte database header. */
const HEADER_PAGE_SIZE_OFFSET = 16;
const HEADER_WRITE_VERSION_OFFSET = 18;
const HEADER_READ_VERSION_OFFSET = 19;
const HEADER_RESERVED_OFFSET = 20;
const HEADER_CHANGE_COUNTER_OFFSET = 24;
const HEADER_PAGE_COUNT_OFFSET = 28;
const HEADER_ENCODING_OFFSET = 56;
const HEADER_VERSION_VALID_FOR_OFFSET = 92;

/** Serial type constants. See the file format's "Record Format" chapter. */
const SERIAL_TYPE_NULL = 0;
const SERIAL_TYPE_FLOAT64 = 7;
const SERIAL_TYPE_ZERO = 8;
const SERIAL_TYPE_ONE = 9;
const SERIAL_TYPE_RESERVED_LOW = 10;
const SERIAL_TYPE_RESERVED_HIGH = 11;
const SERIAL_TYPE_FIRST_VARIABLE = 12;

/** Byte widths of serial types 1 to 6, indexed by serial type (index 0 is unused). */
const INTEGER_WIDTHS = [0, 1, 2, 3, 4, 6, 8] as const;

/** Bytes in an IEEE 754 double. */
const FLOAT64_WIDTH = 8;

/** The widest integer serial type, which needs BigInt to be read exactly. */
const WIDEST_INTEGER_WIDTH = 8;

/** A varint is at most nine bytes: eight carrying seven bits, and a ninth carrying eight. */
const VARINT_SHORT_BYTES = 8;

/** Payload bits carried by each of the first eight varint bytes. */
const VARINT_PAYLOAD_RADIX = 128;

/** Mask for the payload bits of a varint byte. */
const VARINT_PAYLOAD_MASK = 0x7f;

/** Set on a varint byte when another byte follows. */
const VARINT_CONTINUE_BIT = 0x80;

/** Multiplier for the ninth varint byte, which carries all eight bits. */
const VARINT_LAST_BYTE_RADIX = 256;

/**
 * Strict UTF-8, with the byte order mark kept.
 *
 * `fatal` makes invalid bytes throw instead of becoming U+FFFD, because a row
 * with replacement characters in it is a corrupted word, and the loader would
 * rather refuse the file than index it. `ignoreBOM` stops the decoder from
 * quietly dropping a leading U+FEFF that is genuinely part of the stored text.
 */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** What the header said about the file, with the derived sizes the walk needs. */
interface SqliteDatabase {
  readonly bytes: Uint8Array;
  readonly pageSize: number;
  /** `pageSize - reserved`: the bytes of a page that b-tree data may use. */
  readonly usableSize: number;
  readonly pageCount: number;
  /** The most payload bytes a table leaf cell keeps on its own page. */
  readonly maxLocal: number;
  /** The fewest payload bytes a spilling cell keeps on its own page. */
  readonly minLocal: number;
}

/** A varint's value and the offset of the byte after it. */
interface VarintRead {
  readonly value: number;
  readonly next: number;
}

/** The two bounds of a read, kept together so a caller cannot pass them swapped. */
interface ByteWindow {
  readonly start: number;
  readonly limit: number;
}

/**
 * Read a big-endian unsigned 16-bit integer.
 *
 * @param bytes The buffer.
 * @param window Where to read and the exclusive end it must stay below.
 * @throws SqliteFormatError If the two bytes do not fit before the limit.
 */
function readUint16(bytes: Uint8Array, window: ByteWindow): number {
  if (window.start < 0 || window.start + 2 > window.limit) {
    throw new SqliteFormatError('the file ends in the middle of a 2-byte field');
  }
  return (bytes[window.start] ?? 0) * 256 + (bytes[window.start + 1] ?? 0);
}

/**
 * Read a big-endian unsigned 32-bit integer.
 *
 * Multiplication rather than `<<`, because a shift would turn a value above
 * 2^31 negative.
 *
 * @param bytes The buffer.
 * @param window Where to read and the exclusive end it must stay below.
 * @throws SqliteFormatError If the four bytes do not fit before the limit.
 */
function readUint32(bytes: Uint8Array, window: ByteWindow): number {
  if (window.start < 0 || window.start + 4 > window.limit) {
    throw new SqliteFormatError('the file ends in the middle of a 4-byte field');
  }
  let value = 0;
  for (let index = 0; index < 4; index += 1) {
    value = value * 256 + (bytes[window.start + index] ?? 0);
  }
  return value;
}

/**
 * Read a SQLite varint: one to nine bytes, most significant group first.
 *
 * The first eight bytes carry seven bits each and a continuation flag. A ninth
 * byte, if reached, carries all eight of its bits. The result is accumulated by
 * multiplication so it stays exact up to 2^53, and anything above that is
 * refused: no length, rowid or serial type in a real dictionary comes near it.
 *
 * @param bytes The buffer.
 * @param window Where the varint starts and the exclusive end it must stay below.
 * @throws SqliteFormatError If the varint runs past the limit or past 2^53.
 */
function readVarint(bytes: Uint8Array, window: ByteWindow): VarintRead {
  let value = 0;
  for (let index = 0; index < VARINT_SHORT_BYTES; index += 1) {
    const position = window.start + index;
    if (position < 0 || position >= window.limit) {
      throw new SqliteFormatError('a number runs past the end of its page');
    }
    const byte = bytes[position] ?? 0;
    value = value * VARINT_PAYLOAD_RADIX + (byte & VARINT_PAYLOAD_MASK);
    if ((byte & VARINT_CONTINUE_BIT) === 0) {
      return checkedVarint(value, position + 1);
    }
  }
  const lastPosition = window.start + VARINT_SHORT_BYTES;
  if (lastPosition >= window.limit) {
    throw new SqliteFormatError('a number runs past the end of its page');
  }
  return checkedVarint(value * VARINT_LAST_BYTE_RADIX + (bytes[lastPosition] ?? 0), lastPosition + 1);
}

/**
 * Refuse a varint beyond 2^53, which a double cannot hold exactly.
 *
 * @param value The accumulated value.
 * @param next The offset of the byte after the varint.
 * @throws SqliteFormatError If the value is not a safe integer.
 */
function checkedVarint(value: number, next: number): VarintRead {
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new SqliteFormatError('a number in the file is larger than 2^53');
  }
  return { value, next };
}

/**
 * Validate the 100-byte header and derive the sizes every later read uses.
 *
 * @param bytes The whole file.
 * @throws SqliteFormatError For anything that is not a UTF-8, rollback-journal
 *   SQLite 3 file with a self-consistent size.
 */
function openDatabase(bytes: Uint8Array): SqliteDatabase {
  if (bytes.length < DATABASE_HEADER_SIZE) {
    throw new SqliteFormatError('the file is shorter than a SQLite header');
  }
  if (MAGIC_HEADER.some((expected, index) => bytes[index] !== expected)) {
    throw new SqliteFormatError('the file does not start with the SQLite 3 header');
  }
  const storedPageSize = readUint16(bytes, { start: HEADER_PAGE_SIZE_OFFSET, limit: DATABASE_HEADER_SIZE });
  const pageSize = storedPageSize === PAGE_SIZE_SENTINEL ? MAX_PAGE_SIZE : storedPageSize;
  const isPowerOfTwo = pageSize > 0 && (pageSize & (pageSize - 1)) === 0;
  if (pageSize < MIN_PAGE_SIZE || !isPowerOfTwo) {
    throw new SqliteFormatError(`the page size ${pageSize} is not one SQLite uses`);
  }
  if (bytes[HEADER_WRITE_VERSION_OFFSET] === FORMAT_VERSION_WAL || bytes[HEADER_READ_VERSION_OFFSET] === FORMAT_VERSION_WAL) {
    throw new SqliteFormatError('the file is in write-ahead-log mode, which this reader does not support');
  }
  const encoding = readUint32(bytes, { start: HEADER_ENCODING_OFFSET, limit: DATABASE_HEADER_SIZE });
  if (encoding !== ENCODING_UTF8) {
    throw new SqliteFormatError(`the text encoding code ${encoding} is not UTF-8`);
  }
  const usableSize = pageSize - (bytes[HEADER_RESERVED_OFFSET] ?? 0);
  if (usableSize < MIN_USABLE_SIZE) {
    throw new SqliteFormatError('the file reserves too many bytes per page');
  }
  const pageCount = resolvePageCount(bytes, pageSize);
  const maxLocal = usableSize - MAX_LOCAL_OVERHEAD;
  const minLocal =
    Math.floor(((usableSize - MIN_LOCAL_BASE_OFFSET) * MIN_LOCAL_NUMERATOR) / MIN_LOCAL_DENOMINATOR) - MIN_LOCAL_TAIL;
  return { bytes, pageSize, usableSize, pageCount, maxLocal, minLocal };
}

/**
 * How many pages the file holds, and so how many a walk may ever visit.
 *
 * The header's own count is trusted only when SQLite itself would trust it: the
 * count is non-zero and the "version-valid-for" field matches the change
 * counter, which is how an old writer that never updated the count is detected.
 * Otherwise the count is the length divided by the page size. A header that
 * promises more pages than the buffer holds is a truncated file, and is refused
 * here rather than discovered halfway through a table.
 *
 * @param bytes The whole file.
 * @param pageSize The validated page size.
 * @throws SqliteFormatError If the buffer is shorter than its header claims.
 */
function resolvePageCount(bytes: Uint8Array, pageSize: number): number {
  const fromLength = Math.floor(bytes.length / pageSize);
  const headerCount = readUint32(bytes, { start: HEADER_PAGE_COUNT_OFFSET, limit: DATABASE_HEADER_SIZE });
  const changeCounter = readUint32(bytes, { start: HEADER_CHANGE_COUNTER_OFFSET, limit: DATABASE_HEADER_SIZE });
  const validFor = readUint32(bytes, { start: HEADER_VERSION_VALID_FOR_OFFSET, limit: DATABASE_HEADER_SIZE });
  const isHeaderCountTrusted = headerCount > 0 && validFor === changeCounter;
  if (isHeaderCountTrusted && headerCount > fromLength) {
    throw new SqliteFormatError(`the file is truncated: its header lists ${headerCount} pages and it holds ${fromLength}`);
  }
  const pageCount = isHeaderCountTrusted ? headerCount : fromLength;
  if (pageCount < 1) {
    throw new SqliteFormatError('the file is shorter than one page');
  }
  return pageCount;
}

/**
 * The byte offset where a page starts.
 *
 * @param database The opened file.
 * @param pageNumber One-based page number.
 * @throws SqliteFormatError If the number is zero, or past the last page.
 */
function pageStartOf(database: SqliteDatabase, pageNumber: number): number {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > database.pageCount) {
    throw new SqliteFormatError(`the file points at page ${pageNumber}, which does not exist`);
  }
  return (pageNumber - 1) * database.pageSize;
}

/**
 * How many bytes of a payload stay on the cell's own page.
 *
 * SQLite's rule for a table leaf: a payload up to `X = U - 35` stays whole.
 * Past that it keeps `K = M + ((P - M) % (U - 4))` bytes when that fits in `X`,
 * and `M = floor((U - 12) * 32 / 255) - 23` bytes when it does not. The rest
 * continues on overflow pages, each carrying `U - 4` bytes behind a 4-byte link.
 *
 * @param database The opened file, which carries `U`, `X` and `M`.
 * @param payloadSize `P`, the total size of the record in bytes.
 */
function localPayloadSize(database: SqliteDatabase, payloadSize: number): number {
  if (payloadSize <= database.maxLocal) return payloadSize;
  const candidate = database.minLocal + ((payloadSize - database.minLocal) % (database.usableSize - PAGE_NUMBER_SIZE));
  return candidate <= database.maxLocal ? candidate : database.minLocal;
}

/**
 * Collect the tail of a spilled payload from its overflow chain.
 *
 * Bounded by the page count, so a chain that loops back on itself throws rather
 * than spins, and by the payload size, so the loop ends when the record is whole.
 *
 * @param database The opened file.
 * @param payload The record buffer, with its local part already copied in.
 * @param copied How many bytes of it are filled so far.
 * @param firstPage The first overflow page number, read from the cell.
 * @throws SqliteFormatError If the chain ends early, or points outside the file.
 */
function fillFromOverflow(database: SqliteDatabase, payload: Uint8Array, copied: number, firstPage: number): void {
  let filled = copied;
  let nextPage = firstPage;
  for (let hop = 0; filled < payload.length; hop += 1) {
    if (hop >= database.pageCount) {
      throw new SqliteFormatError('an overflow chain is longer than the file');
    }
    const pageStart = pageStartOf(database, nextPage);
    const limit = pageStart + database.usableSize;
    const chunk = Math.min(payload.length - filled, database.usableSize - PAGE_NUMBER_SIZE);
    nextPage = readUint32(database.bytes, { start: pageStart, limit });
    payload.set(database.bytes.subarray(pageStart + PAGE_NUMBER_SIZE, pageStart + PAGE_NUMBER_SIZE + chunk), filled);
    filled += chunk;
  }
}

/**
 * Read the integer behind serial types 1 to 6, as a signed big-endian number.
 *
 * @param payload The assembled record.
 * @param offset Where the column body starts.
 * @param width 1, 2, 3, 4 or 6 bytes (the 8-byte case is {@link readWideInteger}).
 */
function readNarrowInteger(payload: Uint8Array, offset: number, width: number): number {
  let value = 0;
  for (let index = 0; index < width; index += 1) {
    value = value * 256 + (payload[offset + index] ?? 0);
  }
  const signBit = 2 ** (width * 8 - 1);
  return value >= signBit ? value - signBit * 2 : value;
}

/**
 * Read the 8-byte integer (serial type 6) exactly, or refuse it.
 *
 * A double cannot hold every 64-bit integer, so the value goes through BigInt
 * and is refused when it would lose precision. A dictionary scored in the
 * thousands never gets near the limit; a file that does is not a dictionary.
 *
 * @param view A DataView over the record.
 * @param offset Where the column body starts.
 * @throws SqliteFormatError If the integer is beyond +/- 2^53.
 */
function readWideInteger(view: DataView, offset: number): number {
  const value = view.getBigInt64(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new SqliteFormatError('an integer in the file is larger than 2^53');
  }
  return Number(value);
}

/**
 * How many bytes a column body takes, from its serial type.
 *
 * @param serialType The value from the record header.
 * @throws SqliteFormatError For the two reserved types, 10 and 11.
 */
function serialTypeWidth(serialType: number): number {
  if (serialType === SERIAL_TYPE_RESERVED_LOW || serialType === SERIAL_TYPE_RESERVED_HIGH) {
    throw new SqliteFormatError(`the file uses the reserved serial type ${serialType}`);
  }
  if (serialType >= SERIAL_TYPE_FIRST_VARIABLE) return Math.floor((serialType - SERIAL_TYPE_FIRST_VARIABLE) / 2);
  if (serialType === SERIAL_TYPE_FLOAT64) return FLOAT64_WIDTH;
  return INTEGER_WIDTHS[serialType] ?? 0;
}

/** Where one column's body sits inside a record. */
interface ColumnLayout {
  readonly serialType: number;
  readonly offset: number;
  readonly width: number;
}

/**
 * Decode one column body.
 *
 * @param payload The assembled record.
 * @param view A DataView over the same record, for the numeric cases.
 * @param column Its serial type, byte offset and byte width, already bounds checked.
 */
function decodeColumn(payload: Uint8Array, view: DataView, column: ColumnLayout): SqliteValue {
  const { serialType, offset, width } = column;
  if (serialType === SERIAL_TYPE_NULL) return null;
  if (serialType === SERIAL_TYPE_ZERO) return 0;
  if (serialType === SERIAL_TYPE_ONE) return 1;
  if (serialType === SERIAL_TYPE_FLOAT64) return view.getFloat64(offset);
  if (serialType < SERIAL_TYPE_FLOAT64) {
    return width === WIDEST_INTEGER_WIDTH ? readWideInteger(view, offset) : readNarrowInteger(payload, offset, width);
  }
  if (serialType % 2 === 0) return payload.slice(offset, offset + width);
  try {
    return UTF8_DECODER.decode(payload.subarray(offset, offset + width));
  } catch {
    throw new SqliteFormatError('a text column is not valid UTF-8');
  }
}

/**
 * Turn an assembled record into its column values.
 *
 * The record header is a varint giving its own length (the length varint
 * included), then one serial-type varint per column. The bodies follow in the
 * same order. Every column body must lie inside the payload.
 *
 * @param payload The whole record, overflow already joined on.
 * @throws SqliteFormatError If the header or a body does not fit the payload.
 */
function decodeRecord(payload: Uint8Array): SqliteValue[] {
  const headerLength = readVarint(payload, { start: 0, limit: payload.length });
  if (headerLength.value < headerLength.next || headerLength.value > payload.length) {
    throw new SqliteFormatError('a record header has an impossible length');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const values: SqliteValue[] = [];
  let typePosition = headerLength.next;
  let bodyOffset = headerLength.value;
  while (typePosition < headerLength.value) {
    const serialType = readVarint(payload, { start: typePosition, limit: headerLength.value });
    const width = serialTypeWidth(serialType.value);
    if (bodyOffset + width > payload.length) {
      throw new SqliteFormatError('a record column runs past the end of its record');
    }
    values.push(decodeColumn(payload, view, { serialType: serialType.value, offset: bodyOffset, width }));
    bodyOffset += width;
    typePosition = serialType.next;
  }
  return values;
}

/**
 * Read one table leaf cell and decode its row.
 *
 * The cell is `payload size` and `rowid` varints, the local part of the payload,
 * and, only when the payload spilled, a 4-byte first overflow page. The rowid is
 * parsed to find where the payload starts and then dropped: a scan has no use
 * for it, and a table's own `INTEGER PRIMARY KEY` is stored as NULL in the
 * record anyway.
 *
 * @param database The opened file.
 * @param pageStart Byte offset of the leaf page.
 * @param cellOffset The cell's offset from the start of the page.
 * @throws SqliteFormatError If the cell leaves its page or lies about a size.
 */
function readLeafCell(database: SqliteDatabase, pageStart: number, cellOffset: number): SqliteValue[] {
  const limit = pageStart + database.usableSize;
  if (cellOffset >= database.usableSize) {
    throw new SqliteFormatError('a cell starts outside its page');
  }
  const size = readVarint(database.bytes, { start: pageStart + cellOffset, limit });
  const rowid = readVarint(database.bytes, { start: size.next, limit });
  const payloadSize = size.value;
  if (payloadSize > database.bytes.length) {
    throw new SqliteFormatError('a record is larger than the whole file');
  }
  const localSize = localPayloadSize(database, payloadSize);
  const localEnd = rowid.next + localSize;
  const needsOverflow = localSize < payloadSize;
  if (localEnd + (needsOverflow ? PAGE_NUMBER_SIZE : 0) > limit) {
    throw new SqliteFormatError('a cell runs past the end of its page');
  }
  if (!needsOverflow) return decodeRecord(database.bytes.subarray(rowid.next, localEnd));
  const payload = new Uint8Array(payloadSize);
  payload.set(database.bytes.subarray(rowid.next, localEnd), 0);
  const firstOverflow = readUint32(database.bytes, { start: localEnd, limit });
  fillFromOverflow(database, payload, localSize, firstOverflow);
  return decodeRecord(payload);
}

/** What a b-tree page header says, with the cell pointer array's position. */
interface PageHeader {
  /** Absolute offset of the page's first byte. */
  readonly pageStart: number;
  readonly pageType: number;
  readonly cellCount: number;
  /** Absolute offset of the first cell pointer. */
  readonly pointersStart: number;
  /** Absolute offset one past the page's usable bytes. */
  readonly limit: number;
  /** Only an interior page has one; 0 on a leaf. */
  readonly rightMostPage: number;
}

/**
 * Read the b-tree header of one page and check its cell pointer array fits.
 *
 * @param database The opened file.
 * @param pageNumber The page to read.
 * @throws SqliteFormatError If the header or the pointer array leaves the page.
 */
function readPageHeader(database: SqliteDatabase, pageNumber: number): PageHeader {
  const pageStart = pageStartOf(database, pageNumber);
  const limit = pageStart + database.usableSize;
  const headerStart = pageStart + (pageNumber === 1 ? DATABASE_HEADER_SIZE : 0);
  const pageType = database.bytes[headerStart] ?? 0;
  const isInterior = pageType === PAGE_TYPE_TABLE_INTERIOR;
  if (!isInterior && pageType !== PAGE_TYPE_TABLE_LEAF) {
    throw new SqliteFormatError(`page ${pageNumber} has the type 0x${pageType.toString(16)}, which is not a table page`);
  }
  const headerSize = isInterior ? INTERIOR_HEADER_SIZE : LEAF_HEADER_SIZE;
  const cellCount = readUint16(database.bytes, { start: headerStart + 3, limit });
  const pointersStart = headerStart + headerSize;
  if (pointersStart + cellCount * CELL_POINTER_SIZE > limit) {
    throw new SqliteFormatError(`page ${pageNumber} lists more cells than fit on it`);
  }
  const rightMostPage = isInterior ? readUint32(database.bytes, { start: headerStart + 8, limit }) : 0;
  return { pageStart, pageType, cellCount, pointersStart, limit, rightMostPage };
}

/**
 * The cell offsets of a page, in the order the page lists them.
 *
 * @param database The opened file.
 * @param header The page's header, from {@link readPageHeader}.
 */
function readCellOffsets(database: SqliteDatabase, header: PageHeader): number[] {
  return Array.from({ length: header.cellCount }, (_unused, index) =>
    readUint16(database.bytes, { start: header.pointersStart + index * CELL_POINTER_SIZE, limit: header.limit }),
  );
}

/**
 * The child page numbers of an interior page, left to right.
 *
 * Each cell begins with a 4-byte left child pointer; the rowid varint after it
 * only matters to a keyed lookup, so a scan skips it. The right-most pointer
 * lives in the page header and comes last.
 *
 * @param database The opened file.
 * @param header The interior page's header.
 * @throws SqliteFormatError If a cell's pointer leaves the page.
 */
function readChildPages(database: SqliteDatabase, header: PageHeader): number[] {
  const children = readCellOffsets(database, header).map((cellOffset) =>
    readUint32(database.bytes, { start: header.pageStart + cellOffset, limit: header.limit }),
  );
  children.push(header.rightMostPage);
  return children;
}

/**
 * Walk a table b-tree and yield every row in rowid order.
 *
 * An explicit stack replaces recursion, so a deep tree cannot overflow the call
 * stack, and the loop is bounded twice: by the number of pages it may visit, and
 * by the number of references it may hold pending. Both limits are the file's
 * own page count, because a valid b-tree reaches each page exactly once.
 *
 * @param database The opened file.
 * @param rootPage The b-tree's root page number.
 * @throws SqliteFormatError On a cycle, a bad page, or a bad cell.
 */
function* walkTable(database: SqliteDatabase, rootPage: number): Generator<SqliteValue[]> {
  const pending: number[] = [rootPage];
  let visits = 0;
  while (pending.length > 0) {
    const pageNumber = pending.pop();
    if (pageNumber === undefined) break;
    visits += 1;
    if (visits > database.pageCount) {
      throw new SqliteFormatError('the b-tree visits more pages than the file holds, so it loops');
    }
    const header = readPageHeader(database, pageNumber);
    if (header.pageType === PAGE_TYPE_TABLE_LEAF) {
      for (const cellOffset of readCellOffsets(database, header)) {
        yield readLeafCell(database, header.pageStart, cellOffset);
      }
      continue;
    }
    pending.push(...readChildPages(database, header).toReversed());
    if (visits + pending.length > database.pageCount) {
      throw new SqliteFormatError('the b-tree points at more pages than the file holds');
    }
  }
}

/**
 * Find the root page of a table by scanning `sqlite_schema`, which is the
 * b-tree rooted at page 1.
 *
 * Its rows are `type, name, tbl_name, rootpage, sql`. Only a row with the type
 * `table` and the exact name counts; a view or an index of the same name has no
 * table b-tree to walk.
 *
 * @param database The opened file.
 * @param tableName The table to find.
 * @throws SqliteFormatError If there is no such table, or its root page is not a number.
 */
function findTableRootPage(database: SqliteDatabase, tableName: string): number {
  for (const row of walkTable(database, 1)) {
    const [kind, name, , rootPage] = row;
    if (kind !== 'table' || name !== tableName) continue;
    // `Number.isInteger` is false for a string, so a text rootpage is refused here
    // without a runtime type probe, and `Number(...)` on a proven integer is the
    // identity.
    if (!Number.isInteger(rootPage)) {
      throw new SqliteFormatError(`table "${tableName}" has no root page`);
    }
    return Number(rootPage);
  }
  throw new SqliteFormatError(`the file has no table named "${tableName}"`);
}

/**
 * Read every row of one table, in rowid order.
 *
 * The header and the table's presence are checked when this is CALLED, so a
 * wrong file fails at the call site and not on the first iteration. The rows
 * themselves are produced lazily, one cell at a time.
 *
 * @param bytes The whole database file.
 * @param tableName The table to read, matched exactly.
 * @returns The rows, each an array of its column values in table order.
 * @throws SqliteFormatError For anything this reader cannot or will not read.
 */
export function readTableRows(bytes: Uint8Array, tableName: string): Generator<SqliteValue[]> {
  const database = openDatabase(bytes);
  return walkTable(database, findTableRootPage(database, tableName));
}
