import { Command } from "commander";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import chalk from "chalk";
import { getConfigOrExit, type CliConfig } from "../lib/config.js";
import { createApiClient, type BrandingUpdate, type WorkspaceBranding } from "../lib/api.js";
import { createOutput, brand, type Output } from "../lib/output.js";

/**
 * `opendocs theme …` — the look of exported PDF and Word files for the
 * active workspace: brand color, font, logo and footer.
 *
 *   read:   (default) show · presets · fonts · check <color>
 *   change: set · logo                 (owners/admins, any plan)
 *           footer                     (owners/admins on Pro or Team)
 *
 * Changes apply to every export in the workspace, so they need --yes when
 * run non-interactively; agents should get their human's OK first.
 */

/** Below this contrast against white the API refuses a brand color. */
const MIN_CONTRAST = 4.5;
const RECOMMENDED_CONTRAST = 7;

function setup(cmd: Command) {
  const globalOpts = cmd.optsWithGlobals();
  const out = createOutput(globalOpts.json);
  const config = getConfigOrExit(out);
  if (globalOpts.apiUrl) config.apiUrl = globalOpts.apiUrl;
  return { out, config, client: createApiClient(config) };
}

function requireWorkspace(out: Output, config: CliConfig): string | null {
  if (!config.workspaceId) {
    out.error({ code: "no_workspace", message: 'No active workspace. Run "opendocs login" first.' });
    return null;
  }
  return config.workspaceId;
}

function fail(out: Output, err: unknown) {
  out.error(err as { status?: number; code?: string; message: string });
}

