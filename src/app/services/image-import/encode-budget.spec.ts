/**
 * Tests for the stored-size budget.
 *
 * There is no <canvas> in this test environment, so the encoder is a fake
 * that returns whatever size the test wants for each rung. That is not a
 * compromise: the thing worth pinning is the DECISION — which rung is tried,
 * when it stops, and what happens when nothing fits — and that decision is
 * pure arithmetic over the results.
 */
import { describe, expect, it } from 'vitest';
import { ENCODE_LADDER, encodeWithinBudget, type EncodeAttempt } from './encode-budget';
import type { DownscaleResult } from './image-downscaler';

/** A fake encode that reports `bytes` for every attempt. */
function fixedSize(bytes: number, resized = true) {
  const attempts: EncodeAttempt[] = [];
  const encodeAt = async (attempt: EncodeAttempt): Promise<DownscaleResult> => {
    attempts.push(attempt);
    return {
      dataUrl: `data:image/jpeg;base64,${attempt.maxEdge}-${attempt.quality}`,
      width: attempt.maxEdge,
      height: attempt.maxEdge,
      originalBytes: 5_000_000,
      storedBytes: bytes,
      resized
    };
  };
  return { attempts, encodeAt };
}

/** A fake encode whose size shrinks with each rung. */
function shrinking(sizes: number[]) {
  const attempts: EncodeAttempt[] = [];
  const encodeAt = async (attempt: EncodeAttempt): Promise<DownscaleResult> => {
    const storedBytes = sizes[attempts.length] ?? sizes[sizes.length - 1]!;
    attempts.push(attempt);
    return {
      dataUrl: 'data:image/jpeg;base64,x',
      width: attempt.maxEdge,
      height: attempt.maxEdge,
      originalBytes: 5_000_000,
      storedBytes,
      resized: true
    };
  };
  return { attempts, encodeAt };
}

describe('the ladder', () => {
  it('starts at exactly what the app has always produced', () => {
    // *** 1600 px / quality 0.85 MUST BE RUNG 0. *** Every photograph in the
    // owner's database was imported at those numbers, and the whole claim
    // that the default budget changes nothing rests on this rung being
    // tried first and accepted whenever it fits.
    expect(ENCODE_LADDER[0]).toEqual({ maxEdge: 1600, quality: 0.85 });
  });

  it('only ever goes smaller', () => {
    for (let i = 1; i < ENCODE_LADDER.length; i++) {
      const previous = ENCODE_LADDER[i - 1]!;
      const current = ENCODE_LADDER[i]!;
      expect(current.maxEdge).toBeLessThanOrEqual(previous.maxEdge);
      expect(current.quality).toBeLessThanOrEqual(previous.quality);
    }
  });
});

describe('encodeWithinBudget', () => {
  it('encodes ONCE at the default budget — today\'s behaviour, unchanged', async () => {
    // A typical 1600 px photo at ~250 KB against the 1 MB default.
    const { attempts, encodeAt } = fixedSize(250 * 1024);

    const outcome = await encodeWithinBudget(1024 * 1024, encodeAt);

    expect(attempts).toEqual([{ maxEdge: 1600, quality: 0.85 }]);
    expect(outcome.attempts).toBe(1);
    expect(outcome.overBudget).toBe(false);
  });

  it('walks down the ladder until the result fits', async () => {
    const { attempts, encodeAt } = shrinking([900_000, 600_000, 380_000]);

    const outcome = await encodeWithinBudget(400 * 1024, encodeAt);

    expect(attempts).toHaveLength(3);
    expect(outcome.result.storedBytes).toBe(380_000);
    expect(outcome.overBudget).toBe(false);
  });

  it('keeps the smallest attempt rather than losing the photograph', async () => {
    /*
     * A budget nothing can meet is a settings mistake. Dropping the photo
     * over it would be far worse than storing one that is over: the photo
     * may be the only copy the user has, and a silently discarded import is
     * exactly what the whole feature is written to avoid.
     */
    const { attempts, encodeAt } = fixedSize(500_000);

    const outcome = await encodeWithinBudget(64 * 1024, encodeAt);

    expect(attempts).toHaveLength(ENCODE_LADDER.length);
    expect(outcome.result.storedBytes).toBe(500_000);
    // ...and it SAYS so, so the caller can report it rather than pretend.
    expect(outcome.overBudget).toBe(true);
  });

  it('stops early for a photo that was already small enough to pass through', async () => {
    // Capping the long edge again cannot shrink an image that was never
    // resized; grinding through four more encodes of the same tiny picture
    // would cost time and change nothing.
    const { attempts, encodeAt } = fixedSize(200_000, false);

    await encodeWithinBudget(64 * 1024, encodeAt);

    expect(attempts).toHaveLength(2);
  });

  it('treats a missing or nonsensical budget as no limit', async () => {
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { attempts, encodeAt } = fixedSize(9_000_000);
      const outcome = await encodeWithinBudget(budget, encodeAt);

      expect(attempts).toHaveLength(1);
      expect(outcome.overBudget).toBe(false);
    }
  });
});
