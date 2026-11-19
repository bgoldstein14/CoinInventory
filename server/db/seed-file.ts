/*
 * Validates db/seed-data/issuers-denominations.json, the hand-authored reference
 * data db/seed.ts inserts. Every problem is reported in one error: unknown issuer
 * keys, duplicate issuer keys/names, duplicate labels under one issuer (which
 * would make denomination resolution ambiguous) and values too long for their column.
 */

export const ISSUER_KINDS = ['modern', 'historical', 'ancient'] as const;
export type IssuerKind = (typeof ISSUER_KINDS)[number];

/** `Issuers.Name` and `Denominations.Label` are both NVARCHAR(100). */
export const MAX_NAME_LENGTH = 100;

/** One authored issuer, after validation. */
export interface SeedIssuer {
  /** Stable slug joining the two arrays. Never reaches the database. */
  key: string;
  name: string;
  isoCode: string | null;
  kind: IssuerKind;
  validFrom: number | null;
  validTo: number | null;
  sortOrder: number;
}

/** One authored denomination, after validation. */
export interface SeedDenomination {
  /** The `key` of the issuer that struck it. */
  issuer: string;
  label: string;
  faceValue: number | null;
  sortOrder: number;
}

export interface SeedFile {
  issuers: SeedIssuer[];
  denominations: SeedDenomination[];
}

/** Thrown with every problem found, one per line. */
export class SeedValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `server/db/seed-data/issuers-denominations.json is not usable ` +
        `(${problems.length} problem${problems.length === 1 ? '' : 's'}):\n  ` +
        problems.join('\n  ')
    );
    this.name = 'SeedValidationError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

/** `undefined` and `null` both mean "not stated". */
const optional = (value: unknown): unknown => (value === undefined ? null : value);

/**
 * Read and check the whole file, reporting every problem at once.
 *
 * @throws SeedValidationError listing every problem found
 */
