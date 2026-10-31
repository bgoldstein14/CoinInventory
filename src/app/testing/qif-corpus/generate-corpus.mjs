/* ===========================================================================
 * generate-corpus.mjs
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS
 *   The generator for the eight synthetic Quicken exports that sit next to it
 *   in `src/app/testing/qif-corpus/`. Run it and it rewrites all eight,
 *   byte for byte:
 *
 *       node src/app/testing/qif-corpus/generate-corpus.mjs
 *
 *   The corpus is COMMITTED as well as reproducible. Committing it means the
 *   suite needs no build step; committing the generator means the data is not
 *   magic -- anyone can see exactly what is in those files and why.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *   Until this file was written, `qif-accounts.fixture.ts` read the owner's
 *   REAL Quicken exports out of the repository root: eight 6.7 MB files
 *   holding 815 securities, of which only about half were coins. The rest was
 *   his financial life -- stock and fund holdings, a retirement account, savings bonds, option
 *   positions, bank and credit-card accounts, income categories, a private
 *   company name and his street address (it was in a Quicken TAG). The
 *   repository is going public, so those files have to go.
 *
 *   They could not go while the tests depended on them, and the tests
 *   depended on them for a reason that is easy to lose: THE SHAPE OF THE
 *   DATA, not its size.
 *
 * ---------------------------------------------------------------------------
 * !! THE ONE PROPERTY THAT MUST NOT BE "SIMPLIFIED" AWAY !!
 * ---------------------------------------------------------------------------
 *   COLLISION DENSITY. The synthetic census in import-tiers.spec.ts derives
 *   its inventory FROM THE FILENAMES IT TESTS, so it can never hold two coins
 *   of one year and one denomination -- and that is precisely the shape every
 *   interesting bug has hidden in. The real accounts were full of it, and
 *   THIS CORPUS REPRODUCES THE SAME COUNTS, measured before it was written:
 *
 *       account                 coins  (year,denom) groups  largest group
 *       Early Proofs               59                    3              3
 *       2-3-20-cent Collection    112                   26             10
 *       Odd Type Set               13                    3              4
 *       Type Coins                 96                   13              3
 *       20th Cent. Type            22                    3              2
 *       Gold Coins                 44                    5              2
 *       Misc. Coins               131                   12              7
 *
 *   plus FOUR YEARS in Early Proofs that hold both a 3CS and a 3CN, which is
 *   what makes the generic-denomination rule testable at all.
 *
 *   A corpus of one coin per (year, denomination) would let every matcher
 *   test in the suite go on passing while testing almost nothing. If you are
 *   here to shrink this file, shrink the PRICE HISTORY and the CATEGORY LIST.
 *   Do not shrink the coins.
 *
 * ---------------------------------------------------------------------------
 * HOW THE SECURITY NAMES WERE OBTAINED -- "KEEP THE STRUCTURE, LOSE THE MAN"
 * ---------------------------------------------------------------------------
 *   The names in corpus-data.mjs are not invented from nothing and they are
 *   not his collection either. They were produced from the real export by
 *   four BIJECTIONS, each applied to one attribute and nothing else:
 *
 *     YEAR    a single global year->year bijection, chosen so that every
 *             (denomination, year) pair keeps the SAME coin-type band in
 *             quicken-import.service.ts and the SAME alloy band in
 *             pm-reference.ts. Because one map is shared by every
 *             denomination, co-occurrence survives: the years that held both
 *             a 3CS and a 3CN still do. Because it is a bijection, every
 *             duplicate group keeps its exact multiplicity.
 *
 *             56 of the 136 years are deliberately FIXED POINTS: a year that
 *             any security names a date-locked variety for -- "Open 3"
 *             (1873), "N/C" and "W/C" (1883), "VDB" (1909), "Rays" (1866-67),
 *             "T1", the overdates, the commemoratives -- cannot move without
 *             turning the name into nonsense. Pinning is done per YEAR rather
 *             than per security precisely so that a group never half-moves.
 *
 *     MINT    S <-> O before 1906, S <-> D from 1906 on, so the mint still
 *             existed on the date. CC and P are left alone for the same
 *             reason. Both spellings survive -- glued to the year ("1877O
 *             20¢") and hyphenated ("1913-D $5") -- because the matcher reads
 *             them differently.
 *
 *     GRADE   a bijection inside each letter class (AU50->AU53->AU55->AU58->
 *             AU50, and so on). Suffixes ride along untouched, so "PF64RB"
 *             becomes "PF65RB" and "MS64DMPL" becomes "MS65DMPL".
 *
 *     CERT    PCGS <-> NGC. ANACS, PCI, ICG, the "/CAC" sticker and the
 *             real export's "NCG" typo are left exactly as they were, because
 *             each of them is a parser branch.
 *
 *   Four bijections composed are still a bijection, which is why no two
 *   securities collided and every count in the census above came out
 *   unchanged.
 *
 *   COSTS are a strictly increasing function of the real ones --
 *   round(cost^0.97 x 1.42) -- so a double eagle still costs far more than a
 *   two-cent piece and a PF65 still costs more than the same coin in VF,
 *   while no absolute figure is his. DATES are shifted by a constant 143
 *   days, which likewise preserves every ordering.
 *
 *   There are NO certification numbers anywhere in the corpus, for the same
 *   reason there were none in the real export: Quicken never held them and
 *   the importer never reads them. Inventing some would have created a new
 *   thing to audit rather than removing one.
 *
 * ---------------------------------------------------------------------------
 * WHICH QIF SECTIONS THE IMPORTER READS, AND WHICH IT IGNORES
 * ---------------------------------------------------------------------------
 *   Read, in `QuickenImportService.parse`:
 *
 *     !Account        the `N` line names the account every following
 *                     transaction belongs to, and feeds the account picker.
 *     !Type:Invst     blocks carrying a `Y` (security) line. `D N Y I Q T U
 *                     M O` are the fields it understands.
 *
 *   Ignored, each by a different code path -- which is why the corpus still
 *   contains all of them:
 *
 *     !Type:Prices    short-circuited by name before any field parsing; the
 *                     real export had 155,521 of these blocks and they are
 *                     the entire reason those files were 6.7 MB each.
 *     !Type:Security  the master list. Every block has an `N` line, so it
 *                     LOOKS like a transaction to `parseInvestmentFields`
 *                     and is dropped one step later for having no `Y`.
 *     !Type:Cat       same shape, same reason -- categories have `N`/`D`.
 *     !Type:Tag       same again.
 *     !Type:Bank      bank and credit-card registers: `D T P L M N` and no
 *                     `Y`, so they drop out at the same test.
 *     NXIn / NXOut    cash transfers WITH an account context but no coin --
 *                     an explicit skip list in the service.
 *     !Option: / !Clear:AutoSwitch
 *                     not `!Account` and not `!Type`, so they reach
 *                     `parseInvestmentFields` and return null.
 *
 *   The corpus carries a synthetic version of every one of those because the
 *   owner's instinct -- "I don't see why this application would do anything
 *   but ignore stuff that it doesn't actually store" -- is exactly right and
 *   exactly the thing that could silently stop being true. A corpus holding
 *   nothing but coins would stop testing the ignoring.
 *
 *   Every non-coin item below is invented. The tickers are six characters
 *   beginning "ZQ", which is not a form any US exchange issues, so none of
 *   them can be looked up as a real holding.
 * ======================================================================== */

