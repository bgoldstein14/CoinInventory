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
  source: 'manual' | 'quicken' | 'import' | 'csv';
  hasCacSticker?: boolean;
  soldPrice?: number;
  soldDate?: string;
  dealer?: string;
  weight?: number;
  metalContent?: string;
  coinSet?: string;
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

export interface PendingImageMatch {
  fileName: string;
  thumbnailUrl: string;
  matchedCoinId: string | null;
  confidence: number;
  reason: string;
  status: 'auto-matched' | 'confirmed' | 'rejected' | 'pending' | 'unmatched';
}

export interface TransactionRecord {
  id: string;
  coinId: string;
  type: 'purchase' | 'sale' | 'trade' | 'appraisal';
  date: string;
  amount: number;
  dealer: string;
  notes: string;
}

export interface SpotPrices {
  gold: number;
  silver: number;
  platinum: number;
  copper: number;
}
