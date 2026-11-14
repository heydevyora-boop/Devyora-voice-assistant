import { randomBytes } from 'node:crypto';
import { AppConfigService } from '../src/config/app-config.module';
import {
  CryptoService,
  constantTimeEquals,
  parseKeys,
} from '../src/security/services/crypto.service';

function configWith(key: string | undefined): AppConfigService {
  return { providers: { tokenEncryptionKey: key } } as unknown as AppConfigService;
}

const KEY_1 = randomBytes(32).toString('base64');
const KEY_2 = randomBytes(32).toString('base64');

describe('credential encryption', () => {
  describe('key parsing', () => {
    it('reads a bare key as version 1', () => {
      const { keys, problems } = parseKeys(KEY_1);
      expect(problems).toEqual([]);
      expect(keys.get(1)?.length).toBe(32);
    });

    it('reads versioned keys, newest usable as current', () => {
      const { keys } = parseKeys(`1:${KEY_1},2:${KEY_2}`);
      expect(keys.size).toBe(2);
      expect(keys.get(2)?.toString('base64')).toBe(KEY_2);
    });

    it('skips a key of the wrong length and reports it', () => {
      const short = Buffer.alloc(16).toString('base64');
      const { keys, problems } = parseKeys(short);
      expect(keys.size).toBe(0);
      expect(problems[0]).toContain('16 bytes');
    });

    it('skips invalid base64 and reports it', () => {
      const { keys, problems } = parseKeys('1:not base64!!! @@@');
      expect(keys.size).toBe(0);
      expect(problems.length).toBeGreaterThan(0);
    });

    it('treats an absent or empty value as no keys at all', () => {
      expect(parseKeys(undefined).keys.size).toBe(0);
      expect(parseKeys('').keys.size).toBe(0);
      expect(parseKeys('   ').keys.size).toBe(0);
    });

    it('rejects a duplicate version and keeps the first', () => {
      const { keys, problems } = parseKeys(`1:${KEY_1},1:${KEY_2}`);
      expect(keys.get(1)?.toString('base64')).toBe(KEY_1);
      expect(problems.some((p) => p.includes('twice'))).toBe(true);
    });
  });

  describe('seal and open', () => {
    it('round-trips a credential', () => {
      const crypto = new CryptoService(configWith(KEY_1));
      const sealed = crypto.seal('a-real-oauth-token');
      expect(crypto.open(sealed.ciphertext, sealed.keyVersion)).toBe('a-real-oauth-token');
    });

    it('produces different ciphertext for the same plaintext each time', () => {
      // A fresh random IV per call. Equal ciphertexts would mean equal IVs,
      // which is the one thing that must never happen with AES-GCM.
      const crypto = new CryptoService(configWith(KEY_1));
      const a = crypto.seal('same value');
      const b = crypto.seal('same value');
      expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    });

    it('refuses to seal when no key is configured', () => {
      const crypto = new CryptoService(configWith(undefined));
      expect(crypto.available).toBe(false);
      expect(() => crypto.seal('x')).toThrow();
    });

    it('returns null, never throws, for a tampered ciphertext', () => {
      const crypto = new CryptoService(configWith(KEY_1));
      const sealed = crypto.seal('secret');
      const tampered = Buffer.from(sealed.ciphertext);
      tampered[tampered.length - 1] ^= 0xff;

      expect(crypto.open(tampered, sealed.keyVersion)).toBeNull();
    });

    it('returns null for a buffer too short to be real', () => {
      const crypto = new CryptoService(configWith(KEY_1));
      expect(crypto.open(Buffer.alloc(4), 1)).toBeNull();
      expect(crypto.open(null, 1)).toBeNull();
      expect(crypto.open(undefined, 1)).toBeNull();
    });

    it('returns null when the version named is not a key this process holds', () => {
      const crypto = new CryptoService(configWith(KEY_1));
      const sealed = crypto.seal('secret');
      expect(crypto.open(sealed.ciphertext, 99)).toBeNull();
    });

    it('opens old material after a key rotation, using the version the row names', () => {
      // Sealed under version 1 only.
      const before = new CryptoService(configWith(`1:${KEY_1}`));
      const sealed = before.seal('token-from-before-rotation');

      // Rotated: version 2 is now current, version 1 is kept for reads.
      const after = new CryptoService(configWith(`2:${KEY_2},1:${KEY_1}`));
      expect(after.version).toBe(2);
      expect(after.open(sealed.ciphertext, sealed.keyVersion)).toBe('token-from-before-rotation');

      // New material is sealed with the new version.
      const fresh = after.seal('token-from-after-rotation');
      expect(fresh.keyVersion).toBe(2);
    });

    it('flags material sealed under an older key as due for rotation', () => {
      const crypto = new CryptoService(configWith(`2:${KEY_2},1:${KEY_1}`));
      expect(crypto.needsRotation(1)).toBe(true);
      expect(crypto.needsRotation(2)).toBe(false);
    });

    it('reports no rotation need when encryption itself is unavailable', () => {
      const crypto = new CryptoService(configWith(undefined));
      expect(crypto.needsRotation(1)).toBe(false);
    });
  });

  describe('constant-time comparison', () => {
    it('matches equal strings and rejects unequal ones', () => {
      expect(constantTimeEquals('abc', 'abc')).toBe(true);
      expect(constantTimeEquals('abc', 'abd')).toBe(false);
      expect(constantTimeEquals('abc', 'ab')).toBe(false);
      expect(constantTimeEquals('', '')).toBe(true);
    });
  });
});
