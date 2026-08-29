#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { z } from 'zod';

const DEFAULT_APP_URL = process.env.APPSCREEN_URL ?? 'https://appsolves.github.io/appscreen-mcp/';
const OUTPUT_DIR =
  process.env.APPSCREEN_OUTPUT_DIR ??
  path.join(os.homedir(), 'AppScreenMCP', 'outputs');
const HEADLESS = process.env.APPSCREEN_HEADLESS !== 'false';
const BROWSER_TIMEOUT_MS = Number(process.env.APPSCREEN_BROWSER_TIMEOUT_MS ?? 60_000);

type Json = Record<string, unknown>;

type BridgeResponse<T = unknown> = {
  ok: boolean;
  error?: string;
  result?: T;
  [key: string]: unknown;
};

const USER_DATA_DIR =
  process.env.APPSCREEN_BROWSER_PROFILE_DIR ??
  path.join(os.homedir(), 'AppScreenMCP', 'browser-profile');

let browserContext: BrowserContext | null = null;
let page: Page | null = null;
let currentUrl = DEFAULT_APP_URL;

const server = new McpServer({
  name: 'appscreen-mcp',
  version: '1.0.2',
});

function text(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function toToolError(error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

async function ensureOutputDir() {
  await mkdir(OUTPUT_DIR, { recursive: true });
}

function extensionForMime(mimeType: string) {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('zip')) return 'zip';
  return 'bin';
}

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact';
}

function normalizeDataUrl(input: { filePath?: string; dataUrl?: string; base64?: string; mimeType?: string }) {
  if (input.dataUrl) return input.dataUrl;
  if (input.base64) return `data:${input.mimeType ?? 'image/png'};base64,${input.base64}`;
  throw new Error('Expected filePath, dataUrl, or base64.');
}

async function imageInputToDataUrl(input: { filePath?: string; dataUrl?: string; base64?: string; mimeType?: string }) {
  if (input.filePath) {
    const absolute = path.resolve(input.filePath);
    const buffer = await readFile(absolute);
    const ext = path.extname(absolute).slice(1).toLowerCase();
    const mimeType = input.mimeType ?? (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png');
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }
  return normalizeDataUrl(input);
}

async function saveBase64Artifact(base64: string, fileName: string, mimeType: string) {
  await ensureOutputDir();
  const resolvedName = safeName(fileName || `appscreen-${crypto.randomUUID()}.${extensionForMime(mimeType)}`);
  const outputPath = path.join(OUTPUT_DIR, resolvedName);
  await writeFile(outputPath, Buffer.from(base64, 'base64'));
  return outputPath;
}

async function getPage(url = currentUrl) {
  if (!browserContext) {
    await mkdir(USER_DATA_DIR, { recursive: true });

    browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: HEADLESS,
      acceptDownloads: true,
      // Playwright otherwise emulates a fixed 1280x720 viewport, even when the
      // visible Chrome window is resized. A null viewport makes headed editing
      // follow the native window while preserving the previous headless size.
      viewport: HEADLESS ? { width: 1280, height: 720 } : null,
    });

    browserContext.setDefaultTimeout(BROWSER_TIMEOUT_MS);
  }

  if (!page || page.isClosed()) {
    page = browserContext.pages()[0] ?? await browserContext.newPage();
    page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
  }

  if (page.url() === 'about:blank' || page.url() !== url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
  }

  await page.waitForFunction(() => Boolean((window as any).AppScreenMCP), undefined, {
    timeout: BROWSER_TIMEOUT_MS,
  });

  return page;
}

async function bridge<T = unknown>(method: string, args: Json = {}) {
  const p = await getPage();
  const response = await p.evaluate(
    async ({ method, args }) => {
      const api = (window as any).AppScreenMCP;
      if (!api) throw new Error('window.AppScreenMCP is not available.');
      if (typeof api[method] !== 'function') throw new Error(`Unknown AppScreenMCP method: ${method}`);
      return await api[method](args);
    },
    { method, args },
  ) as BridgeResponse<T>;

  if (!response || response.ok !== true) {
    throw new Error(response?.error ?? `AppScreenMCP.${method} failed.`);
  }

  if ('result' in response && Object.keys(response).length <= 2) return response.result as T;
  const { ok: _ok, ...rest } = response;
  return rest as T;
}

