import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  uploadLocalImagesAndRewrite,
  findLocalImageRefs,
  type ImageUploader,
} from "../../src/lib/images.js";

describe("lib/images", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-img-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("findLocalImageRefs only returns local refs", () => {
    const md = [
      "![a](./local.png)",
      "![b](https://cdn.example.com/remote.png)",
      '<img src="./diagram.svg" />',
      "![c](data:image/png;base64,AAAA)",
    ].join("\n\n");
    expect(findLocalImageRefs(md).sort()).toEqual(
      ["./diagram.svg", "./local.png"].sort(),
    );
  });

  test("uploadLocalImagesAndRewrite forwards workspaceId to the uploader", async () => {
    const imagePath = path.join(tmpDir, "hero.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const sourceFile = path.join(tmpDir, "post.md");
    fs.writeFileSync(sourceFile, "![hero](./hero.png)\n");

    const presign = vi.fn<ImageUploader["presignImageUpload"]>().mockResolvedValue({
      uploadUrl: "https://storage.example/put?sig=abc",
      publicUrl: "https://cdn.example.com/images/ws_abc/hero.png",
      key: "images/ws_abc/hero.png",
      expiresInSeconds: 300,
    });
    const putBlob = vi.fn<ImageUploader["uploadToSignedUrl"]>().mockResolvedValue();
    const client: ImageUploader = {
      presignImageUpload: presign,
      uploadToSignedUrl: putBlob,
    };

    const { markdown, report } = await uploadLocalImagesAndRewrite({
      markdown: "![hero](./hero.png)\n",
      sourceFile,
      client,
      workspaceId: "ws_abc",
    });

    expect(presign).toHaveBeenCalledTimes(1);
    expect(presign).toHaveBeenCalledWith({
      workspaceId: "ws_abc",
      contentType: "image/png",
      contentLength: 4,
      filename: "hero.png",
    });
    expect(putBlob).toHaveBeenCalledTimes(1);
    expect(markdown).toContain("https://cdn.example.com/images/ws_abc/hero.png");
    expect(report.uploaded).toHaveLength(1);
    expect(report.skipped).toHaveLength(0);
  });

  test("returns unchanged markdown when no local images are referenced", async () => {
    const presign = vi.fn();
    const client: ImageUploader = {
      presignImageUpload: presign as never,
      uploadToSignedUrl: vi.fn() as never,
    };

    const input = "# Heading\n\n![remote](https://cdn.example.com/x.png)\n";
    const { markdown, report } = await uploadLocalImagesAndRewrite({
      markdown: input,
      sourceFile: path.join(tmpDir, "post.md"),
      client,
      workspaceId: "ws_abc",
    });

    expect(markdown).toBe(input);
    expect(report.uploaded).toHaveLength(0);
    expect(report.skipped).toHaveLength(0);
    expect(presign).not.toHaveBeenCalled();
  });

  test("skips local image refs that escape the document directory", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "opendocs-outside-"));
    const outsideImage = path.join(outsideDir, "secret.png");
    fs.writeFileSync(outsideImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const sourceFile = path.join(tmpDir, "post.md");
    const ref = path.relative(tmpDir, outsideImage);
    fs.writeFileSync(sourceFile, `![secret](${ref})\n`);

    const presign = vi.fn<ImageUploader["presignImageUpload"]>();
    const client: ImageUploader = {
      presignImageUpload: presign,
      uploadToSignedUrl: vi.fn() as never,
    };

    try {
      const { markdown, report } = await uploadLocalImagesAndRewrite({
        markdown: `![secret](${ref})\n`,
        sourceFile,
        client,
        workspaceId: "ws_abc",
      });

      expect(markdown).toBe(`![secret](${ref})\n`);
      expect(presign).not.toHaveBeenCalled();
      expect(report.uploaded).toHaveLength(0);
      expect(report.skipped).toEqual([
        { original: ref, reason: "outside the document directory" },
      ]);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  describe("reference-style images", () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    function makeClient() {
      let n = 0;
      const presign = vi
        .fn<ImageUploader["presignImageUpload"]>()
        .mockImplementation(async ({ filename }) => {
          n += 1;
          return {
            uploadUrl: `https://storage.example/put?sig=${n}`,
            publicUrl: `https://cdn.example.com/images/ws_abc/${n}-${filename}`,
            key: `images/ws_abc/${n}-${filename}`,
            expiresInSeconds: 300,
          };
        });
      const putBlob = vi.fn<ImageUploader["uploadToSignedUrl"]>().mockResolvedValue();
      const client: ImageUploader = {
        presignImageUpload: presign,
        uploadToSignedUrl: putBlob,
      };
      return { client, presign, putBlob };
    }

    function writeImage(rel: string) {
      const abs = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, PNG);
    }

    async function publish(markdown: string) {
      const sourceFile = path.join(tmpDir, "post.md");
      fs.writeFileSync(sourceFile, markdown);
      const { client, presign } = makeClient();
      const result = await uploadLocalImagesAndRewrite({
        markdown,
        sourceFile,
        client,
        workspaceId: "ws_abc",
      });
      return { ...result, presign };
    }

    test("uploads and rewrites a definition without a title", async () => {
      writeImage("img/chart.webp");
      const md = [
        "![Chart via a reference definition][chart-ref]",
        "",
        "[chart-ref]: ./img/chart.webp",
        "",
      ].join("\n");

      expect(findLocalImageRefs(md)).toEqual(["./img/chart.webp"]);

      const { markdown, report, presign } = await publish(md);
      expect(presign).toHaveBeenCalledTimes(1);
      expect(presign.mock.calls[0][0].contentType).toBe("image/webp");
      expect(markdown).toBe(
        [
          "![Chart via a reference definition][chart-ref]",
          "",
          "[chart-ref]: https://cdn.example.com/images/ws_abc/1-chart.webp",
          "",
        ].join("\n"),
      );
      expect(report.uploaded).toEqual([
        {
          original: "./img/chart.webp",
          url: "https://cdn.example.com/images/ws_abc/1-chart.webp",
          bytes: 4,
        },
      ]);
      expect(report.skipped).toHaveLength(0);
    });

    test("preserves double-quoted, single-quoted and parenthesised titles", async () => {
      writeImage("a.png");
      writeImage("b.png");
      writeImage("c.png");
      const md = [
        "![A][a] ![B][b] ![C][c]",
        "",
        '[a]: ./a.png "Title A"',
        "  [b]: b.png 'Title B'",
        "[c]: ./c.png (Title C)",
      ].join("\n");

      const { markdown, report } = await publish(md);
      expect(report.uploaded).toHaveLength(3);
      expect(markdown).toBe(
        [
          "![A][a] ![B][b] ![C][c]",
          "",
          '[a]: https://cdn.example.com/images/ws_abc/1-a.png "Title A"',
          "  [b]: https://cdn.example.com/images/ws_abc/2-b.png 'Title B'",
          "[c]: https://cdn.example.com/images/ws_abc/3-c.png (Title C)",
        ].join("\n"),
      );
    });

    test("handles angle-bracket targets, including paths with spaces", async () => {
      writeImage("img/path with spaces.png");
      const md = [
        "![Spaced][spaced]",
        "",
        '[spaced]: <./img/path with spaces.png> "With spaces"',
      ].join("\n");

      expect(findLocalImageRefs(md)).toEqual(["./img/path with spaces.png"]);

      const { markdown, report } = await publish(md);
      expect(report.uploaded).toHaveLength(1);
      expect(markdown).toBe(
        [
          "![Spaced][spaced]",
          "",
          '[spaced]: <https://cdn.example.com/images/ws_abc/1-path with spaces.png> "With spaces"',
        ].join("\n"),
      );
    });

    test("resolves collapsed and shortcut forms through the same definition", async () => {
      writeImage("img/chart.webp");
      const md = [
        "![chart-ref][]",
        "",
        "![Chart-Ref]",
        "",
        "[chart-ref]: ./img/chart.webp",
      ].join("\n");

      const { markdown, report, presign } = await publish(md);
      expect(presign).toHaveBeenCalledTimes(1);
      expect(report.uploaded).toHaveLength(1);
      expect(markdown).toContain(
        "[chart-ref]: https://cdn.example.com/images/ws_abc/1-chart.webp",
      );
      expect(markdown).toContain("![chart-ref][]");
      expect(markdown).toContain("![Chart-Ref]");
    });

    test("reports a used definition without an image extension as skipped", async () => {
      writeImage("img/chart");
      const md = "![Chart][chart]\n\n[chart]: ./img/chart\n";

      const { markdown, report, presign } = await publish(md);
      expect(presign).not.toHaveBeenCalled();
      expect(markdown).toBe(md);
      expect(report.skipped).toEqual([
        { original: "./img/chart", reason: "unsupported extension (none)" },
      ]);
    });

    test("leaves definitions inside fenced code blocks alone", async () => {
      writeImage("img/chart.webp");
      const md = [
        "Example syntax:",
        "",
        "```md",
        "![Chart][chart-ref]",
        "",
        "[chart-ref]: ./img/chart.webp",
        "```",
        "",
        "~~~",
        "[other]: ./img/chart.webp",
        "~~~",
        "",
      ].join("\n");

      expect(findLocalImageRefs(md)).toEqual([]);

      const { markdown, report, presign } = await publish(md);
      expect(presign).not.toHaveBeenCalled();
      expect(markdown).toBe(md);
      expect(report.uploaded).toHaveLength(0);
      expect(report.skipped).toHaveLength(0);
    });

    test("rewrites a real definition but not an identical one in a code block", async () => {
      writeImage("img/chart.webp");
      const md = [
        "![Chart][chart-ref]",
        "",
        "```",
        "[chart-ref]: ./img/chart.webp",
        "```",
        "",
        "[chart-ref]: ./img/chart.webp",
      ].join("\n");

      const { markdown } = await publish(md);
      expect(markdown).toBe(
        [
          "![Chart][chart-ref]",
          "",
          "```",
          "[chart-ref]: ./img/chart.webp",
          "```",
          "",
          "[chart-ref]: https://cdn.example.com/images/ws_abc/1-chart.webp",
        ].join("\n"),
      );
    });

    test("leaves remote definitions alone", async () => {
      const md = [
        "![Remote][remote] ![Proto][proto]",
        "",
        '[remote]: https://cdn.example.com/chart.webp "Remote"',
        "[proto]: //cdn.example.com/chart.png",
      ].join("\n");

      expect(findLocalImageRefs(md)).toEqual([]);

      const { markdown, report, presign } = await publish(md);
      expect(presign).not.toHaveBeenCalled();
      expect(markdown).toBe(md);
      expect(report.skipped).toHaveLength(0);
    });

    test("ignores non-image definitions that no image uses, and footnotes", async () => {
      fs.writeFileSync(path.join(tmpDir, "other.md"), "# other\n");
      const md = [
        "See [the other doc][other].[^1]",
        "",
        "[other]: ./other.md",
        "[^1]: ./footnote.png",
      ].join("\n");

      expect(findLocalImageRefs(md)).toEqual([]);
      const { markdown, presign } = await publish(md);
      expect(presign).not.toHaveBeenCalled();
      expect(markdown).toBe(md);
    });

    test("preserves CRLF line endings and detects CRLF fences", async () => {
      writeImage("a.png");
      const md = '![A][a]\r\n\r\n```\r\n[b]: ./a.png\r\n```\r\n\r\n[a]: ./a.png "T"\r\n';
      const { markdown } = await publish(md);
      expect(markdown).toBe(
        '![A][a]\r\n\r\n```\r\n[b]: ./a.png\r\n```\r\n\r\n[a]: https://cdn.example.com/images/ws_abc/1-a.png "T"\r\n',
      );
    });
  });
});