import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COIN_ACCOUNTS } from './corpus-data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ===========================================================================
 * WINDOWS-1252, NOT UTF-8
 * ---------------------------------------------------------------------------
 * In the real exports a cent sign is the single byte 0xA2 and "½" is 0xBD.
 * `quicken-import-modal.ts` decodes with `new TextDecoder('windows-1252')`
 * and so does the fixture, so the corpus has to be written in that encoding
 * or the tests would be exercising a decode the application never performs.
 *
 * The table is built by DECODING every high byte rather than typed out, so it
 * is the exact inverse of the decoder the application uses.
 * ======================================================================== */
function cp1252Encoder() {
  const decoder = new TextDecoder('windows-1252');
  const map = new Map();
  for (let byte = 0; byte < 256; byte++) {
    const char = decoder.decode(new Uint8Array([byte]));
    if (!map.has(char)) map.set(char, byte);
  }
  return (text) => {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const byte = map.get(text[i]);
      if (byte === undefined) throw new Error(`"${text[i]}" has no windows-1252 byte (at ${i})`);
      bytes[i] = byte;
    }
    return Buffer.from(bytes);
  };
}
const encode = cp1252Encoder();

/* ===========================================================================
 * THE NON-COIN FURNITURE -- ALL INVENTED
 * ======================================================================== */