const maybeFileImage = {
  filePath: z.string().optional().describe('Local image file path readable by the MCP server.'),
  dataUrl: z.string().optional().describe('data:image/*;base64,... image data URL.'),
  base64: z.string().optional().describe('Raw base64 image data.'),
  mimeType: z.string().optional().describe('MIME type for base64 input, for example image/png.'),
};

const indexArg = z.number().int().min(0).optional();

const localizedStringMap = z
  .record(z.string(), z.string())
  .describe(
    'Localized string map keyed by language code. Example: { "en": "Title", "de": "Titel" }.',
  );

const backgroundPatchSchema = z
  .record(z.string(), z.any())
  .describe(
    'Background patch. Examples: { "type": "solid", "solid": "#111827" } or { "type": "gradient", "gradient": { "angle": 135, "stops": [{ "color": "#2563eb", "position": 0 }, { "color": "#7c3aed", "position": 100 }] } }.',
  );

const deviceSettingsSchema = z
  .record(z.string(), z.any())
  .describe(
    'Device/mockup settings patch. Common fields: x, y, scale, rotation, cornerRadius, shadowEnabled, shadowColor, shadowBlur, use3D, device3D, rotation3D.',
  );

const textSettingsSchema = z
  .record(z.string(), z.any())
  .describe(
    'Text style/settings patch. Common fields: position, offsetY, headlineEnabled, subheadlineEnabled, headlineFontSize, subheadlineFontSize, headlineColor, subheadlineColor, fontFamily.',
  );

function registerTool<T extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: T,
  handler: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>,
) {
  const callback = async (args: unknown) => {
    try {
      return text(await handler(args as z.infer<z.ZodObject<T>>));
    } catch (error) {
      return toToolError(error);
    }
  };

  server.registerTool(
    name,
    {
      description,
      inputSchema: schema,
    } as any,
    callback as any,
  );
}

registerTool(
  'appscreen_get_usage_guide',
  `Return the recommended AppScreen MCP workflows and important schema rules.

Call this before creating real production assets if you are unsure which tool to use.

Key guidance:
- For polished multi-screen App Store sets with different text per screenshot, prefer appscreen_create_screenshot_set.
- Do not use appscreen_demo_run_cable_launch_recipe for production per-screenshot captions. It is a legacy/simple demo shortcut.
- For manual control, use: initialize -> create_project -> set_output_size -> set_languages -> add_screenshot/select_screenshot -> set_text/set_background/set_device_settings -> export.
- appscreen_set_text affects one screenshot only. Use index or select_screenshot first.
- headline/subheadline can be one string for one language, or a localized map like { "en": "Title", "de": "Titel" }.
- To let the agent visually inspect the editor UI, use appscreen_capture_editor_preview. To inspect final App Store assets, export PNG/ZIP.`,
  {},
  async () => ({
    ok: true,
    workflows: {
      productionMultiScreenSet: [
        'appscreen_initialize',
        'appscreen_get_capabilities',
        'appscreen_create_screenshot_set',
        'appscreen_export_all_zip if export was not requested inside create_screenshot_set',
      ],
      manualPerScreenshotControl: [
        'appscreen_initialize',
        'appscreen_create_project',
        'appscreen_set_output_size',
        'appscreen_set_languages',
        'For each screenshot: appscreen_add_screenshot, appscreen_select_screenshot, appscreen_set_text, appscreen_set_background, appscreen_set_device_settings',
        'appscreen_export_current_png or appscreen_export_all_zip',
      ],
    },
    warnings: [
      'appscreen_demo_run_cable_launch_recipe is a legacy demo shortcut. It uses one shared headline/subheadline map across screenshots.',
      'For eight different App Store assets with different captions, use appscreen_create_screenshot_set.',
    ],
  }),
);

registerTool(
  'appscreen_initialize',
  'Launch or reconnect to the AppScreen browser session and verify that the automation bridge is ready.',
  {
    url: z.string().url().optional().describe('App URL to control. Defaults to APPSCREEN_URL or http://localhost:8000.'),
  },
  async ({ url }) => {
    if (url) currentUrl = url;
    const p = await getPage(currentUrl);
    const health = await bridge('health');
    return {
      ok: true,
      url: p.url(),
      outputDir: OUTPUT_DIR,
      browserProfileDir: USER_DATA_DIR,
      headless: HEADLESS,
      health,
    };
  },
);

