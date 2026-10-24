import type { SignerInput } from "./api.js";

/**
 * `--signer` values for `opendocs sign request`:
 *
 *   "John Adams <adams@company.com>"
 *   "Employee=John Adams <adams@company.com>"
 *
 * The role (before the first `=`) must match a role in the document's
 * ```signature block when it has one. Parsing is strict on purpose: an agent
 * should pass exactly what the user said, and a typo'd address should fail
 * here rather than send a contract to the wrong inbox.
 */

export const MAX_SIGNERS = 10;
const MAX_ROLE_LENGTH = 60;

export class SignerParseError extends Error {
  code = "invalid_signers";
  constructor(message: string) {
    super(message);
    this.name = "SignerParseError";
  }
}

const FORMAT_HINT = 'Use "Name <email>" or "Role=Name <email>", e.g. --signer "Employee=John Adams <adams@company.com>".';

// Deliberately simple: one @, no spaces or brackets, a dot in the domain
// and a TLD of 2+ characters. Catches the typos that matter (missing @,
// "gmail" without ".com", stray commas) without rejecting real addresses.
const EMAIL_RE = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[^\s@<>()[\]",;:.]{2,}$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email) && !email.includes("..");
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).trim();
  }
  return v;
}

export function parseSigner(raw: string): SignerInput {
  const input = raw.trim();
  const match = /^(.*?)\s*<([^<>]*)>\s*$/.exec(input);
  if (!match) {
    const bareEmail = /^(?:[^=\s]+=)?\S+@\S+$/.test(input);
    if (bareEmail) {
      throw new SignerParseError(`--signer "${raw}" has no name. ${FORMAT_HINT} Ask the user for the signer's full name; don't guess it.`);
    }
    if (input.includes("@")) {
      throw new SignerParseError(`--signer "${raw}": put the email in angle brackets. ${FORMAT_HINT}`);
    }
    throw new SignerParseError(`--signer "${raw}" has no email address. ${FORMAT_HINT}`);
  }

  const [, before, rawEmail] = match;
  const email = rawEmail.trim();
  if (!isValidEmail(email)) {
    throw new SignerParseError(`--signer "${raw}": "${email}" is not a valid email address.`);
  }

  let role: string | undefined;
  let name = before;
  const eq = before.indexOf("=");
  if (eq !== -1) {
    role = unquote(before.slice(0, eq));
    name = before.slice(eq + 1);
    if (!role) {
      throw new SignerParseError(`--signer "${raw}": the role before "=" is empty. ${FORMAT_HINT}`);
    }
    if (role.length > MAX_ROLE_LENGTH) {
      throw new SignerParseError(`--signer "${raw}": the role is longer than ${MAX_ROLE_LENGTH} characters.`);
    }
    if (/[;{}\n\r]/.test(role)) {
      throw new SignerParseError(`--signer "${raw}": a role can't contain ; { } = or line breaks.`);
    }
  }

  name = unquote(name);
  if (!name) {
    throw new SignerParseError(`--signer "${raw}" has no name. ${FORMAT_HINT} Ask the user for the signer's full name; don't guess it.`);
  }
  if (/[<>\n\r]/.test(name)) {
    throw new SignerParseError(`--signer "${raw}" isn't in the right format. ${FORMAT_HINT}`);
  }

  return role ? { name, email, role } : { name, email };
}

/** Parses every `--signer` and checks the set: 1–10 signers, unique roles. */
export function parseSigners(values: string[]): SignerInput[] {
  if (values.length === 0) {
    throw new SignerParseError(`Pass at least one --signer. ${FORMAT_HINT}`);
  }
  if (values.length > MAX_SIGNERS) {
    throw new SignerParseError(`Got ${values.length} signers; a request can have at most ${MAX_SIGNERS}.`);
  }
  const signers = values.map(parseSigner);
  const seen = new Map<string, string>();
  for (const s of signers) {
    if (!s.role) continue;
    const key = s.role.toLowerCase();
    const other = seen.get(key);
    if (other) {
      throw new SignerParseError(`Role "${s.role}" is given to both ${other} and ${s.name}. Each role has exactly one signer.`);
    }
    seen.set(key, s.name);
  }
  return signers;
}

/** `1. John Adams <adams@company.com> — Employee` */
export function formatSigner(s: { name: string; email: string; role?: string | null }, index: number): string {
  return `${index}. ${s.name} <${s.email}>${s.role ? ` — ${s.role}` : ""}`;
}
