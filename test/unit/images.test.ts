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
});