registerTool('appscreen_get_capabilities', 'List controllable AppScreen features, output sizes, background types, and support flags.', {}, async () => bridge('getCapabilities'));

registerTool(
  'appscreen_get_state',
  'Read the current AppScreen project state. Runtime HTMLImageElement objects are intentionally omitted.',
  { includeScreenshots: z.boolean().default(true) },
  async (args) => bridge('getState', args),
);

registerTool('appscreen_create_project', 'Create and switch to a new project.', { name: z.string().min(1) }, async (args) => bridge('createProject', args));
registerTool('appscreen_switch_project', 'Switch to an existing project by id.', { projectId: z.string().min(1) }, async (args) => bridge('switchProject', args));
registerTool('appscreen_rename_project', 'Rename the current project.', { name: z.string().min(1) }, async (args) => bridge('renameProject', args));
registerTool('appscreen_duplicate_project', 'Duplicate a project.', { sourceProjectId: z.string().optional(), name: z.string().optional() }, async (args) => bridge('duplicateProject', args));
registerTool('appscreen_delete_current_project', 'Delete the current project and switch to another available project.', {}, async () => bridge('deleteCurrentProject'));

registerTool(
  'appscreen_set_output_size',
  'Set the target output size. Use custom with width and height for arbitrary dimensions.',
  {
    device: z.enum(['iphone-6.9', 'iphone-6.7', 'iphone-6.5', 'iphone-5.5', 'ipad-13', 'ipad-12.9', 'ipad-11', 'android-phone', 'android-phone-hd', 'android-tablet-7', 'android-tablet-10', 'web-og', 'web-twitter', 'web-hero', 'web-feature', 'custom']),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
  },
  async (args) => bridge('setOutputSize', args),
);

registerTool(
  'appscreen_set_languages',
  'Configure project languages and the active language.',
  {
    languages: z.array(z.string().min(2)).min(1),
    currentLanguage: z.string().min(2).optional(),
  },
  async (args) => bridge('setLanguages', args),
);

registerTool('appscreen_select_screenshot', 'Select a screenshot by zero-based index.', { index: z.number().int().min(0) }, async (args) => bridge('selectScreenshot', args));
registerTool('appscreen_add_blank_screenshot', 'Add a blank screenshot slot.', { name: z.string().optional(), language: z.string().optional(), deviceType: z.string().optional() }, async (args) => bridge('addBlankScreenshot', args));

registerTool(
  'appscreen_add_screenshot',
  'Upload/add a screenshot image from a local file, data URL, or base64 payload.',
  {
    ...maybeFileImage,
    name: z.string().optional(),
    language: z.string().optional(),
    deviceType: z.string().optional(),
    replaceIndex: z.number().int().min(0).optional(),
  },
  async (args) => {
    const dataUrl = await imageInputToDataUrl(args);
    return bridge('addScreenshotFromDataUrl', { ...args, dataUrl });
  },
);

registerTool(
  'appscreen_set_localized_screenshot_image',
  'Set or replace the image for a specific screenshot and language.',
  {
    ...maybeFileImage,
    index: indexArg,
    language: z.string().min(2),
    name: z.string().optional(),
    deviceType: z.string().optional(),
  },
  async (args) => {
    const dataUrl = await imageInputToDataUrl(args);
    return bridge('setLocalizedScreenshotImage', { ...args, dataUrl });
  },
);

registerTool('appscreen_remove_screenshot', 'Remove a screenshot by zero-based index.', { index: z.number().int().min(0) }, async (args) => bridge('removeScreenshot', args));
registerTool('appscreen_duplicate_screenshot', 'Duplicate a screenshot by index.', { index: indexArg }, async (args) => bridge('duplicateScreenshot', args));

registerTool(
  'appscreen_set_background',
  'Set background settings for one screenshot. This affects only the provided/selected screenshot. Use apply_style_to_all or create_screenshot_set for bulk styling.',
  {
    index: indexArg,
    background: backgroundPatchSchema,
  },
  async (args) => bridge('setBackground', args),
);