/** Quicken tags. The real file had a street address in one of these. */
const TAGS = [
  ['\\', null],
  ['A101', null],
  ['A202', 'Spare set, box two'],
  ['B303', null],
  ['Show 2015', 'Regional show, spring 2015'],
  ['Duplicates', null],
  ['Sets', null]
];

/** Income and expense categories. The real file named a private employer. */
const CATEGORIES = [
  ['Auction Fees', 'Auction house commission', 'E', 'R000'],
  ['Bullion Sales', 'Proceeds of bullion sales', 'I', 'R286'],
  ['Coin Supplies', 'Holders, flips, albums', 'E', 'R000'],
  ['Dealer Fees', null, 'E', 'R000'],
  ['Div Income', 'Dividend Income', 'I', 'R286'],
  ['Grading Fees', 'Third-party grading', 'E', 'R000'],
  ['Hobby Income', null, 'I', 'R460'],
  ['Insurance:Collection', 'Scheduled collection rider', 'E', 'R000'],
  ['Int Income', 'Interest Income', 'I', 'R286'],
  ['Postage', 'Shipping and insurance', 'E', 'R000'],
  ['Show Travel', null, 'E', 'R000'],
  ['Storage', 'Safe deposit box', 'E', 'R000']
];

/**
 * Accounts of every type the real export carried, so the `!Account` scan and
 * the account picker see the same variety. Only the `Invst` rows below ever
 * hold a coin.
 */
const SIDE_ACCOUNTS = [
  ['Alder Bank - Checking', 'Bank', 'Everyday checking'],
  ['Alder Bank - Savings', 'Bank', null],
  ['Birch Credit Union MMA', 'Bank', null],
  ['Cedar Card - Rewards', 'CCard', null],
  ['Cedar Card - Travel', 'CCard', null],
  ['Petty Cash', 'Cash', null],
  ['Collection Insurance Rider', 'Oth A', null],
  ['Home Safe Contents', 'Oth A', null],
  ['Dealer Credit Line', 'Oth L', null],
  ['Driftwood Brokerage', 'Port', 'Taxable brokerage'],
  ['Driftwood Retirement', 'Port', null],
  ['Elm Street CD - 12 month', 'CD', null],
  ['Fernway Trust', 'Trust Fund', null],
  ['Unfiled Invoices', 'Invoice', null],
  ['Tax Holding', 'Tax', null]
];

/**
 * The securities master list, minus the coins. Every ticker is "ZQ" + four
 * letters -- a form no US exchange issues -- so none of these can be looked
 * up as a real position.
 */