async function confirm(out: Output, yes: boolean, question: string): Promise<boolean> {
  if (yes) return true;
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    out.error({
      code: "confirm_required",
      message: `${question} This changes every PDF and Word export in the workspace. Ask your human, then pass --yes.`,
    });
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function normalizeHex(value: string): string | null {
  const hex = value.trim().startsWith("#") ? value.trim() : `#${value.trim()}`;
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toUpperCase() : null;
}

/** WCAG contrast ratio of a `#rrggbb` color against white. */
export function contrastAgainstWhite(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return Math.round((1.05 / (luminance + 0.05)) * 100) / 100;
}

function contrastVerdict(contrast: number) {
  if (contrast >= RECOMMENDED_CONTRAST) return brand.success("great for long documents");
  if (contrast >= MIN_CONTRAST) return brand.warn("readable; a darker shade would be easier on the eyes");
  return brand.error("too light: headings fade and white table-header text becomes unreadable");
}

function swatch(hex: string) {
  return chalk.bgHex(hex)("    ");
}

function footerLine(data: WorkspaceBranding) {
  const f = data.branding.footer;
  if (!f.enabled) return "hidden";
  return [f.companyName ?? data.workspace.name, f.tagline, f.linkLabel ?? f.linkUrl]
    .filter(Boolean)
    .join(" · ");
}

function printBranding(out: Output, data: WorkspaceBranding) {
  const b = data.branding;
  out.info(brand.label(`Export theme for ${data.workspace.name} (${data.tier} plan):`));
  out.info(
    `  Brand color  ${swatch(b.brandColor)} ${brand.value(b.brandColor)} ${brand.muted(`${b.contrast.contrast}:1 on white`)}`,
  );
  out.info(`  Font         ${brand.value(b.font)}`);
  out.info(`  Preset       ${b.preset ? brand.value(b.preset) : brand.muted("custom")}`);
  out.info(
    `  Logo         ${b.logoUrl ? (b.showLogoInExports ? "shown in exports" : "uploaded, hidden in exports") : brand.muted("none")}`,
  );
  out.info(`  Footer       ${footerLine(data)}`);
  if (data.role === "member") {
    out.info(brand.muted("  Only owners and admins can change the theme."));
  } else if (data.canEditFooter === false) {
    out.info(
      brand.muted(
        '  Free exports keep the "Made with OpenDocs" footer; your own footer is a Pro feature: https://opendocs.cc/dashboard/billing',
      ),
    );
  }
}

function printChange(out: Output, before: WorkspaceBranding, after: WorkspaceBranding) {
  const a = before.branding;
  const b = after.branding;
  out.succeed(`Export theme updated for ${after.workspace.name}`);
  if (a.brandColor !== b.brandColor) {
    out.info(`  Brand color  ${swatch(a.brandColor)} ${a.brandColor} → ${swatch(b.brandColor)} ${brand.value(b.brandColor)}`);
  }
  if (a.font !== b.font) out.info(`  Font         ${a.font} → ${brand.value(b.font)}`);
  if (a.showLogoInExports !== b.showLogoInExports) {
    out.info(`  Logo         ${b.showLogoInExports ? "shown in exports" : "hidden in exports"}`);
  }
  if (JSON.stringify(a.footer) !== JSON.stringify(b.footer)) {
    out.info(`  Footer       ${footerLine(after)}`);
  }
  if (b.contrast.level !== "great") out.warn(`Brand color is ${b.contrast.contrast}:1 on white: ${contrastVerdict(b.contrast.contrast)}`);
  out.info(brand.muted('  Preview it: opendocs export <doc> -f pdf'));
}

export const themeCommand = new Command("theme").description(
  "Brand color, font, logo and footer for PDF and Word exports in the active workspace",
);

async function show(cmd: Command) {
  const { out, config, client } = setup(cmd);
  const workspaceId = requireWorkspace(out, config);
  if (!workspaceId) return;
  try {
    out.spin("Fetching theme...");
    const data = await client.getBranding(workspaceId);
    out.stopSpinner();
    printBranding(out, data);
    out.result({
      ...data.branding,
      workspace: data.workspace,
      canEdit: data.canEdit,
      canEditFooter: data.canEditFooter,
      tier: data.tier,
    });
  } catch (err) {
    fail(out, err);
  }
}

themeCommand.action(async (_opts, cmd) => show(cmd));

themeCommand
  .command("show")
  .description("Show the current export theme")
  .action(async (_opts, cmd) => show(cmd));

themeCommand
  .command("presets")
  .description("List curated color + font presets")
  .action(async (_opts, cmd) => {
    const { out, config, client } = setup(cmd);
    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;
    try {
      const data = await client.getBranding(workspaceId);
      out.info(brand.label("Presets (opendocs theme set --preset <id>):"));
      for (const p of data.presets) {
        const current = data.branding.preset === p.id ? brand.success(" current") : "";
        out.info(`  ${swatch(p.brandColor)} ${brand.value(p.id.padEnd(12))} ${p.brandColor}  ${p.fontId.padEnd(14)} ${brand.muted(p.description)}${current}`);
      }
      out.result({ presets: data.presets, current: data.branding.preset });
    } catch (err) {
      fail(out, err);
    }
  });

themeCommand
  .command("fonts")
  .description("List fonts available in exports")
  .action(async (_opts, cmd) => {
    const { out, config, client } = setup(cmd);
    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;
    try {
      const data = await client.getBranding(workspaceId);
      out.info(brand.label("Fonts (opendocs theme set --font <name>):"));
      for (const f of data.fonts) {
        const current = data.branding.font === f.id ? brand.success(" current") : "";
        out.info(`  ${brand.value(f.id.padEnd(14))} ${f.category.padEnd(5)} ${brand.muted(f.description)}${current}`);
      }
      out.result({ fonts: data.fonts, current: data.branding.font });
    } catch (err) {
      fail(out, err);
    }
  });

themeCommand
  .command("check")
  .description("Check whether a color works as a brand color (no changes)")
  .argument("<color>", "Hex color, e.g. #13294B")
  .action(async (color: string, _opts, cmd) => {
    const out = createOutput(cmd.optsWithGlobals().json);
    const hex = normalizeHex(color);
    if (!hex) {
      out.error({ code: "invalid_color", message: "Use a hex color like #13294B." });
      return;
    }
    const contrast = contrastAgainstWhite(hex);
    const level = contrast >= RECOMMENDED_CONTRAST ? "great" : contrast >= MIN_CONTRAST ? "ok" : "too_light";
    out.info(`${swatch(hex)} ${brand.value(hex)} ${contrast}:1 on white: ${contrastVerdict(contrast)}`);
    out.result({ brandColor: hex, contrast, level, minContrast: MIN_CONTRAST, recommendedContrast: RECOMMENDED_CONTRAST });
  });

async function applyUpdate(cmd: Command, update: BrandingUpdate, summary: string, yes: boolean) {
  const { out, config, client } = setup(cmd);
  const workspaceId = requireWorkspace(out, config);
  if (!workspaceId) return;
  try {
    const before = await client.getBranding(workspaceId);
    if (!(await confirm(out, yes, `${summary} for ${before.workspace.name}?`))) return;
    out.spin("Updating theme...");
    const after = await client.updateBranding(workspaceId, update);
    out.stopSpinner();
    printChange(out, before, after);
    out.result({ ...after.branding, workspace: after.workspace });
  } catch (err) {
    fail(out, err);
  }
}

themeCommand
  .command("set")
  .description("Apply a preset and/or set brand color, font and logo visibility")
  .option("--preset <id>", "Preset id (see `opendocs theme presets`)")
  .option("--color <hex>", "Brand color, e.g. #13294B (must be dark: 4.5:1 on white or more)")
  .option("--font <name>", "Export font (see `opendocs theme fonts`)")
  .option("--logo-in-exports <on|off>", "Show the workspace logo in exports")
  .option("--allow-low-contrast", "Save a brand color below 4.5:1 anyway (not recommended)")
  .option("-y, --yes", "Confirm (required when not running in a terminal)")
  .action(async (opts, cmd) => {
    const out = createOutput(cmd.optsWithGlobals().json);
    const update: BrandingUpdate = {};
    const parts: string[] = [];
    if (opts.preset) {
      update.preset = opts.preset;
      parts.push(`preset ${opts.preset}`);
    }
    if (opts.color) {
      const hex = normalizeHex(opts.color);
      if (!hex) {
        out.error({ code: "invalid_color", message: "Use a hex color like #13294B." });
        return;
      }
      update.brandColor = hex;
      parts.push(`brand color ${hex}`);
    }
    if (opts.font) {
      update.font = opts.font;
      parts.push(`font ${opts.font}`);
    }
    if (opts.logoInExports !== undefined) {
      const value = String(opts.logoInExports).toLowerCase();
      if (!["on", "off", "true", "false"].includes(value)) {
        out.error({ code: "invalid_option", message: "--logo-in-exports takes on or off." });
        return;
      }
      update.showLogoInExports = value === "on" || value === "true";
      parts.push(`logo in exports ${update.showLogoInExports ? "on" : "off"}`);
    }
    if (opts.allowLowContrast) update.allowLowContrast = true;
    if (parts.length === 0) {
      out.error({
        code: "nothing_to_change",
        message: "Pass --preset, --color, --font or --logo-in-exports. See `opendocs theme presets`.",
      });
      return;
    }
    await applyUpdate(cmd, update, `Set ${parts.join(", ")}`, Boolean(opts.yes));
  });

themeCommand
  .command("footer")
  .description("Set the footer printed at the end of every export (Pro or Team)")
  .option("--company <name>", "Line 1 (defaults to the workspace name)")
  .option("--tagline <text>", "Line 2")
  .option("--link-url <url>", "Link shown after the tagline")
  .option("--link-label <text>", "Text for the link")
  .option("--on", "Show the footer")
  .option("--off", "Hide the footer")
  .option("-y, --yes", "Confirm (required when not running in a terminal)")
  .action(async (opts, cmd) => {
    const out = createOutput(cmd.optsWithGlobals().json);
    if (opts.on && opts.off) {
      out.error({ code: "invalid_option", message: "Pass --on or --off, not both." });
      return;
    }
    const footer: NonNullable<BrandingUpdate["footer"]> = {};
    if (opts.on) footer.enabled = true;
    if (opts.off) footer.enabled = false;
    if (opts.company !== undefined) footer.companyName = opts.company || null;
    if (opts.tagline !== undefined) footer.tagline = opts.tagline || null;
    if (opts.linkUrl !== undefined) footer.linkUrl = opts.linkUrl || null;
    if (opts.linkLabel !== undefined) footer.linkLabel = opts.linkLabel || null;
    if (Object.keys(footer).length === 0) {
      out.error({
        code: "nothing_to_change",
        message: "Pass --company, --tagline, --link-url, --link-label, --on or --off.",
      });
      return;
    }
    await applyUpdate(cmd, { footer }, "Update the export footer", Boolean(opts.yes));
  });

const LOGO_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

themeCommand
  .command("logo")
  .description("Upload the workspace logo (PNG, JPEG or WebP, max 2 MB) or remove it")
  .argument("[file]", "Image file")
  .option("--remove", "Remove the current logo")
  .option("-y, --yes", "Confirm (required when not running in a terminal)")
  .action(async (file: string | undefined, opts, cmd) => {
    const { out, config, client } = setup(cmd);
    const workspaceId = requireWorkspace(out, config);
    if (!workspaceId) return;
    if (!file && !opts.remove) {
      out.error({ code: "missing_file", message: "Pass an image file, or --remove." });
      return;
    }
    try {
      if (opts.remove) {
        if (!(await confirm(out, Boolean(opts.yes), "Remove the workspace logo?"))) return;
        await client.removeLogo(workspaceId);
        out.succeed("Logo removed");
        out.result({ logoUrl: null });
        return;
      }
      const filePath = path.resolve(file!);
      const contentType = LOGO_TYPES[path.extname(filePath).toLowerCase()];
      if (!contentType) {
        out.error({ code: "unsupported_mime", message: "Logo must be a PNG, JPEG or WebP file." });
        return;
      }
      if (statSync(filePath).size > 2 * 1024 * 1024) {
        out.error({ code: "file_too_large", message: "Logo must be under 2 MB." });
        return;
      }
      if (!(await confirm(out, Boolean(opts.yes), `Use ${path.basename(filePath)} as the workspace logo?`))) return;
      out.spin("Uploading logo...");
      const { logoUrl } = await client.uploadLogo(workspaceId, readFileSync(filePath), path.basename(filePath), contentType);
      out.stopSpinner();
      out.succeed("Logo updated");
      out.info(brand.muted("  Show it in exports: opendocs theme set --logo-in-exports on"));
      out.result({ logoUrl });
    } catch (err) {
      fail(out, err);
    }
  });