registerTool(
  'appscreen_set_background_image',
  'Set an uploaded image as the screenshot background.',
  {
    ...maybeFileImage,
    index: indexArg,
    fit: z.enum(['cover', 'contain', 'fill']).default('cover'),
    blur: z.number().default(0),
    overlayColor: z.string().default('#000000'),
    overlayOpacity: z.number().min(0).max(100).default(0),
  },
  async (args) => {
    const dataUrl = await imageInputToDataUrl(args);
    return bridge('setBackgroundImage', { ...args, dataUrl });
  },
);

registerTool(
  'appscreen_set_device_settings',
  'Patch 2D/3D mockup settings for one screenshot. This affects only the provided/selected screenshot.',
  {
    index: indexArg,
    settings: deviceSettingsSchema,
  },
  async (args) => bridge('setDeviceSettings', args),
);

registerTool('appscreen_apply_position_preset', 'Apply one of the app position presets to the selected screenshot.', { index: indexArg, preset: z.string().min(1) }, async (args) => bridge('applyPositionPreset', args));

registerTool(
  'appscreen_set_text',
  `Set headline/subheadline text and styling for one screenshot.

Important:
- This tool affects only one screenshot: the provided index or the currently selected screenshot.
- For one language, pass language plus string headline/subheadline.
- For multiple languages, pass localized maps like { "en": "Title", "de": "Titel" }.
- For 8 different screenshots with different captions, call this once per screenshot, or use appscreen_create_screenshot_set.

Example:
{
  "index": 0,
  "headline": { "en": "Control your power", "de": "Kontrolliere deinen Strom" },
  "subheadline": { "en": "Monitor batteries and circuits", "de": "Überwache Batterien und Stromkreise" },
  "settings": { "position": "top", "offsetY": 12 }
}`,
  {
    index: indexArg,
    headline: z.union([z.string(), localizedStringMap]).optional(),
    subheadline: z.union([z.string(), localizedStringMap]).optional(),
    language: z
      .string()
      .optional()
      .describe('Language code to use when headline/subheadline are plain strings. Example: en.'),
    settings: textSettingsSchema.default({}),
  },
  async (args) => bridge('setText', args),
);

registerTool('appscreen_add_text_element', 'Add a movable text element overlay.', { index: indexArg, text: z.string().default('Text'), settings: z.record(z.string(), z.any()).default({}) }, async (args) => bridge('addTextElement', args));
registerTool('appscreen_add_emoji_element', 'Add a movable emoji overlay.', { index: indexArg, emoji: z.string().default('✨'), name: z.string().optional(), settings: z.record(z.string(), z.any()).default({}) }, async (args) => bridge('addEmojiElement', args));
registerTool('appscreen_add_icon_element', 'Add a Lucide icon overlay.', { index: indexArg, iconName: z.string().default('star'), settings: z.record(z.string(), z.any()).default({}) }, async (args) => bridge('addIconElement', args));

registerTool(
  'appscreen_add_graphic_element',
  'Add a movable image/graphic overlay from file, data URL, or base64.',
  {
    ...maybeFileImage,
    index: indexArg,
    name: z.string().optional(),
    settings: z.record(z.string(), z.any()).default({}),
  },
  async (args) => {
    const dataUrl = await imageInputToDataUrl(args);
    return bridge('addGraphicElementFromDataUrl', { ...args, dataUrl });
  },
);

registerTool('appscreen_update_element', 'Patch an existing overlay element by id.', { index: indexArg, id: z.string().min(1), patch: z.record(z.string(), z.any()) }, async (args) => bridge('updateElement', args));
registerTool('appscreen_delete_element', 'Delete an overlay element by id.', { index: indexArg, id: z.string().min(1) }, async (args) => bridge('deleteElement', args));
registerTool('appscreen_add_popout', 'Add a popout/callout crop element.', { index: indexArg, patch: z.record(z.string(), z.any()).default({}) }, async (args) => bridge('addPopout', args));
registerTool('appscreen_update_popout', 'Patch an existing popout/callout by id.', { index: indexArg, id: z.string().min(1), patch: z.record(z.string(), z.any()) }, async (args) => bridge('updatePopout', args));
registerTool('appscreen_delete_popout', 'Delete a popout/callout by id.', { index: indexArg, id: z.string().min(1) }, async (args) => bridge('deletePopout', args));