const NON_COIN_SECURITIES = [
  ['Aldbury Manufacturing', 'ZQALDB', 'Stock'],
  ['Barrowfield Energy', 'ZQBRWF', 'Stock'],
  ['Caldmere Health Group', 'ZQCALD', 'Stock'],
  ['Dunwich Freight Lines', 'ZQDUNW', 'Stock'],
  ['Eastmere Semiconductor', 'ZQEAST', 'Stock'],
  ['Fallowgate Retail', 'ZQFALL', 'Stock'],
  ['Garrowby Chemical', 'ZQGARR', 'Stock'],
  ['Harrowden Pharmaceutical', 'ZQHARR', 'Stock'],
  ['Inglewick Insurance', 'ZQINGL', 'Stock'],
  ['Jarrowfield Mining', 'ZQJARR', 'Stock'],
  ['Kelvedon Software', 'ZQKELV', 'Stock'],
  ['Lanchester Utilities', 'ZQLANC', 'Stock'],
  ['Marchmont Foods', 'ZQMARC', 'Stock'],
  ['Netherby Telecom', 'ZQNETH', 'Stock'],
  ['Oakmere Aerospace', 'ZQOAKM', 'Stock'],
  ['Pennycross Bancorp', 'ZQPENN', 'Stock'],
  ['Quarrington Rail', 'ZQQUAR', 'Stock'],
  ['Ravensmoor Timber', 'ZQRAVE', 'Stock'],
  ['Broad Market Index Fund', 'ZQBMIF', 'Mutual Fund'],
  ['Conservative Allocation Fund', 'ZQCAFD', 'Mutual Fund'],
  ['Dividend Growth Fund', 'ZQDGFD', 'Mutual Fund'],
  ['Emerging Markets Fund', 'ZQEMFD', 'Mutual Fund'],
  ['Intermediate Bond Fund', 'ZQIBFD', 'Mutual Fund'],
  ['Money Market Reserve Fund', 'ZQMMRF', 'Mutual Fund'],
  ['Small Cap Value Fund', 'ZQSCVF', 'Mutual Fund'],
  ['Target 2040 Fund', 'ZQT40F', 'Mutual Fund'],
  ['Municipal Bond 2031', 'ZQMB31', 'Bond'],
  ['Municipal Bond 2034', 'ZQMB34', 'Bond'],
  ['Corporate Note 2029', 'ZQCN29', 'Bond'],
  ['$100 Series I Bond 5/2019', 'ZQIB19', 'US Savings Bond'],
  ['$100 Series I Bond 9/2020', 'ZQIB20', 'US Savings Bond'],
  ['$500 Series EE Bond 2/2017', 'ZQEE17', 'US Savings Bond'],
  ['Aldbury Jan 50 Call', 'ZQALDC', 'Stock Option'],
  ['Barrowfield Mar 25 Put', 'ZQBRWP', 'Stock Option'],
  ['Eastmere Jun 120 Call', 'ZQEASC', 'Stock Option'],
  ['Broad Market Composite', 'ZQIDXA', 'Market Index'],
  ['Small Cap Composite', 'ZQIDXB', 'Market Index'],
  ['Generic Silver Round 1 oz', 'ZQAGRD', 'Bullion'],
  ['Generic Gold Bar 1 oz', 'ZQAUBR', 'Bullion'],
  ['Platinum Bar 1 oz', 'ZQPTBR', 'Bullion'],
  ['Unallocated Storage Credit', 'ZQUSTC', 'Other'],
  ['Club Membership Deposit', 'ZQCLUB', 'Other'],
  ['Fernway Trust Units', 'ZQFWTU', 'Trust Fund'],
  ['Elm Street CD - 12 month', 'ZQECD1', 'CD']
];

/** Invented dealers. Nobody real is named anywhere in this corpus. */
const DEALERS = [
  'Harbourstone Coins', 'Pelham & Vance', 'Kingsmere Numismatics',
  'Tollgate Rarities', 'Westmarch Coin Co.', 'Ambersley Auctions'
];

/* ===========================================================================
 * BUILDING ONE FILE
 * ======================================================================== */

const LF = '\n';
const block = (lines) => lines.join(LF) + LF + '^' + LF;

function tagSection() {
  let out = '!Type:Tag' + LF;
  for (const [name, description] of TAGS) {
    out += block(['N' + name, ...(description ? ['D' + description] : [])]);
  }
  return out;
}

function categorySection() {
  let out = '!Type:Cat' + LF;
  for (const [name, description, kind, code] of CATEGORIES) {
    out += block([
      'N' + name,
      ...(description ? ['D' + description] : []),
      kind === 'E' ? 'E' : 'T',
      'R' + code.slice(1),
      kind === 'I' ? 'I' : 'E'
    ]);
  }
  return out;
}

/**
 * The account list, with its real-world quirk intact: Quicken writes
 * `!Option:AutoSwitch` immediately before the first `!Account`, so the FIRST
 * account shares a block with the option line and the importer -- which keys
 * on the block's first line -- never registers it. That is the behaviour on
 * the owner's own files and the corpus reproduces it rather than tidying it.
 */
function accountSection(coinAccounts) {
  let out = '!Option:AutoSwitch' + LF + '!Account' + LF;
  const all = [
    ...SIDE_ACCOUNTS,
    ...coinAccounts.map((a) => [a.account, 'Invst', null])
  ];
  all.forEach(([name, type, description], index) => {
    const lines = ['N' + name, 'T' + type, ...(description ? ['D' + description] : [])];
    out += (index === 0 ? '' : '') + lines.join(LF) + LF + '^' + LF;
  });
  out += '!Clear:AutoSwitch' + LF;
  return out;
}

