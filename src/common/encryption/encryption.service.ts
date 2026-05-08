import { Injectable, OnModuleInit } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/** Delimiter is safe for AES-GCM output encoded as standard base64. */
const TOKEN_SEP = ':';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ALGORITHM = 'aes-256-gcm';

/**
 * Field-at-rest AES-256-GCM. Key from ENCRYPTION_KEY only; never log plaintext or key.
 */
@Injectable()
export class EncryptionService implements OnModuleInit {
  private key!: Buffer;

  /**
   * Customer columns encrypted at rest. full_name stays plaintext for ILIKE search / merge logic.
   */
  static readonly CUSTOMER_ENCRYPTED_FIELDS = [
    'address',
    'barangay',
    'city',
    'region',
    'contact_number',
    'email',
    'id_presented',
  ] as const;

  onModuleInit(): void {
    const raw = process.env.ENCRYPTION_KEY;
    if (!raw?.trim()) {
      throw new Error(
        'ENCRYPTION_KEY is required (32-byte UTF-8 string or 64 hex characters)',
      );
    }
    this.key = this.resolveKey(raw.trim());
  }

  private resolveKey(raw: string): Buffer {
    if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
      const buf = Buffer.from(raw, 'hex');
      if (buf.length !== 32) {
        throw new Error('ENCRYPTION_KEY hex must decode to exactly 32 bytes');
      }
      return buf;
    }
    const utf8 = Buffer.from(raw, 'utf8');
    if (utf8.length !== 32) {
      throw new Error(
        'ENCRYPTION_KEY must be exactly 32 bytes (UTF-8) or 64 hex characters',
      );
    }
    return utf8;
  }

  /** True if value matches iv:ciphertext:tag (base64) shape from encrypt(). */
  isEncrypted(value: string | null | undefined): boolean {
    if (!value || typeof value !== 'string') return false;
    const parts = value.split(TOKEN_SEP);
    if (parts.length !== 3) return false;
    const [ivB64, ctB64, tagB64] = parts;
    if (!ivB64 || !ctB64 || !tagB64) return false;
    try {
      const iv = Buffer.from(ivB64, 'base64');
      const tag = Buffer.from(tagB64, 'base64');
      if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) return false;
      Buffer.from(ctB64, 'base64');
      return true;
    } catch {
      return false;
    }
  }

  encrypt(plainText: string): string {
    if (plainText === '') return '';
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plainText, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}${TOKEN_SEP}${ciphertext.toString('base64')}${TOKEN_SEP}${tag.toString('base64')}`;
  }

  decrypt(stored: string): string {
    if (stored === '' || stored == null) return stored ?? '';
    if (!this.isEncrypted(stored)) return stored;
    try {
      const [ivB64, ctB64, tagB64] = stored.split(TOKEN_SEP);
      const iv = Buffer.from(ivB64, 'base64');
      const ciphertext = Buffer.from(ctB64, 'base64');
      const tag = Buffer.from(tagB64, 'base64');
      if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
        return stored;
      }
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return stored;
    }
  }

  decryptNullable(value: string | null | undefined): string | null {
    if (value == null) return value ?? null;
    return this.decrypt(value);
  }

  encryptUserFullName(name: string): string {
    return this.encrypt(name);
  }

  decryptUserFullName(name: string | null | undefined): string | null {
    if (name == null) return name ?? null;
    return this.decrypt(name);
  }

  /** Mutates record: encrypt string customer PII fields before Prisma/DB write. */
  applyCustomerFieldsForWrite(record: Record<string, unknown>): void {
    for (const f of EncryptionService.CUSTOMER_ENCRYPTED_FIELDS) {
      if (!(f in record)) continue;
      const v = record[f];
      if (typeof v !== 'string') continue;
      record[f] = v === '' ? v : this.encrypt(v);
    }
  }

  decryptCustomerRow<T extends Record<string, unknown>>(
    row: T | null,
  ): T | null {
    if (!row) return row;
    const out = { ...row };
    for (const f of EncryptionService.CUSTOMER_ENCRYPTED_FIELDS) {
      const v = out[f as keyof T];
      if (typeof v === 'string') {
        (out as Record<string, unknown>)[f] = this.decrypt(v);
      }
    }
    return out;
  }

  decryptCustomerEmbed(
    embed: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null | undefined {
    if (embed == null) return embed;
    return this.decryptCustomerRow(embed) ?? embed;
  }

  /** Joined users row: only full_name is encrypted on public.users. */
  decryptUsersJoin(
    u: { full_name?: string | null; email?: string | null } | null | undefined,
  ): { full_name?: string | null; email?: string | null } | null | undefined {
    if (u == null) return u;
    return {
      ...u,
      full_name: u.full_name != null ? this.decrypt(u.full_name) : u.full_name,
      email: u.email,
    };
  }

  encryptTransactionDetails(details: string | null | undefined): string | null {
    if (details == null || details === '') return details ?? null;
    return this.encrypt(String(details));
  }

  decryptTransactionDetails(
    details: string | null | undefined,
  ): string | null | undefined {
    if (details == null) return details;
    return this.decrypt(details);
  }

  encryptBranchContactNumber(contact: string): string {
    return this.encrypt(contact);
  }

  decryptBranchContactNumber(
    contact: string | null | undefined,
  ): string | null {
    if (contact == null) return contact ?? null;
    return this.decrypt(contact);
  }
}