registerTool(
  'appscreen_apply_style_to_all',
  'Copy style settings from one screenshot to all other screenshots.',
  {
    sourceIndex: indexArg,
    includeText: z.boolean().default(true),
    includeBackground: z.boolean().default(true),
    includeDevice: z.boolean().default(true),
    includeElements: z.boolean().default(true),
    includePopouts: z.boolean().default(true),
  },
  async (args) => bridge('applyStyleToAll', args),
);

registerTool(
  'appscreen_create_screenshot_set',
  `Create a complete multi-screen App Store screenshot set in one call.

Use this for production campaigns with per-screenshot captions, for example 8 screenshots where each asset has different English/German headline and subheadline.

This tool:
1. creates a project
2. sets output size and languages
3. uploads all screenshots
4. applies shared background/device/text styling
5. applies per-screenshot localized captions
6. optionally exports all screenshots/languages as ZIP

Example screenshot item:
{
  "filePath": "C:/screens/shot1.png",
  "name": "Home",
  "text": {
    "en": { "headline": "Control your power", "subheadline": "Monitor batteries and circuits" },
    "de": { "headline": "Kontrolliere deinen Strom", "subheadline": "Überwache Batterien und Stromkreise" }
  }
}`,
  {
    projectName: z.string().default('AppScreen Campaign'),
    outputDevice: z
      .enum([
        'iphone-6.9',
        'iphone-6.7',
        'iphone-6.5',
        'iphone-5.5',
        'ipad-13',
        'ipad-12.9',
        'ipad-11',
        'android-phone',
        'android-phone-hd',
        'android-tablet-7',
        'android-tablet-10',
        'web-og',
        'web-twitter',
        'web-hero',
        'web-feature',
        'custom',
      ])
      .default('iphone-6.9'),
    width: z.number().positive().optional().describe('Required when outputDevice is custom.'),
    height: z.number().positive().optional().describe('Required when outputDevice is custom.'),
    languages: z.array(z.string().min(2)).min(1).default(['en']),
    background: backgroundPatchSchema.optional(),
    deviceSettings: deviceSettingsSchema.default({}),
    textSettings: textSettingsSchema.default({}),
    screenshots: z
      .array(
        z.object({
          ...maybeFileImage,
          name: z.string().optional(),
          language: z.string().optional(),
          deviceType: z.string().optional(),
          text: z
            .record(
              z.string(),
              z.object({
                headline: z.string().optional(),
                subheadline: z.string().optional(),
                settings: z.record(z.string(), z.any()).optional(),
              }),
            )
            .optional()
            .describe(
              'Per-screenshot localized caption map. Example: { "en": { "headline": "...", "subheadline": "..." }, "de": { "headline": "...", "subheadline": "..." } }.',
            ),
        }),
      )
      .min(1),
    exportAllLanguagesZip: z.boolean().default(true),
    saveToFile: z.boolean().default(true),
    fileName: z.string().optional(),
  },
  async ({ screenshots, saveToFile, fileName, ...args }) => {
    const hydratedScreenshots = await Promise.all(
      screenshots.map(async (s) => ({
        ...s,
        dataUrl: await imageInputToDataUrl(s),
      })),
    );

    const created = await bridge<{
      projectId: string;
      screenshotCount: number;
      fileName?: string;
      mimeType?: string;
      base64?: string;
      dataUrl?: string;
    }>('createScreenshotSet', {
      ...args,
      screenshots: hydratedScreenshots,
    });

    let outputPath: string | undefined;

    if (saveToFile && created.base64 && created.mimeType) {
      outputPath = await saveBase64Artifact(
        created.base64,
        fileName ?? created.fileName ?? 'appscreen-screenshot-set.zip',
        created.mimeType,
      );
    }

    return {
      ...created,
      outputPath,
    };
  },
);

registerTool(
  'appscreen_patch_state',
  'Advanced escape hatch: deep-merge a patch into the app state. Use only when no higher-level tool fits.',
  { patch: z.record(z.string(), z.any()) },
  async (args) => bridge('patchState', args),
);

