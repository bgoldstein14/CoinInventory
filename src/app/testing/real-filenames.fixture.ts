/*
 * Every filename used by real-filenames.spec.ts, as one flat list, so other
 * specs (e.g. the import-tiers census) can measure across the whole set.
 * real-filenames.spec.ts has a guard test that every name it asserts on is here.
 *
 * Not a sample of a real image share: some names are verbatim, others are
 * constructed probes (bare cert numbers, prices in filenames, photo markers).
 * Counts measured from this list describe a test corpus only. Keep the verbatim
 * quirks as written (missing spaces, mixed-case ".JPG", "1875CC").
 */

/** Photographs of ONE identifiable coin. */
export const REAL_SINGLE_COIN_FILENAMES: readonly string[] = [
  // --- 3CN / 3CS: digits bound to a metal abbreviation -------------------
  '1865 3CN - Choice VF - Obverse - Photo.jpg',
  '1865 3CN - Obverse.jpg',
  '1873 3CN - Closed 3 - XF - Obverse.jpg',
  '1873 3CN - XF - Obverse.jpg',
  '1851 3CS - Obverse.jpg',
  '1851 3-cent - VF - Obverse.jpg',

  // --- the cent sign -----------------------------------------------------
  '1875 20¢ - VF+ - Obverse - Orig.jpg',
  '1875 20¢ - Obverse.jpg',
  '1812 50¢ VG - Obverse - Small.jpg',
  '1812 50¢ - Obverse.jpg',

  // --- the hyphenated N-cent form ----------------------------------------
  '1875-CC 20-cent Choice F - Obverse.jpg',
  '1875-S 20-cent ANACS XF40.jpg',
  '1875 20-cent - Obverse.jpg',
  '1870 1-cent NGC PF65RB - Obverse 2.jpg',
  '1870 10-cent - NGC PF64Cameo - Reverse 5.jpg',
  '1870 10-cent - Obverse.jpg',
  '1913 50-Cent Canadian - Obverse.jpg',
  '1913 50-Cent Canadian - Reverse.jpg',
  '1913 50-Cent Canadian - Obverse 2.jpg',
  '1913 50-Cent Canadian - Obverse - Photo.jpg',
  '1913 50-Cent Canadian - Obverse - Sharpened.jpg',
  '1913 50-Cent Canadian - Obverse - Small.jpg',
  '1964 Kennedy 50C - Obverse.jpg',

  // --- the dollar sign ---------------------------------------------------
  '1870 $1 - PCGS PF62CAM- Obverse.jpg',
  '1870 $1 - Obverse.jpg',
  '1904 $20 - PCGS MS63 - small.jpg',
  '1904 $20 - PCGS MS63 - Label.jpg',
  '1904 $20 - PCGS MS63.jpg',
  '1904 $20 - Obverse.jpg',
  '1906-S $5 - XF-AU.jpg',
  '1906-S $5.jpg',

  // --- mint mark glued to the year, no separator at all ------------------
  '1875CC - VF30 - 2 - Obverse.jpg',

  // --- Morgans and Peace dollars, the most duplicated coins on the share --
  '1881-S Morgan Dollar.jpg',
  '1881-S Morgan - 20 - Obverse.jpg',
  '1881-S Morgan Dollar - 20 - Obverse.jpg',
  '1881 Morgan Dollar NGC 2599001.jpg',
  '1881 Morgan Dollar PCGS MS63 - Obverse.jpg',
  '1925-S Peace Dollar $25.00.jpg',

  // --- a plain word denomination with a variety note ---------------------
  '2008 Hawaii Quarter - Dropped D - 2.JPG',

  // --- a FOREIGN unit: "5S" is sheqels, NOT five US cents ----------------
  'Israel 1982 5S Qumran Gold - ANACS PF69 DCAM - Obverse.jpeg',

  // --- a year with nothing else usable attached --------------------------
  '1873 - CLOSED.jpg',

  // --- ANCIENTS: no year, no denomination, a catalogue reference instead --
  '67-68 CE 1st Revolt - Obverse - 2.jpg',
  'Caracalla Denarius - Sear 6819 - Obverse.jpg',
  'Constantine - RIC 34 - Obverse.jpg',
  'Bar Kochba - Hendin 736 - Obverse 1.jpg'
];

/**
 * Files that are not a photograph of one identifiable coin (group shots,
 * non-coin items, camera defaults). The import reports these rather than
 * silently dropping them.
 */
export const REAL_NOT_ONE_COIN_FILENAMES: readonly string[] = [
  // group shots
  '20th Century Type Set.JPG',
  'Ancient Judaica - 8 coins - Obverse.jpg',
  'Gold Coins.JPG',
  'Canadian Cents - Part 1.jpg',
  'Coins - Obverse - Large.jpg',
  'Half Dimes and Cap and Rays.jpg',

  // non-coin items -- both of the first two carry a valid-looking "3 cent"
  'Stamp - 11 - 3 cent.jpg',
  '3-cent paper - Large.jpg',
  '3-cent Fractional - FR1227.jpg',
  'CSA Bond Coupon.jpg',

  // containers
  'Sovereign Proof Boxes.jpg',

  // camera defaults
  'Coin_026.JPG',
  'IM000025.JPG'
];

/** The whole corpus, single coins first. */
export const REAL_FILENAMES: readonly string[] = [
  ...REAL_SINGLE_COIN_FILENAMES,
  ...REAL_NOT_ONE_COIN_FILENAMES
];
