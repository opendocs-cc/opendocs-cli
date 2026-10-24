import { describe, test, expect } from "vitest";
import { formatSigner, parseSigner, parseSigners, SignerParseError } from "../../src/lib/signers.js";
import { filenameFromDisposition } from "../../src/lib/api.js";

describe("lib/signers parseSigner", () => {
  test('parses "Name <email>"', () => {
    expect(parseSigner("John Adams <adams@company.com>")).toEqual({
      name: "John Adams",
      email: "adams@company.com",
    });
  });

  test('parses "Role=Name <email>" and trims around the parts', () => {
    expect(parseSigner("  Board member = Jón Jónsson   <jon@acme.is> ")).toEqual({
      name: "Jón Jónsson",
      email: "jon@acme.is",
      role: "Board member",
    });
  });

  test("accepts no space before the bracket and strips quotes around name and role", () => {
    expect(parseSigner(`"Employee"='John Adams'<adams@company.com>`)).toEqual({
      name: "John Adams",
      email: "adams@company.com",
      role: "Employee",
    });
  });

  test("only the first = separates the role", () => {
    expect(parseSigner("CEO=A=B <a@b.co>")).toEqual({ name: "A=B", email: "a@b.co", role: "CEO" });
  });

  test.each([
    ["adams@company.com", /has no name/],
    ["Employee=adams@company.com", /has no name/],
    ["<adams@company.com>", /has no name/],
    ["Employee= <adams@company.com>", /has no name/],
    ["John Adams adams@company.com", /angle brackets/],
    ["John Adams", /no email address/],
    ["John Adams <adams@company>", /not a valid email/],
    ["John Adams <adams company.com>", /not a valid email/],
    ["John Adams <adams@@company.com>", /not a valid email/],
    ["John Adams <>", /not a valid email/],
    ["=John Adams <adams@company.com>", /role before "=" is empty/],
    ["Sign;er=John Adams <adams@company.com>", /can't contain/],
    ["Sign{er}=John Adams <adams@company.com>", /can't contain/],
    [`${"x".repeat(61)}=John Adams <adams@company.com>`, /longer than 60/],
  ])("rejects %j", (input, message) => {
    expect(() => parseSigner(input)).toThrow(SignerParseError);
    expect(() => parseSigner(input)).toThrow(message);
  });

  test("errors carry the invalid_signers code", () => {
    try {
      parseSigner("nope");
      expect.unreachable();
    } catch (err) {
      expect((err as SignerParseError).code).toBe("invalid_signers");
    }
  });
});

describe("lib/signers parseSigners", () => {
  test("keeps order and mixes signers with and without roles", () => {
    expect(
      parseSigners(["Employee=John Adams <adams@company.com>", "Jón Jónsson <jon@acme.is>"]),
    ).toEqual([
      { name: "John Adams", email: "adams@company.com", role: "Employee" },
      { name: "Jón Jónsson", email: "jon@acme.is" },
    ]);
  });

  test("requires at least one and at most 10 signers", () => {
    expect(() => parseSigners([])).toThrow(/at least one --signer/);
    const eleven = Array.from({ length: 11 }, (_, i) => `P${i} <p${i}@acme.com>`);
    expect(() => parseSigners(eleven)).toThrow(/at most 10/);
    expect(parseSigners(eleven.slice(0, 10))).toHaveLength(10);
  });

  test("rejects the same role twice (case-insensitive)", () => {
    expect(() =>
      parseSigners(["Employee=John Adams <adams@company.com>", "employee=Jane Roe <jane@company.com>"]),
    ).toThrow(/given to both John Adams and Jane Roe/);
  });
});

describe("lib/signers formatSigner", () => {
  test("numbers the signer and adds the role after an em dash", () => {
    expect(formatSigner({ name: "John Adams", email: "adams@company.com", role: "Employee" }, 1)).toBe(
      "1. John Adams <adams@company.com> — Employee",
    );
    expect(formatSigner({ name: "Jane Roe", email: "jane@acme.com", role: null }, 2)).toBe(
      "2. Jane Roe <jane@acme.com>",
    );
  });
});

describe("lib/api filenameFromDisposition", () => {
  test("reads quoted, RFC 5987 and bare filenames", () => {
    expect(filenameFromDisposition('attachment; filename="Offer (signed).pdf"')).toBe("Offer (signed).pdf");
    expect(
      filenameFromDisposition(`attachment; filename="Stjornarfundir.pdf"; filename*=UTF-8''Stj%C3%B3rnarfundir.pdf`),
    ).toBe("Stjórnarfundir.pdf");
    expect(filenameFromDisposition("attachment; filename=offer.pdf")).toBe("offer.pdf");
    expect(filenameFromDisposition("attachment")).toBeNull();
    expect(filenameFromDisposition(null)).toBeNull();
  });
});