function securitySection(coinNames) {
  let out = '';
  for (const [name, ticker, type] of NON_COIN_SECURITIES) {
    out += '!Type:Security' + LF + block(['N' + name, 'S' + ticker, 'T' + type]);
  }
  for (const name of coinNames) {
    // Coin securities carry no symbol, exactly as Quicken writes them.
    out += '!Type:Security' + LF + block(['N' + name, 'T' + (/G?\$[0-9]/.test(name) ? 'Gold Coin' : 'Coin')]);
  }
  return out;
}

/** The coin account's own register. */
function investmentSection(account, dealerSeed) {
  let out = '!Account' + LF + block(['N' + account.account, 'TInvst']);
  out += '!Type:Invst' + LF;

  // A cash transfer in, and a cash entry: both are skipped by the importer
  // (NXIn is on the cash-transfer list, NCash carries no security at all).
  out += block([
    'D1/15\'10', 'NXIn', 'P' + DEALERS[dealerSeed % DEALERS.length], 'U1,500.00', 'T1,500.00',
    'MOpening transfer', 'L[Alder Bank - Checking]', '$1,500.00'
  ]);
  out += block(['D1/16\'10', 'NCash', 'L[' + account.account + ']']);

  account.coins.forEach((coin, index) => {
    const dealer = DEALERS[(dealerSeed + index) % DEALERS.length];
    const amount = coin.c.toFixed(2);
    if (coin.a === 'ShrsIn') {
      out += block([
        'D' + coin.bd, 'NShrsIn', 'Y' + coin.n, 'I' + amount, 'Q1', 'U' + amount, 'T' + amount,
        'MXfr From: Misc. Coins'
      ]);
    } else {
      out += block([
        'D' + coin.bd, 'N' + coin.a, 'Y' + coin.n, 'I' + amount, 'Q1', 'T' + amount,
        'P' + dealer, ...(coin.a === 'BuyX' ? ['L[Alder Bank - Checking]', '$' + amount] : [])
      ]);
    }
    if (coin.d) {
      const proceeds = (coin.p ?? coin.c).toFixed(2);
      if (coin.d === 'ShrsOut') {
        out += block(['D' + coin.sd, 'NShrsOut', 'Y' + coin.n, 'Q1', 'MXfr To: Odd Type Set']);
      } else {
        out += block([
          'D' + coin.sd, 'N' + coin.d, 'Y' + coin.n, 'I' + proceeds, 'Q1', 'T' + proceeds,
          'P' + DEALERS[(dealerSeed + index + 3) % DEALERS.length],
          ...(coin.d === 'SellX' ? ['L[Alder Bank - Checking]', '$' + proceeds] : [])
        ]);
      }
    }
  });
  return out;
}

/**
 * A second investment account holding nothing but stock, so the account
 * filter in `parse(text, account)` has something it must actually exclude.
 */
function otherBrokerageSection() {
  let out = '!Account' + LF + block(['NDriftwood Brokerage', 'TPort']);
  out += '!Type:Invst' + LF;
  const rows = [
    ['3/ 4\'18', 'Buy', 'Aldbury Manufacturing', '41.22', '100'],
    ['6/19\'19', 'Buy', 'Broad Market Index Fund', '118.40', '25'],
    ['9/ 8\'20', 'Sell', 'Barrowfield Energy', '27.65', '50'],
    ['2/11\'21', 'ReinvDiv', 'Dividend Growth Fund', '33.10', '4.512'],
    ['5/23\'22', 'Buy', 'Municipal Bond 2031', '99.25', '10']
  ];
  for (const [date, action, security, price, qty] of rows) {
    out += block([
      'D' + date, 'N' + action, 'Y' + security, 'I' + price, 'Q' + qty,
      'T' + (Number(price) * Number(qty)).toFixed(2)
    ]);
  }
  return out;
}