export function validateSeed(data: unknown): SeedFile {
  const problems: string[] = [];

  if (!isRecord(data)) {
    throw new SeedValidationError([
      `the file must contain a JSON object with "issuers" and "denominations" arrays (got ${
        data === null ? 'null' : typeof data
      })`,
    ]);
  }

  const rawIssuers = data['issuers'];
  const rawDenominations = data['denominations'];

  if (!Array.isArray(rawIssuers)) problems.push('"issuers" must be an array');
  if (!Array.isArray(rawDenominations)) problems.push('"denominations" must be an array');
  if (problems.length > 0) throw new SeedValidationError(problems);

  /* ---- issuers ------------------------------------------------------- */
  const issuers: SeedIssuer[] = [];
  const keysSeen = new Map<string, number>();
  const namesSeen = new Map<string, number>();

  (rawIssuers as unknown[]).forEach((raw, index) => {
    const where = `issuers[${index}]`;
    if (!isRecord(raw)) {
      problems.push(`${where}: must be an object`);
      return;
    }

    const key = String(raw['key'] ?? '').trim();
    const name = String(raw['name'] ?? '').trim();
    const kind = raw['kind'];
    const isoCode = optional(raw['isoCode']);
    const validFrom = optional(raw['validFrom']);
    const validTo = optional(raw['validTo']);
    const sortOrder = raw['sortOrder'];
    const label = `${where} ${name ? `'${name}'` : ''}`.trim();

    if (!key) problems.push(`${label}: "key" must be a non-empty slug`);
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
      // The key joins the two arrays, so it must be an unambiguous slug.
      problems.push(`${label}: "key" must be lower-case letters, digits and hyphens (got '${key}')`);
    }

    if (!name) problems.push(`${label}: "name" must be non-empty`);
    else if (name.length > MAX_NAME_LENGTH) {
      problems.push(`${label}: "name" is ${name.length} characters; Issuers.Name is NVARCHAR(${MAX_NAME_LENGTH})`);
    }

    if (!ISSUER_KINDS.includes(kind as IssuerKind)) {
      problems.push(`${label}: "kind" must be one of ${ISSUER_KINDS.join(', ')} (got ${JSON.stringify(kind)})`);
    }

    if (isoCode !== null && !(typeof isoCode === 'string' && /^[A-Za-z]{2}$/.test(isoCode))) {
      // CHAR(2); null for ancients and historical states.
      problems.push(`${label}: "isoCode" must be exactly two letters or null (got ${JSON.stringify(isoCode)})`);
    }

    for (const [field, value] of [['validFrom', validFrom], ['validTo', validTo]] as const) {
      if (value !== null && !isInteger(value)) {
        problems.push(`${label}: "${field}" must be a whole year or null (got ${JSON.stringify(value)})`);
      }
    }
    if (isInteger(validFrom) && isInteger(validTo) && validTo < validFrom) {
      problems.push(`${label}: "validTo" (${validTo}) is before "validFrom" (${validFrom})`);
    }

    if (!isInteger(sortOrder)) {
      problems.push(`${label}: "sortOrder" must be a whole number (got ${JSON.stringify(sortOrder)})`);
    }

    if (key) {
      const first = keysSeen.get(key);
      if (first !== undefined) problems.push(`${label}: duplicate issuer key '${key}', first used by issuers[${first}]`);
      else keysSeen.set(key, index);
    }
    if (name) {
      // Case-insensitive, matching SQL Server's default collation on UQ_Issuers_Name.
      const folded = name.toLowerCase();
      const first = namesSeen.get(folded);
      if (first !== undefined) problems.push(`${label}: duplicate issuer name '${name}', first used by issuers[${first}]`);
      else namesSeen.set(folded, index);
    }

    issuers.push({
      key,
      name,
      isoCode: typeof isoCode === 'string' ? isoCode.toUpperCase() : null,
      kind: kind as IssuerKind,
      validFrom: isInteger(validFrom) ? validFrom : null,
      validTo: isInteger(validTo) ? validTo : null,
      sortOrder: isInteger(sortOrder) ? sortOrder : 0,
    });
  });

  /* ---- denominations -------------------------------------------------- */
  const denominations: SeedDenomination[] = [];
  const pairsSeen = new Map<string, number>();

  (rawDenominations as unknown[]).forEach((raw, index) => {
    const where = `denominations[${index}]`;
    if (!isRecord(raw)) {
      problems.push(`${where}: must be an object`);
      return;
    }

    const issuer = String(raw['issuer'] ?? '').trim();
    const rawLabel = raw['label'];
    const labelText = typeof rawLabel === 'string' ? rawLabel.trim() : '';
    const faceValue = optional(raw['faceValue']);
    const sortOrder = raw['sortOrder'];
    const where2 = `${where} ${labelText ? `'${labelText}'` : ''}`.trim();

    if (!labelText) problems.push(`${where2}: "label" must be non-empty`);
    else if (labelText.length > MAX_NAME_LENGTH) {
      problems.push(`${where2}: "label" is ${labelText.length} characters; Denominations.Label is NVARCHAR(${MAX_NAME_LENGTH})`);
    }

    if (!issuer) {
      problems.push(`${where2}: "issuer" must name an issuer key`);
    } else if (!keysSeen.has(issuer)) {
      problems.push(`${where2}: unknown issuer key '${issuer}' -- no issuer in this file has that key`);
    }

    if (faceValue !== null && !(typeof faceValue === 'number' && Number.isFinite(faceValue))) {
      problems.push(`${where2}: "faceValue" must be a number or null (got ${JSON.stringify(faceValue)})`);
    }

    if (!isInteger(sortOrder)) {
      problems.push(`${where2}: "sortOrder" must be a whole number (got ${JSON.stringify(sortOrder)})`);
    }

    if (issuer && labelText) {
      // Case-insensitive, for the same collation reason.
      const pair = `${issuer}\u0000${labelText.toLowerCase()}`;
      const first = pairsSeen.get(pair);
      if (first !== undefined) {
        problems.push(
          `${where2}: duplicate denomination -- issuer '${issuer}' already has label '${labelText}' at denominations[${first}]. ` +
            `Two rows that fold to one key make every resolution of that text ambiguous, which resolves to NULL.`
        );
      } else {
        pairsSeen.set(pair, index);
      }
    }

    denominations.push({
      issuer,
      label: labelText,
      faceValue: typeof faceValue === 'number' ? faceValue : null,
      sortOrder: isInteger(sortOrder) ? sortOrder : 0,
    });
  });

  if (problems.length > 0) throw new SeedValidationError(problems);
  return { issuers, denominations };
}
