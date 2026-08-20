export type CoinGrade =
  | 'Poor'
  | 'Fair'
  | 'AG'
  | 'G'
  | 'VG'
  | 'F'
  | 'VF'
  | 'XF'
  | 'AU'
  | 'MS60'
  | 'MS61'
  | 'MS62'
  | 'MS63'
  | 'MS64'
  | 'MS65'
  | 'MS66'
  | 'MS67'
  | 'MS68'
  | 'MS69'
  | 'MS70'
  | 'PR60'
  | 'PR63'
  | 'PR65'
  | 'PR68'
  | 'PR70'
  | 'PF60'
  | 'PF63'
  | 'PF65'
  | 'PF68'
  | 'PF70';

export interface CoinRecord {
  id: string;
  name: string;
  denomination: string;
  year: number | null;
  type: string;
  category: string;
  country: string;
  grade: CoinGrade | string;
  certCompany: string;
  certNumber: string;
  variety: string;
  mintMark: string;
  composition: string;
  purchaseDate: string;
  purchasePrice: number;
  currentValue: number;
  notes: string;
  imagePaths: string[];
  tags: string[];
  source: 'manual' | 'quicken' | 'import';
  /**
   * Whether this coin carries a CAC "green bean" sticker. CAC does not
   * grade coins independently - it stickers a coin already graded by a
   * third-party service (typically PCGS or NGC) as meeting a tighter
   * quality bar within its stated grade. So this is a layered accent on
   * top of certCompany/certNumber, not a replacement for them - a coin
   * can be, for example, "PCGS MS64" AND carry a green bean at once.
   * Optional (rather than required) so records saved before this field
   * existed keep loading without a migration; treat missing/undefined
   * the same as `false`.
   */
  hasCacSticker?: boolean;
}

export interface QuickenImportRecord {
  id: string;
  name: string;
  denomination: string;
  account?: string;
  purchaseDate?: string;
  purchasePrice: number;
  currentValue: number;
  country: string;
  type: string;
  notes: string;
  source: 'quicken';
}

export interface ImageMatchCandidate {
  imagePath: string;
  matchedRecordId: string | null;
  confidence: number;
  reason: string;
}