/** A bank register: `D T P L M N` and never a `Y`, so the importer drops it. */
function bankSection() {
  let out = '!Account' + LF + block(['NAlder Bank - Checking', 'TBank']);
  out += '!Type:Bank' + LF;
  const rows = [
    ['1/ 8\'19', '-42.00', 'Harbourstone Coins', 'Coin Supplies', 'Flips and 2x2s', '1041'],
    ['2/14\'19', '-180.00', 'Tollgate Rarities', 'Grading Fees', 'Submission 4 coins', '1042'],
    ['3/ 2\'19', '1,250.00', 'Ambersley Auctions', 'Bullion Sales', 'Auction settlement', ''],
    ['4/19\'19', '-16.85', 'Post Office', 'Postage', 'Insured parcel', ''],
    ['7/ 1\'19', '-95.00', 'Elm Street Vault', 'Storage', 'Annual box fee', '1043']
  ];
  for (const [date, amount, payee, category, memo, check] of rows) {
    out += block([
      'D' + date, 'T' + amount, ...(check ? ['N' + check] : []),
      'P' + payee, 'L' + category, 'M' + memo
    ]);
  }
  return out;
}

/**
 * Price history. The real export carried 155,521 of these blocks -- they are
 * why those files were 6.7 MB each. Forty is enough to prove the
 * short-circuit in `parse` still fires.
 */
function priceSection() {
  let out = '';
  let value = 23.14;
  for (let i = 0; i < 40; i++) {
    const [name, ticker] = NON_COIN_SECURITIES[i % NON_COIN_SECURITIES.length];
    value = Math.round((value * 1.0137 + 0.42) * 100) / 100;
    const day = String((i % 28) + 1).padStart(2, ' ');
    out += '!Type:Prices' + LF + block([`"${ticker}",${value.toFixed(2)}," ${((i % 12) + 1)}/${day}'24"`]);
    if (!name) break;
  }
  return out;
}

/* ===========================================================================
 * WHAT GOES IN WHICH FILE
 * ---------------------------------------------------------------------------
 * The real exports repeated the WHOLE 815-security master list in every one
 * of the eight files. Reproducing that exactly would cost about 4 MB of
 * repository for no extra coverage, so each file here carries the complete
 * non-coin list, its own account's coins, and a slice of the other accounts'
 * coins -- enough that the master list is always bigger than the account and
 * always contains securities the account never traded.
 * ======================================================================== */
function otherAccountSample(index) {
  const sample = [];
  COIN_ACCOUNTS.forEach((account, i) => {
    if (i === index) return;
    for (let k = 0; k < account.coins.length; k += 11) sample.push(account.coins[k].n);
  });
  return [...new Set(sample)].slice(0, 25);
}

function buildFile(index) {
  const account = COIN_ACCOUNTS[index];
  const coinNames = [...account.coins.map((c) => c.n), ...otherAccountSample(index)];
  return (
    tagSection() +
    categorySection() +
    accountSection(COIN_ACCOUNTS) +
    securitySection(coinNames) +
    investmentSection(account, index * 2) +
    priceSection() +
    otherBrokerageSection() +
    bankSection()
  );
}

let total = 0;
for (let i = 0; i < COIN_ACCOUNTS.length; i++) {
  const account = COIN_ACCOUNTS[i];
  const text = buildFile(i);
  const bytes = encode(text);
  const path = resolve(HERE, account.file);
  writeFileSync(path, bytes);
  total += bytes.length;

  // THE DECODE IS ASSERTED, NOT ASSUMED. If this ever stopped holding, every
  // denomination in the corpus would turn into a replacement character and
  // the suite would go on passing against a corpus the importer never sees.
  const back = new TextDecoder('windows-1252').decode(readFileSync(path));
  if (back !== text) throw new Error(`${account.file} did not round-trip through windows-1252`);
  const raw = readFileSync(path);
  const hasCent = raw.includes(0xa2);
  const hasHalf = raw.includes(0xbd);
  console.log(
    `${account.file.padEnd(22)} ${String(bytes.length).padStart(7)} bytes  ` +
    `${String(account.coins.length).padStart(3)} coins  0xA2:${hasCent ? 'yes' : 'no '}  0xBD:${hasHalf ? 'yes' : 'no '}`
  );
}
console.log(`total ${total} bytes`);