registerTool(
  'appscreen_capture_editor_preview',
  'Capture a PNG screenshot of the visible AppScreen editor UI via Playwright. Use this when the agent needs to visually inspect the editor, not just the exported App Store asset.',
  {
    saveToFile: z.boolean().default(true),
    fileName: z.string().optional(),
    fullPage: z.boolean().default(true),
  },
  async ({ saveToFile, fileName, fullPage }) => {
    const p = await getPage();
    const buffer = await p.screenshot({ type: 'png', fullPage });
    const base64 = buffer.toString('base64');
    const mimeType = 'image/png';

    const outputPath = saveToFile
      ? await saveBase64Artifact(
        base64,
        fileName ?? `appscreen-editor-preview-${crypto.randomUUID()}.png`,
        mimeType,
      )
      : undefined;

    return {
      fileName: fileName ?? 'appscreen-editor-preview.png',
      mimeType,
      base64,
      dataUrl: `data:${mimeType};base64,${base64}`,
      outputPath,
    };
  },
);

registerTool(
  'appscreen_export_current_png',
  'Render the selected screenshot as PNG. Returns base64 and optionally saves it to APPSCREEN_OUTPUT_DIR.',
  {
    language: z.string().optional(),
    saveToFile: z.boolean().default(true),
    fileName: z.string().optional(),
  },
  async ({ saveToFile, fileName, ...args }) => {
    const exported = await bridge<{ fileName: string; mimeType: string; base64: string; dataUrl: string }>('renderCurrentPng', args);
    const outputPath = saveToFile ? await saveBase64Artifact(exported.base64, fileName ?? exported.fileName, exported.mimeType) : undefined;
    return { ...exported, outputPath };
  },
);

registerTool(
  'appscreen_export_all_zip',
  'Export all screenshots as a ZIP. Can export current language only, selected languages, or all project languages.',
  {
    languages: z.array(z.string()).optional(),
    currentLanguageOnly: z.boolean().default(false),
    saveToFile: z.boolean().default(true),
    fileName: z.string().optional(),
  },
  async ({ saveToFile, fileName, ...args }) => {
    const exported = await bridge<{ fileName: string; mimeType: string; base64: string; dataUrl: string }>('exportAllZip', args);
    const outputPath = saveToFile ? await saveBase64Artifact(exported.base64, fileName ?? exported.fileName, exported.mimeType) : undefined;
    return { ...exported, outputPath };
  },
);

registerTool(
  'appscreen_demo_run_cable_launch_recipe',
  `Legacy/demo shortcut only: create Cable Launch, upload screenshots, apply one shared English/German headline/subheadline map, blue-purple gradient, centered rotated phone, and export all languages as ZIP.
  Do NOT use this for production multi-screen App Store sets where every screenshot needs its own caption. For that, use appscreen_create_screenshot_set.`,
  {
    screenshots: z.array(z.object({
      ...maybeFileImage,
      name: z.string().optional(),
      language: z.string().optional(),
      deviceType: z.string().optional(),
    })).min(1),
    projectName: z.string().default('Cable Launch'),
    languages: z.array(z.string()).default(['en', 'de']),
    headline: localizedStringMap
      .optional()
      .describe('One shared localized headline map applied to all screenshots. Not per-screenshot.'),
    subheadline: localizedStringMap
      .optional()
      .describe('One shared localized subheadline map applied to all screenshots. Not per-screenshot.'),
    saveToFile: z.boolean().default(true),
    fileName: z.string().optional(),
  },
  async ({ screenshots, saveToFile, fileName, ...args }) => {
    const hydratedScreenshots = await Promise.all(screenshots.map(async (s) => ({ ...s, dataUrl: await imageInputToDataUrl(s) })));
    const exported = await bridge<{ fileName: string; mimeType: string; base64: string; dataUrl: string }>('runDemoCableLaunchRecipe', { ...args, screenshots: hydratedScreenshots });
    const outputPath = saveToFile ? await saveBase64Artifact(exported.base64, fileName ?? exported.fileName, exported.mimeType) : undefined;
    return { ...exported, outputPath };
  },
);

registerTool(
  'appscreen_raw_bridge_call',
  'Advanced escape hatch: call any method exposed by window.AppScreenMCP with JSON arguments.',
  {
    method: z.string().min(1),
    args: z.record(z.string(), z.any()).default({}),
  },
  async ({ method, args }) => bridge(method, args),
);

process.on('SIGINT', async () => {
  await browserContext?.close().catch(() => undefined);
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await browserContext?.close().catch(() => undefined);
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
